/** Compensated returns remain historical evidence, NOT a second source of
 * stock. The posted ReturnCorrection is authoritative for all goods readers.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-correction-goods-guard.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-corrected-goods-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { pendingRestockService } = await import('../../src/main/services/PendingRestockService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('correction stock guard')
const category = seed.category('corrected goods')
const product = seed.product('scanned item', category)
const variantId = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=100 WHERE id=?').run(variantId)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'open shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const sale = await salesService.create({ userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 100, destination: 'CASH' }] })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
const ret = await salesService.createReturn({ invoiceId: sale.id, full: true,
  lines: [{ saleItemId, qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 100, userId, shiftId })
const goods = await returnGoodsService.items(ret.id)
assert.equal(goods.managed, false, 'C2C does not expose a separate physical-intake path')
const before = await pendingRestockService.summary()
assert.equal(before.totalQty, 1)
const stockBefore = seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock
const corrected = await salesService.returnReconcileVoid({ id: ret.id,
  reason: 'درخواست تکراریِ برگشت ثبت شده بود', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.ok(corrected)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?', ret.id).n, 1)
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', ret.id).voidedAt, null,
  'the original document remains as historical evidence')
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock, stockBefore)
const after = await pendingRestockService.summary()
assert.equal(after.totalQty, 0, 'corrected papers must not be listed as a live pending receipt')
assert.equal((await pendingRestockService.byVariant())[variantId] ?? 0, 0)
assert.equal((await returnGoodsService.items(ret.id)).corrected, true)
const input = { returnId: ret.id, returnItemId: seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=?', ret.id).id, qty: 1,
  eventKey: 'corrected-goods-never-receive', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'موجودی فیزیکی بررسی شد', physicalConfirmed: true, actorUserId: userId }
await assert.rejects(() => returnGoodsService.receive(input), /اصلاح جبرانی|تغییر|تازه/)
await assert.rejects(() => salesService.returnUpdate({ id: ret.id,
  lines: [{ saleItemId, qty: 1 }], panelPassword: DEFAULT_MANAGER_PASSWORD,
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'ثبت مجدد اشتباه', userId }), /اصلاح جبرانی/)
await assert.rejects(() => salesService.returnDelete({ id: ret.id, reason: 'ابطال دوم',
  panelPassword: DEFAULT_MANAGER_PASSWORD, userId }), /اصلاح جبرانی/)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', ret.id).n, 0)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock, stockBefore)
console.log('✓ corrected C2C return remains historical; pending/receive/edit/void cannot re-apply stock')
