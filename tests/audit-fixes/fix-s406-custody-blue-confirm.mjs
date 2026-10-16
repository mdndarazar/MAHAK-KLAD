/**
 * Live blue handovers: two PINs/two independent counts, explicit confirmation,
 * inherited old shortage never a new case, and sales never freeze on difference.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s406-custody-blue-confirm.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-confirm-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const day = toJalaliDate(new Date())
const manager = seed.user('مدیر S406')
const first = seed.user('صبح S406')
const noon = seed.user('ظهر S406')
const night = seed.user('شب S406')
await custodyService.setPin({ userId: manager, newPassword: 'Manager406!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager406!' })
for (const [id, temp, final] of [[first, 'First406!', 'First4064!'], [noon, 'Noon406!', 'Noon4064!'], [night, 'Night406!', 'Night4064!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager406!', reason: 'صدور PIN شخصی آزمون تحویل' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: final })
}
// This scenario tests blue transfer, so explicitly grant midday permission.
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: first, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager406!', reason: 'مجوز مستند تحویل میان‌روز آزمون اسناد آبی' })
const method = seed.insert('PaymentMethod', { key: 'S406_CASH', label: 'نقدی', kind: 'CASH', isActive: 1 })
const opened = await custodyService.open({ userId: first, password: 'First4064!', operationalTotal: 18_481_000 })
function sale(receiptNo, amount, owner, shiftId) {
  const inv = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, owner, shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId: method, amount, seq: 1, kind: 'CASH', destination: 'CASH', paidAt: Date.now(), paidAtJalali: day, createdByUserId: owner, createdShiftId: shiftId })
}
sale(406001, 19_481_000, first, opened.shiftId)
let checked = 0
const eq = (name, got, expected) => {
  if (got !== expected) throw new Error(`${name}: expected ${expected}, got ${got}`)
  checked++; console.log(`  ✓ ${name}`)
}
const start = await custodyService.handoverStart({ password: 'First4064!', operationalTotal: 18_481_000,
  toUserId: noon, idempotencyKey: 's406:first-to-noon', blueReference: true })
const counted = await custodyService.handoverCountBlue({ handoverId: start.id, password: 'Noon4064!', operationalTotal: 18_481_000 })
eq('first receiver sees raw prior -1M', counted.rawDifference, -1_000_000)
eq('same count makes zero new difference at this boundary', counted.freshDifference, 0)
eq('sale still permitted with nonzero raw', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
const completed = await custodyService.handoverConfirmBlue({ handoverId: start.id, password: 'Noon4064!' })
eq('confirm switches custodian without manager preapproval', (await custodyService.status()).custodian?.id, noon)
eq('new shift owned by actual receiver', (await custodyService.actorForFinancialOperation()).expectedShiftId, completed.shiftId)
eq('historic aggregate discrepancy cases not fabricated', seed.count('CustodyDiscrepancyCase'), 0)
eq('POS money not converted to cash float', seed.count('CashMovement', 'shiftId=? AND type=?', completed.shiftId, 'OPENING_FLOAT'), 0)
eq('blue result no fresh shortage on receiver', Number(seed.one('SELECT freshDifference FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', start.id, 'IN').freshDifference), 0)

sale(406002, 10_000_000, noon, completed.shiftId)
const second = await custodyService.handoverStart({ password: 'Noon4064!', operationalTotal: 27_481_000,
  toUserId: night, idempotencyKey: 's406:noon-to-night', blueReference: true })
const out = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'OUT')
eq('noon raw now -2M', Number(out.rawDifference), -2_000_000)
eq('noon inherits earlier -1M', Number(out.inheritedDifference), -1_000_000)
eq('noon fresh only -1M', Number(out.freshDifference), -1_000_000)
const counted2 = await custodyService.handoverCountBlue({ handoverId: second.id, password: 'Night4064!', operationalTotal: 27_481_000 })
eq('night raw remains -2M', counted2.rawDifference, -2_000_000)
eq('night receives no NEW shortage from the existing gap', counted2.freshDifference, 0)
const accepted = await custodyService.handoverConfirmBlue({ handoverId: second.id, password: 'Night4064!' })
eq('night becomes responsible without explaining previous losses', (await custodyService.status()).custodian?.id, night)
eq('raw+fresh original snapshots linked to same completed handover', seed.count('CustodyBlueSnapshot', 'handoverId=?', second.id), 2)
eq('old ledger holds no duplicate discrepancy case', seed.count('CustodyDiscrepancyCase'), 0)
eq('accepted handover actually closes noon Shift', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', completed.shiftId).closedAt != null, true)
eq('future sales attribute real new owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, accepted.shiftId)

console.log(`\n✓ ${checked} checks passed`)
