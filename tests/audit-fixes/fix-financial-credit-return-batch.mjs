/**
 * Regression: creditReturnAllocation.groupBy may receive > 999 SQLite bind values
 * when one 500-invoice page has many partial returns. Batch return ids as well.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-credit-return-batch.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-return-batch-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { debtAdjustmentsByInvoice } = await import('../../src/main/services/invoiceDebt.ts')

const invoiceIds = Array.from({ length: 1002 }, (_, i) => i + 1)
const returns = [
  ...Array.from({ length: 1201 }, (_, i) => ({ id: i + 1, invoiceId: 1 })),
  ...invoiceIds.slice(1).map((invoiceId, i) => ({ id: 1202 + i, invoiceId }))
].map((r) => ({ ...r, kind: 'RETURN', total: 100, refundMethod: 'CASH', refundAmount: 0,
  exchangeDiff: null, debtReduction: null }))
const byReturn = new Map(returns.map((r) => [r.id, r]))
let groupCalls = 0
const client = {
  saleReturn: { async findMany({ where }) {
    assert.ok(where.invoiceId.in.length <= 500)
    return returns.filter((r) => where.invoiceId.in.includes(r.invoiceId))
  } },
  returnCorrection: { async findMany() { return [] } },
  creditReturnAllocation: { async groupBy({ by, where, _sum }) {
    assert.deepEqual(by, ['returnId'])
    assert.equal(_sum.amount, true)
    assert.ok(where.returnId.in.length <= 500, 'all return-id queries must respect SQLite limits')
    groupCalls++
    return where.returnId.in.map((returnId) => {
      assert.ok(byReturn.has(returnId))
      return { returnId, _sum: { amount: 1 } }
    })
  } },
  saleInvoice: { async findMany({ where }) {
    assert.ok(where.sourceInvoiceId.in.length <= 500)
    return []
  } }
}
const result = await debtAdjustmentsByInvoice(client, invoiceIds)
assert.equal(result.size, 1002)
assert.deepEqual(result.get(1), { returnedValue: 120100, refundFromReceived: 1201 })
assert.deepEqual(result.get(1002), { returnedValue: 100, refundFromReceived: 1 })
assert.ok(groupCalls >= 6, `expected > one return batch per invoice page; got ${groupCalls}`)
console.log(`✓ 1002 invoices, 2202 returns: ${groupCalls} bounded credit-allocation batches; non-cash refunds preserved`)
