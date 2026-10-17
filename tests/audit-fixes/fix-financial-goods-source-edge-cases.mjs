/** Central-warehouse logical null vs real physical row, separate returns on
 * one allocation, and a sale row relocated before receipt. No guessed STORE.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-goods-source-edge-cases.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-source-edge-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { stockAllocationService } = await import('../../src/main/services/StockAllocationService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { optionKey, resolveLine } = await import('@shared/stockSource')
const { OrderType } = await import('@shared/enums')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('default warehouse return')
const cat = seed.category('tracked default')
const shiftId = seed.insert('Shift', { name: 'open', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const defaultId = seed.one('SELECT id FROM "SecondaryWarehouse" WHERE isDefault=1 ORDER BY id LIMIT 1').id
assert.ok(defaultId, 'base migrations seed a real default warehouse')
const branchA = seed.insert('SecondaryWarehouse', { name: 'other source', isActive: 1 })
const branchB = seed.insert('SecondaryWarehouse', { name: 'destination', isActive: 1 })
const newVariant = (label) => {
  const id = seed.variant(seed.product(label, cat))
  sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=100 WHERE id=?').run(id)
  return { id, code: seed.one('SELECT code FROM "ProductVariant" WHERE id=?', id).code }
}
const sellFrom = async (variantId, qty, warehouseId) => {
  const line = (await stockAllocationService.preview({ lines: [{ variantId, qty }] })).lines[0]
  const chosen = line.sources.find((s) => s.kind === 'WAREHOUSE' && s.warehouseId === warehouseId)
  assert.ok(chosen)
  const plan = resolveLine(line, optionKey(chosen), [])
  assert.equal(plan.complete, true, JSON.stringify({ chosen, plan }))
  const sale = await salesService.create({ userId, shiftId, orderType: OrderType.WHOLESALE,
    lines: [{ variantId, qty, unitPrice: 100, discount: 0, tax: 0 }],
    payments: [], stockPlan: { lines: [{ variantId, entries: plan.entries }] } })
  const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
  const allocation = seed.one('SELECT id, warehouseId FROM "SaleItemStockAllocation" WHERE saleItemId=?', saleItemId)
  return { sale, saleItemId, allocation }
}
const retOf = async (sale, saleItemId) => salesService.createReturn({ invoiceId: sale.id, full: false,
  lines: [{ saleItemId, qty: 1 }], refundMethod: 'NONE', userId, shiftId })
const receive = async (ret, code, key) => {
  const item = (await returnGoodsService.items(ret.id)).items[0]
  return returnGoodsService.receive({ returnId: ret.id, returnItemId: item.id,
    qty: 1, eventKey: key, witnessKind: 'SCAN', witnessRef: code,
    physicalConfirmed: true, actorUserId: userId })
}
const correct = (ret) => salesService.returnReconcileVoid({ id: ret.id,
  reason: 'جبران ردیف شاهددار همان انبار مبدأ', panelPassword: DEFAULT_MANAGER_PASSWORD })
const central = newVariant('default receipt source')
const centralRow = seed.insert('SecondaryStockItem', { name: 'physical default row', code: central.code, qty: 2, warehouseId: defaultId })
const centralSale = await sellFrom(central.id, 2, null)
assert.equal(centralSale.allocation.warehouseId, null, 'sale plan uses the logical central warehouse')
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', centralRow).qty, 0)
const first = await retOf(centralSale.sale, centralSale.saleItemId)
const firstReceipt = await receive(first, central.code, 'default-source-first')
const second = await retOf(centralSale.sale, centralSale.saleItemId)
const secondReceipt = await receive(second, central.code, 'default-source-second')
const recorded = seed.rows('SELECT receiptId, sourceKind, warehouseId, secondaryStockItemId, qty FROM "ReturnGoodsReceiptSource" WHERE variantId=? ORDER BY id', central.id)
assert.deepEqual(recorded, [firstReceipt, secondReceipt].map((r) => ({ receiptId: r.id,
  sourceKind: 'WAREHOUSE', warehouseId: defaultId, secondaryStockItemId: centralRow, qty: 1 })))
assert.equal(seed.one('SELECT restoredQty FROM "SaleItemStockAllocation" WHERE id=?', centralSale.allocation.id).restoredQty, 2)
// Editing the stock row for a DIFFERENT item must not let correction remove
// someone else's goods; the saved physical row identity includes name/code.
sql.prepare('UPDATE "SecondaryStockItem" SET code=? WHERE id=?').run('unrelated-product', centralRow)
await assert.rejects(() => correct(first), /مبدأ|رسید|ردیف/)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', centralRow).qty, 2)
sql.prepare('UPDATE "SecondaryStockItem" SET code=? WHERE id=?').run(central.code, centralRow)
await correct(first)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', centralRow).qty, 1)
assert.equal(seed.one('SELECT restoredQty FROM "SaleItemStockAllocation" WHERE id=?', centralSale.allocation.id).restoredQty, 1,
  'compensating one return cannot erase another receipt on the same allocation')
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', central.id).stock, 10)
await correct(second)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', centralRow).qty, 0)
assert.equal(seed.one('SELECT restoredQty FROM "SaleItemStockAllocation" WHERE id=?', centralSale.allocation.id).restoredQty, 0)
console.log('✓ logical central warehouse/null uses its real row; independent receipts share the allocation without cross-debit; repurposed row blocked')

const moved = newVariant('relocated sale row')
const oldRow = seed.insert('SecondaryStockItem', { name: 'original A', code: moved.code, qty: 1, warehouseId: branchA })
const movedSale = await sellFrom(moved.id, 1, branchA)
sql.prepare('UPDATE "SecondaryStockItem" SET warehouseId=? WHERE id=?').run(branchB, oldRow)
const movedRet = await retOf(movedSale.sale, movedSale.saleItemId)
const movedReceipt = await receive(movedRet, moved.code, 'moved-original-row')
const actual = seed.one('SELECT warehouseId, secondaryStockItemId, stockItemCode FROM "ReturnGoodsReceiptSource" WHERE receiptId=?', movedReceipt.id)
assert.equal(actual.warehouseId, branchA)
assert.notEqual(actual.secondaryStockItemId, oldRow, 'the moved old row must not receive goods in branch B')
assert.equal(actual.stockItemCode, moved.code)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', oldRow).qty, 0)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', actual.secondaryStockItemId).qty, 1)
await correct(movedRet)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', actual.secondaryStockItemId).qty, 0)
assert.equal(seed.one('SELECT warehouseId FROM "SecondaryStockItem" WHERE id=?', oldRow).warehouseId, branchB)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', moved.id).stock, 10)
console.log('✓ relocated sale row is not credited/debited in the wrong branch; actual receipt row is captured and compensated')

const exchanged = newVariant('warehouse exchange return')
const replacement = newVariant('exchange replacement')
const exchangeRow = seed.insert('SecondaryStockItem', { name: 'source of exchange', code: exchanged.code, qty: 1, warehouseId: branchA })
const exchangeSale = await sellFrom(exchanged.id, 1, branchA)
const ex = await salesService.createExchange({ invoiceId: exchangeSale.sale.id,
  lines: [{ saleItemId: exchangeSale.saleItemId, qty: 1 }],
  replacements: [{ variantId: replacement.id, qty: 1 }], userId, shiftId })
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacement.id).stock, 9)
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', exchangeRow).qty, 0)
await receive({ id: ex.returnId }, exchanged.code, 'warehouse-exchange-witness')
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', exchangeRow).qty, 1)
const exchangeCorrection = await correct({ id: ex.returnId })
assert.equal(seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', exchangeRow).qty, 0)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', exchanged.id).stock, 10)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacement.id).stock, 10)
assert.equal(seed.one('SELECT restoredQty FROM "SaleItemStockAllocation" WHERE id=?', exchangeSale.allocation.id).restoredQty, 0)
assert.deepEqual(seed.rows('SELECT type, qty FROM "ReturnCorrectionEffect" WHERE correctionId=? AND qty>0 ORDER BY id', exchangeCorrection.id),
  [{ type: 'WAREHOUSE_INVENTORY_OUT', qty: 1 }, { type: 'EXCHANGE_REPLACEMENT_IN', qty: 1 }])
console.log('✓ wholesale exchange: received source leaves exactly its branch; replacement returns to store, both effects witnessed')
