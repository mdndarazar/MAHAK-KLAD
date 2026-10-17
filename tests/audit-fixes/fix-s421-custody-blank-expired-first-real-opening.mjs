/**
 * A blank optional opening today may expire before anybody really counts.
 * Recovery then requires a real amount, and that first observed opening must
 * still include yesterday's actual receipts instead of treating blank as zero.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s421-custody-blank-expired-first-real-opening.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blank-expired-'))
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
const yesterdayDate = new Date(jalaliStartOfDay(today).getTime() - 60_000)
const yesterday = toJalaliDate(yesterdayDate)
const manager = seed.user('مدیر S421')
const old = seed.user('مسئول دیروز S421')
const blank = seed.user('مسئول بدون شمارش S421')
const opener = seed.user('مسئول بازیابی S421')
await custodyService.setPin({ userId: manager, newPassword: 'Manager421!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager421!' })
for (const [id, temp, pin] of [[old, 'Old421!', 'Old4214!'], [blank, 'Blank421!', 'Blank4214!'], [opener, 'New421!', 'New4214!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager421!', reason: 'بررسی اولین شمارش پس از افتتاح خالی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
const oldShift = await custodyService.open({ userId: old, password: 'Old4214!', countedCash: 0 })
sql.prepare('UPDATE "Shift" SET openedAt=?, closedAt=? WHERE id=?').run(yesterdayDate.getTime() - 60_000, yesterdayDate.getTime(), oldShift.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, endedAt=?, endKind=? WHERE shiftId=?').run(yesterday, yesterdayDate.getTime(), 'FINAL_CLOSE', oldShift.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=? AND kind=?').run(yesterday, oldShift.shiftId, 'OPENING')
sql.prepare('UPDATE "CustodyState" SET state=?, activeShiftId=NULL, pendingHandoverId=NULL, epoch=epoch+1 WHERE key=?').run('NO_SESSION', 'MAIN')
const method = seed.insert('PaymentMethod', { key: 'S421_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
for (const [receipt, amount, when, day, owner, shiftId] of [[421001, 5_000_000, yesterdayDate, yesterday, old, oldShift.shiftId], [421002, 500_000, new Date(), today, blank, null]]) {
  const inv = seed.invoice({ receiptNo: receipt, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAt=?, issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=?, shiftId=? WHERE id=?')
    .run(when.getTime(), day, amount, amount, owner, shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId: method, amount, seq: 1, kind: 'CASH', destination: 'CASH',
    paidAt: when.getTime(), paidAtJalali: day, createdByUserId: owner, createdShiftId: shiftId })
}
const uncounted = await custodyService.open({ userId: blank, password: 'Blank4214!' })
eq('optional opening is count-pending, not an actual observation', uncounted.countStatus, 'COUNT_PENDING')
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?').run(Date.now() - 60_000, uncounted.shiftId)
const rolled = await custodyService.status()
eq('system ends last actual, not a planned worker', rolled.state, 'NO_SESSION')
eq('system-closed blank Shift keeps old actual owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', uncounted.shiftId)?.userId, blank)
eq('no fake morning count added on expiry', seed.count('CustodyBlueSnapshot', 'shiftId=?', uncounted.shiftId), 0)
let rejected = ''
try { await custodyService.open({ userId: opener, password: 'New4214!' }) } catch (error) { rejected = error?.code ?? '' }
eq('after expiry even optional mode demands a new real count', rejected, 'CUSTODY_RECOVERY_COUNT_REQUIRED')
const opened = await custodyService.open({ userId: opener, password: 'New4214!', operationalTotal: 5_500_000 })
const witness = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'OPENING')
eq('first real opening still uses both days', Number(witness?.referenceAmount), 5_500_000)
eq('first real opening scope starts on yesterday', witness?.referenceFromDay, yesterday)
eq('first real opening is not mistaken for a second count', witness?.scopeKind, 'PRIOR_AND_TODAY')
eq('new owner can sell immediately', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
eq('missed Shift case remains separate from new owner', seed.count('CustodyResolution', 'shiftId=? AND status=?', uncounted.shiftId, 'OPEN'), 1)
console.log(`\n✓ ${checked} checks passed`)
