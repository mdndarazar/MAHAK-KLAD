/**
 * An actual first morning opening sees previous day + today. A later handover
 * sees only today's WHOLE report, never the outgoing Shift's own sales.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s410-custody-blue-live-day-boundary.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-days-live-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate, jalaliStartOfDay } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const now = new Date()
const today = toJalaliDate(now)
const priorDay = toJalaliDate(new Date(jalaliStartOfDay(today).getTime() - 1000))
const priorAt = new Date(jalaliStartOfDay(today).getTime() - 60_000)
const manager = seed.user('مدیر S410')
const oldOwner = seed.user('مسئول دیروز S410')
const morning = seed.user('مسئول صبح S410')
const noon = seed.user('مسئول ظهر S410')
await custodyService.setPin({ userId: manager, newPassword: 'Manager410!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager410!' })
for (const [id, temp, own] of [[oldOwner, 'Old410!', 'Old4104!'], [morning, 'Morning410!', 'Morning4104!'], [noon, 'Noon410!', 'Noon4104!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager410!', reason: 'ساخت PIN آزمون مرز روز آبی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: own })
}
const opened = await custodyService.open({ userId: oldOwner, password: 'Old4104!', countedCash: 0 })
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(priorAt.getTime() - 60_000, opened.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?').run(priorDay, priorAt.getTime(), opened.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=? AND kind=?').run(priorDay, opened.shiftId, 'OPENING')
const cash = seed.insert('PaymentMethod', { key: 'S410_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
function paid(receiptNo, amount, when, paidDay) {
  const inv = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAt=?, issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=?, shiftId=? WHERE id=?')
    .run(when.getTime(), paidDay, amount, amount, oldOwner, opened.shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId: cash, amount, seq: 1, kind: 'CASH', destination: 'CASH',
    paidAt: when.getTime(), paidAtJalali: paidDay, createdByUserId: oldOwner, createdShiftId: opened.shiftId })
}
paid(410001, 5_000_000, priorAt, priorDay)
paid(410002, 500_000, now, today)
let checked = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checked++; console.log(`  ✓ ${label}`)
}
await custodyService.status() // the actual old Shift, not missing roster slots, is rolled over
const first = await custodyService.open({ userId: morning, password: 'Morning4104!', operationalTotal: 5_500_000 })
const firstSnapshot = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', first.shiftId, 'OPENING')
eq('morning first reference combines yesterday and today', Number(firstSnapshot.referenceAmount), 5_500_000)
eq('first count includes the previous day', firstSnapshot.referenceFromDay, priorDay)
eq('actual morning count matches its first reference', Number(firstSnapshot.rawDifference), 0)
const handover = await custodyService.handoverStart({ password: 'Morning4104!', operationalTotal: 500_000,
  toUserId: noon, blueReference: true, idempotencyKey: 's410:noon-handover' })
const outgoing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', handover.id, 'OUT')
eq('noon reference uses only today', Number(outgoing.referenceAmount), 500_000)
eq('noon excludes yesterday from date scope', outgoing.referenceFromDay, today)
eq('noon reference is whole day, including previous seller', outgoing.scopeKind, 'TODAY')
eq('noon does not generate a fresh delta across different scopes', outgoing.freshDifference, null)
await custodyService.handoverCountBlue({ handoverId: handover.id, password: 'Noon4104!', operationalTotal: 500_000 })
await custodyService.handoverConfirmBlue({ handoverId: handover.id, password: 'Noon4104!' })
eq('noon seller becomes owner without managerial preapproval', (await custodyService.status()).custodian?.id, noon)
eq('yesterday sale remains on old actual owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE receiptNo=?', 410001).userId, oldOwner)
console.log(`\n✓ ${checked} checks passed`)
