/**
 * Cash-refund correction audit: verify the original refund reduces physical blue,
 * ordinary return void is blocked after a recorded cash payout, and the audited
 * reconciliation changes blue only by cash actually recovered.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-cash-return-correction-blue.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-cash-return-blue-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { RefundMethod } = await import('../../src/shared/enums.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('cash return cashier')
const shiftId = seed.insert('Shift', {
  name: 'cash-return-blue-correction', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
})
const cashMethod = seed.insert('PaymentMethod', {
  key: 'CASH-RETURN-BLUE', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('cash-return-blue')
const productId = seed.product('کالای بازپرداخت نقدی اشتباهی', categoryId)
const variantId = seed.variant(productId, 'CRB-01')
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=1000000 WHERE id=?').run(variantId)
const stock = () => Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)
const itemId = (invoiceId) => Number(seed.one(
  'SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id LIMIT 1', invoiceId
).id)
const errOf = async (fn) => {
  try { await fn(); return null } catch (error) { return String(error?.message ?? error) }
}

async function createCashRefundCase(label, recovered) {
  const blueBeforeSale = await physicalMovementForCustodyShift(shiftId)
  const sale = await salesService.create({
    userId, shiftId,
    lines: [{ variantId, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
    payments: [{ methodId: cashMethod, amount: 1_000_000, destination: 'CASH' }]
  })
  assert.equal(stock(), 9 - (label === 'partial recovery' ? 1 : 0))
  assert.equal(await physicalMovementForCustodyShift(shiftId) - blueBeforeSale, 1_000_000,
    `${label}: sale cash enters blue`)
  const returned = await salesService.createReturn({
    invoiceId: sale.id,
    full: false,
    lines: [{ saleItemId: itemId(sale.id), qty: 1 }],
    refundMethod: RefundMethod.CASH,
    refundAmount: 1_000_000,
    userId,
    shiftId
  })
  assert.equal(returned.refundAmount, 1_000_000)
  assert.equal(stock(), 10 - (label === 'partial recovery' ? 1 : 0))
  const blueAfterCashRefund = await physicalMovementForCustodyShift(shiftId)
  assert.equal(blueAfterCashRefund, blueBeforeSale,
    `${label}: recorded 1M cash refund cancels the 1M sale receipt in the sales-blue measure`)
  const cashboxAfterRefund = await cashboxService.expected({ shiftId })

  const voidError = await errOf(() => salesService.returnDelete({
    id: returned.id,
    userId,
    reason: 'برگشت اشتباهی با بازپرداخت نقدی؛ کالا واقعاً برنگشته بود',
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    panelPassword: DEFAULT_MANAGER_PASSWORD
  }))
  assert.match(voidError ?? '', /بازپرداخت نقد.*ممکن نیست|پول واقعاً رفته/)
  assert.equal(await physicalMovementForCustodyShift(shiftId), blueAfterCashRefund,
    `${label}: blocked void has no blue effect`)

  const correction = await salesService.returnReconcileVoid({
    id: returned.id,
    userId,
    reason: `اصلاح جبرانی ${label}؛ بررسی وجهی که واقعاً به صندوق برگشت`,
    panelPassword: DEFAULT_MANAGER_PASSWORD,
    cashRecovered: recovered,
    creditOutcome: 'NONE'
  })
  assert.equal(correction.cashRecovered, recovered)
  assert.equal(correction.unrecoveredAmount, 1_000_000 - recovered)
  assert.equal(stock(), 9 - (label === 'partial recovery' ? 1 : 0),
    `${label}: reconciliation reverses the false stock increase`)
  const blueAfterCorrection = await physicalMovementForCustodyShift(shiftId)
  const cashboxAfterCorrection = await cashboxService.expected({ shiftId })
  assert.equal(blueAfterCorrection, blueAfterCashRefund,
    `${label}: the historical sales-blue measure remains unchanged by an out-of-sales recovery`)
  assert.equal(cashboxAfterCorrection.expectedCash, cashboxAfterRefund.expectedCash + recovered,
    `${label}: cash-close expected drawer balance rises only by cash actually recovered`)
  return { blueBeforeSale, blueAfterCashRefund, blueAfterCorrection, cashboxAfterRefund, cashboxAfterCorrection, correction }
}

const fullyRecovered = await createCashRefundCase('full recovery', 1_000_000)
assert.equal(fullyRecovered.cashboxAfterRefund.expectedCash, 0)
assert.equal(fullyRecovered.cashboxAfterCorrection.expectedCash, 1_000_000)
assert.equal(fullyRecovered.correction.unrecoveredAmount, 0)
console.log('✓ 1M cash refund lowers expected drawer cash; ordinary void is blocked; recovering all 1M restores cash-close expectation')

const notRecovered = await createCashRefundCase('partial recovery', 0)
assert.equal(notRecovered.cashboxAfterCorrection.expectedCash, notRecovered.cashboxAfterRefund.expectedCash,
  'with no cash returned, expected drawer cash cannot be restored by paperwork')
assert.equal(notRecovered.correction.unrecoveredAmount, 1_000_000)
console.log('✓ when no cash is recovered, expected drawer cash stays lower and the 1M unrecovered amount remains visible')
