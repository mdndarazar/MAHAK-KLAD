/** Independent check of Claude 01's *untested* two-step-return claim.
 * Temporary SQLite/harness only; no product or customer database writes.
 * Run separately for each mode:
 *   HARNESS_BIGINT=1 node --import ./test/harness/register.mjs tools/audit-probes/credit-exchange-round2-sequential-return.mjs one
 *   HARNESS_BIGINT=1 node --import ./test/harness/register.mjs tools/audit-probes/credit-exchange-round2-sequential-return.mjs two
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode = process.argv[2]
assert.ok(mode === 'one' || mode === 'two', 'Choose one or two')
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'mahak-credit-sequence-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('round2'), category = seed.category('round2')
const shiftId = seed.insert('Shift', { name: 'round2', number: 1, userId, openedAt: Date.now() - 60_000,
  dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
const variant = (name) => {
  const v = seed.variant(seed.product(name, category))
  sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=5 WHERE id=?').run(2_500_000, v)
  return v
}
const a = variant('a'), b = variant('b')
const A = await db.$transaction(tx => issueStoreCredit(tx, { source: 'MANUAL', amount: 10_000_000,
  multiUse: false, maxUses: 1, carryRemainder: false, days: 30, userId, note: 'isolated test' }))
const lines = [a, b].map(variantId => ({ variantId, qty: 1, unitPrice: 2_500_000, discount: 0, tax: 0 }))
const sale = await salesService.create({ userId, shiftId, lines, payments: [], storeCreditCode: A.code,
  storeCreditAmount: 5_000_000, storeCreditIdempotencyKey: 'round2-once' })
const itemIds = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id).map(r => r.id)
assert.equal(itemIds.length, 2)
const ret = (ids, full) => salesService.createReturn({ invoiceId: sale.id, full,
  lines: ids.map(saleItemId => ({ saleItemId, qty: 1 })), refundMethod: 'NONE', refundAmount: 0, userId, shiftId })
const first = mode === 'one' ? await ret(itemIds, true) : await ret([itemIds[0]], false)
const second = mode === 'two' ? await ret([itemIds[1]], false) : null
const credits = seed.rows('SELECT id,source,amount,usedAmount,status,multiUse,expiresAt FROM "StoreCredit" ORDER BY id')
const allocations = seed.rows('SELECT kind,amount,supplementUnspent,successorCreditId FROM "CreditReturnAllocation" ORDER BY id')
const returns = seed.rows('SELECT id,total,isFull,voidedAt FROM "SaleReturn" WHERE invoiceId=? ORDER BY id', sale.id)
const spendable = []
for (const row of seed.rows('SELECT id,code FROM "StoreCredit" ORDER BY id')) {
  try { await findRedeemable(db, row.code); spendable.push(row.id) } catch { /* DRAFT is a valid, not-yet-delivered right */ }
}
const restoredNominal = credits.reduce((sum, c) => sum + (c.id === A.id ? Number(c.status === 'ACTIVE' ? c.amount : 0) : Number(c.amount)), 0)
assert.equal(Number(credits[0].amount), 10_000_000)
assert.equal(returns.length, mode === 'one' ? 1 : 2)
assert.equal(restoredNominal, 10_000_000, 'Nominal gift opportunity across root/branches after full return')
if (mode === 'one') {
  assert.equal(credits.length, 1)
  assert.equal(credits[0].status, 'ACTIVE')
  assert.equal(Number(credits[0].usedAmount), 0)
} else {
  assert.equal(credits.length, 3)
  assert.equal(credits[0].status, 'USED')
  assert.deepEqual(credits.slice(1).map(c => Number(c.amount)), [2_500_000, 7_500_000])
  assert.deepEqual(allocations.map(c => Number(c.supplementUnspent)), [0, 5_000_000])
  assert.deepEqual(credits.slice(1).map(c => c.status), ['DRAFT', 'DRAFT'])
}
console.log(JSON.stringify({ mode, first: first.creditOpportunity, second: second?.creditOpportunity ?? null,
  credits: credits.map(({ id, amount, usedAmount, status, multiUse }) => ({ id, amount: Number(amount), usedAmount: Number(usedAmount), status, multiUse })),
  allocations: allocations.map(({ kind, amount, supplementUnspent, successorCreditId }) => ({ kind, amount: Number(amount), supplementUnspent: Number(supplementUnspent), successorCreditId })),
  spendable, restoredNominal }))
