/** Child of fix-financial-receipt-source-upgrade.mjs: opens the upgraded COPY,
 * not the migrator's throwaway connection. Never run against customer data. */
import assert from 'node:assert/strict'
const [warehouseReturnId, storeReturnId, stockRowId, allocationId, storeVariantId] = process.argv.slice(2).map(Number)
const { harnessClient } = await import('../../../test/harness/stubs/prismaClient.mjs')
const { salesService } = await import('../../../src/main/services/SalesService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const sql = db.$harness.db
const userId = Number(sql.prepare('SELECT userId FROM "SaleReturn" WHERE id=?').get(warehouseReturnId).userId)
const correct = (id) => salesService.returnReconcileVoid({ id, userId,
  reason: 'رسید تاریخی روی کپی ارتقا بررسی شد', panelPassword: DEFAULT_MANAGER_PASSWORD })
await assert.rejects(() => correct(warehouseReturnId), /مبدأ|رسید|انبار/,
  'the old branch receipt has no actual source row; debit must not be guessed')
assert.equal(sql.prepare('SELECT qty FROM "SecondaryStockItem" WHERE id=?').get(stockRowId).qty, 2)
assert.equal(sql.prepare('SELECT restoredQty FROM "SaleItemStockAllocation" WHERE id=?').get(allocationId).restoredQty, 2)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "ReturnCorrection" WHERE returnId=?').get(warehouseReturnId).n, 0)
console.log('✓ legacy warehouse receipt blocked without a guessed source')
const correction = await correct(storeReturnId)
assert.ok(correction.id)
assert.equal(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id=?').get(storeVariantId).stock, 4)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "ReturnCorrectionEffect" WHERE correctionId=? AND type=?').get(correction.id, 'INVENTORY_OUT').n, 1)
assert.equal(sql.prepare('SELECT COUNT(*) n FROM "ReturnGoodsReceiptSource"').get().n, 0,
  'even successful legacy store correction never backfills historic receipts')
console.log('✓ store-only historic receipt compensated without inventing a source row')
