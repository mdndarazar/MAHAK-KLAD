/**
 * Manager Reset Shift is recovery, not deletion or automatic reassignment:
 * healthy boxes stay healthy, unfinished counts survive but cannot be reused,
 * and only an actually open named Shift (not a planned slot) can be resumed.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s412-custody-shift-reset.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-shift-reset-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const manager = seed.user('مدیر ریست S412')
const owner = seed.user('صاحب واقعی S412')
const incoming = seed.user('گیرنده S412')
await custodyService.setPin({ userId: manager, newPassword: 'Manager412!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager412!' })
for (const [id, temp, own] of [[owner, 'Owner412!', 'Owner4124!'], [incoming, 'Incoming412!', 'Incoming4124!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager412!', reason: 'شاهدهای ریست امن حضانت' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: own })
}
let checks = 0
function eq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function reject(label, code, fn) {
  try { await fn() } catch (error) { eq(label, error?.code, code); return }
  throw new Error(`${label}: unexpectedly accepted`)
}
const reason = 'ریست امن بدون بازنویسی شمارش و انتقال مسئولیت قبلی'
const reset = (extra = {}) => custodyService.resetShift({ managerUserId: manager, password: 'Manager412!', reason, confirmed: true, ...extra })
const opened = await custodyService.open({ userId: owner, password: 'Owner4124!', operationalTotal: 0 })
await reject('reset needs manager PIN even with active manager session', 'PIN_WRONG', () => reset({ password: '1111' }))
await reject('reset needs explicit confirmation', 'CUSTODY_RESET_CONFIRM_REQUIRED', () => reset({ confirmed: false }))
const beforeEpoch = (await custodyService.status()).epoch
const healthy = await reset()
eq('healthy shift reset has explicit no-op outcome', healthy.outcome, 'NO_CHANGE')
eq('healthy reset cannot bump owner epoch', (await custodyService.status()).epoch, beforeEpoch)
eq('healthy reset cannot close Shift', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt, null)
eq('healthy reset cannot create a new Shift', seed.count('Shift'), 1)

const pending = await custodyService.handoverStart({ password: 'Owner4124!', operationalTotal: 0,
  toUserId: incoming, blueReference: true, idempotencyKey: 's412:pending-out' })
const aborted = await reset()
eq('unfinished handover reset aborts attempt but stays on old real owner', aborted.outcome, 'ABORTED_INCOMPLETE')
eq('pending original count evidence retained', seed.count('CustodyBlueSnapshot', 'handoverId=? AND role=?', pending.id, 'OUT'), 1)
eq('pending attempt is marked aborted, not deleted', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', pending.id).status, 'RESET_ABORTED')
eq('responsibility stays with actual owner', (await custodyService.status()).custodian?.id, owner)
eq('sales continue under real owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
await reject('no reuse of old pending count or PIN', 'BLUE_HANDOVER_NOT_PENDING',
  () => custodyService.handoverCountBlue({ handoverId: pending.id, password: 'Incoming4124!', operationalTotal: 0 }))

const counted = await custodyService.handoverStart({ password: 'Owner4124!', operationalTotal: 0,
  toUserId: incoming, blueReference: true, idempotencyKey: 's412:counted-out' })
await custodyService.handoverCountBlue({ handoverId: counted.id, password: 'Incoming4124!', operationalTotal: 0 })
const twice = await reset()
eq('counted but unconfirmed attempt also aborts safely', twice.outcome, 'ABORTED_INCOMPLETE')
eq('both previous counts remain durable', seed.count('CustodyBlueSnapshot', 'handoverId=?', counted.id), 2)
await reject('unconfirmed count cannot be confirmed after reset', 'BLUE_NOT_COUNTED',
  () => custodyService.handoverConfirmBlue({ handoverId: counted.id, password: 'Incoming4124!' }))
eq('no new custodian made by reset', (await custodyService.status()).custodian?.id, owner)

await custodyService.finalClose({ password: 'Owner4124!', operationalTotal: 0 })
const closedCount = seed.count('Shift')
const closed = await reset()
eq('closed reset does nothing destructive', closed.outcome, 'NO_CHANGE')
eq('closed reset does not fabricate scheduled Shift', seed.count('Shift'), closedCount)
eq('closed reset leaves no active owner', (await custodyService.status()).state, 'NO_SESSION')

const actual = await custodyService.open({ userId: owner, password: 'Owner4124!', operationalTotal: 0 })
sql.prepare('UPDATE "CustodyState" SET state=?, activeShiftId=NULL, pendingHandoverId=NULL WHERE key=?').run('NO_SESSION', 'MAIN')
const resumed = await reset()
eq('corrupt pointer recovers ACTUAL last open Shift, not a planned name', resumed.outcome, 'RECOVERED_REAL_OWNER')
eq('recovered last actual Shift id is unchanged', (await custodyService.status()).activeShiftId, actual.shiftId)
eq('recovered owner is the original real person', (await custodyService.status()).custodian?.id, owner)
eq('recovery never creates an invented Shift', seed.count('Shift'), closedCount + 1)
eq('sales available again for real owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, actual.shiftId)
eq('reason and personal manager id are auditable', seed.one('SELECT userId FROM "AuditLog" WHERE entity=? ORDER BY id DESC LIMIT 1', 'CustodyShiftReset').userId, manager)
console.log(`\n✓ ${checks} checks passed`)
