/**
 * Absent old owner: NO departing count, zero, PIN or substitute witness. The
 * new worker's PIN/physical observation belong ONLY to their new Shift.
 * Same-day recovery is atomic; sales and old invoices retain their own owners.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s442-absent-giver-uncounted-new-owner-only.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-absent-uncounted-s442-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر S442')
const absent = seed.user('علی غایب S442')
const receiver = seed.user('سارا حاضر S442')
for (const id of [absent, receiver]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager442!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager442!' })
for (const [id, temp, pin] of [[absent, 'AbsentTemp442!', 'AbsentFinal442!'], [receiver, 'ReceiverTemp442!', 'ReceiverFinal442!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager442!', reason: 'PINهای مستقل برای مرز غیبت واقعی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
const old = await custodyService.open({ userId: absent, password: 'AbsentFinal442!', operationalTotal: 500 })
const invoice = seed.invoice({ receiptNo: 442001, grandTotal: 500, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET shiftId=?, userId=? WHERE id=?').run(old.shiftId, absent, invoice.id)
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 442, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const reason = 'علی حضور ندارد؛ سارا فقط موجودی آغاز مسئولیت خودش را شمرده است.'
const response = await invoke(IPC.custodyEmergencyCover, { userId: receiver,
  password: 'ReceiverFinal442!', operationalTotal: 700, countedCash: 999, reason })
eq('cashier independently assumes the drawer despite absent old PIN', response.ok, true)
const cover = response.data
const outgoing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', cover.handoverId, 'OUT')
const incoming = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', cover.handoverId, 'IN')
eq('absent OUT is recorded as UNCOUNTED, not zero', outgoing?.countOrigin, 'ABSENT_UNCOUNTED')
eq('no old PIN or counterfeit human attestation', outgoing?.authMethod, 'SYSTEM_ABSENCE')
eq('no absent physical count is fabricated', outgoing?.humanAmount, null)
eq('no absent arithmetic amount is fabricated', outgoing?.arithmeticAmount, null)
eq('no absent raw discrepancy is fabricated', outgoing?.rawDifference, null)
eq('no absent fresh discrepancy is fabricated', outgoing?.freshDifference, null)
eq('new count belongs to the incoming worker only', Number(incoming?.humanAmount), 700)
eq('new count is personally authenticated', incoming?.authMethod, 'CUSTODY_PIN')
eq('new IN snapshot belongs to new Shift', incoming?.shiftId, cover.shiftId)
eq('old OUT snapshot remains on old Shift', outgoing?.shiftId, old.shiftId)
eq('only the real new worker has a saved physical cover count', seed.count('CustodyCount', 'kind=?', 'BLUE_EMERGENCY_IN'), 1)
const ownCount = seed.one('SELECT * FROM "CustodyCount" WHERE kind=?', 'BLUE_EMERGENCY_IN')
eq('physical count belongs to new Shift, never old', ownCount?.shiftId, cover.shiftId)
eq('physical count belongs to new worker, never absent old', ownCount?.countedByUserId, receiver)
eq('forged legacy countedCash was discarded by public IPC', ownCount?.countedCash, 700)
eq('old Shift has no receiver-as-outgoing physical count', seed.count('CustodyCount', 'shiftId=? AND kind=?', old.shiftId, 'BLUE_EMERGENCY_IN'), 0)
eq('without comparable outgoing count, fresh difference stays unknown', incoming?.freshDifference, null)
eq('no automatic accusation is made', seed.count('CustodyDiscrepancyCase'), 0)
const absence = seed.one('SELECT actorUserId, actorKind, authMethod, payloadJson FROM "CustodyEvent" WHERE handoverId=? AND type=?', cover.handoverId, 'BLUE_OUTGOING_UNCOUNTED_ABSENT')
eq('absence is witnessed by SYSTEM, not the new employee impersonating old', absence?.actorUserId, null)
eq('absence is visibly a system event', absence?.actorKind, 'SYSTEM')
eq('system event contains no missing PIN or count', JSON.parse(absence?.payloadJson ?? '{}').outgoingHumanCount, null)
eq('system event cites the original owner', JSON.parse(absence?.payloadJson ?? '{}').absentCustodianUserId, absent)
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager442!', take: 100 })
const transfer = report.handovers.find((row) => row.id === cover.handoverId)
eq('manager report shows old side as uncounted', transfer?.blue?.outgoing?.humanAmount, null)
eq('old side is not projected as a count by receiver', transfer?.blue?.outgoing?.actorUserId, null)
eq('old handover count field never presents receiver count as old owner', transfer?.countedAtStart, null)
eq('manager report keeps new IN count separate', transfer?.blue?.incoming?.humanAmount, 700)
eq('manager count list assigns receiver observation to their new Shift',
  report.counts.find((row) => row.id === ownCount.id)?.shiftId, cover.shiftId)
eq('manager audit contains explicit SYSTEM absence event',
  report.events.some((row) => row.type === 'BLUE_OUTGOING_UNCOUNTED_ABSENT' && row.actorUserId == null && row.handoverId === cover.handoverId), true)
eq('earlier invoice keeps old responsible person', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', invoice.id)?.userId, absent)
eq('earlier invoice keeps original Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', invoice.id)?.shiftId, old.shiftId)
const product = seed.product('فروش پس از غیبت S442')
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=? WHERE id=?').run(10, variant)
const method = seed.insert('PaymentMethod', { key: 'S442_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const sale = await invoke(IPC.saleCreate, { deductInventory: false,
  lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: method, amount: 1_000_000, destination: 'CASH' }] })
eq('POS sale succeeds immediately after absence boundary', sale.ok, true)
eq('new sale is attributed only to current cashier', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, receiver)
eq('new sale is on the independent new Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, cover.shiftId)
console.log(`\n✓ ${checks} absent-uncounted new-owner checks passed`)
