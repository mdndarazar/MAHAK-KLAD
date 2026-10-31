/** POST-CURE ACCEPTANCE v2 (Claude-02). RED today by design; no assert.fail placeholders, no "expect BusinessError".
 * Owner example: sale 15,980,000 = A 2,000,000 (ONCE gift, fully spent) + 13,980,000 cash really received.
 * E1: exchange to 15,000,000 with refundMode STORE_CREDIT. R1: child partial (1/15 via 2-line child) then full return.
 * Policy under test = GIFT-FIRST (recommended, NOT yet owner-approved). Swap EXPECT for another policy if owner decides.
 * Run WITHOUT HARNESS_BIGINT:  node --import ./test/harness/register.mjs tools/audit-probes/ACCEPTANCE-claude02-S1-E1-R1.mjs
 * Each step reads DB rows / cashbox report, prints PASS | FAIL | NOT_IMPLEMENTED(<missing contract>). exit 1 if any non-PASS. */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'acc2-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const CONTROL = process.env.ACC_CONTROL === 'allcash' // all-cash control: shows which post-cure checks current code already meets
const EXPECT = CONTROL ? { giftCarry: 0, cashCarry: 15_000_000, N: 980_000, partialGift: 0, partialCash: 1_000_000, fullGift: 0, fullCash: 14_000_000, gift: 0 }
  : { giftCarry: 2_000_000, cashCarry: 13_000_000, N: 980_000, partialGift: 133_333, partialCash: 866_667, fullGift: 1_866_667, fullCash: 12_133_333, gift: 2_000_000 }
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('acc2'), cat = seed.category('c')
const shiftId = seed.insert('Shift', { name: 's', number: 1, userId, openedAt: Date.now() - 60_000, dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
const cashM = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'Cash', isActive: 1 })
const v = (p) => { const id = seed.variant(seed.product('p', cat)); sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=10 WHERE id=?').run(p, id); return id }
const hasTable = (t) => !!seed.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", t)
class NotImpl extends Error {}
const need = (t) => { if (!hasTable(t)) throw new NotImpl(`table ${t}`) }
const results = []
const step = async (id, fn) => { try { await fn(); results.push([id, 'PASS']); return true }
  catch (e) { results.push([id, e instanceof NotImpl ? 'NOT_IMPLEMENTED' : 'FAIL', String(e?.message ?? e).split('\n')[0].slice(0, 150)]); return false } }
const drawer = async () => Number((await cashboxService.expected({ shiftId })).expectedCash)
const stock = (id) => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', id).stock)
const src = v(15_980_000), repA = v(14_000_000), repB = v(1_000_000), nxt = v(980_000)
const A = await db.$transaction(tx => issueStoreCredit(tx, { source: 'MANUAL', amount: 2_000_000, multiUse: false, maxUses: 1, carryRemainder: false, days: 30, userId, note: 'acc2' }))
let orig, ex, d0
await step('S1 sale commits; A USED; drawer +13.98M; Payment rows = 2M credit + 13.98M CASH', async () => {
  orig = await salesService.create({ userId, shiftId, lines: [{ variantId: src, qty: 1, unitPrice: 15_980_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cashM, amount: CONTROL ? 15_980_000 : 13_980_000, destination: 'CASH' }], ...(CONTROL ? {} : { storeCreditCode: A.code, storeCreditAmount: 2_000_000, storeCreditIdempotencyKey: 'acc2-1' }) })
  if (!CONTROL) { assert.equal(Number(orig.storeCreditApplied), 2_000_000); assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', A.id).status, 'USED') }
  d0 = await drawer(); assert.equal(d0, CONTROL ? 15_980_000 : 13_980_000)
})
const okE = await step('E1 exchange commits: 1 SaleReturn(EXCHANGE) + 1 child invoice 15M (two lines 14M+1M), stock moved', async () => {
  ex = await salesService.createExchange({ invoiceId: orig.id, lines: [{ saleItemId: seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', orig.id).id, qty: 1 }],
    replacements: [{ variantId: repA, qty: 1, unitPrice: 14_000_000, discount: 0, tax: 0 }, { variantId: repB, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
    refundMode: 'STORE_CREDIT', userId, shiftId })
  assert.equal(seed.count('SaleReturn', "invoiceId=? AND voidedAt IS NULL AND kind='EXCHANGE'", orig.id), 1)
  assert.equal(seed.count('SaleInvoice', 'sourceInvoiceId=? AND voidedAt IS NULL', orig.id), 1)
  assert.deepEqual([stock(repA), stock(repB)], [9, 9])
})
if (okE) {
  const child = seed.one('SELECT id FROM "SaleInvoice" WHERE sourceInvoiceId=?', orig.id).id
  await step('E2 A stays non-spendable; no 2M (or any gift-sized) code minted', async () => {
    if (!CONTROL) await assert.rejects(() => findRedeemable(db, A.code))
    assert.equal(seed.count('StoreCredit', 'id<>? AND amount=2000000', A.id), 0)
  })
  await step('E3 child funding ledger = GIFT_CARRY 2M(root A, A expiry) + REAL_CASH_CARRY 13M; sum = EXCHANGE_CREDIT 15M', async () => {
    need('ExchangeFundingAllocation')
    const rows = seed.rows('SELECT kind, amount, rootCreditId FROM "ExchangeFundingAllocation" WHERE childInvoiceId=? ORDER BY kind', child)
    assert.deepEqual(rows.map(r => [r.kind, Number(r.amount)]).filter(r => r[1] > 0), [['GIFT_CARRY', EXPECT.giftCarry], ['REAL_CASH_CARRY', EXPECT.cashCarry]].filter(r => r[1] > 0))
    if (!CONTROL) assert.equal(rows.find(r => r.kind === 'GIFT_CARRY').rootCreditId, A.id)
  })
  await step('E4 N = 980K REAL_CASH_RIGHT: no expiry, multi-use, DRAFT + PENDING_DELIVERY, NOT spendable before witnessed delivery', async () => {
    const n = seed.rows('SELECT id, amount, status, expiresAt, multiUse FROM "StoreCredit" WHERE id<>? AND returnId IS NOT NULL', A.id)
    assert.equal(n.length, 1); assert.equal(Number(n[0].amount), EXPECT.N)
    assert.equal(n[0].expiresAt, null, 'real-cash right must not inherit the 7-day EXCHANGE default expiry')
    assert.equal(n[0].multiUse, 1); assert.equal(n[0].status, 'DRAFT')
    assert.equal(seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', n[0].id)?.status, 'PENDING_DELIVERY')
    await assert.rejects(() => findRedeemable(db, seed.one('SELECT code FROM "StoreCredit" WHERE id=?', n[0].id).code))
  })
  await step('E5 drawer untouched by exchange (expectedCash before == after); no CASH_OUT/CASH_IN', async () => {
    assert.equal(await drawer(), d0)
    assert.equal(seed.count('CashMovement', "type IN ('CASH_IN','CASH_OUT','RETURN_REFUND')"), 0)
  })
  await step('E6 after witnessed delivery N spends once (980K), second spend rejected', async () => {
    const n = seed.one('SELECT id, code FROM "StoreCredit" WHERE id<>? ORDER BY id LIMIT 1', A.id)
    await confirmCreditDelivery({ creditId: n.id, witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'acceptance handoff', managerPassword: PW, actorUserId: userId })
    const s = await salesService.create({ userId, shiftId, lines: [{ variantId: nxt, qty: 1, unitPrice: 980_000, discount: 0, tax: 0 }], payments: [], storeCreditCode: n.code, storeCreditAmount: 980_000, storeCreditIdempotencyKey: 'acc2-n' })
    assert.equal(Number(s.storeCreditApplied), 980_000)
    await assert.rejects(() => findRedeemable(db, n.code))
  })
  const cItems = seed.rows('SELECT id, lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY lineTotal', child)
  await step('R1a child partial return (1M line = 1/15): B gift 133,333 (A expiry, DRAFT) + real cash 866,667 paid from drawer', async () => {
    const r = await salesService.createReturn({ invoiceId: child, lines: [{ saleItemId: cItems[0].id, qty: 1 }], full: false, refundMethod: 'CASH', refundAmount: EXPECT.partialCash, userId, shiftId })
    assert.equal(Number(r.creditOpportunity?.restored ?? 0), EXPECT.partialGift)
    assert.equal(Number(r.refundAmount), EXPECT.partialCash)
    assert.equal(await drawer(), d0 - EXPECT.partialCash)
  })
  await step('R1b child full remainder (14M): B gift 1,866,667 + cash 12,133,333; chain cash rights = 13.98M exactly (incl. spent N), never 14.96M', async () => {
    const r = await salesService.createReturn({ invoiceId: child, lines: [{ saleItemId: cItems[1].id, qty: 1 }], full: false, refundMethod: 'CASH', refundAmount: EXPECT.fullCash, userId, shiftId })
    assert.equal(Number(r.creditOpportunity?.restored ?? 0), EXPECT.fullGift)
    const cashOut = Number(seed.one("SELECT COALESCE(SUM(refundAmount),0) s FROM \"SaleReturn\" WHERE refundMethod='CASH' AND voidedAt IS NULL").s)
    assert.equal(cashOut + EXPECT.N, CONTROL ? 15_980_000 : 13_980_000)
    const gift = seed.rows('SELECT amount, expiresAt FROM "StoreCredit" WHERE id<>? AND source<>\'MANUAL\' AND amount<>?', A.id, EXPECT.N)
    assert.equal(gift.reduce((s, g) => s + Number(g.amount), 0), EXPECT.gift)
    assert.ok(gift.every(g => Number(g.expiresAt) === Number(seed.one('SELECT expiresAt FROM "StoreCredit" WHERE id=?', A.id).expiresAt)))
  })
}
for (const r of results) console.log(r.join(' | '))
process.exit(results.some(r => r[1] !== 'PASS') ? 1 : 0)
