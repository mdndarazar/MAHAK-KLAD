/**
 * An optional BLANK opening is not a physical count. If yesterday's actual
 * Shift was closed and today's new Shift opened without a count, the first
 * REAL human observation still includes yesterday + today. The next one uses
 * all of today only. A real count on FINAL_CLOSE may be that first witness.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s420-custody-optional-blank-not-first-day-count.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blank-not-first-count-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate, jalaliStartOfDay } = await import('@shared/jalali')
const db = harnessClient(); const seed = makeSeeder(db); const sql = db.$harness.db
let checked = 0
function eq(label, got, expected) {
  if (got !== expected) throw new Error(`${label}: expected ${expected}, got ${got}`)
  checked++; console.log(`  ✓ ${label}`)
}
const today = toJalaliDate(new Date())
const beforeCutover = new Date(jalaliStartOfDay(today).getTime() - 60_000)
const yesterday = toJalaliDate(beforeCutover)
const manager = seed.user('مدیر S420')
const previous = seed.user('مسئول دیروز S420')
const blankOwner = seed.user('مسئول بدون شمارش اولیه S420')
const next = seed.user('مسئول پس از شمارش S420')
await custodyService.setPin({ userId: manager, newPassword: 'Manager420!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager420!' })
for (const [id, temporary, personal] of [[previous, 'Prev420!', 'Prev4204!'], [blankOwner, 'Blank420!', 'Blank4204!'], [next, 'Next420!', 'Next4204!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager420!', reason: 'آزمون افتتاح اختیاری خالی و مرز روز' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
// Historical database fixture: yesterday's actual owner completed their Shift
// before midnight; there is NO unresolved outage forcing a real count today.
const old = await custodyService.open({ userId: previous, password: 'Prev4204!', countedCash: 0 })
sql.prepare('UPDATE "Shift" SET openedAt=?, closedAt=? WHERE id=?').run(beforeCutover.getTime() - 2 * 60_000, beforeCutover.getTime(), old.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, endedAt=?, endKind=? WHERE shiftId=?').run(yesterday, beforeCutover.getTime(), 'FINAL_CLOSE', old.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=? AND kind=?').run(yesterday, old.shiftId, 'OPENING')
sql.prepare('UPDATE "CustodyState" SET state=?, activeShiftId=NULL, pendingHandoverId=NULL, epoch=epoch+1 WHERE key=?').run('NO_SESSION', 'MAIN')
const cash = seed.insert('PaymentMethod', { key: 'S420_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
for (const [receipt, amount, when, day, user, shiftId] of [[420001, 5_000_000, beforeCutover, yesterday, previous, old.shiftId], [420002, 500_000, new Date(), today, blankOwner, null]]) {
  const inv = seed.invoice({ receiptNo: receipt, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAt=?, issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=?, shiftId=? WHERE id=?')
    .run(when.getTime(), day, amount, amount, user, shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId: cash, amount, seq: 1, kind: 'CASH', destination: 'CASH',
    paidAt: when.getTime(), paidAtJalali: day, createdByUserId: user, createdShiftId: shiftId })
}
const opened = await custodyService.open({ userId: blankOwner, password: 'Blank4204!' })
eq('optional blank opening is not a real count', opened.countStatus, 'COUNT_PENDING')
eq('blank opening creates no Blue opening witness', seed.count('CustodyBlueSnapshot', 'shiftId=?', opened.shiftId), 0)
eq('blank opening does not claim an explicit zero', seed.count('CustodyCount', 'shiftId=?', opened.shiftId), 0)
eq('sales still have the current actual owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
await custodyService.finalClose({ password: 'Blank4204!', operationalTotal: 5_500_000 })
const first = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'FINAL_CLOSE')
eq('first REAL count still includes yesterday and today', Number(first.referenceAmount), 5_500_000)
eq('first REAL scope begins yesterday', first.referenceFromDay, yesterday)
eq('first REAL scope is previous and today', first.scopeKind, 'PRIOR_AND_TODAY')
const newlyOpened = await custodyService.open({ userId: next, password: 'Next4204!', operationalTotal: 500_000 })
const later = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newlyOpened.shiftId, 'OPENING')
eq('later count uses only the full current day', Number(later.referenceAmount), 500_000)
eq('later scope begins today', later.referenceFromDay, today)
console.log(`\n✓ ${checked} checks passed`)
