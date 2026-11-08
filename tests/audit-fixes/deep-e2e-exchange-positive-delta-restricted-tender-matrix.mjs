/**
 * Positive exchange-delta barcode eligibility matrix for the owner's question:
 * cash-purchased A=100,000 returned for B=120,000; a 50,000 multi-use code
 * settles exactly 20,000 iff its scope includes B. Isolated SQLite only.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-exchange-positive-delta-restricted-tender-matrix.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-positive-delta-credit-scope-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('positive-delta-credit-scope-matrix')
const shiftId = seed.insert('Shift', {
  name: 'positive-delta-credit-scope-matrix', number: 1,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'PDCS-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryA = seed.category('positive-delta-A')
const categoryB = seed.category('positive-delta-B')
const categoryC = seed.category('positive-delta-C')
const productA = seed.product('positive-delta-product-A', categoryA)
const productB = seed.product('positive-delta-product-B', categoryB)
const productC = seed.product('positive-delta-product-C', categoryC)
let seq = 0
const n = (value) => Number(value ?? 0)
const variant = (productId, price, label) => {
  const id = seed.variant(productId, `PDCS-${++seq}-${label}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const snapshot = (creditId, sourceVariantId, replacementVariantId) => ({
  invoices: seed.count('SaleInvoice', '1=1'),
  returns: seed.count('SaleReturn', '1=1'),
  payments: seed.count('Payment', '1=1'),
  movements: seed.count('CashMovement', '1=1'),
  redemptions: seed.count('StoreCreditRedemption', '1=1'),
  sourceStock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', sourceVariantId).stock),
  replacementStock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariantId).stock),
  credit: seed.one('SELECT id,code,status,amount,usedAmount,usedCount,restrictScope,restrictVariantIdsJson,restrictCategoryIdsJson FROM "StoreCredit" WHERE id=?', creditId)
})

async function runCase(spec) {
  const sourceVariantId = variant(productA, 100_000, `${spec.name}-A100`)
  const replacementVariantId = variant(productB, 120_000, `${spec.name}-B120`)
  const sourceSale = await salesService.create({
    userId, shiftId,
    lines: [line(sourceVariantId, 100_000)],
    payments: [{ methodId: cashMethodId, amount: 100_000, destination: 'CASH' }],
    saleRequestIdempotencyKey: `pdcs-sale-${spec.name}`
  })
  const sourceItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sourceSale.id)
  const credit = await storeCreditService.issueManual({
    amount: 50_000,
    multiUse: true,
    maxUses: 10,
    carryRemainder: true,
    restrictScope: spec.scope,
    ...(spec.scope === 'VARIANTS' ? { restrictVariantIds: spec.variantIds(replacementVariantId, sourceVariantId) } : {}),
    ...(spec.scope === 'CATEGORY' ? { restrictCategoryIds: spec.categoryIds } : {}),
    userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    note: `positive exchange scope case ${spec.name}`
  })
  const creditRow = seed.one('SELECT id,code,status,amount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', credit.id)
  const before = snapshot(credit.id, sourceVariantId, replacementVariantId)
  const request = {
    invoiceId: n(sourceSale.id),
    lines: [{ saleItemId: n(sourceItem.id), qty: 1 }],
    replacements: [line(replacementVariantId, 120_000)]
  }
  const preview = await salesService.previewExchangeFunding(request)
  assert.equal(preview.ok, true, `${spec.name}: preview succeeds: ${preview.error ?? ''}`)
  assert.equal(n(preview.nominalDiff), 20_000, `${spec.name}: raw price gap is 20,000`)
  assert.equal(n(preview.effectiveDiff), 20_000, `${spec.name}: cash-paid A leaves 20,000 to settle`)

  let result = null
  let error = ''
  try {
    result = await salesService.createExchange({
      ...request,
      userId,
      shiftId,
      exchangeCreditCode: creditRow.code,
      expectedSettlementDiff: n(preview.effectiveDiff),
      idempotencyKey: `pdcs-exchange-${spec.name}`
    })
  } catch (e) {
    error = String(e?.message ?? e)
  }

  if (spec.accepted) {
    assert.ok(result, `${spec.name}: eligible barcode is accepted; error=${error}`)
    assert.equal(n(result.diff), 20_000, `${spec.name}: exchange settlement gap`)
    assert.equal(n(result.barcodeCreditApplied), 20_000, `${spec.name}: use only the 20,000 gap, not all 50,000`)
    assert.equal(n(result.cashDue), 0, `${spec.name}: barcode fully covers the gap`)
    assert.equal(n(result.cashReceived), 0)
    assert.equal(n(result.cardReceived), 0)
    assert.equal(n(result.sourceCreditRestoredAmount), 0)
    const afterCredit = seed.one('SELECT id,code,status,amount,usedAmount,usedCount FROM "StoreCredit" WHERE id=?', credit.id)
    assert.equal(n(afterCredit.id), n(credit.id), `${spec.name}: balance stays on the same credit record`)
    assert.equal(afterCredit.code, creditRow.code, `${spec.name}: barcode identity is unchanged`)
    assert.equal(n(afterCredit.amount), 50_000)
    assert.equal(n(afterCredit.usedAmount), 20_000)
    assert.equal(n(afterCredit.amount) - n(afterCredit.usedAmount), 30_000, `${spec.name}: 30,000 remains on the same barcode`)
    assert.equal(n(afterCredit.usedCount), 1)
    assert.equal(afterCredit.status, 'PARTIALLY_USED')
    const redemption = seed.one('SELECT creditId,amount FROM "StoreCreditRedemption" WHERE invoiceId=? AND creditId=?',
      result.exchangeInvoiceId, credit.id)
    assert.ok(redemption, `${spec.name}: redemption is recorded against the exact same credit`)
    assert.equal(n(redemption.amount), 20_000)
    const after = snapshot(credit.id, sourceVariantId, replacementVariantId)
    assert.equal(after.sourceStock, before.sourceStock + 1)
    assert.equal(after.replacementStock, before.replacementStock - 1)
    assert.equal(after.invoices, before.invoices + 1)
    assert.equal(after.returns, before.returns + 1)
    assert.equal(after.cashReceived ?? 0, 0)
    return {
      name: spec.name, result: 'PASS', accepted: true,
      scope: spec.scope, diff: n(result.diff), applied: n(result.barcodeCreditApplied),
      remainingOnSameBarcode: n(afterCredit.amount) - n(afterCredit.usedAmount),
      status: afterCredit.status, usedCount: n(afterCredit.usedCount)
    }
  }

  assert.equal(result, null, `${spec.name}: out-of-scope barcode is rejected`)
  assert.match(error, /محدود|مجاز|کالا|اعتبار/u, `${spec.name}: rejection explains eligibility`)
  const after = snapshot(credit.id, sourceVariantId, replacementVariantId)
  assert.deepEqual(after, before, `${spec.name}: rejected attempt has no persistent invoice, return, payment, stock or credit mutation`)
  return { name: spec.name, result: 'PASS', accepted: false, scope: spec.scope, error, mutationFree: true }
}

const specs = [
  { name: 'ordinary-ALL-multiuse', scope: 'ALL', accepted: true },
  { name: 'restricted-to-B-variant', scope: 'VARIANTS', accepted: true,
    variantIds: (b) => [b] },
  { name: 'restricted-to-category-containing-B', scope: 'CATEGORY', accepted: true,
    categoryIds: [categoryB] },
  { name: 'restricted-to-A-variant-rejects-B', scope: 'VARIANTS', accepted: false,
    variantIds: (_b, a) => [a] },
  { name: 'restricted-to-C-category-rejects-B', scope: 'CATEGORY', accepted: false,
    categoryIds: [categoryC] }
]
const results = []
for (const spec of specs) results.push(await runCase(spec))

const summary = {
  generatedAt: new Date().toISOString(),
  isolatedDatabase: process.env.HARNESS_DB,
  scenario: 'Cash-paid A=100,000 returned; B=120,000 replacement; 50,000 multi-use barcode is tried against ALL, B variant, B category, A-only variant, and C-only category scopes.',
  expected: 'Accept ALL/B-variant/B-category; apply exactly 20,000; keep 30,000 on the same barcode. Reject A-only and C-only scopes with no persistent mutation.',
  passed: results.filter((result) => result.result === 'PASS').length,
  failed: results.filter((result) => result.result !== 'PASS').length,
  results
}
const reportsDir = resolve(process.cwd(), 'reports')
mkdirSync(reportsDir, { recursive: true })
writeFileSync(join(reportsDir, 'deep-e2e-exchange-positive-delta-restricted-tender-matrix.json'), JSON.stringify(summary, null, 2) + '\n')
writeFileSync(join(reportsDir, 'deep-e2e-exchange-positive-delta-restricted-tender-matrix.md'), [
  '# بارکد اعتبار برای مابه‌التفاوت تعویض A→B', '',
  `**نتیجه:** ${summary.passed}/${results.length} PASS · ${summary.failed} FAIL.`,
  '**دیتابیس:** SQLite موقت ایزوله؛ هیچ DB واقعی یا staging استفاده نشد.',
  '**نمونه:** A با ۱۰۰٬۰۰۰ پول واقعی خریداری شده؛ A برگشت می‌خورد و B=۱۲۰٬۰۰۰ جایگزین می‌شود؛ بارکد ۵۰٬۰۰۰تایی فقط تا سقف اختلاف ۲۰٬۰۰۰ استفاده می‌شود.', '',
  '| حالت بارکد | نتیجه | اعمال‌شده از بارکد | مانده روی همان بارکد |', '|---|---|---:|---:|',
  ...results.map((result) => `| ${result.name} | ${result.accepted ? 'پذیرفته شد' : 'درست رد شد'} | ${result.applied ?? 0} | ${result.remainingOnSameBarcode ?? '—'} |`),
  '', 'در دو مورد رد، تعداد سند، پرداخت، حرکت موجودی و ماندهٔ بارکد قبل و بعد یکسان ماند.'
].join('\n') + '\n')
console.log(`Positive exchange delta scope matrix: PASS=${summary.passed}/${results.length}; FAIL=${summary.failed}; report=reports/deep-e2e-exchange-positive-delta-restricted-tender-matrix.md`)
await db.$disconnect?.()
if (summary.failed) process.exitCode = 1
