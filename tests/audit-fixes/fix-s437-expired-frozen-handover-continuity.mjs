/**
 * A pre-blue handover may have committed its short recount freeze just before
 * the old app lost power. Even after 180 days, nobody should need either old
 * person's PIN: system expiry ends the ACTUAL old Shift as unresolved, then a
 * named worker supplies their own PIN, new physical total and reason to open.
 * No old count, sale, invoice or case is assigned to the new worker.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s437-expired-frozen-handover-continuity.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-expired-frozen-s437-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { parseShiftConfig } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(); const seed = makeSeeder(db); const sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
async function rejects(label, code, fn) {
  await assert.rejects(fn, (error) => error?.code === code, label)
  checks++; console.log(`  ✓ ${label}`)
}
const manager = seed.user('مدیر S437')
const oldOwner = seed.user('مسئول قدیمی S437')
const oldReceiver = seed.user('گیرندهٔ ناتمام S437')
const newOwner = seed.user('صندوق‌دار حاضر S437')
for (const id of [oldOwner, oldReceiver, newOwner]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager437!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager437!' })
for (const [id, temporary, permanent] of [[oldOwner, 'OldTemp437!', 'OldFinal437!'], [oldReceiver, 'ReceiverTemp437!', 'ReceiverFinal437!'], [newOwner, 'NewTemp437!', 'NewFinal437!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager437!', reason: 'صدور PIN برای آزمون بازیابی پس از وقفه' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
const before = parseShiftConfig(await settingsService.shiftConfig())
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...before, custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: oldOwner },
  managerUserId: manager, managerPassword: 'Manager437!', reason: 'مسئول روزانهٔ قدیمی پس از قطع برق در محل حضور ندارد' })
const old = await custodyService.open({ userId: oldOwner, password: 'OldFinal437!', countedCash: 0 })
const oldInvoice = seed.invoice({ receiptNo: 437001, grandTotal: 200, status: 'SETTLED' })
const past = new Date(Date.now() - 180 * 86400000)
sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=?, issuedAtJalali=? WHERE id=?').run(oldOwner, old.shiftId, toJalaliDate(past), oldInvoice.id)
const handover = await custodyService.handoverStart({ password: 'OldFinal437!', operationalTotal: 0,
  toUserId: oldReceiver, idempotencyKey: 's437-old-handover' })
eq('historical handover remains pending before outage', (await custodyService.status()).state, 'HANDOVER_PENDING')
const oldOutCount = seed.one('SELECT outCountId FROM "CustodyHandover" WHERE id=?', handover.id)?.outCountId
// Model the first committed transaction in handoverAccept before its following
// calculation/commit: this intermediate state can survive a crash. The test
// fixture alone moves timestamps; production documents are never modified.
sql.prepare('UPDATE "CustodyState" SET state=?, epoch=epoch+1 WHERE key=?').run('HANDOVER_RECOUNT', 'MAIN')
sql.prepare('UPDATE "Shift" SET openedAt=?, dayJalali=? WHERE id=?').run(past.getTime(), toJalaliDate(past), old.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=?, scheduledEndAt=?, operationalDay=? WHERE shiftId=?')
  .run(past.getTime(), past.getTime(), toJalaliDate(past), old.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=?').run(toJalaliDate(past), old.shiftId)
const closeCount = seed.count('Shift')
await rejects('bad replacement PIN does not take over the expired drawer', 'PIN_WRONG',
  () => custodyService.open({ userId: newOwner, password: 'bad', operationalTotal: 0, note: 'تحویل قدیمی ناتمام است و صندوق را شمردم' }))
eq('wrong PIN does not roll or close old evidence', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt, null)
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 437, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const reason = 'تحویل قدیمی هنگام قطع سیستم ناتمام ماند؛ مبلغ واقعی را خودم شمارش کردم.'
// NO preceding status() call: the public command itself must roll over an
// expired frozen Shift rather than reusing an old amount or waiting for it.
const response = await invoke(IPC.custodyOpen, { userId: newOwner, password: 'NewFinal437!', operationalTotal: 0, note: reason })
eq('public opening after expired freeze succeeds without either previous PIN', response.ok, true)
const opened = response.data
eq('new worker has their own Shift', seed.one('SELECT userId FROM "Shift" WHERE id=?', opened?.shiftId)?.userId, newOwner)
eq('only one new Shift is made', seed.count('Shift'), closeCount + 1)
eq('old Shift is closed at its persisted deadline, not falsely at detection', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt, past.getTime())
eq('old receipt belongs to old owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.userId, oldOwner)
eq('old invoice still has its original Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.shiftId, old.shiftId)
eq('unfinished historical handover is ended as unresolved, not accepted', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', handover.id)?.status, 'EXPIRED_UNRESOLVED')
eq('previous real outgoing count remains independently stored', seed.one('SELECT countedCash FROM "CustodyCount" WHERE id=?', oldOutCount)?.countedCash, 0)
eq('old expired case remains open for manager review', seed.count('CustodyResolution', 'shiftId=? AND status=?', old.shiftId, 'OPEN'), 1)
eq('no old CashSession was invented', seed.count('CashSession'), 0)
const rolloverEvent = seed.one('SELECT payloadJson FROM "CustodyEvent" WHERE type=? AND shiftId=?', 'ROLLOVER_UNRESOLVED', old.shiftId)
eq('audit names the frozen state that was retired', JSON.parse(rolloverEvent?.payloadJson ?? '{}').previousState, 'HANDOVER_RECOUNT')
const exception = seed.one('SELECT actorUserId, payloadJson FROM "CustodyEvent" WHERE type=? AND shiftId=?', 'OPEN_UNSCHEDULED', opened.shiftId)
eq('out-of-plan opening names only the actual replacement', exception?.actorUserId, newOwner)
eq('replacement reason is durable', JSON.parse(exception?.payloadJson ?? '{}').reason, reason)
const blue = seed.one('SELECT humanAmount, referenceAmount, rawDifference, freshDifference, referenceStatus FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'OPENING', opened.shiftId)
eq('explicit zero is a real new observation, not the old count', Number(blue?.humanAmount), 0)
eq('180-day gap has no fabricated official reference', blue?.referenceAmount, null)
eq('180-day gap has no blamed difference', blue?.freshDifference, null)
const product = seed.product('کالای پس از وقفه S437')
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=? WHERE id=?').run(10, variant)
const cash = seed.insert('PaymentMethod', { key: 'S437_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const sale = await invoke(IPC.saleCreate, { deductInventory: false,
  lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] })
eq('actual POS sale after 180 days succeeds', sale.ok, true)
eq('new invoice belongs to new worker', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, newOwner)
eq('new invoice belongs to new Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, opened.shiftId)
console.log(`\n✓ ${checks} expired-frozen handover continuity checks passed`)
