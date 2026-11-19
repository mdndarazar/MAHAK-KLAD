/**
 * Desktop host for the local remote hub. The readiness gate is open, but the hub
 * starts only when the owner opt-in (userData/remote-settings.json, default off)
 * is on and owner setup (remoteSetup) has created every required file. Missing
 * configuration or keys never causes automatic initialization.
 */
import { hkdfSync } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { prisma } from '../db/client'
import { registerRemoteAuthHandlers } from '../ipc/remoteAuth'
import { REMOTE_PANELS } from '../../shared/enums'
import { remoteImplementationReady } from '../../shared/remoteAuthChannels'
import { remoteSettingEnabled } from './cloud/remoteSettings'
import { createCloudReader } from './cloud/cloudReader'
import { openCloudStateStore } from './cloud/cloudState'
import { databaseChangedSince, readFingerprintBaseline, writeFingerprintBaseline } from './cloud/databaseFingerprint'
import { createRemoteTransportVault } from './cloud/remoteTransportVault'
import { createExperimentalRestoreBarrier } from './cloud/experimentalRestoreBarrier'
import { startExperimentalHubSupervisor } from './cloud/experimentalHubSupervisor'
import { createExperimentalHubScheduler } from './cloud/experimentalHubScheduler'
import { readRemoteConfig, restoreMarkerHash, type RemoteOwner } from './cloud/remoteSetup'
import { initRemoteGrantRegistry } from './RemoteGrantRegistry'
import * as sessions from './panelSession'

// Only these non-operation panel scopes are connected in this host (one shared
// list with the request IPC and the lock-screen button). Financial one-shot
// operations require a separate reviewed policy and remain off.
const PANELS = REMOTE_PANELS
const POLICIES = Object.fromEntries(PANELS.map(panel => [panel,{tier:'NORMAL' as const,mode:'PANEL' as const,ttlMs:600_000}]))
type Store = ReturnType<typeof openCloudStateStore>
type Hub = Awaited<ReturnType<typeof startExperimentalHubSupervisor>>
type Scheduler = ReturnType<typeof createExperimentalHubScheduler>
let starting:Promise<void>|null=null, stopping:Promise<void>|null=null
let hub:Hub|null=null, scheduler:Scheduler|null=null, state:Store|null=null
let quitHookInstalled=false, quitAfterStop=false, stopRequested=false, handlersRegistered=false, failed=false, shutdownFailed=false
// Last startup failure message for the owner's setup page (fixed strings and
// local file errors only; never credentials). Cleared by a successful start.
let lastStartError:string|null=null

function existingDirectory(path:string):void {
  const stat=lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Remote directory unavailable')
}
function existingFile(path:string):void {
  const stat=lstatSync(path)
  if (!stat.isFile() || stat.nlink!==1) throw new Error('Remote file unavailable')
}
/** The hub database exists after the first successful owner bootstrap start. */
function hubDatabaseExists(path:string):boolean {
  try { existingFile(path);return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return false
    throw error
  }
}
const restoreMarker=restoreMarkerHash
/** Diagnostics only (the child's own lock and listener stay authoritative):
 * a lock left by a crashed hub, or another program on the fixed port, gets a
 * clear message for the owner instead of a generic child failure. */
function absent(path:string):boolean {
  try { lstatSync(path);return false } catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return true;throw error }
}
async function portAvailable(port:number):Promise<void> {
  const net=await import('node:net')
  await new Promise<void>((resolve,reject)=>{
    const probe=net.createServer()
    probe.once('error',error=>reject((error as NodeJS.ErrnoException).code==='EADDRINUSE' ? new Error('Remote port in use') : error))
    probe.listen(port,'127.0.0.1',()=>probe.close(()=>resolve()))
  })
}
function derivedKey(key:Uint8Array, storeId:string, epoch:string, purpose:string):Buffer {
  return Buffer.from(hkdfSync('sha256',key,Buffer.from(`${storeId}:${epoch}`),Buffer.from(`mahak-remote-${purpose}-v1`),32))
}

/** Start only after owner provisioning (remoteSetup) has created every required
 * file. Owner credentials are accepted only for the very first start, when the
 * hub database does not exist yet; the child bootstraps exactly one owner from
 * them and they are not stored by the desktop host. */
