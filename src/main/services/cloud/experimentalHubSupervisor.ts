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
 * real restore, and a reader timeout may not cancel the underlying query. A heap
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

type Reader = {
  latestBoundaryTotals(): Promise<unknown>
  openShiftsPage(afterId: number, limit?: number): Promise<unknown>
  auditPage(afterId: number, limit?: number): Promise<{id:number; at:string; action:string; entity:string}[]>
  invoiceFactsPage?(fromDay:string,toDay:string,afterId:number,limit:number): Promise<unknown>
}
type Options = {
  nodeExecutable: string; childFile: string; directory: string; origin?: string; origins?: readonly string[]
  owner: null | { username:string; password:string; pin:string }
  auditKey: Uint8Array; snapshotMaxAgeMs: number
  reader: Reader; state: { load():CloudState | null; save(value:CloudState):void }
  readRestoreMarker: () => Promise<string | null>
  // Experimental explicit opt-in only; not sufficient to enable production.
  enableInvoiceFacts?: boolean
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
      (options.reader.invoiceFactsPage !== undefined && typeof options.reader.invoiceFactsPage !== 'function') ||
      (options.enableInvoiceFacts !== undefined && typeof options.enableInvoiceFacts !== 'boolean') ||
      (options.enableInvoiceFacts === true && typeof options.reader.invoiceFactsPage !== 'function') ||
      !options.state || typeof options.state.load !== 'function' ||
      typeof options.state.save !== 'function' || typeof options.readRestoreMarker !== 'function') throw new Error('Invalid experimental hub configuration')
  const origins=normalizeMobileOrigins(options.origin,options.origins)
  const originConfig=options.origin !== undefined ? {origin:origins[0]} : {origins}
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new Error('Invalid hub timeout')
  const key = Buffer.from(options.auditKey), reader = options.reader, state = options.state, readRestoreMarker = options.readRestoreMarker
  // Do not inherit DATABASE_URL, NODE_OPTIONS, credentials, or the POS environment.
  // Windows filesystem/runtime behavior still needs a real platform test.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TZ','LANG']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name]
  }
  const child: ChildProcess = fork(options.childFile, [], { execPath:options.nodeExecutable, execArgv:['--max-old-space-size=128'],
    stdio:['ignore','ignore','ignore','ipc'], serialization:'json', env })
  let dead = false, closed = false, busy = false, nextId = 0
  let invoiceBusy=false, invoiceLastRead=-Infinity, invoiceLastId=0
  const invoiceReader=options.enableInvoiceFacts === true ? reader.invoiceFactsPage!.bind(reader) : undefined
  let stopPromise: Promise<void> | null = null
  const waiting = new Map<number,{ resolve:(ok:boolean)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>()
  let startupResolve: ((ports:{mobilePort:number; auditPort:number})=>void) | undefined
  let startupReject: ((error:Error)=>void) | undefined
  const startup = new Promise<{mobilePort:number; auditPort:number}>((resolve,reject) => { startupResolve=resolve;startupReject=reject })
  const fail = () => {
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
      void (async () => {
        try {
          // These checks detect known restores but do not serialize with restore.
          // The application must remain disabled until real coordination exists.
          const initial=state.load()
          if (!initial || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          const value=parseInvoicePage(await invoiceReader(from,to,afterId,50),from,to,afterId)
          const current=state.load()
          if (!current || current.storeId !== initial.storeId || current.epoch !== initial.epoch ||
              current.restoreMarker !== initial.restoreMarker || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          if (!closed && !dead) send({type:'invoiceReadResult',id,ok:true,value})
        } catch { failRead() } finally { invoiceBusy=false }
      })()
    }
    else if (message.type === 'snapshot' && Number.isSafeInteger(message.id)) {
      const item=waiting.get(message.id)
      if (!item) return
      waiting.delete(message.id);clearTimeout(item.timer)
      if (typeof message.ok !== 'boolean') item.reject(new Error('Invalid hub response'))
      else item.resolve(message.ok)
    }
  })
  const send = (message: Record<string, any>) => {
    if (dead || !child.connected || !child.send) throw new Error('Hub child unavailable')
    child.send(message, (error) => { if (error) fail() })
  }
  const startTimer=setTimeout(() => { fail();child.kill() },timeout)
  try {
    send({type:'start',config:{directory:options.directory,...originConfig,owner:options.owner,
      auditKey:key.toString('hex'),snapshotMaxAgeMs:options.snapshotMaxAgeMs,...(invoiceReader ? {invoiceFacts:true} : {})}})
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
      async refreshOnce(): Promise<void> {
        if (closed || dead) throw new Error('Hub child unavailable')
        if (busy) throw new Error('Hub refresh busy')
        busy=true
        try {
          // Remove the old snapshot before potentially slow reads. A refresh can
          // overlap an uncoordinated restore; an old value must not remain visible
          // while this refresh is blocked or checking the marker.
          if (!await update({type:'invalidateSnapshot'})) throw new Error('Hub rejected invalidation')
          // Detect known restore/epoch changes before publishing. These checks
          // are not a lock: restore must still be coordinated by the host.
          const initial=state.load()
          if (!initial || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          const capturedAtMs=Date.now()
          const boundary=await reader.latestBoundaryTotals()
          const shifts=await reader.openShiftsPage(0,200)
          const current=state.load()
          if (!current || current.storeId !== initial.storeId || current.epoch !== initial.epoch ||
              current.restoreMarker !== initial.restoreMarker || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          if (!await update({type:'snapshot',capturedAtMs,value:{boundary,shifts}})) throw new Error('Hub rejected snapshot')
        } catch (error) {
          // Never knowingly leave a previously good snapshot visible on read error.
          if (!closed && !dead) try { await update({type:'invalidateSnapshot'}) } catch { child.kill() }
          throw error
        } finally {busy=false}
      },
      async syncOnce() {
        if (closed || dead) throw new Error('Hub child unavailable')
        return sync.runOnce()
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
        })
        return stopPromise
      }
    }
  } catch (error) {
    clearTimeout(startTimer);child.kill();throw error
  }
}
