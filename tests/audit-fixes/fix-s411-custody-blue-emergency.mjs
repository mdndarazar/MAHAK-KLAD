/**
 * Emergency/manager exceptions no longer fabricate a human zero or freeze
 * sales. Only the NEW person's real count + personal PIN move responsibility;
 * an unfinished handover is kept as superseded and never reused.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s411-custody-blue-emergency.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-emergency-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const manager = seed.user('مدیر S411')
const absent = seed.user('غایب S411')
const cover = seed.user('جانشین S411')
await custodyService.setPin({ userId: manager, newPassword: 'Manager411!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager411!' })
for (const [id, temporary, personal] of [[absent, 'Absent411!', 'Absent4114!'], [cover, 'Cover411!', 'Cover4114!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager411!', reason: 'آزمون پوشش اضطراری با PIN شخصی' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function reject(label, code, fn) {
  try { await fn() } catch (error) { eq(label, error?.code, code); return }
  throw new Error(`${label}: unexpectedly accepted`)
}
const old = await custodyService.open({ userId: absent, password: 'Absent4114!', operationalTotal: 0 })
const beforeCover = await custodyService.actorForFinancialOperation()
eq('old seller remains free to sell before emergency transfer', beforeCover.expectedShiftId, old.shiftId)
const covered = await custodyService.emergencyCover({ userId: cover, password: 'Cover4114!', operationalTotal: 700,
  reason: 'مسئول واقعی غایب است و کارمند دیگر با شمارش مستقل پوشش می‌دهد.' })
eq('new worker becomes custodian without absent PIN', (await custodyService.status()).custodian?.id, cover)
eq('sales resume directly with new worker', (await custodyService.actorForFinancialOperation()).expectedShiftId, covered.shiftId)
eq('old Shift closes with actual old owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', old.shiftId).userId, absent)
eq('old Shift has a real close boundary', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId).closedAt != null, true)
const oldSide = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', covered.handoverId, 'OUT')
const newSide = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', covered.handoverId, 'IN')
eq('absent side is system provenance, not claimed human zero', oldSide.countOrigin, 'SYSTEM_ABSENCE_ZERO')
eq('system provenance never claims absent personal PIN', oldSide.authMethod, 'SYSTEM_ABSENCE_ZERO')
eq('system zero has no human amount', oldSide.humanAmount, null)
eq('system zero is not an arithmetic stand-in for a real count', oldSide.arithmeticAmount, null)
eq('cover count is explicit physical amount', Number(newSide.humanAmount), 700)
eq('cover independently used own personal PIN', newSide.authMethod, 'CUSTODY_PIN')
eq('reference is actual known zero', Number(newSide.referenceAmount), 0)
eq('positive count gives positive RAW difference', Number(newSide.rawDifference), 700)
eq('system zero cannot establish fresh blame', newSide.freshDifference, null)
eq('no fake aggregate discrepancy case on absent worker', seed.count('CustodyDiscrepancyCase'), 0)
eq('POS total never becomes cash opening float', seed.count('CashMovement', 'shiftId=? AND type=?', covered.shiftId, 'OPENING_FLOAT'), 0)

const pending = await custodyService.handoverStart({ password: 'Cover4114!', operationalTotal: 700,
  toUserId: absent, blueReference: true, idempotencyKey: 's411:unfinished:cover-to-absent' })
await reject('shared manager password never authorizes Master Override', 'PIN_WRONG',
  () => custodyService.masterOverride({ managerUserId: manager, managerPassword: '1111', operationalTotal: 700, reason: 'مدیر برای مسئول غایب شمارش جدید ثبت می‌کند.' }))
eq('wrong PIN leaves pending handover and sale owner intact', (await custodyService.actorForFinancialOperation()).expectedShiftId, covered.shiftId)
const mastered = await custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager411!',
  operationalTotal: 700, reason: 'مدیر با PIN شخصی مسئولیت صندوق را پس از غیبت به عهده می‌گیرد.' })
eq('manager becomes responsible with own PIN', (await custodyService.status()).custodian?.id, manager)
eq('manager can sell without waiting for previous handover', (await custodyService.actorForFinancialOperation()).expectedShiftId, mastered.shiftId)
eq('unfinished handover preserved as superseded', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', pending.id).status, 'SUPERSEDED_EMERGENCY')
eq('unfinished original outgoing count still stored', seed.count('CustodyBlueSnapshot', 'handoverId=? AND role=?', pending.id, 'OUT'), 1)
eq('old count was NOT reused as system zero', seed.one('SELECT countOrigin FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', mastered.handoverId, 'OUT').countOrigin, 'SYSTEM_ABSENCE_ZERO')
eq('manager attested new count', seed.one('SELECT authMethod FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', mastered.handoverId, 'IN').authMethod, 'MANAGER_CUSTODY_PIN')
eq('manager recorded as personal approver', seed.one('SELECT managerApproverUserId FROM "CustodyHandover" WHERE id=?', mastered.handoverId).managerApproverUserId, manager)
eq('no old discrepancy case auto-produced by manager exception', seed.count('CustodyDiscrepancyCase'), 0)
console.log(`\n✓ ${checks} checks passed`)