async function startConfigured(owner:RemoteOwner|null):Promise<void> {
  const userData=app.getPath('userData'), root=join(userData,'remote-hub'), stateDir=join(root,'state'), hubDir=join(root,'hub')
  const dbFile=join(userData,'data','shop.db'), runtimeDir=join(process.resourcesPath,'remote')
  if (process.env.DATABASE_URL!==`file:${dbFile}`) throw new Error('Remote database identity unavailable')
  const nodeExecutable=join(runtimeDir,'node.exe'),childFile=join(runtimeDir,'remote-hub-child.cjs')
  for (const path of [root,stateDir,hubDir,runtimeDir]) existingDirectory(path)
  for (const path of [dbFile,nodeExecutable,childFile,join(stateDir,'cloud-state.json')]) existingFile(path)
  const hubExists=hubDatabaseExists(join(hubDir,'remote-hub.sqlite'))
  if (!hubExists && !owner) throw new Error('Remote owner setup required')
  const {origin,port}=readRemoteConfig(join(root,'config.json'))
  if (!absent(join(hubDir,'remote-hub.lock'))) throw new Error('Remote hub lock present')
  if (port!==null) await portAvailable(port)
  // Before any listener: opening the state with the current restore marker
  // adopts a changed marker as a new epoch and replaces earlier-epoch ledgers
  // through the explicit stopped-hub transition. Missing or corrupt state and
  // ledgers still fail closed and are not recreated.
  const markerPath=join(userData,'backups','last-restore.txt')
  // A fingerprint persisted for the current epoch by the previous run that no
  // longer matches means the database was replaced while the hub was stopped
  // (even with an unchanged marker): the store then starts a new epoch exactly
  // as for a changed marker. Read before the state lock, re-checked under it.
  const fingerprintFile=join(stateDir,'database-fingerprint.json'), reader=createCloudReader(prisma)
  const baseline=readFingerprintBaseline(fingerprintFile)
  const changedEpoch=baseline && await databaseChangedSince(dbFile,baseline,id=>reader.auditTail(id)) ? baseline.epoch : null
  const localState=openCloudStateStore(stateDir,{restoreMarker:restoreMarker(markerPath),changedEpoch})
  let localHub:Hub|null=null, localScheduler:Scheduler|null=null, hubStartAttempted=false
  try {
    if (JSON.stringify(readFingerprintBaseline(fingerprintFile))!==JSON.stringify(baseline)) throw new Error('Remote fingerprint changed during startup')
    const snapshot=localState.load()
    if (!snapshot) throw new Error('Remote state unavailable')
    // Loading both ledgers must succeed before starting any network listener.
    localState.openRevocationLedger();localState.openGrantReplayLedger()
    const electron=await import('electron')
    const keys=createRemoteTransportVault(root,snapshot.storeId,electron.safeStorage).load()
    const revocationKey=derivedKey(keys.commandKey,snapshot.storeId,snapshot.epoch,'revocation')
    const approvalKey=derivedKey(keys.commandKey,snapshot.storeId,snapshot.epoch,'approval')
    initRemoteGrantRegistry({notePanelUnlocked:(panel,_scope,owner,allowed)=>sessions.noteRemotePanelUnlocked(panel,owner,allowed),clearPanelScope:sessions.clearPanelScope,clearPanelSessions:sessions.clearPanelSessions})
    const barrier=createExperimentalRestoreBarrier()
    hubStartAttempted=true
    // The supervisor keeps its options for the hub's lifetime, but the owner's
    // phone credentials are needed only by the first start message: drop them
    // (success or failure) so they do not stay in Main memory.
    const hubOptions:Parameters<typeof startExperimentalHubSupervisor>[0]={nodeExecutable,childFile,directory:hubDir,origin,owner:hubExists ? null : owner,auditKey:keys.auditKey,
      ...(port!==null ? {mobilePort:port} : {}),
      snapshotMaxAgeMs:60_000,reader,state:localState,databaseFile:dbFile,restoreBarrier:barrier,coordinateDesktopBackup:true,
      // First start after install can be slow (antivirus scanning node.exe);
      // a timed-out start keeps the state lock until the application restarts.
      startupTimeoutMs:30_000,
      persistFingerprint:value=>writeFingerprintBaseline(fingerprintFile,{version:1,storeId:snapshot.storeId,...value}),
      readRestoreMarker:async()=>restoreMarker(markerPath),
      verifyLocalRecoveryPassword:async password=>{
        const auth=await import('./AuthService')
        await auth.assertManagerPassword(password,'بازیابی توقف اضطراری کنترل از راه دور')
      },
      revocation:{key:revocationKey,allowEpochRotation:true,onRevocation:entry=>{
        if (entry.kind==='ALL') {
          if (!electron.Notification.isSupported()) throw new Error('Desktop notification unavailable')
          new electron.Notification({title:'کنترل از راه دور',body:'دسترسی‌های راه دور بسته شدند.'}).show()
        }
        return undefined
      }},
      approval:{key:approvalKey,policies:POLICIES}}
    try { localHub=await startExperimentalHubSupervisor(hubOptions) } finally { hubOptions.owner=null }
    if (stopRequested) throw new Error('Remote startup cancelled')
    if (!handlersRegistered) {
      registerRemoteAuthHandlers(async(password,pin)=>hub ? hub.recoverPanic(password,pin) : false,PANELS)
      handlersRegistered=true
    }
    localScheduler=createExperimentalHubScheduler(localHub)
    localScheduler.start()
    state=localState;hub=localHub;scheduler=localScheduler
  } catch (error) {
    if (localScheduler) await localScheduler.stop().catch(()=>{})
    let cleanupConfirmed=!hubStartAttempted
    if (localHub) { try {await localHub.stop();cleanupConfirmed=true} catch {} }
    if (cleanupConfirmed) { try {localState.close()} catch {failed=true} }
    else {failed=true;state=localState} // retain the lock on uncertain shutdown
    throw error
  }
}

