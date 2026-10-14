/**
 * Long outage: close only the last REAL owner's Shift, create no missed planned
 * Shift, demand the new person's own PIN and explicit physical count even when
 * counting was historically optional. A positive real count against a zero
 * blue reference is a real positive RAW difference, not a guessed zero.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s409-custody-blue-recovery-opening.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-recovery-open-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const now = new Date()
const previousDay = toJalaliDate(new Date(now.getTime() - 24 * 60 * 60_000))
const today = toJalaliDate(now)
const manager = seed.user('مدیر S409')
const lastOwner = seed.user('آخرین مسئول واقعی S409')
const newOwner = seed.user('مسئول تازه S409')
await custodyService.setPin({ userId: manager, newPassword: 'Manager409!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager409!' })
for (const [id, temp, own] of [[lastOwner, 'Last409!', 'Last4094!'], [newOwner, 'New409!', 'New4094!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager409!', reason: 'راه‌اندازی سنجش بازیابی خاموشی طولانی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: own })
}
const prior = await custodyService.open({ userId: lastOwner, password: 'Last4094!', countedCash: 0 })
// Stand in for a real database persisted before the outage. No planned Shift
// is inserted here: the system knows only the last ACTUAL responsible worker.
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(now.getTime() - 30 * 60 * 60_000, prior.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?')
  .run(previousDay, now.getTime() - 25 * 60 * 60_000, prior.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=? AND kind=?').run(previousDay, prior.shiftId, 'OPENING')
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function reject(label, code, fn) {
  try { await fn() } catch (error) { eq(label, error?.code, code); return }
  throw new Error(`${label}: unexpectedly accepted`)
}
const postOutage = await custodyService.status()
eq('status lazily ends only last actual responsibility', postOutage.state, 'NO_SESSION')
eq('old Shift remains credited to prior owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', prior.shiftId).userId, lastOwner)
eq('system closed prior actual Shift, no fake planned shifts', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', prior.shiftId).closedAt != null, true)
eq('no synthetic missed planned Shift', seed.count('Shift'), 1)
await reject('recovery opening cannot silently omit physical amount', 'CUSTODY_RECOVERY_COUNT_REQUIRED',
  () => custodyService.open({ userId: newOwner, password: 'New4094!' }))
eq('missing count never creates an opening', seed.count('Shift'), 1)
const opened = await custodyService.open({ userId: newOwner, password: 'New4094!', operationalTotal: 700 })
eq('new person begins only their own Shift', (await custodyService.status()).custodian?.id, newOwner)
eq('financial attribution follows new real owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
eq('recovery does not wait for a manager decision', seed.one('SELECT status FROM "CustodyResolution" ORDER BY id DESC LIMIT 1').status, 'OPEN')
eq('original old Shift still exists, new Shift added', seed.count('Shift'), 2)
const opening = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'OPENING')
eq('new count is independent opening evidence', Number(opening?.humanAmount), 700)
eq('count origin is explicit, not system or blank zero', opening?.countOrigin, 'EXPLICIT_AMOUNT')
eq('first real morning count keeps prior + today scope', opening?.scopeKind, 'PRIOR_AND_TODAY')
eq('first morning scope begins on prior Jalali day', opening?.referenceFromDay, previousDay)
eq('first morning scope ends today', opening?.referenceToDay, today)
eq('known zero reference is not guessed count zero', Number(opening?.referenceAmount), 0)
eq('positive against zero is a positive RAW difference', Number(opening?.rawDifference), 700)
eq('fresh difference unknown without comparable prior human count', opening?.freshDifference, null)
eq('POS count never becomes a fictitious CASH opening float', seed.count('CashMovement', 'shiftId=? AND type=?', opened.shiftId, 'OPENING_FLOAT'), 0)
console.log(`\n✓ ${checks} checks passed`)
