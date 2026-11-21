/**
 * Experimental opt-in bridge for the desktop backup IPC. Not sufficient for
 * production readiness: direct service calls, other processes, crash recovery,
 * and ledger resynchronization still need integration. No secrets are stored.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

type Exclusive = (operation:()=>Promise<void>)=>Promise<void>
let owner: { run?:Exclusive } | undefined
const activeBackups=new Set<symbol>()
const context=new AsyncLocalStorage<symbol>()

/** Reserve synchronously before child startup so backup cannot overlap startup. */
export function reserveDesktopBackupCoordination() {
  if (owner || activeBackups.size) throw new Error('Remote backup coordination unavailable')
  const reservation:{run?:Exclusive}={};owner=reservation
  return {
    install(run:Exclusive) {
      if (owner!==reservation || reservation.run || typeof run!=='function') throw new Error('Remote backup coordination unavailable')
      reservation.run=run
    },
    release() {
      if (owner!==reservation || activeBackups.size) throw new Error('Remote backup coordination unavailable')
      owner=undefined
    }
  }
}

/** True while an experimental supervisor is starting, running or uncertain. */
export function desktopBackupCoordinationActive():boolean { return owner!==undefined }

export async function withDesktopBackupCoordination<T>(operation:()=>Promise<T>):Promise<T> {
  if (typeof operation!=='function') throw new Error('Remote backup coordination unavailable')
  // BackupService.apply invokes mergeBackup itself. Only the same live async
  // operation may reenter; a detached task after completion cannot reuse it.
  const parent=context.getStore()
  if (parent && activeBackups.has(parent)) return operation()
  if (owner && activeBackups.size) throw new Error('Remote backup coordination unavailable')
  // Preserve existing concurrent local-only backup behavior while preventing
  // supervisor startup until every such operation has completed.
  const token=Symbol('backup-operation');activeBackups.add(token)
  try {
    const reservation=owner
    if (!reservation) return await context.run(token,operation)
    if (!reservation.run) throw new Error('Remote backup coordination unavailable')
    let result:T|undefined,completed=false
    await reservation.run(async()=>{result=await context.run(token,operation);completed=true})
    if (!completed) throw new Error('Remote backup operation unavailable')
    return result as T
  } finally {activeBackups.delete(token)}
}