export function startCloudSync(options?:{owner?:RemoteOwner}):Promise<void> {
  // Default-off must not read userData, open a DB, start timers or IPC.
  if (!remoteImplementationReady()) return Promise.resolve()
  if (hub || starting || stopping || failed) return starting ?? Promise.resolve()
  // The owner opt-in (default off). Anything unreadable means off: then no
  // file other than the setting is read, and no port, connection or timer exists.
  let enabled=false
  try { enabled=remoteSettingEnabled(app.getPath('userData')) } catch {}
  if (!enabled) return Promise.resolve()
  stopRequested=false;quitAfterStop=false
  if (!quitHookInstalled) {
    quitHookInstalled=true
    app.on('before-quit',event=>{
      if (quitAfterStop || (!starting && !hub)) return
      event.preventDefault();quitAfterStop=true
      void stopCloudSync().catch(error=>console.error('[remote] shutdown not confirmed',error)).finally(()=>app.quit())
    })
  }
  const task=startConfigured(options?.owner ?? null).then(()=>{lastStartError=null},error=>{
    lastStartError=String((error as Error)?.message ?? error).slice(0,300)
    console.error('[remote] startup unavailable',error)
  })
  starting=task
  void task.finally(()=>{if(starting===task)starting=null})
  return task
}

/** Internal status only; no credentials, keys or paths are returned. */
export function cloudSyncStatus():{running:boolean;mobilePort:number|null} {
  return {running:hub!==null,mobilePort:hub?.mobilePort ?? null}
}

/** Host lifecycle for the owner's setup page. `needsRestart` means a shutdown
 * or cleanup was not confirmed: the state lock is retained until app restart. */
export function remoteHostState():{running:boolean;busy:boolean;needsRestart:boolean;mobilePort:number|null;error:string|null} {
  return {running:hub!==null,busy:starting!==null || stopping!==null,needsRestart:failed || shutdownFailed,mobilePort:hub?.mobilePort ?? null,error:lastStartError}
}

export function stopCloudSync():Promise<void> {
  stopRequested=true
  if (stopping) return stopping
  if (shutdownFailed) return Promise.reject(new Error('Remote shutdown not confirmed'))
  if (!starting && !hub) return Promise.resolve()
  const task=(async()=>{
    if (starting) await starting
    // A failed startup may have retained the state lock because child shutdown
    // was not confirmed. Never release that lock via the concurrent stop path.
    if (failed && !hub) return
    const oldScheduler=scheduler,oldHub=hub,oldState=state
    scheduler=null;hub=null;state=null
    // stop() marks the scheduler stopped synchronously; initiate child shutdown
    // immediately as well, so a stuck parent read cannot leave its port alive.
    let timer:ReturnType<typeof setTimeout>|undefined
    const operations=Promise.allSettled([oldScheduler?.stop() ?? Promise.resolve(),oldHub?.stop() ?? Promise.resolve()])
    const results=await Promise.race([operations,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),15000)})])
    if (timer) clearTimeout(timer)
    if (!results || results.some(result=>result.status==='rejected')) {failed=true;shutdownFailed=true;state=oldState;throw new Error('Remote shutdown not confirmed')}
    if (oldState) try {oldState.close()} catch {failed=true;shutdownFailed=true;state=oldState;throw new Error('Remote state cleanup not confirmed')}
  })()
  stopping=task
  void task.then(()=>{if(stopping===task)stopping=null},()=>{if(stopping===task)stopping=null})
  return task
}
