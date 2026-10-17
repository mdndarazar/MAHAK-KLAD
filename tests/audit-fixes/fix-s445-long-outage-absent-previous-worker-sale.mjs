/**
 * 180 days offline: old owner cannot sign or close; system expires ONLY their
 * actual Shift without a fictitious count, and an unscheduled present cashier
 * independently opens theirs with own PIN/count/reason. POS sales work. This
 * isn't the old person's handover count or a system-absence-zero boundary.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s445-long-outage-absent-previous-worker-sale.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-outage-sale-s445-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر S445')
const absent = seed.user('مسئول قدیمی غایب S445')
const present = seed.user('مسئول امروز S445')
for (const id of [absent, present]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager445!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager445!' })
for (const [id, temp, final] of [[absent, 'AbsentTemp445!', 'AbsentFinal445!'], [present, 'PresentTemp445!', 'PresentFinal445!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager445!', reason: 'PIN مستقل برای وقفهٔ طولانی سیستم' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: final })
}
const cfg = JSON.parse(seed.one('SELECT value FROM "Setting" WHERE key=?', 'shift.config')?.value ?? '{}')
seed.setting('shift.config', { ...cfg, custodyModeConfigured: true, custodyMode: 'SINGLE_SHIFT',
  singleShiftCustodianUserId: absent })
const old = await custodyService.open({ userId: absent, password: 'AbsentFinal445!', countedCash: 200 })
const oldReceipt = seed.invoice({ receiptNo: 445001, grandTotal: 1000, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=? WHERE id=?').run(absent, old.shiftId, oldReceipt.id)
const past = new Date(Date.now() - 180 * 86400_000)
const cutoff = new Date(past.getTime() + 2 * 3600_000)
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(past.toISOString(), old.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?')
  .run(toJalaliDate(past), cutoff.toISOString(), old.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=?').run(toJalaliDate(past), old.shiftId)
// On restart there is no earlier PIN/count, and no timer has run in 180 days.
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 445, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const openingReason = 'مسئول اصلی بعد از ۱۸۰ روز خاموشی حاضر نیست؛ صندوق امروز را خودم شمردم.'
const opened = await invoke(IPC.custodyOpen, { userId: present,
  password: 'PresentFinal445!', operationalTotal: 700, note: openingReason })
eq('unplanned cashier opens without old owner PIN/count', opened.ok, true)
const newShiftId = opened.data?.shiftId
eq('current cashier owns only new Shift', seed.one('SELECT userId FROM "Shift" WHERE id=?', newShiftId)?.userId, present)
eq('old Shift ends at old cutoff, not today or on new worker count', Number(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt), cutoff.getTime())
eq('old owner remains old invoice owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', oldReceipt.id)?.userId, absent)
eq('old receipt remains old Shift evidence', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', oldReceipt.id)?.shiftId, old.shiftId)
eq('old Shift is unresolved, not signed by new worker', seed.one('SELECT status FROM "CustodyResolution" WHERE shiftId=?', old.shiftId)?.status, 'OPEN')
eq('new first actual count belongs to new Shift', seed.one('SELECT shiftId FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newShiftId, 'OPENING')?.shiftId, newShiftId)
eq('new worker actual count is 700, not yesterday close', seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newShiftId, 'OPENING')?.humanAmount, 700)
eq('180-day gap cannot invent a reliable reference', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newShiftId, 'OPENING')?.referenceAmount, null)
eq('no absent-count OUT snapshot is needed after expiry', seed.count('CustodyBlueSnapshot', 'shiftId=? AND role=?', old.shiftId, 'OUT'), 0)
eq('no old-person count was manufactured', seed.count('CustodyCount', 'shiftId=? AND kind=?', old.shiftId, 'BLUE_EMERGENCY_IN'), 0)
eq('reason is auditable on the replacement opening', seed.one('SELECT note FROM "AuditLog" WHERE action=? ORDER BY id DESC LIMIT 1', 'CUSTODY_UNSCHEDULED_OPEN')?.note, openingReason)
const product = seed.product('فروش بعد وقفه S445')
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=? WHERE id=?').run(10, variant)
const cash = seed.insert('PaymentMethod', { key: 'S445_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const sale = await invoke(IPC.saleCreate, { deductInventory: false,
  lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] })
eq('POS sale succeeds without any prior-worker count or PIN', sale.ok, true)
eq('new sale belongs only to present cashier', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, present)
eq('new sale is on the new Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, newShiftId)
console.log(`\n✓ ${checks} long-outage continuity checks passed`)
