/** POST-CURE ACCEPTANCE (NOT YET PASSING). Owner example: 15,980,000 = A 2,000,000 + cash 13,980,000 -> exchange 15,000,000 -> N 980,000.
 * Archived as a deliberately RED diagnostic, outside regression-test glob.
 * Run: node --import ./test/harness/register.mjs tools/audit-probes/ACCEPTANCE-credit-funded-exchange-owner-example.mjs
 * Each step prints PASS/FAIL; exit code 1 if any FAIL. Step S1 (sale with valid barcode) passes today;
 * E4/E5 contain unconditional assert.fail placeholders and MUST be replaced by real assertions after design. */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'acc-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD: pw } = await import('@shared/receipt')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('acc'), cat = seed.category('c')
const shiftId = seed.insert('Shift', { name: 's', number: 1, userId, openedAt: Date.now() - 60_000, dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
const cashM = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'Cash', isActive: 1 })
const v = (p) => { const id = seed.variant(seed.product('p', cat)); sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=10 WHERE id=?').run(p, id); return id }
const results = []
const step = async (id, fn) => { try { await fn(); results.push([id, 'PASS']) } catch (e) { results.push([id, 'FAIL', String(e?.message ?? e).split('\n')[0].slice(0, 140)]) ; return false } return true }
const src = v(15_980_000), rep = v(15_000_000), nxt = v(980_000)
const A = await db.$transaction(tx => issueStoreCredit(tx, { source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1, carryRemainder: false, days: 30, userId, note: 'acc' }))
let orig
await step('S1 sale 15.98M = A 2M + cash 13.98M commits', async () => {
  orig = await salesService.create({ userId, shiftId, lines: [{ variantId: src, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cashM, amount: 13_980_000, destination: 'CASH' }], storeCreditCode: A.code, storeCreditAmount: 2_000_000, storeCreditIdempotencyKey: 'acc-1' })
  assert.equal(orig.storeCreditApplied, 2_000_000)
})
let ex
const okE = await step('E1 exchange commits (SaleReturn + child invoice exist)', async () => {
  ex = await salesService.createExchange({ invoiceId: orig.id, lines: [{ saleItemId: seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', orig.id).id, qty: 1 }],
    replacements: [{ variantId: rep, qty: 1, unitPrice: 15_000_000, discount: 0, tax: 0 }], refundMode: 'STORE_CREDIT', managerPassword: pw, userId, shiftId })
  assert.equal(seed.count('SaleReturn', 'invoiceId=? AND voidedAt IS NULL', orig.id), 1)
  assert.equal(seed.count('SaleInvoice', 'sourceInvoiceId=? AND voidedAt IS NULL', orig.id), 1)
})
if (okE) {
  await step('E2 A stays non-spendable, no 2M code issued', async () => {
    assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', A.id).status, 'USED')
    await assert.rejects(() => findRedeemable(db, A.code))
    assert.equal(seed.count('StoreCredit', "amount=2000000 AND id<>?", A.id), 0)
  })
  await step('E3 exactly one new code N = 980,000 from real-cash right; not spendable before delivery', async () => {
    const n = seed.rows('SELECT amount,status FROM "StoreCredit" WHERE id<>?', A.id)
    assert.equal(n.length, 1); assert.equal(Number(n[0].amount), 980_000)
  })
  await step('E4 no drawer movement at exchange time (cash in=0, out=0)', async () => { assert.fail('needs ledger/report accessor from cure design') })
  await step('E5 child fully returned later: gift share 2M + real-cash right 13M; total real 13.98M (N included), never 14.96M', async () => { assert.fail('depends on ExchangeFundingAllocation ledger') })
}
for (const r of results) console.log(r.join(' | '))
process.exit(results.some(r => r[1] === 'FAIL') ? 1 : 0)
