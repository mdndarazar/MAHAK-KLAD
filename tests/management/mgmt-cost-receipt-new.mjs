/** New (not pre-cutover) physical intake is the only event that returns a
 * sold item to its FIFO lot. Finance-only return and replay must not do it.
 * node --import ./test/harness/register.mjs tests/management/mgmt-cost-receipt-new.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-cost-physical-new-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
process.env.HARNESS_BIGINT = '1'
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { costEngine } = await import('../../src/main/services/management/CostEngine.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('FIFO witnessed goods')
const variantId = seed.variant(seed.product('lot goods', seed.category('new FIFO')))
sql.prepare('UPDATE "ProductVariant" SET stock=0, salePrice=200, purchasePrice=0 WHERE id=?').run(variantId)
const now = Date.now()
const today = toJalaliDate(new Date(now))
const shiftId = seed.insert('Shift', { name: 'FIFO open shift', number: 1, userId,
  dayJalali: today, openedAt: now - 10_000 })
const purchaseId = seed.insert('PurchaseInvoice', { invoiceNo: 5678901,
  issuedAtJalali: today, issuedAt: now, goodsTotal: 200, discountTotal: 0,
  grandTotal: 200, status: 'CONFIRMED' })
seed.insert('PurchaseInvoiceItem', { invoiceId: purchaseId, variantId, qty: 2,
  unitPrice: 100, lineTotal: 200 })
seed.insert('StockMovement', { variantId, delta: 2, reason: 'PURCHASE',
  refType: 'PurchaseInvoice', refId: purchaseId, state: 'FINAL', createdAt: now })
sql.prepare('UPDATE "ProductVariant" SET stock=2, purchasePrice=100 WHERE id=?').run(variantId)
const sale = await salesService.create({ userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 200, discount: 0, tax: 0 }], payments: [] })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
const lots = () => Number(seed.one('SELECT COALESCE(SUM(qtyLeft),0) qty FROM "PurchaseLot" WHERE variantId=?', variantId).qty)
const stock = () => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
await costEngine.run()
assert.equal(lots(), 1)
const ret = await salesService.createReturn({ invoiceId: sale.id, full: true,
  lines: [{ saleItemId, qty: 1 }], refundMethod: 'NONE', userId })
assert.equal(ret.goodsReceiptRequired, true)
await costEngine.run()
assert.deepEqual([lots(), stock()], [1, 1], 'financial return cannot fabricate a FIFO lot')
const good = (await returnGoodsService.items(ret.id)).items[0]
const input = { returnId: ret.id, returnItemId: good.id, qty: 1,
  eventKey: 'physical-cost-fifo-once', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'این قلم شمارش و تحویل شد', physicalConfirmed: true, actorUserId: userId }
await returnGoodsService.receive(input)
await costEngine.run()
assert.deepEqual([lots(), stock()], [2, 2], 'physical receipt restores original lot and stock')
assert.equal((await returnGoodsService.receive(input)).replayed, true)
await costEngine.run()
assert.deepEqual([lots(), stock()], [2, 2], 'retry cannot inflate the lot')
console.log('✓ new witnessed goods, not settlement, restores FIFO once and replay remains idempotent')
