/** A witnessed wholesale return must retain the exact warehouse row in its
 * receipt, and compensation must undo only the received quantity there.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-goods-warehouse.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-goods-warehouse-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { stockAllocationService } = await import('../../src/main/services/StockAllocationService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { pendingRestockService } = await import('../../src/main/services/PendingRestockService.ts')
const { optionKey, resolveLine } = await import('@shared/stockSource')
const { OrderType } = await import('@shared/enums')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('wholesale witnessed')
const cat = seed.category('wholesale goods')
const product = seed.product('wholesale variant', cat)
const variantId = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=100 WHERE id=?').run(variantId)
const warehouseId = seed.insert('SecondaryWarehouse', { name: 'branch A', isActive: 1, sortOrder: 1 })
const code = seed.one('SELECT code FROM "ProductVariant" WHERE id=?', variantId).code
const warehouseItemId = seed.insert('SecondaryStockItem', { name: 'warehouse item', code, qty: 5, warehouseId })
const shiftId = seed.insert('Shift', { name: 'open wholesale shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const preview = await stockAllocationService.preview({ lines: [{ variantId, qty: 2 }] })
const source = preview.lines[0].sources.find((s) => s.warehouseId === warehouseId)
assert.ok(source)
const resolved = resolveLine(preview.lines[0], optionKey(source), [])
assert.equal(resolved.complete, true)
const sale = await salesService.create({ userId, shiftId, orderType: OrderType.WHOLESALE,
  lines: [{ variantId, qty: 2, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [], stockPlan: { lines: [{ variantId, entries: resolved.entries }] } })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
const store = () => seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock
const warehouse = () => seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', warehouseItemId).qty
const allocation = () => seed.one('SELECT id, restoredQty FROM "SaleItemStockAllocation" WHERE saleItemId=?', saleItemId)
assert.deepEqual([store(), warehouse(), allocation().restoredQty], [10, 3, 0])
const ret = await salesService.createReturn({ invoiceId: sale.id, full: true,
  lines: [{ saleItemId, qty: 2 }], refundMethod: 'NONE', userId, shiftId })
assert.deepEqual([store(), warehouse(), allocation().restoredQty], [10, 3, 0], 'document alone cannot restore warehouse stock')
assert.equal((await pendingRestockService.summary()).unconfirmedQty, 2)
const item = (await returnGoodsService.items(ret.id)).items[0]
const receive = (key) => returnGoodsService.receive({ returnId: ret.id, returnItemId: item.id,
  qty: 1, eventKey: key, witnessKind: 'SCAN', witnessRef: code,
  physicalConfirmed: true, actorUserId: userId })
const one = await receive('warehouse-witness-first')
assert.equal(one.restoredToWarehouses, 1)
assert.deepEqual([store(), warehouse(), allocation().restoredQty], [10, 4, 1])
assert.deepEqual(seed.rows('SELECT receiptId, returnItemId, variantId, allocationId, sourceKind, warehouseId, secondaryStockItemId, qty FROM "ReturnGoodsReceiptSource"'), [
  { receiptId: one.id, returnItemId: item.id, variantId, allocationId: allocation().id,
    sourceKind: 'WAREHOUSE', warehouseId, secondaryStockItemId: warehouseItemId, qty: 1 }
])
const correction = await salesService.returnReconcileVoid({ id: ret.id,
  reason: 'اصلاح شاهددار همان یک واحد دریافت شده از انبار شعبه', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.ok(correction)
assert.deepEqual([store(), warehouse(), allocation().restoredQty], [10, 3, 0], 'only the received warehouse unit is debited')
assert.deepEqual(seed.rows('SELECT type, qty, variantId FROM "ReturnCorrectionEffect" WHERE correctionId=? AND qty>0', correction.id), [
  { type: 'WAREHOUSE_INVENTORY_OUT', qty: 1, variantId }
])
assert.equal(seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE id=?', item.id).restockedQty, 1, 'historical receipt remains intact')
await assert.rejects(() => receive('warehouse-witness-second'), /اصلاح جبرانی/)
await assert.rejects(() => salesService.returnReconcileVoid({ id: ret.id,
  reason: 'اصلاح دوباره ممنوع', panelPassword: DEFAULT_MANAGER_PASSWORD }), /قبلاً|دوباره/)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?', ret.id).n, 1)
assert.equal((await pendingRestockService.summary()).items.some((i) => i.returnId === ret.id), false)
console.log('✓ partial warehouse receipt: exact source row persisted, only received unit compensated, replay blocked')
