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
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isInvoiceDate, parseInvoicePage } from './invoiceFactsValidation'
import { normalizeMobileOrigins } from './mobileOrigins'
import { createAuditSync } from './auditSync'
import { createLoopbackAuditTransport } from './loopbackAuditTransport'
import type { CloudState } from './cloudState'
import type { createExperimentalRestoreBarrier } from './experimentalRestoreBarrier'
import { startExperimentalRevocationReceiver } from './experimentalNetworkRevocation'
import { acquireRemoteAdmissionLease, revokeAll, revokeBy } from '../RemoteGrantRegistry'
import { createExperimentalApprovalBridge } from './experimentalApprovalBridge'
import type { GrantReplayStore } from './signedCommandVerifier'
import { reserveDesktopBackupCoordination } from './desktopBackupCoordination'
import { auditRowHash, createDatabaseFingerprint } from './databaseFingerprint'

type Reader = {
  latestBoundaryTotals(): Promise<unknown>
  openShiftsPage(afterId: number, limit?: number): Promise<unknown>
  auditPage(afterId: number, limit?: number): Promise<{id:number; at:string; action:string; entity:string}[]>
  tryAuditPage?(afterId: number, limit?: number): Promise<{id:number; at:string; action:string; entity:string}[]> | null
  // Optional single-snapshot read of row `id` (if present) and the newest row.
  auditTail?(id: number): Promise<{id:number; at:string; action:string; entity:string}[]>
  tryAuditTail?(id: number): Promise<{id:number; at:string; action:string; entity:string}[]> | null
  // Trusted readers can expose underlying operations that outlive public timeouts.
  waitForIdle?(): Promise<void>
  invoiceFactsPage?(fromDay:string,toDay:string,afterId:number,limit:number): Promise<unknown>
}
type Options = {
  nodeExecutable: string; childFile: string; directory: string; origin?: string; origins?: readonly string[]
  owner: null | { username:string; password:string; pin:string }
  auditKey: Uint8Array; snapshotMaxAgeMs: number
  // Fixed loopback port (1024-65535) for the owner's overlay/tunnel; the child
  // must report exactly this port. Omitted = ephemeral port.
  mobilePort?: number
  // Window for the child to become ready (spawn, hub database, owner bootstrap,
  // listeners). A first run on a slow PC (antivirus scanning the bundled Node)
  // can exceed an ordinary operation timeout, and a failed start cannot confirm
  // cleanup. Defaults to timeoutMs; every later operation keeps timeoutMs.
  startupTimeoutMs?: number
  reader: Reader; state: { load():CloudState | null; save(value:CloudState):void; openRevocationLedger?():Omit<Parameters<typeof startExperimentalRevocationReceiver>[0]['ledger'],'apply'>; openGrantReplayLedger?():GrantReplayStore }
  readRestoreMarker: () => Promise<string | null>
  // Enables the composite database fingerprint (file identity and SQLite
  // header inside every marker read, plus the audit high-water row) checked
  // before every approval, claim and outbound send. It narrows, but does not
  // replace, restore coordination: see databaseFingerprint.ts for its limits.
  databaseFile?: string
  // Receives the verified fingerprint baseline (throttled, and once after a
  // confirmed stop) so the host can detect a replacement while it was closed.
  // Errors are ignored: a missing update only weakens that startup check.
  persistFingerprint?: (value:{epoch:string; counter:number; highWaterId:number; highWaterHash:string})=>void
  // Experimental explicit opt-in only; not sufficient to enable production.
  enableInvoiceFacts?: boolean
  // Optional in-process experiment only. Every restore must use restoreExclusive,
  // and no other component may bypass the gate or start queries on this reader.
  restoreBarrier?: ReturnType<typeof createExperimentalRestoreBarrier>
  // Experimental opt-in for the desktop backup IPC; not a production switch.
  coordinateDesktopBackup?: boolean
  // The caller owns an exclusive durable replay ledger scoped to this store and
  // epoch. This opt-in does not enable the Electron integration.
  revocation?: { key:Uint8Array; ledger?:Omit<Parameters<typeof startExperimentalRevocationReceiver>[0]['ledger'],'apply'>;
    // Synchronous, idempotent host delivery: called before durable ACK. It can
    // repeat after a failure or lost ACK; never use a volatile-only notification
    // as evidence that a user has seen a message.
    onRevocation?:(entry:{id:number;kind:'ALL'|'MEMBER';memberId:string|null})=>undefined
    // Host opt-in after an explicit stopped-hub epoch transition. Only when the
    // desktop ledger has no applied entry may the child move its delivery cursor.
    allowEpochRotation?: true }
  // Trusted desktop callback must enforce the existing local manager-password
  // gate and lockout. Do not expose recovery to the mobile network.
  verifyLocalRecoveryPassword?: (password:string)=>Promise<void>
  // Experimental opt-in, not wired to Electron. When omitted, the replay store
  // must already be explicitly initialized in the exclusive cloud state store.
  approval?: {key:Uint8Array;policies:Readonly<Record<string,{tier:'NORMAL';mode:'PANEL';ttlMs:number}>>;replayStore?:GrantReplayStore}
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
      (options.reader.tryAuditPage !== undefined && typeof options.reader.tryAuditPage !== 'function') ||
      (options.coordinateDesktopBackup !== undefined && typeof options.coordinateDesktopBackup !== 'boolean') ||
      (options.coordinateDesktopBackup === true && (!options.restoreBarrier || !options.revocation || options.revocation.ledger !== undefined || options.approval?.replayStore !== undefined)) ||
      (options.restoreBarrier !== undefined && (!options.restoreBarrier || typeof options.restoreBarrier.run !== 'function' ||
        typeof options.restoreBarrier.restore !== 'function' || typeof options.restoreBarrier.status !== 'function' || typeof options.reader.waitForIdle !== 'function')) ||
      (options.reader.invoiceFactsPage !== undefined && typeof options.reader.invoiceFactsPage !== 'function') ||
      (options.enableInvoiceFacts !== undefined && typeof options.enableInvoiceFacts !== 'boolean') ||
      (options.enableInvoiceFacts === true && typeof options.reader.invoiceFactsPage !== 'function') ||
      (options.verifyLocalRecoveryPassword !== undefined && (typeof options.verifyLocalRecoveryPassword !== 'function' || !options.revocation)) ||
      (options.revocation !== undefined && (!options.revocation || !(options.revocation.key instanceof Uint8Array) ||
        options.revocation.key.byteLength!==32 || Buffer.from(options.revocation.key).equals(Buffer.from(options.auditKey)) ||
        (options.revocation.onRevocation !== undefined && typeof options.revocation.onRevocation !== 'function') ||
        (options.revocation.allowEpochRotation !== undefined && options.revocation.allowEpochRotation !== true) ||
        (options.revocation.ledger === undefined ? typeof options.state?.openRevocationLedger !== 'function' :
          (!options.revocation.ledger || typeof options.revocation.ledger.load!=='function' || typeof options.revocation.ledger.hasNonce!=='function' || typeof options.revocation.ledger.save!=='function')))) ||
      (options.approval !== undefined && (!options.revocation || !options.approval || !(options.approval.key instanceof Uint8Array) ||
        options.approval.key.byteLength!==32 || Buffer.from(options.approval.key).equals(Buffer.from(options.auditKey)) ||
        Buffer.from(options.approval.key).equals(Buffer.from(options.revocation.key)) ||
        (options.approval.replayStore===undefined ? typeof options.state?.openGrantReplayLedger!=='function' :
          !options.approval.replayStore || typeof options.approval.replayStore.consume!=='function') || !options.approval.policies ||
        Object.keys(options.approval.policies).length<1 || Object.keys(options.approval.policies).length>64 ||
        Object.entries(options.approval.policies).some(([panel,p])=>! /^[A-Za-z0-9_.:-]{1,128}$/.test(panel) || panel==='custody' ||
          !p || p.tier!=='NORMAL' || p.mode!=='PANEL' || !Number.isSafeInteger(p.ttlMs) || p.ttlMs<=0 || p.ttlMs>600_000))) ||
      !options.state || typeof options.state.load !== 'function' ||
      typeof options.state.save !== 'function' || typeof options.readRestoreMarker !== 'function' ||
      (options.databaseFile !== undefined && (typeof options.databaseFile !== 'string' || !isAbsolute(options.databaseFile) || !options.revocation)) ||
      (options.persistFingerprint !== undefined && (typeof options.persistFingerprint !== 'function' || options.databaseFile === undefined)) ||
      (options.mobilePort !== undefined && (!Number.isSafeInteger(options.mobilePort) || options.mobilePort < 1024 || options.mobilePort > 65535))) throw new Error('Invalid experimental hub configuration')
  const origins=normalizeMobileOrigins(options.origin,options.origins)
  const originConfig=options.origin !== undefined ? {origin:origins[0]} : {origins}
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new Error('Invalid hub timeout')
  const startupTimeout = options.startupTimeoutMs ?? timeout
  if (!Number.isSafeInteger(startupTimeout) || startupTimeout < 100 || startupTimeout > 120_000) throw new Error('Invalid hub timeout')
  const key = Buffer.from(options.auditKey), reader = options.reader, state = options.state
  // Captured before opening admissions; file size and timestamps are not used
  // because ordinary SQLite writes legitimately change them.
  const fingerprint=options.databaseFile === undefined ? undefined : createDatabaseFingerprint(options.databaseFile)
  const readRestoreMarker=async():Promise<string|null> => {
    try {
      fingerprint?.verify()
      const marker=await options.readRestoreMarker()
      fingerprint?.verify()
      if (revocationConfig && marker!==revocationRestoreMarker) throw new Error('Restore marker changed')
      return marker
    } catch (error) {
      // Once the live identity is uncertain, all admissions must remain closed.
      // This callback is only invoked after the child and failure handler exist.
      if (options.revocation) { storeInvalidated=true;fail();fenceUncertainEpoch();child.kill() }
      throw error
    }
  }
  const barrier=options.restoreBarrier
  // Give foreground DB work priority over the periodic mirror. This avoids
  // turning an ordinary overlap with the mirror's anchor read into a fatal
  // reader-busy error. The barrier still counts waiters before their first await.
  let foregroundCount=0, mirrorWork:Promise<void>|null=null
  let foregroundTail:Promise<void>=Promise.resolve()
  async function foreground<T>(operation:()=>Promise<T>):Promise<T> {
    // The reader is single-flight. Serialize all its foreground users, not just
    // the mirror, and bound the backlog so mobile requests cannot grow it forever.
    if (foregroundCount>=64) throw new Error('Hub foreground queue full')
    const queuedAt=performance.now(), preceding=mirrorWork, previous=foregroundTail
    let release!:()=>void
    foregroundTail=new Promise<void>(resolve=>{release=resolve})
    foregroundCount++
    try {
      await previous
      if (preceding) await preceding
      // Never apply a stale approval after a long queue wait. Restore waiters
      // are already counted by barrier.run before reaching this point.
      if (performance.now()-queuedAt>=timeout || closed || dead || storeInvalidated || (barrier && barrier.status().state!=='OPEN')) throw new Error('Hub child unavailable')
      return await operation()
    } finally { foregroundCount--;release() }
  }
  function guarded<T>(operation:()=>Promise<T>):Promise<T> {
    if (!barrier) return foreground(operation)
    return barrier.run(()=>foreground(async()=>{ try { return await operation() } finally { await reader.waitForIdle!() } }))
  }
  // Reserve before the first asynchronous startup step; an uncertain startup or
  // shutdown deliberately leaves the experimental backup fence closed.
  const backupCoordination=options.coordinateDesktopBackup ? reserveDesktopBackupCoordination() : undefined
  // The lease starts closed and remains closed on any uncertain startup or
  // shutdown. Only one supervisor may own desktop admissions at a time.
  const admission = options.revocation ? acquireRemoteAdmissionLease() : undefined
  let revocationReceiver: Awaited<ReturnType<typeof startExperimentalRevocationReceiver>> | undefined
  let recoveryLedger: Omit<Parameters<typeof startExperimentalRevocationReceiver>[0]['ledger'],'apply'> | undefined
  let revocationConfig: {key:string;storeId:string;epoch:string;port:number;rotate?:true} | undefined
  let revocationRestoreMarker: string | null = null
  let closeReceiver: Promise<void> | undefined
  let appliedRevocationId=0
  let approvalBridge:ReturnType<typeof createExperimentalApprovalBridge> | undefined
  let approvalTimer:ReturnType<typeof setInterval> | undefined
  if (options.revocation) {
    const initial=state.load()
    if (!initial) throw new Error('Revocation state unavailable')
    const storeId=initial.storeId, epoch=initial.epoch, ledger=options.revocation.ledger ?? state.openRevocationLedger!()
    revocationRestoreMarker=initial.restoreMarker
    recoveryLedger=ledger
    appliedRevocationId=ledger.load()?.id ?? 0
    revokeAll()
    function guardedLedger<T>(operation:()=>T):T {
      try { return operation() } catch (error) {
        // Once delivery or durable acknowledgement is uncertain, don't admit a
        // new request or reactivate a grant while the child retries its outbox.
        // Recovery requires a clean stop and fresh startup; an ACK alone cannot
        // prove there are no later queued revocations.
        admission?.block()
        try { revokeAll() } catch {}
        throw error
      }
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
        // Event loop serialization prevents a grant from interleaving between
        // the registry revocation and advancing the in-memory fence.
        appliedRevocationId=entry.id
      })
    }})
    // A fresh desktop ledger expects delivery to restart at zero in this epoch.
    const rotate=options.revocation.allowEpochRotation===true && ledger.load()===null
    revocationConfig={key:Buffer.from(options.revocation.key).toString('hex'),storeId,epoch,port:revocationReceiver.port,...(rotate ? {rotate:true as const} : {})}
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
  let dead = false, closed = false, busy = false, storeInvalidated = false, nextId = 0, snapshotCaptureId = 0
  let revocationCleanupFailed = false
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
    if (approvalTimer) { clearInterval(approvalTimer); approvalTimer=undefined }
    admission?.block()
    if (options.revocation) {
      try { revokeAll() } catch { revocationCleanupFailed = true }
      void releaseReceiver().catch(() => {})
    }
    dead = true
    startupReject?.(new Error('Hub child unavailable'));startupReject=undefined;startupResolve=undefined
    for (const item of waiting.values()) { clearTimeout(item.timer);item.reject(new Error('Hub child unavailable')) }
    waiting.clear()
  }
  child.on('error',fail);child.on('exit',fail);child.on('disconnect',fail)
  // The child releases its own `remote-hub.lock` on a confirmed stop or IPC
  // disconnect, but not when killed (SIGTERM/TerminateProcess) on a fail-closed
  // path; the next start would then stay blocked. Only after this exact child
  // has exited, remove the lock it reported, and only while the file still
  // holds its token. Any doubt leaves the lock in place (fail closed).
  // Registered before any other exit listener: stop() settles after this ran.
  let childLockToken:string|undefined
  child.once('exit',()=>{
    if (!childLockToken) return
    try {
      const lockPath=join(realpathSync(options.directory),'remote-hub.lock'), stat=lstatSync(lockPath)
      if (stat.isFile() && stat.nlink===1 && readFileSync(lockPath,'utf8')===childLockToken) unlinkSync(lockPath)
    } catch {}
  })
  // Kill if still running and wait up to `timeout` for the exit event. Never
  // rejects: callers report their own failure either way.
  function waitForChildExit():Promise<void> {
    if (child.exitCode!==null || child.signalCode!==null) return Promise.resolve()
    return new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);child.off('exit',done);resolve()}
      const timer=setTimeout(done,timeout)
      child.once('exit',done)
      try { child.kill() } catch {}
    })
  }
  function fenceUncertainEpoch():void {
    // fail() must close admission and revoke first. A new epoch cannot be
    // resumed with the old ledgers in this process; only an explicit stopped-hub
    // transition on a later startup may replace them and resend audit history.
    // If a coordinated restore is already draining, it owns epoch rotation.
    if (!revocationConfig || (barrier && barrier.status().state!=='OPEN')) return
    try {
      const current=state.load()
      if (!current || current.storeId!==revocationConfig.storeId || current.epoch!==revocationConfig.epoch) return
      state.save({...current,epoch:randomUUID(),lastAcked:0,anchorHash:''})
    } catch {
      // The admission/backup leases remain closed if persisting is uncertain.
      // Do not manufacture replacement ledger state or claim recovery.
    }
  }
  // Audit high-water: the newest AuditLog row observed by this supervisor. It
  // must stay present and unchanged; later rows only advance it. Retention
  // cleanup deletes only rows older than its window (a stale row fails closed).
  let auditHighWater:{id:number;hash:string}|null=null
  const auditHash=auditRowHash
  let persistedBaseline='', persistedAt=-Infinity
  function persistBaseline(force:boolean):void {
    if (!options.persistFingerprint || !fingerprint || !revocationConfig || storeInvalidated) return
    const counter=fingerprint.committedCounter()
    if (counter===null) return
    const value={epoch:revocationConfig.epoch,counter,highWaterId:auditHighWater?.id ?? 0,highWaterHash:auditHighWater?.hash ?? ''}
    const key=JSON.stringify(value), now=performance.now()
    if (key===persistedBaseline || (!force && now-persistedAt<10_000)) return
    try { options.persistFingerprint(value);persistedBaseline=key;persistedAt=now } catch {}
  }
  const auditItem=(value:unknown):value is {id:number;at:string;action:string;entity:string} => object(value) &&
    Number.isSafeInteger(value.id) && value.id>0 && typeof value.at==='string' && typeof value.action==='string' && typeof value.entity==='string'
  // A timed-out read can still be running. Revoke immediately rather than
  // waiting for it in finally, while keeping the barrier held until the
  // underlying query really settles so restore cannot race it.
  async function auditRead(start:()=>Promise<unknown>|null, limit:number):Promise<unknown[]|null> {
    const query=start()
    if (query===null) return null
    let rows:unknown
    try { rows=await query }
    catch (error) {
      storeInvalidated=true
      fail();fenceUncertainEpoch();child.kill()
      throw error
    } finally { if (reader.waitForIdle) await reader.waitForIdle() }
    if (!Array.isArray(rows) || rows.length>limit) throw new Error('Invalid audit page')
    return rows
  }
  // Verifies the previous high-water row and advances to the newest observed
  // row within ONE read snapshot. Throws on change; false only if declined.
  async function auditHighWaterCurrent(skipBusy:boolean, lastAcked:number):Promise<boolean> {
    const previous=auditHighWater
    let rows:unknown[]|null
    if (reader.auditTail) {
      const id=previous?.id ?? 0
      rows=await auditRead(()=>skipBusy && reader.tryAuditTail ? reader.tryAuditTail(id) : reader.auditTail!(id),2)
    } else {
      // Readers without auditTail: a page that starts at the previous row (or
      // the acknowledged anchor) still verifies and advances in one query.
      const from=previous?.id ?? lastAcked
      rows=await auditRead(()=>skipBusy && reader.tryAuditPage ? reader.tryAuditPage(Math.max(0,from-1),200) : reader.auditPage(Math.max(0,from-1),200),200)
    }
    if (rows===null) return false
    if (previous) {
      const first=rows[0]
      if (!auditItem(first) || first.id!==previous.id || auditHash(first)!==previous.hash) throw new Error('Audit high-water row changed')
    }
    if (rows.length) {
      const last=rows[rows.length-1]
      if (!auditItem(last) || (previous && last.id<previous.id) || rows.some((row,i)=>!auditItem(row) || (i>0 && row.id<=(rows![i-1] as {id:number}).id)))
        throw new Error('Invalid audit page')
      auditHighWater={id:last.id,hash:auditHash(last)}
    }
    return true
  }
  // Composite database fingerprint, checked before every approval, claim and
  // outbound send: cloud state and epoch, restore marker plus file identity and
  // SQLite header (inside readRestoreMarker), the last acknowledged audit anchor
  // and the audit high-water row. Throws on any change or uncertain read and
  // returns false only when a skip-busy read was declined. It complements, but
  // does not replace, exclusive restore coordination.
  async function databaseIdentityCurrent(checkAuditAnchor:boolean, skipBusy:boolean, checkAnchorRow=true):Promise<boolean> {
    if (!revocationConfig) throw new Error('Database identity unavailable')
    const before=state.load()
    if (!before || before.storeId!==revocationConfig.storeId || before.epoch!==revocationConfig.epoch ||
        before.restoreMarker!==revocationRestoreMarker) throw new Error('Restore detected')
    let markerTimer:ReturnType<typeof setTimeout> | undefined
    let marker:string | null
    try {
      marker=await Promise.race([readRestoreMarker(),new Promise<never>((_,reject)=>{
        markerTimer=setTimeout(()=>reject(new Error('Restore marker timed out')),timeout)
      })])
    } finally { if (markerTimer) clearTimeout(markerTimer) }
    if (marker!==revocationRestoreMarker) throw new Error('Restore detected')
    if (checkAuditAnchor && checkAnchorRow && before.lastAcked>0) {
      // A replacement can preserve inode and the restore marker. Verify the
      // last acknowledged audit row before issuing/claiming any new grant.
      // This detects changed history, not an identical rollback or a change
      // outside that row; the external-writer limitation still applies.
      // A periodic mirror may defer when another trusted read owns the
      // reader. This is not permission to publish an unchecked mirror.
      const rows=await auditRead(()=>skipBusy && reader.tryAuditPage ? reader.tryAuditPage(before.lastAcked-1,1) : reader.auditPage(before.lastAcked-1,1),1)
      if (rows===null) return false
      const item=rows.length===1 ? rows[0] : null
      if (!auditItem(item) || item.id!==before.lastAcked || auditHash(item)!==before.anchorHash) throw new Error('Audit anchor changed')
    }
    if (checkAuditAnchor && fingerprint && !await auditHighWaterCurrent(skipBusy,before.lastAcked)) return false
    if (checkAuditAnchor && (before.lastAcked>0 || fingerprint) && await readRestoreMarker()!==revocationRestoreMarker) throw new Error('Restore detected')
    const after=state.load()
    if (!after || after.storeId!==before.storeId || after.epoch!==before.epoch || after.restoreMarker!==before.restoreMarker ||
        (checkAuditAnchor && (after.lastAcked!==before.lastAcked || after.anchorHash!==before.anchorHash))) throw new Error('Restore detected')
    if (checkAuditAnchor && fingerprint) persistBaseline(false)
    return true
  }
  // For callers outside approvalStateCurrent: any mismatch or uncertain read
  // fails closed and fences the epoch before the error propagates.
  async function verifiedDatabaseIdentity(checkAnchorRow=true):Promise<boolean> {
    try { return await databaseIdentityCurrent(true,false,checkAnchorRow) }
    catch (error) { storeInvalidated=true;fail();fenceUncertainEpoch();child.kill();throw error }
  }
  // Never approve after an uncertain read: revoke the desktop sessions and
  // terminate the child.
  async function approvalStateCurrent(checkAuditAnchor=false, skipBusy=false): Promise<boolean> {
    try {
      if (closed || dead || storeInvalidated || !revocationConfig) return false
      if (!await databaseIdentityCurrent(checkAuditAnchor,skipBusy)) return false
      return !closed && !dead && !storeInvalidated && !!admission?.isOpen() && (!barrier || barrier.status().state==='OPEN')
    } catch {
      storeInvalidated=true
      fail();fenceUncertainEpoch();child.kill()
      return false
    }
  }
  // Count approval checks as barrier work too: restore must not replace the DB
  // while an earlier marker/file-identity read is still in progress. Do not use
  // guarded(), which also drains the shared SQL reader and can serialize an
  // unrelated snapshot query against approval.
  async function runApprovalGuard(operation:()=>Promise<void>, background=false):Promise<void> {
    const run=background ? operation : ()=>foreground(operation)
    if (barrier) await barrier.run(run)
    else await run()
  }
  child.on('message',(message: unknown) => {
    if (!object(message)) return
    if (message.type==='approvalCommand' && approvalBridge) {
      void track(runApprovalGuard(async()=>{
        const current=await approvalStateCurrent(true)
        // isClosed is checked again synchronously by the bridge before grant.
        if (current) approvalBridge?.onMessage(message)
        else { try { send({type:'approvalResult',id:message.id,ok:false}) } catch {} }
      }).catch(()=>{try {send({type:'approvalResult',id:message.id,ok:false})} catch {}}))
      return
    }
    if (message.type === 'ready' && startupResolve && message.pid === child.pid &&
        Number.isSafeInteger(message.mobilePort) && message.mobilePort >= 1 && message.mobilePort <= 65535 &&
        (options.mobilePort === undefined || message.mobilePort === options.mobilePort) &&
        Number.isSafeInteger(message.auditPort) && message.auditPort >= 1 && message.auditPort <= 65535 && message.mobilePort !== message.auditPort &&
        (message.lockToken === undefined || (typeof message.lockToken === 'string' && /^[0-9a-f]{64}$/.test(message.lockToken)))) {
      if (typeof message.lockToken === 'string') childLockToken=message.lockToken
      startupResolve({mobilePort:message.mobilePort,auditPort:message.auditPort});startupResolve=undefined;startupReject=undefined
    } else if (message.type === 'error' && message.operation === 'start') fail()
    else if (message.type === 'revocationDeliveryFailed' && options.revocation && Object.keys(message).join(',') === 'type') {
      // The child may fail before a packet reaches our authenticated receiver;
      // close admissions as soon as it reports any delivery uncertainty. This
      // latch is not reopened by a later ACK; shutdown and startup must succeed.
      admission?.block()
      // Failed grant cleanup remains marked revoking in the registry; outbox
      // retry and stop() both retry it. stop() independently reports failure if
      // cleanup is still unsuccessful at shutdown.
      try { revokeAll() } catch {}
    }
    else if (message.type === 'invoiceRead' && invoiceReader) {
      const id=message.id, from=message.fromDay, to=message.toDay, afterId=message.afterId
      if (!Number.isSafeInteger(id) || id <= invoiceLastId || id <= 0) return
      invoiceLastId=id
      const failRead=() => { try { if (!closed && !dead) send({type:'invoiceReadResult',id,ok:false}) } catch {} }
      const now=performance.now()
      if (closed || dead || storeInvalidated || invoiceBusy || now < invoiceLastRead || now-invoiceLastRead < 10_000 ||
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
          if (revocationConfig && fingerprint && !await verifiedDatabaseIdentity()) throw new Error('Database identity unavailable')
          const value=parseInvoicePage(await invoiceReader(from,to,afterId,50),from,to,afterId)
          const current=state.load()
          if (!current || current.storeId !== initial.storeId || current.epoch !== initial.epoch ||
              current.restoreMarker !== initial.restoreMarker || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          if (barrier && barrier.status().state !== 'OPEN') throw new Error('Restore in progress')
          // Data read above is sent only if the composite fingerprint still matches.
          if (revocationConfig && fingerprint && !await verifiedDatabaseIdentity()) throw new Error('Database identity unavailable')
          if (!closed && !dead && !storeInvalidated) send({type:'invoiceReadResult',id,ok:true,value})
          else failRead()
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
  const startTimer=setTimeout(() => { fail();child.kill() },startupTimeout)
  try {
    const approval=options.approval ? {key:Buffer.from(options.approval.key),policies:Object.fromEntries(Object.entries(options.approval.policies).map(([name,p])=>[name,{...p}]))} : undefined
    if (approval && revocationConfig && options.approval) approvalBridge=createExperimentalApprovalBridge({
      key:approval.key,storeId:revocationConfig.storeId,epoch:revocationConfig.epoch,policies:approval.policies,
      replayStore:options.approval.replayStore ?? state.openGrantReplayLedger!(),appliedRevocation:()=>appliedRevocationId,
      isClosed:()=>closed || dead || storeInvalidated || !admission?.isOpen() || (barrier !== undefined && barrier.status().state !== 'OPEN'),send,
      onReplayFailure:()=>{admission?.block();try {revokeAll()} catch {}}
    })
    send({type:'start',config:{directory:options.directory,...originConfig,owner:options.owner,...(options.mobilePort !== undefined ? {mobilePort:options.mobilePort} : {}),
      auditKey:key.toString('hex'),snapshotMaxAgeMs:options.snapshotMaxAgeMs,...(invoiceReader ? {invoiceFacts:true} : {}),
      ...(revocationConfig ? {revocation:revocationConfig} : {}),
      ...(approval && revocationConfig ? {approval:{key:approval.key.toString('hex'),storeId:revocationConfig.storeId,panels:Object.keys(approval.policies).sort(),policies:approval.policies}} : {})}})
    const ports=await startup
    clearTimeout(startTimer)
    const transport=createLoopbackAuditTransport(`http://127.0.0.1:${ports.auditPort}/internal/v1/audit`,key,timeout)
    // The sync cycle verifies the marker and its anchor itself; the remaining
    // composite fingerprint (audit high-water row, file header) is checked
    // again immediately before the batch is sent.
    const sync=createAuditSync({state,reader,transport,readRestoreMarker,
      ...(revocationConfig && fingerprint ? {beforeSend:async()=>{ if (!await verifiedDatabaseIdentity(false)) throw new Error('Database identity unavailable') }} : {})})
    const update = (message: Record<string,unknown>) => new Promise<boolean>((resolve,reject) => {
      if (dead || closed || nextId >= Number.MAX_SAFE_INTEGER) { reject(new Error('Hub child unavailable'));return }
      const id=++nextId
      const timer=setTimeout(() => { waiting.delete(id);reject(new Error('Hub snapshot timed out'));child.kill() },timeout)
      waiting.set(id,{resolve,reject,timer})
      try { send({...message,id}) } catch (error) { clearTimeout(timer);waiting.delete(id);reject(error) }
    })
    if (revocationConfig) {
      // The child has drained its initial outbox, but the desktop database may
      // have changed during startup. Keep admission closed until the same
      // store/epoch/marker and optional file identity are verified again.
      const verifyStartup=async()=>{
        const before=state.load()
        if (!before || before.storeId!==revocationConfig!.storeId || before.epoch!==revocationConfig!.epoch ||
            before.restoreMarker!==revocationRestoreMarker || await readRestoreMarker()!==revocationRestoreMarker) throw new Error('Restore detected during startup')
        // Baseline for the composite fingerprint before any admission opens.
        if (fingerprint && !await verifiedDatabaseIdentity()) throw new Error('Restore detected during startup')
        const after=state.load()
        if (!after || after.storeId!==before.storeId || after.epoch!==before.epoch || after.restoreMarker!==before.restoreMarker ||
            (barrier && barrier.status().state!=='OPEN')) throw new Error('Restore detected during startup')
      }
      let timer:ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([runApprovalGuard(verifyStartup),new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Startup restore check timed out')),timeout)
        })])
      } finally { if (timer) clearTimeout(timer) }
    }
    // The barrier may start closing after verification yielded, before this
    // continuation runs. Never open admissions into a draining restore.
    if (dead || storeInvalidated || (barrier && barrier.status().state !== 'OPEN')) throw new Error('Hub child unavailable')
    if (approvalBridge && admission) admission.installClaimGuard(async claim=>{
      let result=false
      try {
        await track(runApprovalGuard(async()=>{
          if (await approvalStateCurrent(true)) result=claim()
        }))
      } catch { return false }
      return result
    })
    admission?.open()
    if (approvalBridge) {
      let ticking=false
      const tickApproval=()=>{
        if (ticking) return
        if (foregroundCount) {
          try { approvalBridge?.clearMirror() } catch { fail();child.kill() }
          return
        }
        ticking=true
        const task=runApprovalGuard(async()=>{
          // A request mirror is also outbound data: validate the last durable
          // audit anchor before sending it, not only on approval and claim.
          const current=await approvalStateCurrent(true,true)
          if (current && !foregroundCount) approvalBridge?.tick()
          else if (!closed && !dead && !storeInvalidated && admission?.isOpen() && (!barrier || barrier.status().state==='OPEN'))
            approvalBridge?.clearMirror()
        },true).catch(()=>{
          // A closing restore is expected to reject new work. Any other error
          // leaves the admission latch closed and the child unavailable.
          if (!barrier || barrier.status().state==='OPEN') {fail();child.kill()}
        }).finally(()=>{ticking=false;if (mirrorWork===task) mirrorWork=null})
        mirrorWork=task
        void track(task)
      }
      approvalTimer=setInterval(tickApproval,500)
      approvalTimer.unref?.()
      tickApproval()
    }
    const supervisor = {
      mobilePort:ports.mobilePort,
      refreshOnce(): Promise<void> {
        if (closed || dead || storeInvalidated) return Promise.reject(new Error('Hub child unavailable'))
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
          if (snapshotCaptureId>=Number.MAX_SAFE_INTEGER) throw new Error('Snapshot capture exhausted')
          const captureId=++snapshotCaptureId
          // The child starts a conservative freshness clock before any source
          // read; no wall-clock comparison between processes is needed.
          if (!await update({type:'beginSnapshot',captureId})) throw new Error('Hub rejected capture')
          const boundary=await reader.latestBoundaryTotals()
          const shifts=await reader.openShiftsPage(0,200)
          const current=state.load()
          if (!current || current.storeId !== initial.storeId || current.epoch !== initial.epoch ||
              current.restoreMarker !== initial.restoreMarker || await readRestoreMarker() !== initial.restoreMarker) throw new Error('Restore detected')
          if (barrier && barrier.status().state !== 'OPEN') throw new Error('Restore in progress')
          // Snapshot data must not be published on a database whose last
          // acknowledged audit anchor has changed. This is a limited fence,
          // not a substitute for a complete database identity or writer lock.
          if (revocationConfig && !await approvalStateCurrent(true)) throw new Error('Snapshot identity unavailable')
          if (!await update({type:'snapshot',captureId,value:{boundary,shifts}})) throw new Error('Hub rejected snapshot')
        } catch (error) {
          // With remote grants enabled, an uncertain refresh must revoke before
          // guarded() waits for a timed-out query to finish. Killing the child
          // also removes the previous snapshot. A draining restore has already
          // closed admissions and remains responsible for its epoch fence.
          if (options.revocation && !closed && (!barrier || barrier.status().state==='OPEN')) {
            storeInvalidated=true;fail();fenceUncertainEpoch();child.kill()
          } else if (!closed && !dead) {
            // Non-revocation callers retain the existing snapshot-only behavior.
            try { await update({type:'invalidateSnapshot'}) } catch { child.kill() }
          }
          throw error
        } }).finally(() => {busy=false}))
      },
      syncOnce() {
        if (closed || dead) return Promise.reject(new Error('Hub child unavailable'))
        if (storeInvalidated) return Promise.reject(new Error(barrier?.status().state !== 'OPEN' ? 'Restore barrier closed' : 'Hub child unavailable'))
        return track(guarded(() => sync.runOnce().catch(error=>{
          // Close admissions before guarded() waits for the real SQL query to
          // drain. A timeout is not cancellation and must not leave a grant
          // active throughout an arbitrarily long wait. The barrier remains
          // held until waitForIdle completes, preventing restore from racing it.
          if (options.revocation && !closed && (!barrier || barrier.status().state==='OPEN')) {
            storeInvalidated=true;fail();fenceUncertainEpoch();child.kill()
          }
          throw error
        })))
      },
      // Local trusted caller only. This is not registered as a mobile endpoint
      // or Electron IPC; integration must enforce a trusted local window.
      recoverPanic(password:string, ownerPin:string):Promise<boolean> {
        if (closed || dead || storeInvalidated || recoveryBusy || !options.verifyLocalRecoveryPassword || !revocationConfig ||
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
            // A mismatch here fails closed (revoke, fence) inside the check.
            if (fingerprint && !await verifiedDatabaseIdentity()) return false
            const cursor=recoveryLedger?.load()
            if (!cursor || !Number.isSafeInteger(cursor.id) || cursor.id<1) return false
            return await update({type:'recoverPanic',pin:ownerPin,lastAck:cursor.id})
          } catch { return false }
        }).finally(()=>{recoveryBusy=false}))
      },
      restoreExclusive(operation:()=>Promise<void>):Promise<void> {
        if (closed || dead || storeInvalidated || !barrier || typeof operation !== 'function') return Promise.reject(new Error('Restore coordination unavailable'))
        const invalidate=async()=>{ if (!await update({type:'invalidateSnapshot'})) throw new Error('Hub rejected invalidation') }
        const closeAdmissions=async()=>{
          // Synchronously close and revoke before the first await. Keep this
          // lease latched even after success: a new epoch and controlled restart
          // are still required before any subsequent remote admission.
          storeInvalidated=true
          admission?.block()
          if (options.revocation) {
            try { revokeAll() } catch (error) { revocationCleanupFailed=true;throw error }
          }
          await invalidate()
        }
        // Persist an epoch fence before mutation, after all guarded work drains.
        // Existing revocation/replay ledgers remain bound to the old epoch: this
        // supervisor never reopens, and a later startup must run the explicit
        // stopped-hub epoch transition before audit history is resent.
        // This covers only callers using this barrier, not external writers.
        return track(barrier.restore(async()=>{
          await invalidate()
          if (revocationConfig) {
            const before=state.load()
            if (!before || before.storeId!==revocationConfig.storeId || before.epoch!==revocationConfig.epoch) throw new Error('Restore epoch unavailable')
            const next={...before,epoch:randomUUID(),lastAcked:0,anchorHash:''}
            state.save(next)
            const saved=state.load()
            if (!saved || saved.storeId!==next.storeId || saved.epoch!==next.epoch || saved.lastAcked!==0 || saved.anchorHash!=='' || saved.restoreMarker!==next.restoreMarker) throw new Error('Restore epoch unavailable')
          }
          await operation()
        },closeAdmissions))
      },
      stop(): Promise<void> {
        if (stopPromise) return stopPromise
        closed=true
        if (approvalTimer) {clearInterval(approvalTimer);approvalTimer=undefined}
        admission?.block()
        // Close admissions and revoke existing grants and requests before
        // waiting for child shutdown; cleanup failure must not report success.
        if (options.revocation) {
          try { revokeAll() } catch { revocationCleanupFailed = true }
        }
        // After a disconnect or kill the process may still be exiting. Settle a
        // failed stop only after it has really exited (bounded wait): Windows
        // keeps its hub database and other files locked until then.
        if (dead) {
          stopPromise=waitForChildExit().then(()=>{ throw new Error('Hub child unavailable; cleanup not confirmed') })
          return stopPromise
        }
        stopPromise = new Promise<void>((resolve,reject) => {
          let acknowledged = false
          const onMessage = (message: unknown) => { if (object(message) && message.type === 'stopped') acknowledged=true }
          const cleanup = () => { clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit) }
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            if (acknowledged && code === 0 && signal === null) resolve()
            else reject(new Error('Hub stopped without confirmed cleanup'))
          }
          const timer=setTimeout(() => {cleanup();void waitForChildExit().then(()=>reject(new Error('Hub stop timed out')))},timeout)
          child.on('message',onMessage);child.once('exit',onExit)
          try { send({type:'stop'}) } catch (error) { cleanup();void waitForChildExit().then(()=>reject(error)) }
        }).then(async () => {
          persistBaseline(true)
          await releaseReceiver()
          // A killed/closed child does not cancel already-running parent reads or
          // sync writes. Do not claim a clean stop while they can still mutate
          // sync state. A timeout is failure, not cancellation of those tasks.
          const tasks=[...activeTasks]
          // The concrete cloud reader can retain a SQL operation after its
          // caller timed out. Custom readers without this contract remain the
          // host's responsibility; no cancellation or restore lock is implied.
          if (!tasks.length && !reader.waitForIdle) {
            if (revocationCleanupFailed) throw new Error('Remote panel cleanup not confirmed')
            backupCoordination?.release()
            admission?.release()
            return
          }
          const drained=Promise.allSettled(tasks).then(async () => { if (reader.waitForIdle) await reader.waitForIdle() })
          let timer:ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              drained,
              new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('Hub parent work did not settle')),timeout) })
            ])
          } finally { if (timer) clearTimeout(timer) }
          if (revocationCleanupFailed) throw new Error('Remote panel cleanup not confirmed')
          backupCoordination?.release()
          admission?.release()
        })
        return stopPromise
      }
    }
    backupCoordination?.install(operation=>supervisor.restoreExclusive(operation))
    return supervisor
  } catch (error) {
    // Startup can fail even after admission was opened (for example while
    // installing backup coordination). Close it synchronously, not when the
    // child eventually emits exit or disconnect.
    clearTimeout(startTimer);fail();child.kill();await releaseReceiver().catch(() => {});throw error
  }
}
