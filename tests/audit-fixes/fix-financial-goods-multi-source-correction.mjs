/** One returned item can be received in parts from multiple sale allocations
 * and multiple physical warehouse rows. A correction must reverse exactly
 * those receipt sources, never a similarly named row or the store by default.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-goods-multi-source-correction.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-multi-source-correction-'))
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
const userId = seed.user('multi-source physical witness')
const product = seed.product('multi-warehouse jacket', seed.category('multi source'))
const variantId = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=1, salePrice=100 WHERE id=?').run(variantId)
const code = seed.one('SELECT code FROM "ProductVariant" WHERE id=?', variantId).code
const branchA = seed.insert('SecondaryWarehouse', { name: 'branch A', isActive: 1 })
const branchB = seed.insert('SecondaryWarehouse', { name: 'branch B', isActive: 1 })
const rowA1 = seed.insert('SecondaryStockItem', { name: 'A1', code, qty: 1, warehouseId: branchA })
const rowA2 = seed.insert('SecondaryStockItem', { name: 'A2', code, qty: 1, warehouseId: branchA })
const rowB = seed.insert('SecondaryStockItem', { name: 'B', code, qty: 1, warehouseId: branchB })
const shiftId = seed.insert('Shift', { name: 'cashier', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
const preview = await stockAllocationService.preview({ lines: [{ variantId, qty: 4 }] })
const sources = preview.lines[0].sources
const plan = resolveLine(preview.lines[0], optionKey(sources.find((s) => s.kind === 'STORE')),
  [{ type: 'SOURCE', key: optionKey(sources.find((s) => s.warehouseId === branchA)) },
   { type: 'SOURCE', key: optionKey(sources.find((s) => s.warehouseId === branchB)) }])
assert.equal(plan.complete, true, plan.error ?? 'incomplete plan')
assert.deepEqual(plan.entries.map((e) => [e.kind, e.warehouseId, e.qty]),
  [['STORE', null, 1], ['WAREHOUSE', branchA, 2], ['WAREHOUSE', branchB, 1]])
const sale = await salesService.create({ userId, shiftId, orderType: OrderType.WHOLESALE,
  lines: [{ variantId, qty: 4, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [], stockPlan: { lines: [{ variantId, entries: plan.entries }] } })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
const stock = () => [seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock,
  ...[rowA1, rowA2, rowB].map((id) => seed.one('SELECT qty FROM "SecondaryStockItem" WHERE id=?', id).qty)]
const allocations = () => seed.rows('SELECT id, sourceKind, warehouseId, restoredQty FROM "SaleItemStockAllocation" WHERE saleItemId=? ORDER BY id', saleItemId)
assert.deepEqual(stock(), [0, 0, 0, 0])
const ret = await salesService.createReturn({ invoiceId: sale.id, full: true,
  lines: [{ saleItemId, qty: 4 }], refundMethod: 'NONE', userId, shiftId })
const item = (await returnGoodsService.items(ret.id)).items[0]
const receive = (qty, eventKey) => returnGoodsService.receive({ returnId: ret.id,
  returnItemId: item.id, qty, eventKey, witnessKind: 'SCAN', witnessRef: code,
  physicalConfirmed: true, actorUserId: userId })
const first = await receive(2, 'multi-source-first')
const second = await receive(2, 'multi-source-second')
assert.deepEqual(stock(), [1, 1, 1, 1])
const receiptRows = () => seed.rows('SELECT id, receiptId, returnItemId, variantId, allocationId, sourceKind, warehouseId, warehouseName, secondaryStockItemId, stockItemName, stockItemCode, qty FROM "ReturnGoodsReceiptSource" ORDER BY id')
const sourcesRecorded = receiptRows()
assert.deepEqual(sourcesRecorded.map((r) => [r.receiptId, r.sourceKind, r.warehouseId, r.secondaryStockItemId, r.qty]),
  [[first.id, 'WAREHOUSE', branchB, rowB, 1], [first.id, 'WAREHOUSE', branchA, rowA1, 1],
   [second.id, 'WAREHOUSE', branchA, rowA2, 1], [second.id, 'STORE', null, null, 1]])
assert.ok(sourcesRecorded.every((r) => r.returnItemId === item.id && r.variantId === variantId && r.allocationId != null))
const beforeAlloc = allocations()
assert.deepEqual(beforeAlloc.map((r) => r.restoredQty), [1, 2, 1])
const correct = () => salesService.returnReconcileVoid({ id: ret.id,
  reason: 'بازگردانی دقیق منابع این دو رسید پس از شمارش واقعی', panelPassword: DEFAULT_MANAGER_PASSWORD })
// A row moved to another warehouse cannot be debited from its old location.
sql.prepare('UPDATE "SecondaryStockItem" SET warehouseId=? WHERE id=?').run(branchB, rowA1)
await assert.rejects(correct, /مبدأ|انبار|ردیف/)
assert.deepEqual(stock(), [1, 1, 1, 1])
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?', ret.id).n, 0)
sql.prepare('UPDATE "SecondaryStockItem" SET warehouseId=? WHERE id=?').run(branchA, rowA1)
// Even an old receipt with one missing source must not be backfilled by a guess.
sql.prepare('DELETE FROM "ReturnGoodsReceiptSource" WHERE id=?').run(sourcesRecorded[0].id)
await assert.rejects(correct, /مبدأ|رسید|انبار/)
assert.deepEqual(stock(), [1, 1, 1, 1])
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?', ret.id).n, 0)
const missing = sourcesRecorded[0]
sql.prepare('INSERT INTO "ReturnGoodsReceiptSource" (id, receiptId, returnItemId, variantId, allocationId, sourceKind, warehouseId, warehouseName, secondaryStockItemId, stockItemName, stockItemCode, qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(missing.id, missing.receiptId, missing.returnItemId, missing.variantId, missing.allocationId,
    missing.sourceKind, missing.warehouseId, missing.warehouseName,
    missing.secondaryStockItemId, missing.stockItemName, missing.stockItemCode, missing.qty)
// A failure after stock debits but before effect posting must roll back all stock and money.
sql.exec(`CREATE TRIGGER block_source_effect BEFORE INSERT ON "ReturnCorrectionEffect"
  WHEN NEW.type='WAREHOUSE_INVENTORY_OUT' BEGIN SELECT RAISE(ABORT, 'simulated effect failure'); END`)
await assert.rejects(correct, /simulated effect failure/)
assert.deepEqual(stock(), [1, 1, 1, 1])
assert.deepEqual(allocations(), beforeAlloc)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?', ret.id).n, 0)
sql.exec('DROP TRIGGER block_source_effect')
const correction = await correct()
assert.deepEqual(stock(), [0, 0, 0, 0], 'compensate all four received units from their four original rows/sources')
assert.deepEqual(allocations().map((r) => r.restoredQty), [0, 0, 0])
const effects = seed.rows('SELECT type, qty, variantId, referenceType, referenceId, detailsJson FROM "ReturnCorrectionEffect" WHERE correctionId=? AND qty>0 ORDER BY id', correction.id)
assert.deepEqual(effects.map((r) => [r.type, r.qty]),
  [['WAREHOUSE_INVENTORY_OUT', 1], ['WAREHOUSE_INVENTORY_OUT', 1],
   ['WAREHOUSE_INVENTORY_OUT', 1], ['INVENTORY_OUT', 1]])
assert.deepEqual(effects.map((r) => JSON.parse(r.detailsJson).receiptSourceId), sourcesRecorded.map((r) => r.id))
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', ret.id).n, 2)
assert.equal(seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE id=?', item.id).restockedQty, 4)
const purgePreview = await salesService.purgePreview({ invoiceIds: [sale.id] })
assert.equal(purgePreview.restoreLines.find((r) => r.variantId === variantId)?.qty, 4)
await salesService.purge({ invoiceIds: [sale.id], restoreStock: true, userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'تست بازگردانی از همان سه مبدأ اصلی' })
assert.deepEqual(stock(), [1, 1, 1, 1], 'purge after correction restores the original sale once to each source')
assert.equal(receiptRows().length, 4, 'purge does not erase receipt-source evidence')
console.log('✓ two receipts / three allocations / four physical sources; moved or missing source and partial failure fail closed; correction and purge reverse exactly once')
