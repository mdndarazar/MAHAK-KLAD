/** New return/exchange stock rule: non-C2C methods move returned goods immediately;
 * only a C2C return waits for manager payment. Replacement goods are deducted at once.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-goods-all-methods.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-all-goods-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { returnReceiptHtml, exchangeReceiptHtml } = await import('../../src/main/print/templates.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('immediate return stock test')
const cat = seed.category('return stock tests')
const product = seed.product('inventory item', cat)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'open shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const variant = (price) => {
  const id = seed.variant(product)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const stock = (id) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock)
const returnRow = (id) => seed.one('SELECT * FROM "SaleReturn" WHERE id=?', id)
const saleOf = async (price, qty = 1, deductInventory = true) => {
  const variantId = variant(price)
  const sale = await salesService.create({ userId, shiftId, deductInventory,
    lines: [{ variantId, qty, unitPrice: price, discount: 0, tax: 0 }],
    payments: [{ methodId: cash, amount: price * qty, destination: 'CASH' }] })
  const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
  return { sale, saleItemId, variantId }
}
const makeReturn = ({ sale, saleItemId }, method, amount) => salesService.createReturn({
  invoiceId: sale.id, full: true, lines: [{ saleItemId, qty: 1 }],
  refundMethod: method, refundAmount: amount, userId, shiftId, confirmOverpay: true,
  ...(method === 'CARD' ? { cardPosOverride: { acknowledgedNoReverse: true,
    reason: 'آزمون بازپرداخت کارتی', managerPassword: DEFAULT_MANAGER_PASSWORD } } : {})
})

// CASH, CARD, STORE_CREDIT and no-refund returns all restore stock in the return transaction.
for (const [method, amount] of [['NONE', 0], ['CASH', 100], ['CARD', 100], ['STORE_CREDIT', 100]]) {
  const source = await saleOf(100)
  const before = stock(source.variantId)
  const result = await makeReturn(source, method, amount)
  assert.equal(stock(source.variantId), before + 1, `${method}: returned item is immediately back in stock`)
  assert.equal(result.restocked, true)
  assert.equal(result.restockPending, false)
  assert.equal(result.goodsReceiptRequired, false)
  assert.equal(result.restockedQty, 1)
  assert.equal(seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', result.id).restockedQty, 1)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', result.id).n, 0,
    'no extra witness/receipt step is created')
  assert.equal((await returnGoodsService.items(result.id)).managed, false)
}
console.log('✓ NONE, CASH, CARD and STORE_CREDIT returns immediately restore the returned stock')

// C2C alone stays pending until the manager confirms the exact linked request.
{
  const source = await saleOf(100)
  const before = stock(source.variantId)
  const result = await makeReturn(source, 'CARD_TO_CARD', 100)
  assert.equal(stock(source.variantId), before)
  assert.equal(result.restocked, false)
  assert.equal(result.restockPending, true)
  assert.equal(result.goodsReceiptRequired, false)
  assert.equal(result.pendingRestockQty, 1)
  assert.ok(result.cardTransfer?.id)
  assert.equal((await returnGoodsService.items(result.id)).managed, false)
  const itemId = seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=?', result.id).id
  await assert.rejects(() => returnGoodsService.receive({ returnId: result.id, returnItemId: itemId,
    qty: 1, eventKey: 'c2c-physical-intake-is-not-a-release', witnessKind: 'SELECTED_CONFIRMED',
    witnessRef: 'کالای تحویل‌شده', physicalConfirmed: true, actorUserId: userId }), /کارت‌به‌کارت.*فقط با تأیید پرداخت مدیر/)
  assert.equal(stock(source.variantId), before)
  const cashMovementsBeforePay = seed.one('SELECT COUNT(*) n FROM "CashMovement"').n
  const paid = await cardTransferService.pay({ id: result.cardTransfer.id,
    managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
  assert.equal(paid.releasedQty, 1)
  assert.equal(paid.bankEvidenceState, 'UNKNOWN_BANK')
  assert.equal(paid.stockStillPending, false)
  assert.equal(stock(source.variantId), before + 1)
  assert.equal(returnRow(result.id).restockPending, 0)
  assert.equal(seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', result.id).restockedQty, 1)
  assert.equal(seed.one('SELECT COUNT(*) n FROM "CashMovement"').n, cashMovementsBeforePay,
    'manager confirmation does not create a cash-drawer movement')
  assert.equal(seed.one('SELECT stockReleasedQty FROM "CardTransferRequest" WHERE id=?', result.cardTransfer.id).stockReleasedQty, 1)
  await assert.rejects(() => cardTransferService.pay({ id: result.cardTransfer.id,
    managerPassword: DEFAULT_MANAGER_PASSWORD, userId }), /قبلاً پرداخت شده/)
  assert.equal(stock(source.variantId), before + 1, 'repeat payment cannot add stock twice')
}
console.log('✓ C2C waits for manager pay; no physical-intake bypass, no cash movement, no duplicate release')

// For every exchange settlement, the replacement leaves immediately. Non-C2C
// returns come back immediately; only a C2C refund waits for manager payment.
for (const [oldPrice, newPrice, refundMode] of [
  [100, 150, undefined], [100, 100, undefined], [150, 100, 'CASH'], [150, 100, 'CARD_TO_CARD']
]) {
  const source = await saleOf(oldPrice)
  const replacementVariant = variant(newPrice)
  const oldStock = stock(source.variantId)
  const replacementStock = stock(replacementVariant)
  const result = await salesService.createExchange({ invoiceId: source.sale.id,
    lines: [{ saleItemId: source.saleItemId, qty: 1 }],
    replacements: [{ variantId: replacementVariant, qty: 1 }],
    refundMode, methodId: cash, userId, shiftId })
  assert.equal(stock(replacementVariant), replacementStock - 1, 'replacement is always deducted immediately')
  if (refundMode === 'CARD_TO_CARD') {
    assert.equal(stock(source.variantId), oldStock)
    assert.equal(result.restockPending, true)
    assert.equal(result.goodsReceiptRequired, false)
    assert.ok(result.cardTransfer?.id)
    const paid = await cardTransferService.pay({ id: result.cardTransfer.id,
      managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
    assert.equal(paid.releasedQty, 1)
    assert.equal(stock(source.variantId), oldStock + 1)
    assert.equal(stock(replacementVariant), replacementStock - 1)
  } else {
    assert.equal(stock(source.variantId), oldStock + 1, `${refundMode ?? 'positive/zero'} exchange restores return immediately`)
    assert.equal(result.restockPending, false)
    assert.equal(result.goodsReceiptRequired, false)
    assert.equal(result.restockedQty, 1)
  }
}
console.log('✓ exchange stock timing: replacements always leave immediately; only C2C returns wait for manager pay')

// A sale that never deducted stock must not create stock on its return.
{
  const source = await saleOf(100, 1, false)
  const before = stock(source.variantId)
  const result = await makeReturn(source, 'NONE', 0)
  assert.equal(stock(source.variantId), before)
  assert.equal(result.restockedQty, 0)
  assert.equal(result.restockPending, false)
  assert.equal(result.goodsReceiptRequired, false)
}
console.log('✓ returns from non-deducted sales do not create phantom inventory')

// Customer-facing printouts describe the new split without implying a witness step.
const itemLine = { name: 'کالای برگشتی', qty: 1, unitPrice: 100, lineTotal: 100 }
const c2cReturnHtml = returnReceiptHtml({
  sourceReceiptNo: 1, dateJalali: '1405/01/01', time: '10:00', items: [itemLine], total: 100,
  refundMethod: 'CARD_TO_CARD', refundMethodLabel: 'کارت‌به‌کارت', refundAmount: 100,
  restocked: false, restockedQty: 0, restockPending: true, pendingRestockQty: 1, goodsReceiptRequired: false
})
assert.match(c2cReturnHtml, /تا تأیید پرداخت مدیرِ همین درخواست/)
assert.doesNotMatch(c2cReturnHtml, /بدون شاهد|رسید فیزیکی/)
const exchangeHtml = exchangeReceiptHtml({
  exchangeReceiptNo: 2, sourceReceiptNo: 1, dateJalali: '1405/01/01', time: '10:00',
  returnedItems: [itemLine], returnTotal: 100, replacementItems: [itemLine], exchangeTotal: 100,
  diff: 0, settlementLabel: 'بدون مابه‌التفاوت', cashReceived: 0, refundMethod: 'CARD_TO_CARD',
  goodsReceiptRequired: false, restockPending: true, restockedQty: 0, pendingRestockQty: 1
})
assert.match(exchangeHtml, /تا تأیید پرداخت مدیرِ همین درخواست/)
assert.doesNotMatch(exchangeHtml, /بدون شاهد/)
console.log('✓ return and exchange printouts say C2C awaits manager payment, not physical witness')
