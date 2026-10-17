/** Every NEW inventory-deducted return/exchange needs its own physical receipt,
 * independently of refund, credit, debt and bank. Historical rows remain as-is.
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
const { pendingRestockService } = await import('../../src/main/services/PendingRestockService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('physical goods test')
const cat = seed.category('goods tests')
const product = seed.product('inventory item', cat)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'open shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000 })
const v = (price) => { const id = seed.variant(product)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id }
const stock = (id) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock)
const retRow = (id) => seed.one('SELECT * FROM "SaleReturn" WHERE id=?', id)
const goodsInput = (returnId, returnItemId, qty, eventKey) => ({ returnId, returnItemId, qty, eventKey,
  witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'کالاها شمارش و مشاهده شدند', physicalConfirmed: true, actorUserId: userId })
const saleOf = async (price, qty, paid, deductInventory = true) => {
  const variantId = v(price)
  const sale = await salesService.create({ userId, shiftId, deductInventory,
    lines: [{ variantId, qty, unitPrice: price, discount: 0, tax: 0 }],
    payments: paid ? [{ methodId: cash, amount: paid, destination: 'CASH' }] : [] })
  const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
  return { sale, saleItemId, variantId }
}
const retOf = ({ sale, saleItemId }, qty, refundMethod, refundAmount, opts) =>
  salesService.createReturn({ invoiceId: sale.id, full: true,
    lines: [{ saleItemId, qty }], refundMethod, refundAmount, userId, shiftId,
    ...(refundMethod === 'CARD' ? { cardPosOverride: { acknowledgedNoReverse: true,
      reason: 'آزمون تأیید بازپرداخت واقعی کارت', managerPassword: DEFAULT_MANAGER_PASSWORD } } : {}) }, opts)

// Debt-only case: old immediate restock must NOT be mistaken for physical proof.
const unpaid = await saleOf(100, 3, 0)
assert.equal(stock(unpaid.variantId), 97)
const ret = await retOf(unpaid, 3, 'NONE')
assert.equal(stock(unpaid.variantId), 97, 'money-free return cannot fabricate physical receipt')
assert.equal(retRow(ret.id).goodsReceiptRequired, 1)
assert.equal(retRow(ret.id).restockPending, 1)
assert.equal(seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE returnId=?', ret.id).restockedQty, 0)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', ret.id).n, 0)
const pending = await pendingRestockService.summary()
assert.equal(pending.unconfirmedQty, 3)
assert.equal(pending.byVariant[unpaid.variantId], 3)
assert.equal(pending.physicalByVariant?.[unpaid.variantId] ?? 0, 0)
assert.equal((await pendingRestockService.byVariant())[unpaid.variantId] ?? 0, 0)
const activeRow = (await salesService.returnList({ take: 200 })).find((row) => row.id === ret.id)
assert.equal(activeRow?.goodsReceiptRequired, true)
assert.equal(activeRow?.pendingRestockQty, 3)
assert.equal(activeRow?.corrected, false)
const pendingPaper = await printService.returnHtml(ret.id)
assert.match(pendingPaper, /هنوز بدون شاهد/)
assert.doesNotMatch(pendingPaper, /به انبار برگشت \(۳ عدد\)/)
const goods = await returnGoodsService.items(ret.id)
assert.equal(goods.managed, true)
assert.equal(goods.state, 'GOODS_ONLY')
const itemId = goods.items[0].id
await assert.rejects(() => returnGoodsService.receive(goodsInput(ret.id, itemId, 4, 'qty-overflow-not-allowed')),
  /تغییر|تازه/)
const first = goodsInput(ret.id, itemId, 1, 'nonbank-goods-first-once')
assert.equal((await returnGoodsService.receive(first)).releasedQty, 1)
assert.equal((await returnGoodsService.receive(first)).replayed, true)
assert.equal(stock(unpaid.variantId), 98)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement" WHERE returnId=?', ret.id).n, 0,
  'no fake bank/entitlement row for NONE')
assert.equal(seed.one('SELECT COUNT(*) n FROM "CardTransferRequest" WHERE returnId=?', ret.id).n, 0)
assert.equal(seed.one('SELECT action FROM "AuditLog" WHERE entity=? AND entityId=?', 'ReturnGoodsReceipt', 1).action,
  'RETURN_GOODS_RECEIVE')
const second = goodsInput(ret.id, itemId, 2, 'nonbank-goods-second-once')
assert.equal((await returnGoodsService.receive(second)).allReceived, true)
assert.equal(stock(unpaid.variantId), 100)
assert.equal(retRow(ret.id).restockPending, 0)
assert.equal((await pendingRestockService.summary()).byVariant[unpaid.variantId] ?? 0, 0)
await assert.rejects(() => returnGoodsService.receive(goodsInput(ret.id, itemId, 1, 'nonbank-third-must-fail')),
  /تغییر|تازه/)
console.log('✓ NONE/debt: no immediate stock; 1+2 witnessed receipts; replay does not re-add goods or bank proof')

// Receipt links survive a financial correction. The original restockPending
// flag remains true for history, but the correction ends the actionable case.
const partial = await saleOf(100, 2, 0)
const partialReturn = await retOf(partial, 2, 'NONE')
const goods2 = await returnGoodsService.items(partialReturn.id)
await returnGoodsService.receive(goodsInput(partialReturn.id, goods2.items[0].id, 1, 'partial-before-correction'))
assert.equal(stock(partial.variantId), 99)
await assert.rejects(() => salesService.returnUpdate({ id: partialReturn.id,
  lines: [{ saleItemId: partial.saleItemId, qty: 2 }], panelPassword: DEFAULT_MANAGER_PASSWORD,
  userId, overrideReason: 'تست ویرایش مستقیم' }), /رسید فیزیکی/)
await assert.rejects(() => salesService.returnDelete({ id: partialReturn.id,
  reason: 'تست ابطال مستقیم', panelPassword: DEFAULT_MANAGER_PASSWORD, userId }), /رسید فیزیکی/)
const correction = await salesService.returnReconcileVoid({ id: partialReturn.id,
  reason: 'اشتباه ثبتی با رسید فیزیکی جزئی', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.ok(correction)
assert.equal(stock(partial.variantId), 98, 'compensate only the witnessed unit')
assert.equal(retRow(partialReturn.id).restockPending, 1, 'original paper is not rewritten')
assert.equal((await pendingRestockService.summary()).items.some((i) => i.returnId === partialReturn.id), false)
assert.equal((await returnGoodsService.items(partialReturn.id)).corrected, true)
const correctedRow = (await salesService.returnList({ take: 200 })).find((row) => row.id === partialReturn.id)
assert.equal(correctedRow?.corrected, true)
assert.equal(correctedRow?.restockPending, false)
assert.equal(correctedRow?.pendingRestockQty, 0)
assert.match(await printService.returnHtml(partialReturn.id), /اصلاح جبرانی ثبت شده است/)
await assert.rejects(() => returnGoodsService.receive(goodsInput(partialReturn.id, goods2.items[0].id, 1,
  'attempt-after-correction')), /اصلاح جبرانی/)
assert.equal(stock(partial.variantId), 98)
const purgePreview = await salesService.purgePreview({ invoiceIds: [partial.sale.id] })
assert.equal(purgePreview.restoreLines.find((i) => i.variantId === partial.variantId)?.qty, 2,
  'purge must restore both sold units: the first physical receipt was already compensated')
await salesService.purge({ invoiceIds: [partial.sale.id], restoreStock: true, userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'تست بازگردانی کالای اصلاح شده' })
assert.equal(stock(partial.variantId), 100, 'actual purge also restores the correct net, not just preview')
console.log('✓ partial receipt + correction: only proven stock compensated; no subsequent receipt or direct edit/void')

// The new protocol is independent of CASH, CARD, credit issuance and C2C.
for (const method of ['CASH', 'CARD', 'STORE_CREDIT', 'CARD_TO_CARD']) {
  const source = await saleOf(200, 1, 200)
  const before = stock(source.variantId)
  const document = await retOf(source, 1, method, 200)
  assert.equal(stock(source.variantId), before, `${method} does not imply physical delivery`)
  assert.equal(retRow(document.id).goodsReceiptRequired, 1)
  assert.equal(retRow(document.id).restockPending, 1)
  assert.equal((await returnGoodsService.items(document.id)).managed, true)
  const one = (await returnGoodsService.items(document.id)).items[0]
  await returnGoodsService.receive(goodsInput(document.id, one.id, 1, `all-method-${method}-receipt`))
  assert.equal(stock(source.variantId), before + 1)
  assert.equal(retRow(document.id).restockPending, 0)
}
console.log('✓ CASH, CARD, STORE_CREDIT and C2C all wait for witnessed goods; money paths unchanged')

// Replacement goods leave stock immediately; returned goods DO NOT re-enter
// until the cashier sees them. Test positive, zero and negative differences.
for (const [oldPrice, newPrice, paid, refundMode] of [
  [100, 120, 100, undefined], [100, 100, 100, undefined], [100, 50, 100, 'STORE_CREDIT']
]) {
  const source = await saleOf(oldPrice, 1, paid)
  const replacement = v(newPrice)
  const beforeBack = stock(source.variantId)
  const beforeRep = stock(replacement)
  const result = await salesService.createExchange({ invoiceId: source.sale.id,
    lines: [{ saleItemId: source.saleItemId, qty: 1 }],
    replacements: [{ variantId: replacement, qty: 1 }], refundMode, methodId: cash, userId, shiftId })
  assert.equal(stock(source.variantId), beforeBack)
  assert.equal(stock(replacement), beforeRep - 1)
  assert.equal(retRow(result.returnId).goodsReceiptRequired, 1)
  assert.equal(retRow(result.returnId).restockPending, 1, 'no implicit release for diff >= 0')
  assert.equal(result.restockPending, true)
  assert.equal(result.pendingRestockQty, 1)
  const freshExchangeRow = (await salesService.exchangeList({ take: 100 })).rows
    .find((row) => row.returnId === result.returnId)
  assert.equal(freshExchangeRow?.corrected, false)
  assert.equal(freshExchangeRow?.goodsReceiptRequired, true)
  assert.equal(freshExchangeRow?.restockedQty, 0)
  assert.match(await printService.exchangeHtml(result.returnId), /هنوز بدون شاهد/,
    'exchange receipt must distinguish settlement from physical return')
  await assert.rejects(() => salesService.update({ id: result.exchangeInvoiceId,
    userId, shiftId, keepPayments: true,
    lines: [{ variantId: replacement, qty: 1, unitPrice: newPrice, discount: 0, tax: 0 }] }),
  /سند تعویض/, 'ordinary saleUpdate cannot bypass the exchange return and its witnessed goods')
  const item = (await returnGoodsService.items(result.returnId)).items[0]
  assert.equal((await returnGoodsService.receive(goodsInput(result.returnId, item.id, 1,
    `exchange-${oldPrice}-${newPrice}-witness`))).allReceived, true)
  assert.equal(stock(source.variantId), beforeBack + 1)
  assert.equal(stock(replacement), beforeRep - 1)
}
console.log('✓ exchange positive / zero / credit-negative: replacements leave immediately, returns arrive only after witness')

// A corrected exchange already restored the *replacement* once. Purging that
// replacement invoice must not count its original sale as still absent.
const correctedSource = await saleOf(100, 1, 0)
const correctedReplacement = v(100)
const correctedExchange = await salesService.createExchange({ invoiceId: correctedSource.sale.id,
  lines: [{ saleItemId: correctedSource.saleItemId, qty: 1 }],
  replacements: [{ variantId: correctedReplacement, qty: 1 }], userId, shiftId })
assert.equal(stock(correctedReplacement), 99)
assert.ok(Number.isInteger(correctedExchange.exchangeInvoiceId))
await salesService.returnReconcileVoid({ id: correctedExchange.returnId,
  reason: 'تعویض بدون دریافت فیزیکی لغو شد', panelPassword: DEFAULT_MANAGER_PASSWORD })
assert.equal((await salesService.exchangeGet({ id: correctedExchange.returnId }))?.corrected, true)
assert.match(await printService.exchangeHtml(correctedExchange.returnId), /اصلاح جبرانی ثبت شده است/)
const correctedReplacementPaper = await printService.receiptDataFor(correctedExchange.exchangeInvoiceId)
const { receiptHtml } = await import('../../src/main/print/templates.ts')
assert.match(receiptHtml(correctedReplacementPaper), /سند تعویض.*اصلاح جبرانی/,
  'reprinting the replacement sale must not hide its correction')
assert.equal(stock(correctedReplacement), 100)
const correctedReplacementItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', correctedExchange.exchangeInvoiceId).id
await assert.rejects(() => salesService.createReturn({ invoiceId: correctedExchange.exchangeInvoiceId,
  full: true, lines: [{ saleItemId: correctedReplacementItem, qty: 1 }],
  refundMethod: 'NONE', confirmOverpay: true, userId }), /اصلاح جبرانی/,
  'a corrected exchange must not issue another return on its already-restored replacement')
await assert.rejects(() => salesService.update({ id: correctedExchange.exchangeInvoiceId,
  userId, shiftId, keepPayments: true,
  lines: [{ variantId: correctedReplacement, qty: 1, unitPrice: 100, discount: 0, tax: 0 }] }),
  /اصلاح جبرانی|سند تعویض/,
  'ordinary saleUpdate cannot re-activate a replacement already compensated by correction')
const replacementPreview = await salesService.purgePreview({ invoiceIds: [correctedExchange.exchangeInvoiceId] })
assert.equal(replacementPreview.restoreLines.find((i) => i.variantId === correctedReplacement)?.qty ?? 0, 0,
  'replacement invoice must not re-add inventory already restored by its correction')
await salesService.purge({ invoiceIds: [correctedExchange.exchangeInvoiceId], restoreStock: true, userId,
  managerPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'تست عدم دوباره افزودن کالای تعویض' })
assert.equal(stock(correctedReplacement), 100, 'purge must not double-restore the replacement')
console.log('✓ corrected exchange replacement is not double-restored by actual purge')

// Different event keys racing for the LAST unit must never both add it.
const raceSource = await saleOf(100, 1, 0)
const raceReturn = await retOf(raceSource, 1, 'NONE')
const raceStock = stock(raceSource.variantId)
const raceItem = (await returnGoodsService.items(raceReturn.id)).items[0]
const simultaneous = await Promise.allSettled([
  returnGoodsService.receive(goodsInput(raceReturn.id, raceItem.id, 1, 'race-receive-left-key')),
  returnGoodsService.receive(goodsInput(raceReturn.id, raceItem.id, 1, 'race-receive-right-key'))
])
assert.equal(simultaneous.filter((r) => r.status === 'fulfilled').length, 1)
assert.equal(stock(raceSource.variantId), raceStock + 1)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', raceReturn.id).n, 1)
console.log('✓ concurrent final-unit receipts: exactly one commit, one physical stock change')

// No inventory deduction => no pending goods, even for cash/credit returns.
const noDeduct = await saleOf(100, 1, 0, false)
const noStock = stock(noDeduct.variantId)
const noStockReturn = await retOf(noDeduct, 1, 'NONE')
assert.equal(stock(noDeduct.variantId), noStock)
assert.equal(retRow(noStockReturn.id).goodsReceiptRequired, 0)
assert.equal(retRow(noStockReturn.id).restockPending, 0)
assert.equal((await returnGoodsService.items(noStockReturn.id)).managed, false)

// Explicit pre-cutover service fixture: legacy semantics stay until real
// migrations are applied to live data, never guessed from payment method.
const historic = await saleOf(100, 1, 0)
const oldStock = stock(historic.variantId)
const oldReturn = await retOf(historic, 1, 'NONE', undefined, { goodsReceiptRequired: false })
assert.equal(retRow(oldReturn.id).goodsReceiptRequired, 0)
assert.equal(stock(historic.variantId), oldStock + 1)
assert.equal((await returnGoodsService.items(oldReturn.id)).managed, false)
console.log('✓ non-deducted and explicit legacy fixture never acquire new physical protocol')
