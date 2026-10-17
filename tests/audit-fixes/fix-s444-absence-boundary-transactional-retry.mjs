/**
 * A failed absence witness after the old Shift closed / new Shift was created
 * must roll the ENTIRE transfer back. The present worker can retry with their
 * own PIN/count; an absent person's PIN/count is never needed to sell.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s444-absence-boundary-transactional-retry.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-absence-rollback-s444-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر S444')
const absent = seed.user('مسئول غایب S444')
const present = seed.user('صندوقدار حاضر S444')
for (const id of [absent, present]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager444!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager444!' })
for (const [id, temp, final] of [[absent, 'AbsentTemp444!', 'AbsentFinal444!'], [present, 'PresentTemp444!', 'PresentFinal444!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager444!', reason: 'PIN شخصی برای بازیابی تراکنشی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: final })
}
const old = await custodyService.open({ userId: absent, password: 'AbsentFinal444!', operationalTotal: 700 })
const oldInvoice = seed.invoice({ receiptNo: 444001, grandTotal: 700, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET shiftId=?, userId=? WHERE id=?').run(old.shiftId, absent, oldInvoice.id)
const reason = 'مسئول صندوق غایب است؛ صندوق‌دار حاضر موجودی آغاز مسئولیت خود را شمرد.'
const request = () => custodyService.emergencyCover({ userId: present, password: 'PresentFinal444!',
  operationalTotal: 700, reason })
db.$harness.breakNext('CustodyBlueSnapshot', 'create')
await assert.rejects(request, (error) => String(error?.message ?? '').includes('HARNESS-FAULT'),
  'injected persistence failure rejects rather than committing a partial transfer')
checks++; console.log('  ✓ injected failure is returned to the caller')
eq('failed transfer keeps only original Shift', seed.count('Shift'), 1)
eq('failed transfer leaves previous Shift open', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt, null)
eq('failed transfer retains actual old owner, never invents new owner', (await custodyService.status()).custodian?.id, absent)
eq('failed transfer has no partial new physical count', seed.count('CustodyCount', 'kind=?', 'BLUE_EMERGENCY_IN'), 0)
eq('failed transfer has no partial handover', seed.count('CustodyHandover'), 0)
eq('failed transfer has no partial system absence event', seed.count('CustodyEvent', 'type=?', 'BLUE_OUTGOING_UNCOUNTED_ABSENT'), 0)
const cover = await request()
eq('present worker can retry without old PIN or count', (await custodyService.status()).custodian?.id, present)
eq('retry opens only one new Shift', seed.count('Shift'), 2)
eq('retry has a new-Shift-only physical count', seed.one('SELECT shiftId FROM "CustodyCount" WHERE kind=?', 'BLUE_EMERGENCY_IN')?.shiftId, cover.shiftId)
eq('retry preserves unknown old departure', seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', cover.handoverId, 'OUT')?.humanAmount, null)
eq('retry leaves older sale with old owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.userId, absent)
const product = seed.product('فروش بعد از retry S444')
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=? WHERE id=?').run(10, variant)
const cash = seed.insert('PaymentMethod', { key: 'S444_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 444, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const sale = await handlers.get(IPC.saleCreate)({ sender }, { deductInventory: false,
  lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] })
eq('normal POS sale works immediately after successful retry', sale.ok, true)
eq('sale after retry belongs to actual new owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, present)
eq('sale after retry belongs to their new Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, cover.shiftId)
console.log(`\n✓ ${checks} atomic absence-retry checks passed`)
