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

/** طرح ۱۴۰۵ · مورد ۱۳ (معماری §۴-۱): پیام‌رسان پیش و پس از هر بازگردانی یا ادغام از راه برنامه خبر می‌گیرد.
 * فقط سطح اول (نه ورود دوبارهٔ mergeBackup درون apply)؛ خطای قلاب هرگز کار بکاپ را عوض نمی‌کند.
 * مرحلهٔ ۸ (§۴-۲): صفر کردن هم از همین راه می‌گذرد، با `kind: 'reset'`. */
export type DesktopDatabaseOperationKind = 'backup' | 'reset'
type BackupHooks = { before(kind?:DesktopDatabaseOperationKind):void; after(outcome:{ok:boolean;result?:unknown;kind?:DesktopDatabaseOperationKind}):void }
let backupHooks: BackupHooks | undefined
export function setDesktopBackupHooks(hooks:BackupHooks | undefined):void { backupHooks=hooks }
/** صفر کردن هم‌زمان با هیچ بازگردانی یا ادغامی اجرا نمی‌شود، و برعکس (با هاب روشن یا خاموش). */
let resetActive=false

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

export async function withDesktopBackupCoordination<T>(operation:()=>Promise<T>, kind:DesktopDatabaseOperationKind='backup'):Promise<T> {
  if (typeof operation!=='function' || (kind!=='backup' && kind!=='reset')) throw new Error('Remote backup coordination unavailable')
  // BackupService.apply invokes mergeBackup itself. Only the same live async
  // operation may reenter; a detached task after completion cannot reuse it.
  const parent=context.getStore()
  if (parent && activeBackups.has(parent)) return operation()
  if (resetActive || (kind==='reset' && activeBackups.size)) throw new Error('Desktop database operation busy')
  if (owner && activeBackups.size) throw new Error('Remote backup coordination unavailable')
  const hooks=backupHooks
  try {hooks?.before(kind)} catch {}
  let outcome:{ok:boolean;result?:unknown}={ok:false}
  // Preserve existing concurrent local-only backup behavior while preventing
  // supervisor startup until every such operation has completed.
  const token=Symbol('backup-operation');activeBackups.add(token)
  if (kind==='reset') resetActive=true
  try {
    const reservation=owner
    if (!reservation) { const value=await context.run(token,operation);outcome={ok:true,result:value};return value }
    if (!reservation.run) throw new Error('Remote backup coordination unavailable')
    let result:T|undefined,completed=false
    await reservation.run(async()=>{result=await context.run(token,operation);completed=true})
    if (!completed) throw new Error('Remote backup operation unavailable')
    outcome={ok:true,result}
    return result as T
  } finally {activeBackups.delete(token);if (kind==='reset') resetActive=false;try {hooks?.after({...outcome,kind})} catch {}}
}
