/**
 * Experimental explicit supervisor for a separate Node hub child. Not started
 * by Electron and not a deployment/installer: callers must provision a trusted
 * executable, bundled child, protected key, HTTPS proxy, dedicated hub directory,
 * restore coordination and platform-specific file permissions. No approval,
 * grant, Panic or remote session integration is provided. Do not enable the app.
 *
 * The parent supplies the existing read-only reader and an isolated sync-state
 * object. Never give the child shop.db or the Prisma client; only fixed DTOs and
 * authenticated audit batches cross the boundary. Optional invoice reads require
 * explicit opt-in and a trusted child/IPC; marker rechecks do not coordinate a
 * real restore, and a reader timeout may not cancel the underlying query. A
 * custom reader without waitForIdle cannot prove underlying queries have ended
 * on shutdown. No other owner may start new reads during that wait. A heap
 * limit is not an RSS cap. Multiple origin identities do not create or secure
 * any HTTPS transport or tunnel.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isInvoiceDate, parseInvoicePage } from './invoiceFactsValidation'
import { normalizeMobileOrigins } from './mobileOrigins'
import { createAuditSync } from './auditSync'
import { createLoopbackAuditTransport } from './loopbackAuditTransport'
import type { CloudState } from './cloudState'
import type { createExperimentalRestoreBarrier } from './experimentalRestoreBarrier'
import { startExperimentalRevocationReceiver } from './experimentalNetworkRevocation'
import { revokeAll, revokeBy } from '../RemoteGrantRegistry'

type Reader = {
  latestBoundaryTotals(): Promise<unknown>
  openShiftsPage(afterId: number, limit?: number): Promise<unknown>
  auditPage(afterId: number, limit?: number): Promise<{id:number; at:string; action:string; entity:string}[]>
  // Trusted readers can expose underlying operations that outlive public timeouts.
  waitForIdle?(): Promise<void>
  invoiceFactsPage?(fromDay:string,toDay:string,afterId:number,limit:number): Promise<unknown>
}
type Options = {
  nodeExecutable: string; childFile: string; directory: string; origin?: string; origins?: readonly string[]
  owner: null | { username:string; password:string; pin:string }
  auditKey: Uint8Array; snapshotMaxAgeMs: number
  reader: Reader; state: { load():CloudState | null; save(value:CloudState):void; openRevocationLedger?():Omit<Parameters<typeof startExperimentalRevocationReceiver>[0]['ledger'],'apply'> }
  readRestoreMarker: () => Promise<string | null>
  // Experimental explicit opt-in only; not sufficient to enable production.
  enableInvoiceFacts?: boolean
  // Optional in-process experiment only. Every restore must use restoreExclusive,
  // and no other component may bypass the gate or start queries on this reader.
  restoreBarrier?: ReturnType<typeof createExperimentalRestoreBarrier>
  // The caller owns an exclusive durable replay ledger scoped to this store and
  // epoch. This opt-in does not enable the Electron integration.
  revocation?: { key:Uint8Array; ledger?:Omit<Parameters<typeof startExperimentalRevocationReceiver>[0]['ledger'],'apply'>;
    // Synchronous, idempotent host delivery: called before durable ACK. It can
    // repeat after a failure or lost ACK; never use a volatile-only notification
    // as evidence that a user has seen a message.
    onRevocation?:(entry:{id:number;kind:'ALL'|'MEMBER';memberId:string|null})=>undefined }
  // Trusted desktop callback must enforce the existing local manager-password
  // gate and lockout. Do not expose recovery to the mobile network.
  verifyLocalRecoveryPassword?: (password:string)=>Promise<void>
  timeoutMs?: number
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function startExperimentalHubSupervisor(options: Options) {
  if (!options || typeof options.nodeExecutable !== 'string' || !isAbsolute(options.nodeExecutable) ||
      typeof options.childFile !== 'string' || !isAbsolute(options.childFile) ||
      typeof options.directory !== 'string' || !isAbsolute(options.directory) ||
      !(options.auditKey instanceof Uint8Array) || options.auditKey.byteLength !== 32 ||
      !Number.isSafeInteger(options.snapshotMaxAgeMs) || options.snapshotMaxAgeMs < 100 || options.snapshotMaxAgeMs > 60_000 ||
      !options.reader || typeof options.reader.latestBoundaryTotals !== 'function' || typeof options.reader.openShiftsPage !== 'function' ||
      typeof options.reader.auditPage !== 'function' ||
      (options.reader.waitForIdle !== undefined && typeof options.reader.waitForIdle !== 'function') ||
      (options.restoreBarrier !== undefined && (!options.restoreBarrier || typeof options.restoreBarrier.run !== 'function' ||
        typeof options.restoreBarrier.restore !== 'function' || typeof options.restoreBarrier.status !== 'function' || typeof options.reader.waitForIdle !== 'function')) ||
      (options.reader.invoiceFactsPage !== undefined && typeof options.reader.invoiceFactsPage !== 'function') ||
      (options.enableInvoiceFacts !== undefined && typeof options.enableInvoiceFacts !== 'boolean') ||
      (options.enableInvoiceFacts === true && typeof options.reader.invoiceFactsPage !== 'function') ||
      (options.verifyLocalRecoveryPassword !== undefined && (typeof options.verifyLocalRecoveryPassword !== 'function' || !options.revocation)) ||
      (options.revocation !== undefined && (!options.revocation || !(options.revocation.key instanceof Uint8Array) ||
        options.revocation.key.byteLength!==32 || Buffer.from(options.revocation.key).equals(Buffer.from(options.auditKey)) ||
        (options.revocation.onRevocation !== undefined && typeof options.revocation.onRevocation !== 'function') ||
        (options.revocation.ledger === undefined ? typeof options.state?.openRevocationLedger !== 'function' :
          (!options.revocation.ledger || typeof options.revocation.ledger.load!=='function' || typeof options.revocation.ledger.hasNonce!=='function' || typeof options.revocation.ledger.save!=='function')))) ||
      !options.state || typeof options.state.load !== 'function' ||
      typeof options.state.save !== 'function' || typeof options.readRestoreMarker !== 'function') throw new Error('Invalid experimental hub configuration')
  const origins=normalizeMobileOrigins(options.origin,options.origins)
  const originConfig=options.origin !== undefined ? {origin:origins[0]} : {origins}
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new Error('Invalid hub timeout')
  const key = Buffer.from(options.auditKey), reader = options.reader, state = options.state, readRestoreMarker = options.readRestoreMarker
  const barrier=options.restoreBarrier
  function guarded<T>(operation:()=>Promise<T>):Promise<T> {
    if (!barrier) return operation()
    return barrier.run(async()=>{ try { return await operation() } finally { await reader.waitForIdle!() } })
  }
  let revocationReceiver: Awaited<ReturnType<typeof startExperimentalRevocationReceiver>> | undefined
  let recoveryLedger: Omit<Parameters<typeof startExperimentalRevocationReceiver>[0]['ledger'],'apply'> | undefined
  let revocationConfig: {key:string;storeId:string;epoch:string;port:number} | undefined
  let closeReceiver: Promise<void> | undefined
  if (options.revocation) {
    const initial=state.load()
    if (!initial) throw new Error('Revocation state unavailable')
    const storeId=initial.storeId, epoch=initial.epoch, ledger=options.revocation.ledger ?? state.openRevocationLedger!()
    recoveryLedger=ledger
    revokeAll()
    function guardedLedger<T>(operation:()=>T):T {
      try { return operation() } catch (error) { try {revokeAll()} catch {} ; throw error }
    }
    revocationReceiver=await startExperimentalRevocationReceiver({key:options.revocation.key,storeId,epoch,ledger:{
      load:()=>guardedLedger(()=>ledger.load()), hasNonce:nonce=>guardedLedger(()=>ledger.hasNonce(nonce)),
      save:(entry,nonce)=>guardedLedger(()=>ledger.save(entry,nonce)),
      apply:entry=>guardedLedger(()=>{
        const current=state.load()
        if (!current || current.storeId!==storeId || current.epoch!==epoch) throw new Error('Revocation epoch changed')
        if (entry.kind==='ALL') revokeAll(); else revokeBy(entry.memberId!)
        // Fail before saving the nonce/cursor if host delivery fails. A retry
        // re-applies revocation and may call the host again; it must deduplicate.
        if (options.revocation?.onRevocation) {
          const result:unknown=options.revocation.onRevocation({...entry})
          if (result !== undefined) {
            // A mistakenly supplied async callback must not produce an
            // unhandled rejection or receive an ACK for unfinished work.
            if (result instanceof Promise) void result.catch(() => {})
            throw new Error('Invalid revocation callback')
          }
        }
      })
    }})
    revocationConfig={key:Buffer.from(options.revocation.key).toString('hex'),storeId,epoch,port:revocationReceiver.port}
  }
  function releaseReceiver():Promise<void> {
    if (!revocationReceiver) return Promise.resolve()
    closeReceiver ??= revocationReceiver.close()
    return closeReceiver
  }
  // Do not inherit DATABASE_URL, NODE_OPTIONS, credentials, or the POS environment.
  // Windows filesystem/runtime behavior still needs a real platform test.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TZ','LANG']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name]
  }
  let child: ChildProcess
  try { child = fork(options.childFile, [], { execPath:options.nodeExecutable, execArgv:['--max-old-space-size=128'],
    stdio:['ignore','ignore','ignore','ipc'], serialization:'json', env }) }
  catch (error) { await releaseReceiver();throw error }
  let dead = false, closed = false, busy = false, nextId = 0
  let invoiceBusy=false, invoiceLastRead=-Infinity, invoiceLastId=0, recoveryBusy=false
  const invoiceReader=options.enableInvoiceFacts === true ? reader.invoiceFactsPage!.bind(reader) : undefined
  let stopPromise: Promise<void> | null = null
  const activeTasks = new Set<Promise<unknown>>()
  function track<T>(task: Promise<T>): Promise<T> {
    activeTasks.add(task)
    void task.then(() => activeTasks.delete(task), () => activeTasks.delete(task))
    return task
  }
  const waiting = new Map<number,{ resolve:(ok:boolean)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>()
  let startupResolve: ((ports:{mobilePort:number; auditPort:number})=>void) | undefined
  let startupReject: ((error:Error)=>void) | undefined
  const startup = new Promise<{mobilePort:number; auditPort:number}>((resolve,reject) => { startupResolve=resolve;startupReject=reject })
  const fail = () => {
    if (options.revocation) { try { revokeAll() } catch {} ; void releaseReceiver().catch(() => {}) }
    dead = true
    startupReject?.(new Error('Hub child unavailable'));startupReject=undefined;startupResolve=undefined
    for (const item of waiting.values()) { clearTimeout(item.timer);item.reject(new Error('Hub child unavailable')) }
    waiting.clear()
  }
  child.on('error',fail);child.on('exit',fail);child.on('disconnect',fail)
  child.on('message',(message: unknown) => {
    if (!object(message)) return
    if (message.type === 'ready' && startupResolve && message.pid === child.pid &&
        Number.isSafeInteger(message.mobilePort) && message.mobilePort >= 1 && message.mobilePort <= 65535 &&
        Number.isSafeInteger(message.auditPort) && message.auditPort >= 1 && message.auditPort <= 65535 && message.mobilePort !== message.auditPort) {
      startupResolve({mobilePort:message.mobilePort,auditPort:message.auditPort});startupResolve=undefined;startupReject=undefined
    } else if (message.type === 'error' && message.operation === 'start') fail()
    else if (message.type === 'invoiceRead' && invoiceReader) {
      const id=message.id, from=message.fromDay, to=message.toDay, afterId=message.afterId
      if (!Number.isSafeInteger(id) || id <= invoiceLastId || id <= 0) return
      invoiceLastId=id
      const failRead=() => { try { if (!closed && !dead) send({type:'invoiceReadResult',id,ok:false}) } catch {} }
      const now=performance.now()
      if (closed || dead || invoiceBusy || now < invoiceLastRead || now-invoiceLastRead < 10_000 ||
          Object.keys(message).sort().join(',') !== 'afterId,fromDay,id,toDay,type' ||
          !isInvoiceDate(from) || !isInvoiceDate(to) || from > to || !Number.isSafeInteger(afterId) || afterId < 0) { failRead();return }
      invoiceBusy=true;invoiceLastRead=now
      void track(guarded(async () => {
        try {
          // These checks detect known restores but do not serialize with restore.
          // The application must remain disabled until real coordination exists.
          const loaded=state.load()
          if (!loaded) throw new Error('Restore detected')
          const initial={storeId:loaded.storeId,epoch:loaded.epoch,restoreMarker:loaded.restoreMarker}
          if (await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          const value=parseInvoicePage(await invoiceReader(from,to,afterId,50),from,to,afterId)
          const current=state.load()
          if (!current || current.storeId !== initial.storeId || current.epoch !== initial.epoch ||
              current.restoreMarker !== initial.restoreMarker || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          if (barrier && barrier.status().state !== 'OPEN') throw new Error('Restore in progress')
          if (!closed && !dead) send({type:'invoiceReadResult',id,ok:true,value})
        } catch { failRead() }
      }).catch(() => { failRead() }).finally(() => { invoiceBusy=false }))
    }
    else if ((message.type === 'snapshot' || message.type === 'panicRecovered') && Number.isSafeInteger(message.id)) {
      const item=waiting.get(message.id)
      if (!item) return
      waiting.delete(message.id);clearTimeout(item.timer)
      if (typeof message.ok !== 'boolean') item.reject(new Error('Invalid hub response'))
      else if (message.type === 'snapshot' && message.ok === false && typeof message.reason === 'string' &&
               ['invalid-capture','clock-regressed','clock-future','snapshot-expired','invalid-payload'].includes(message.reason)) {
        item.reject(new Error(`Hub rejected snapshot (${message.reason})`))
      } else item.resolve(message.ok)
    }
  })
  const send = (message: Record<string, any>) => {
    if (dead || !child.connected || !child.send) throw new Error('Hub child unavailable')
    child.send(message, (error) => { if (error) fail() })
  }
  const startTimer=setTimeout(() => { fail();child.kill() },timeout)
  try {
    send({type:'start',config:{directory:options.directory,...originConfig,owner:options.owner,
      auditKey:key.toString('hex'),snapshotMaxAgeMs:options.snapshotMaxAgeMs,...(invoiceReader ? {invoiceFacts:true} : {}),
      ...(revocationConfig ? {revocation:revocationConfig} : {})}})
    const ports=await startup
    clearTimeout(startTimer)
    const transport=createLoopbackAuditTransport(`http://127.0.0.1:${ports.auditPort}/internal/v1/audit`,key,timeout)
    const sync=createAuditSync({state,reader,transport,readRestoreMarker})
    const update = (message: Record<string,unknown>) => new Promise<boolean>((resolve,reject) => {
      if (dead || closed || nextId >= Number.MAX_SAFE_INTEGER) { reject(new Error('Hub child unavailable'));return }
      const id=++nextId
      const timer=setTimeout(() => { waiting.delete(id);reject(new Error('Hub snapshot timed out'));child.kill() },timeout)
      waiting.set(id,{resolve,reject,timer})
      try { send({...message,id}) } catch (error) { clearTimeout(timer);waiting.delete(id);reject(error) }
    })
    return {
      mobilePort:ports.mobilePort,
      refreshOnce(): Promise<void> {
        if (closed || dead) return Promise.reject(new Error('Hub child unavailable'))
        if (busy) return Promise.reject(new Error('Hub refresh busy'))
        busy=true
        return track(guarded(async () => { try {
          // Remove the old snapshot before potentially slow reads. A refresh can
          // overlap an uncoordinated restore; an old value must not remain visible
          // while this refresh is blocked or checking the marker.
          if (!await update({type:'invalidateSnapshot'})) throw new Error('Hub rejected invalidation')
          // Detect known restore/epoch changes before publishing. These checks
          // are not a lock: restore must still be coordinated by the host.
          const loaded=state.load()
          if (!loaded) throw new Error('Restore detected')
          const initial={storeId:loaded.storeId,epoch:loaded.epoch,restoreMarker:loaded.restoreMarker}
          if (await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          const capturedAtMs=Date.now()
          const boundary=await reader.latestBoundaryTotals()
          const shifts=await reader.openShiftsPage(0,200)
          const current=state.load()
          if (!current || current.storeId !== initial.storeId || current.epoch !== initial.epoch ||
              current.restoreMarker !== initial.restoreMarker || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          if (barrier && barrier.status().state !== 'OPEN') throw new Error('Restore in progress')
          if (!await update({type:'snapshot',capturedAtMs,value:{boundary,shifts}})) throw new Error('Hub rejected snapshot')
        } catch (error) {
          // Never knowingly leave a previously good snapshot visible on read error.
          if (!closed && !dead) try { await update({type:'invalidateSnapshot'}) } catch { child.kill() }
          throw error
        } }).finally(() => {busy=false}))
      },
      syncOnce() {
        if (closed || dead) return Promise.reject(new Error('Hub child unavailable'))
        return track(guarded(() => sync.runOnce()))
      },
      // Local trusted caller only. This is not registered as a mobile endpoint
      // or Electron IPC; integration must enforce a trusted local window.
      recoverPanic(password:string, ownerPin:string):Promise<boolean> {
        if (closed || dead || recoveryBusy || !options.verifyLocalRecoveryPassword || !revocationConfig ||
            typeof password!=='string' || !password || Buffer.byteLength(password,'utf8')>128 ||
            typeof ownerPin!=='string' || !/^[0-9]{6}$/.test(ownerPin)) return Promise.resolve(false)
        recoveryBusy=true
        return track(guarded(async()=>{
          try {
            const before=state.load()
            if (!before || before.storeId!==revocationConfig!.storeId || before.epoch!==revocationConfig!.epoch ||
                await readRestoreMarker()!==before.restoreMarker) return false
            if (await options.verifyLocalRecoveryPassword!(password) !== undefined) return false
            const current=state.load()
            if (closed || dead || !current || current.storeId!==before.storeId || current.epoch!==before.epoch ||
                current.restoreMarker!==before.restoreMarker || await readRestoreMarker()!==before.restoreMarker ||
                (barrier && barrier.status().state!=='OPEN')) return false
            const cursor=recoveryLedger?.load()
            if (!cursor || !Number.isSafeInteger(cursor.id) || cursor.id<1) return false
            return await update({type:'recoverPanic',pin:ownerPin,lastAck:cursor.id})
          } catch { return false }
        }).finally(()=>{recoveryBusy=false}))
      },
      restoreExclusive(operation:()=>Promise<void>):Promise<void> {
        if (closed || dead || !barrier || typeof operation !== 'function') return Promise.reject(new Error('Restore coordination unavailable'))
        const invalidate=async()=>{ if (!await update({type:'invalidateSnapshot'})) throw new Error('Hub rejected invalidation') }
        // Invalidate both as the gate closes and once more after old work drains.
        // The caller must rotate epoch/revoke and serialize every restore itself.
        return track(barrier.restore(async()=>{await invalidate();await operation()},invalidate))
      },
      stop(): Promise<void> {
        if (stopPromise) return stopPromise
        closed=true
        if (dead) return Promise.reject(new Error('Hub child unavailable; cleanup not confirmed'))
        stopPromise = new Promise<void>((resolve,reject) => {
          let acknowledged = false
          const onMessage = (message: unknown) => { if (object(message) && message.type === 'stopped') acknowledged=true }
          const cleanup = () => { clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit) }
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            if (acknowledged && code === 0 && signal === null) resolve()
            else reject(new Error('Hub stopped without confirmed cleanup'))
          }
          const timer=setTimeout(() => {cleanup();child.kill();reject(new Error('Hub stop timed out'))},timeout)
          child.on('message',onMessage);child.once('exit',onExit)
          try { send({type:'stop'}) } catch (error) { cleanup();child.kill();reject(error) }
        }).then(async () => {
          await releaseReceiver()
          // A killed/closed child does not cancel already-running parent reads or
          // sync writes. Do not claim a clean stop while they can still mutate
          // sync state. A timeout is failure, not cancellation of those tasks.
          const tasks=[...activeTasks]
          // The concrete cloud reader can retain a SQL operation after its
          // caller timed out. Custom readers without this contract remain the
          // host's responsibility; no cancellation or restore lock is implied.
          if (!tasks.length && !reader.waitForIdle) return
          const drained=Promise.allSettled(tasks).then(async () => { if (reader.waitForIdle) await reader.waitForIdle() })
          let timer:ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              drained,
              new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('Hub parent work did not settle')),timeout) })
            ])
          } finally { if (timer) clearTimeout(timer) }
        })
        return stopPromise
      }
    }
  } catch (error) {
    clearTimeout(startTimer);child.kill();await releaseReceiver().catch(() => {});throw error
  }
}
