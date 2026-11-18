/**
 * Desktop host for the experimental local remote hub. The product readiness
 * gate remains false until provisioning, restore recovery and device testing are
 * complete. Missing configuration or keys never causes automatic initialization.
 */
import { createHash, hkdfSync } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { prisma } from '../db/client'
import { registerRemoteAuthHandlers } from '../ipc/remoteAuth'
import { remoteImplementationReady } from '../../shared/remoteAuthChannels'
import { remoteSettingEnabled } from './cloud/remoteSettings'
import { createCloudReader } from './cloud/cloudReader'
import { openCloudStateStore } from './cloud/cloudState'
import { createRemoteTransportVault } from './cloud/remoteTransportVault'
import { createExperimentalRestoreBarrier } from './cloud/experimentalRestoreBarrier'
import { startExperimentalHubSupervisor } from './cloud/experimentalHubSupervisor'
import { createExperimentalHubScheduler } from './cloud/experimentalHubScheduler'
import { normalizeMobileOrigins } from './cloud/mobileOrigins'
import { initRemoteGrantRegistry } from './RemoteGrantRegistry'
import * as sessions from './panelSession'

// Only these non-operation panel scopes are connected in this experimental host.
// Financial one-shot operations require a separate reviewed policy and remain off.
const PANELS = ['products','settings','secondary-stock'] as const
const POLICIES = Object.fromEntries(PANELS.map(panel => [panel,{tier:'NORMAL' as const,mode:'PANEL' as const,ttlMs:600_000}]))
type Store = ReturnType<typeof openCloudStateStore>
type Hub = Awaited<ReturnType<typeof startExperimentalHubSupervisor>>
type Scheduler = ReturnType<typeof createExperimentalHubScheduler>
let starting:Promise<void>|null=null, stopping:Promise<void>|null=null
let hub:Hub|null=null, scheduler:Scheduler|null=null, state:Store|null=null
let quitHookInstalled=false, quitAfterStop=false, stopRequested=false, handlersRegistered=false, failed=false, shutdownFailed=false

function existingDirectory(path:string):void {
  const stat=lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Remote directory unavailable')
}
function existingFile(path:string):void {
  const stat=lstatSync(path)
  if (!stat.isFile() || stat.nlink!==1) throw new Error('Remote file unavailable')
}
function readConfig(path:string):string {
  const stat=lstatSync(path)
  if (!stat.isFile() || stat.nlink!==1 || stat.size<1 || stat.size>2048) throw new Error('Remote configuration unavailable')
  const value:unknown=JSON.parse(readFileSync(path,'utf8'))
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid remote configuration')
  const config=value as Record<string,unknown>
  if (Object.keys(config).sort().join(',')!=='origin,version' || config.version!==1) throw new Error('Invalid remote configuration')
  return normalizeMobileOrigins(config.origin,undefined)[0]
}
function restoreMarker(path:string):string|null {
  try {
    const stat=lstatSync(path)
    if (!stat.isFile() || stat.nlink!==1 || stat.size>65536) throw new Error('Invalid restore marker')
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return null
    throw error
  }
}
function derivedKey(key:Uint8Array, storeId:string, epoch:string, purpose:string):Buffer {
  return Buffer.from(hkdfSync('sha256',key,Buffer.from(`${storeId}:${epoch}`),Buffer.from(`mahak-remote-${purpose}-v1`),32))
}

/** Start only after a separate owner-provisioning process has created every
 * required file. No credentials or identity are accepted from renderer IPC. */
async function startConfigured():Promise<void> {
  const userData=app.getPath('userData'), root=join(userData,'remote-hub'), stateDir=join(root,'state'), hubDir=join(root,'hub')
  const dbFile=join(userData,'data','shop.db'), runtimeDir=join(process.resourcesPath,'remote')
  if (process.env.DATABASE_URL!==`file:${dbFile}`) throw new Error('Remote database identity unavailable')
  const nodeExecutable=join(runtimeDir,'node.exe'),childFile=join(runtimeDir,'remote-hub-child.cjs')
  for (const path of [root,stateDir,hubDir,runtimeDir]) existingDirectory(path)
  for (const path of [dbFile,nodeExecutable,childFile,join(hubDir,'remote-hub.sqlite'),join(stateDir,'cloud-state.json')]) existingFile(path)
  const origin=readConfig(join(root,'config.json'))
  const localState=openCloudStateStore(stateDir)
  let localHub:Hub|null=null, localScheduler:Scheduler|null=null, hubStartAttempted=false
  try {
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
    localHub=await startExperimentalHubSupervisor({nodeExecutable,childFile,directory:hubDir,origin,owner:null,auditKey:keys.auditKey,
      snapshotMaxAgeMs:60_000,reader:createCloudReader(prisma),state:localState,databaseFile:dbFile,restoreBarrier:barrier,coordinateDesktopBackup:true,
      readRestoreMarker:async()=>restoreMarker(join(userData,'backups','last-restore.txt')),
      verifyLocalRecoveryPassword:async password=>{
        const auth=await import('./AuthService')
        await auth.assertManagerPassword(password,'بازیابی توقف اضطراری کنترل از راه دور')
      },
      revocation:{key:revocationKey,onRevocation:entry=>{
        if (entry.kind==='ALL') {
          if (!electron.Notification.isSupported()) throw new Error('Desktop notification unavailable')
          new electron.Notification({title:'کنترل از راه دور',body:'دسترسی‌های راه دور بسته شدند.'}).show()
        }
        return undefined
      }},
      approval:{key:approvalKey,policies:POLICIES}})
    if (stopRequested) throw new Error('Remote startup cancelled')
    if (!handlersRegistered) {
      registerRemoteAuthHandlers(async(password,pin)=>hub ? hub.recoverPanic(password,pin) : false)
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

export function startCloudSync():Promise<void> {
  // Default-off must not read userData, open a DB, start timers or IPC.
  if (!remoteImplementationReady()) return Promise.resolve()
  if (hub || starting || stopping || failed) return starting ?? Promise.resolve()
  if (!remoteSettingEnabled(app.getPath('userData'))) return Promise.resolve()
  stopRequested=false;quitAfterStop=false
  if (!quitHookInstalled) {
    quitHookInstalled=true
    app.on('before-quit',event=>{
      if (quitAfterStop || (!starting && !hub)) return
      event.preventDefault();quitAfterStop=true
      void stopCloudSync().catch(error=>console.error('[remote] shutdown not confirmed',error)).finally(()=>app.quit())
    })
  }
  const task=startConfigured().catch(error=>{console.error('[remote] startup unavailable',error)})
  starting=task
  void task.finally(()=>{if(starting===task)starting=null})
  return task
}

/** Internal status only; no credentials, keys or paths are returned. */
export function cloudSyncStatus():{running:boolean;mobilePort:number|null} {
  return {running:hub!==null,mobilePort:hub?.mobilePort ?? null}
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
