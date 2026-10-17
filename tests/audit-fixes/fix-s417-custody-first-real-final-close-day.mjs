/**
 * The FIRST physical observation of a new day can be the outgoing person's
 * final close, not only a morning OPENING/accepted IN. Only that first count
 * inherits yesterday; every later opening/handover uses today's full report.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s417-custody-first-real-final-close-day.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-first-final-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate, jalaliStartOfDay } = await import('@shared/jalali')
const db = harnessClient(); const seed = makeSeeder(db); const sql = db.$harness.db
const now = new Date()
const today = toJalaliDate(now)
const yesterday = toJalaliDate(new Date(jalaliStartOfDay(today).getTime() - 1000))
const beforeCutover = new Date(jalaliStartOfDay(today).getTime() - 60_000)
const manager = seed.user('مدیر S417')
const oldOwner = seed.user('مسئول دیروز S417')
const nextOwner = seed.user('مسئول امروز S417')
await custodyService.setPin({ userId: manager, newPassword: 'Manager417!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager417!' })
for (const [id, temporary, personal] of [[oldOwner, 'Old417!', 'Old4174!'], [nextOwner, 'New417!', 'New4174!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager417!', reason: 'آزمون نخستین شمارش نهایی روز' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
const opened = await custodyService.open({ userId: oldOwner, password: 'Old4174!', countedCash: 0 })
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(beforeCutover.getTime() - 60_000, opened.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?').run(yesterday, now.getTime() + 60 * 60_000, opened.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=? AND kind=?').run(yesterday, opened.shiftId, 'OPENING')
const cash = seed.insert('PaymentMethod', { key: 'S417_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
for (const [receipt, amount, date, day] of [[417001, 5_000_000, beforeCutover, yesterday], [417002, 500_000, now, today]]) {
  const invoice = seed.invoice({ receiptNo: receipt, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAt=?, issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=?, shiftId=? WHERE id=?')
    .run(date.getTime(), day, amount, amount, oldOwner, opened.shiftId, invoice.id)
  seed.insert('Payment', { invoiceId: invoice.id, methodId: cash, amount, seq: 1, kind: 'CASH', destination: 'CASH',
    paidAt: date.getTime(), paidAtJalali: day, createdByUserId: oldOwner, createdShiftId: opened.shiftId })
}
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
const closed = await custodyService.finalClose({ password: 'Old4174!', operationalTotal: 5_500_000 })
eq('actual old custodian closes after midnight, not a planned worker', closed.state, 'NO_SESSION')
const closing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'FINAL_CLOSE')
eq('first count includes yesterday and today', Number(closing.referenceAmount), 5_500_000)
eq('first scope starts yesterday', closing.referenceFromDay, yesterday)
eq('first scope has previous-and-current day flag', closing.scopeKind, 'PRIOR_AND_TODAY')
eq('real final close is the first human count today', Number(closing.humanAmount), 5_500_000)
const newlyOpened = await custodyService.open({ userId: nextOwner, password: 'New4174!', operationalTotal: 500_000 })
const opening = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newlyOpened.shiftId, 'OPENING')
eq('later opening excludes yesterday and uses WHOLE today', Number(opening.referenceAmount), 500_000)
eq('later scope begins today', opening.referenceFromDay, today)
eq('later scope ends today', opening.referenceToDay, today)
eq('later scope is TODAY', opening.scopeKind, 'TODAY')
eq('sales remain attributed to old actual owner even across midnight', seed.one('SELECT userId FROM "SaleInvoice" WHERE receiptNo=?', 417002).userId, oldOwner)
eq('new owner can sell immediately', (await custodyService.actorForFinancialOperation()).expectedShiftId, newlyOpened.shiftId)
console.log(`\n✓ ${checks} checks passed`)
