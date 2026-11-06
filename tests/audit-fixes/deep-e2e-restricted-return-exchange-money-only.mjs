/**
 * Owner policy: when returned A was funded by A-only credit plus real money,
 * only the money-backed share can fund an out-of-scope replacement B. The A
 * share is restored with its exact scope and original expiry. Separate cases
 * cover a more expensive and a cheaper B replacement.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-restricted-return-exchange-money-only.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-restricted-return-money-only-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('restricted-return-money-only')
const shiftId = seed.insert('Shift', {
  name: 'restricted-return-money-only', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'RESTRICTED-RETURN-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryA = seed.category('restricted-return-A')
const categoryB = seed.category('restricted-return-B')
const productA = seed.product('restricted-return-product-A', categoryA)
const productB = seed.product('restricted-return-product-B', categoryB)
const makeVariant = (productId, code, price) => {
  const id = seed.variant(productId, code)
  sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(price, id)
  return id
}
const variantA = makeVariant(productA, 'RRM-A', 100_000)
const variantB120 = makeVariant(productB, 'RRM-B120', 120_000)
const variantB80 = makeVariant(productB, 'RRM-B80', 80_000)
const variantB40 = makeVariant(productB, 'RRM-B40', 40_000)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })

async function runReplacement(replacementVariant, replacementPrice, suffix, expectedCashDue, settleCashSurplus = false) {
  const issued = await storeCreditService.issueManual({
    amount: 50_000,
    multiUse: false,
    carryRemainder: false,
    restrictScope: 'VARIANTS',
    restrictVariantIds: [variantA],
    userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    note: `A-only credit for ${suffix}`
  })
  const credit = seed.one('SELECT code,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
  const sale = await salesService.create({
    userId, shiftId, lines: [line(variantA, 100_000)],
    payments: [{ methodId: cashMethodId, amount: 50_000, destination: 'CASH' }],
    storeCreditCode: credit.code,
    storeCreditIdempotencyKey: `restricted-return-${suffix}`
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id)
  const exchangeLines = [{ saleItemId: Number(sourceItem.id), qty: 1 }]
  const replacementLines = [line(replacementVariant, replacementPrice)]
  const preview = await salesService.previewExchangeFunding({
    invoiceId: sale.id, lines: exchangeLines, replacements: replacementLines
  })
  assert.equal(preview.ok, true, `${suffix}: read-only preview succeeds: ${preview.error ?? ''}`)
  assert.equal(preview.effectiveDiff, expectedCashDue > 0 ? expectedCashDue : settleCashSurplus ? -10_000 : expectedCashDue,
    `${suffix}: preview predicts actual settlement gap`)
  const beforeStalePreview = {
    invoices: seed.count('SaleInvoice', '1=1'),
    returns: seed.count('SaleReturn', '1=1'),
    payments: seed.count('Payment', '1=1'),
    stockA: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantA).stock),
    stockB: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock)
  }
  await assert.rejects(() => salesService.createExchange({
    userId, shiftId, invoiceId: sale.id,
    lines: exchangeLines, replacements: replacementLines,
    expectedSettlementDiff: Number(preview.effectiveDiff) + 1,
    methodId: cashMethodId,
    idempotencyKey: `restricted-return-stale-preview-${suffix}`
  }), /پیش‌نمایش.*تغییر کرده/u)
  assert.deepEqual({
    invoices: seed.count('SaleInvoice', '1=1'),
    returns: seed.count('SaleReturn', '1=1'),
    payments: seed.count('Payment', '1=1'),
    stockA: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantA).stock),
    stockB: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock)
  }, beforeStalePreview, `${suffix}: stale preview failure rolls back all mutations`)
  const result = await salesService.createExchange({
    userId, shiftId, invoiceId: sale.id,
    lines: exchangeLines,
    replacements: replacementLines,
    expectedSettlementDiff: preview.effectiveDiff,
    methodId: cashMethodId,
    ...(settleCashSurplus ? { refundMode: 'CASH', exchangeSettlementDecision: 'METHOD' } : {}),
    idempotencyKey: `restricted-return-exchange-${suffix}`
  })

  assert.equal(result.cashDue, expectedCashDue, `${suffix}: only the 50k real-money share reduces B`)
  assert.equal(Number(result.sourceCreditRestoredAmount), 50_000, `${suffix}: A-only credit returns separately`)
  const source = seed.one('SELECT status,usedAmount FROM "StoreCredit" WHERE id=?', issued.id)
  assert.equal(source.status, 'USED', `${suffix}: consumed one-use source code remains USED`)
  assert.equal(Number(source.usedAmount), 50_000)
  const successor = seed.one('SELECT amount,status,expiresAt,restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE returnId=?', result.returnId)
  assert.equal(Number(successor.amount), 50_000)
  assert.equal(successor.status, 'ACTIVE')
  assert.equal(successor.expiresAt, credit.expiresAt, 'source expiry is retained exactly')
  assert.equal(successor.restrictScope, 'VARIANTS')
  assert.equal(successor.restrictVariantIdsJson, JSON.stringify([variantA]))
  const exchangeCash = Number(seed.one(
    'SELECT COALESCE(SUM(p.amount),0) AS n FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.invoiceId=? AND p.voidedAt IS NULL AND m.kind IN (?,?)',
    result.exchangeInvoiceId, 'CASH', 'CARD'
  ).n)
  assert.equal(exchangeCash, expectedCashDue)
  const cashRefund = Number(seed.one(
    'SELECT COALESCE(SUM(amount),0) AS n FROM "CashMovement" WHERE refId=? AND type=?',
    result.returnId, 'EXCHANGE_REFUND'
  ).n)
  assert.equal(cashRefund, settleCashSurplus ? 10_000 : 0, `${suffix}: only actual money surplus leaves the drawer`)
  const sourceAllocations = seed.rows(
    'SELECT amount,restrictScope,saleItemId FROM "CreditReturnAllocation" WHERE returnId=?', result.returnId
  )
  assert.equal(sourceAllocations.length, 1)
  assert.equal(Number(sourceAllocations[0].amount), 50_000)
  assert.equal(sourceAllocations[0].restrictScope, 'VARIANTS')
  assert.equal(Number(sourceAllocations[0].saleItemId), Number(sourceItem.id))
  return { result, source: sale, credit: issued }
}

// A=100k (50k A-only credit + 50k cash), B=120k: customer pays 70k.
const moreExpensive = await runReplacement(variantB120, 120_000, 'B120', 70_000)
assert.equal(moreExpensive.result.diff, 70_000)
assert.equal(moreExpensive.result.exchangeCreditApplied, 50_000)

// The same funding with B=80k still leaves the customer owing 30k; the
// restricted 50k does not create a refund or get silently moved to B.
const cheaper = await runReplacement(variantB80, 80_000, 'B80', 30_000)
assert.equal(cheaper.result.diff, 30_000)
assert.equal(cheaper.result.exchangeCreditApplied, 50_000)

// A genuinely cheaper B leaves 10k of actual money to refund; the separate
// 50k A-only credit still returns to its original restricted source.
const refund = await runReplacement(variantB40, 40_000, 'B40', 0, true)
assert.equal(refund.result.diff, -10_000)
assert.equal(refund.result.exchangeCreditApplied, 40_000)
assert.equal(refund.result.realMoneyRefundAmount, 10_000)
assert.equal(refund.result.cashRefunded, 10_000)

console.log('✓ restricted A credit is restored with original scope/expiry; out-of-scope B uses only real money (70k due for B120, 30k for B80, 10k real-money refund for B40)')
