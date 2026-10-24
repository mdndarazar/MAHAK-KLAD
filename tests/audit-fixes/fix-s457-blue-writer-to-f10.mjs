/**
 * F10 must consume the immutable IN exactly where the REAL V3 writer stores it
 * (source Shift for a normal transfer, destination Shift for emergency cover).
 * No manually planted snapshot stands in for the writer in this test.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s457-blue-writer-to-f10.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-to-f10-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { cashClosingHistoryService } = await import('../../src/main/services/CashClosingHistoryService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { notePanelUnlocked, runWithPanelSessionOwner } = await import('../../src/main/services/panelSession.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const manager = seed.user('مدیر F10'), first = seed.user('مسئول اول F10'), second = seed.user('مسئول دوم F10')
let checks = 0
const eq = (label, value, expected) => { assert.deepEqual(value, expected, label); checks++; console.log(`  ✓ ${label}`) }
await custodyService.setPin({ userId: manager, newPassword: 'Manager457!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager457!' })
for (const [id, temp, pin] of [[first, 'First457!', 'First4574!'], [second, 'Second457!', 'Second4574!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager457!', reason: 'آزمون اتصال سند تحویل و F10' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(),
  custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: first, singleShiftAllowMidDayHandover: true },
  managerUserId: manager, managerPassword: 'Manager457!', reason: 'مجوز تحویل میان‌روز برای آزمون F10 و سند واقعی' })
const amount = 47_940_000, day = toJalaliDate(new Date())
const cashMethod = seed.insert('PaymentMethod', { key: 'S457_CASH', label: 'نقدی', kind: 'CASH', isActive: 1 })
const opened = await custodyService.open({ userId: first, password: 'First4574!', operationalTotal: amount })
const sale = seed.invoice({ receiptNo: 457001, grandTotal: amount, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
  .run(amount, amount, day, first, opened.shiftId, sale.id)
seed.insert('Payment', { invoiceId: sale.id, methodId: cashMethod, amount, seq: 1, kind: 'CASH', destination: 'CASH',
  paidAt: Date.now(), paidAtJalali: day, createdByUserId: first, createdShiftId: opened.shiftId })
const started = await custodyService.handoverStart({ password: 'First4574!', operationalTotal: amount,
  toUserId: second, idempotencyKey: 's457:real-normal-blue-out', blueReference: true })
await custodyService.handoverCountBlue({ handoverId: started.id, password: 'Second4574!', operationalTotal: amount })
const confirmed = await custodyService.handoverConfirmBlue({ handoverId: started.id, password: 'Second4574!' })
const incoming = seed.one('SELECT shiftId, referenceAmount, referenceStatus FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'IN')
eq('writer stored IN on the source Shift before the new Shift existed', incoming.shiftId, opened.shiftId)
eq('writer stored the actual sales blue amount and status', [incoming.referenceAmount, incoming.referenceStatus], [amount, 'AVAILABLE'])
eq('a distinct new Shift now owns the drawer', confirmed.shiftId !== opened.shiftId, true)
const countBefore = seed.count('CustodyEvent')
const query = () => runWithPanelSessionOwner(457, () => cashClosingHistoryService.query({ fromJalali: day, toJalali: day }))
await assert.rejects(query(), /فقط نشست فعال مدیر/); checks++
runWithPanelSessionOwner(457, () => notePanelUnlocked('__manager__', 'MANAGER'))
const report = await query()
const row = report.rows.find((r) => r.handoverId === started.id)
eq('F10 reads the completed handover as a real event', [report.totals.handovers, row?.kind], [1, 'HANDOVER'])
eq('F10 shows the original stored reference, not today’s recalculation', [row?.reference.state, row?.reference.amount, row?.reference.snapshotId], ['KNOWN_V3', amount, seed.one('SELECT id FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'IN').id])
eq('F10 correctly associates source and destination while keeping IN linked to source', [row?.from?.shiftId, row?.to?.shiftId], [opened.shiftId, confirmed.shiftId])
eq('no inconsistent evidence manufactured by the real writer', [report.totals.amountInconsistent, report.warnings.length], [0, 0])
eq('reading F10 produces no custody event or synthetic close', seed.count('CustodyEvent'), countBefore)
console.log(`\n✓ ${checks} real writer → F10 checks passed`)
