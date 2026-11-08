import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-refund-decision-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')

const [{ harnessClient }, { makeSeeder }, { salesService }, { toJalaliDate }] = await Promise.all([
  import('../../test/harness/stubs/prismaClient.mjs'),
  import('../../test/harness/seed.mjs'),
  import('../../src/main/services/SalesService.ts'),
  import('../../src/shared/jalali.ts')
])

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('refund decision state-machine test')
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'U-REFUND-CASH', label: 'isolated test cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const categoryId = seed.category('U-REFUND')
let sequence = 0
const n = (value) => Number(value ?? 0)
const line = (variantId, qty, unitPrice) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })

function makeVariant(name, price) {
  const productId = seed.product(`U-${++sequence}-${name}`, categoryId)
  const variantId = seed.variant(productId, `U-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = 20, salePrice = ? WHERE id = ?').run(price, variantId)
  return { id: variantId, name, price }
}

function snapshot(variantIds) {
  const count = (table) => n(seed.one(`SELECT COUNT(*) AS count FROM "${table}"`).count)
  const sum = (table, column) => n(seed.one(`SELECT COALESCE(SUM("${column}"), 0) AS total FROM "${table}"`).total)
  return {
    saleInvoices: count('SaleInvoice'),
    saleInvoiceItems: count('SaleInvoiceItem'),
    saleReturns: count('SaleReturn'),
    payments: count('Payment'),
    paymentTotal: sum('Payment', 'amount'),
    storeCredits: count('StoreCredit'),
    redemptions: count('StoreCreditRedemption'),
    allocations: count('CreditReturnAllocation'),
    cashMovements: count('CashMovement'),
    inventoryMovements: count('StockMovement'),
    auditLogs: count('AuditLog'),
    stock: variantIds.map((id) => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', id).stock))
  }
}

async function makeInvoice({ key, qty = 2, price = 50000 }) {
  const variant = makeVariant(key, price)
  const shiftId = seed.insert('Shift', {
    name: `U ${key}`, number: 700 + sequence, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId
  })
  const invoice = await salesService.create({
    userId,
    shiftId,
    lines: [line(variant.id, qty, price)],
    payments: [{ methodId: cashMethodId, amount: qty * price, destination: 'CASH' }],
    saleRequestIdempotencyKey: `u-refund-${key}`
  })
  const item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id LIMIT 1', invoice.id)
  return { invoice, itemId: n(item.id), shiftId, variant }
}

const results = []

// Unselected + positive real-money right: reject before any return/stock/payment/credit write.
{
  const source = await makeInvoice({ key: 'unselected-return' })
  const before = snapshot([source.variant.id])
  let error = ''
  try {
    await salesService.createReturn({
      userId, invoiceId: n(source.invoice.id), full: false,
      lines: [{ saleItemId: source.itemId, qty: 1 }], refundDecision: 'UNSELECTED'
    })
  } catch (e) { error = String(e?.message ?? e) }
  const after = snapshot([source.variant.id])
  if (!error.includes('روش بازپرداخت انتخاب نشده')) throw new Error(`Unselected return did not show the expected guidance: ${error}`)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Unselected return mutated the isolated database')
  results.push({ case: 'unselected-return-positive-right', blocked: true, mutationFree: true, error })
}

// Explicit NONE is a separate, reasoned, audited decision; it issues no money or barcode.
{
  const source = await makeInvoice({ key: 'explicit-none-return' })
  const result = await salesService.createReturn({
    userId, invoiceId: n(source.invoice.id), full: false,
    lines: [{ saleItemId: source.itemId, qty: 1 }],
    refundMethod: 'NONE', refundDecision: 'DECLINED', refundNote: 'مشتری بازپرداخت را نخواست', confirmOverpay: true
  })
  const ret = seed.one('SELECT refundMethod, refundAmount, refundNote FROM "SaleReturn" WHERE id = ?', result.id)
  const issued = n(seed.one('SELECT COUNT(*) AS count FROM "StoreCredit" WHERE returnId = ?', result.id).count)
  const audit = seed.rows('SELECT note, after FROM "AuditLog" WHERE entity = ? AND entityId = ? ORDER BY id', 'SaleReturn', result.id)
  if (ret.refundMethod !== 'NONE' || n(ret.refundAmount) !== 0 || ret.refundNote !== 'مشتری بازپرداخت را نخواست')
    throw new Error('Explicit no-refund decision was not recorded on the return')
  if (issued !== 0) throw new Error('Explicit no-refund decision unexpectedly issued a store credit')
  if (!audit.some((row) => String(row.note).includes('ثبت صریح «بدون بازپرداخت»')))
    throw new Error('Explicit no-refund decision has no audit record')
  results.push({ case: 'explicit-none-with-reason', returnId: n(result.id), refundAmount: n(ret.refundAmount), issuedCredits: issued, auditCount: audit.length })
}

// A selected store-credit method remains an ordinary, successful refund path.
{
  const source = await makeInvoice({ key: 'selected-store-credit-return' })
  const result = await salesService.createReturn({
    userId, invoiceId: n(source.invoice.id), full: false,
    lines: [{ saleItemId: source.itemId, qty: 1 }], refundMethod: 'STORE_CREDIT', refundDecision: 'METHOD'
  })
  const issued = seed.one('SELECT id, amount, status FROM "StoreCredit" WHERE returnId = ? ORDER BY id LIMIT 1', result.id)
  if (!issued || n(issued.amount) !== 50000) throw new Error('Selected store-credit return did not issue the exact 50,000-rial amount')
  results.push({ case: 'selected-store-credit-return', returnId: n(result.id), issuedAmount: n(issued.amount), status: issued.status })
}

// Negative exchange + positive money entitlement: explicit UNSELECTED must roll back its entire transaction.
{
  const source = await makeInvoice({ key: 'unselected-exchange', qty: 1, price: 100000 })
  const replacement = makeVariant('exchange-replacement', 80000)
  const before = snapshot([source.variant.id, replacement.id])
  let error = ''
  try {
    await salesService.createExchange({
      userId, invoiceId: n(source.invoice.id), lines: [{ saleItemId: source.itemId, qty: 1 }],
      replacements: [line(replacement.id, 1, replacement.price)], exchangeSettlementDecision: 'UNSELECTED'
    })
  } catch (e) { error = String(e?.message ?? e) }
  const after = snapshot([source.variant.id, replacement.id])
  if (!error.includes('فروشنده روش را انتخاب نکرده')) throw new Error(`Unselected exchange did not show the expected guidance: ${error}`)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Unselected exchange mutated the isolated database')
  results.push({ case: 'unselected-exchange-positive-right', blocked: true, mutationFree: true, error })
}

// The same exchange succeeds after the seller explicitly chooses STORE_CREDIT.
{
  const source = await makeInvoice({ key: 'selected-exchange', qty: 1, price: 100000 })
  const replacement = makeVariant('selected-exchange-replacement', 80000)
  const result = await salesService.createExchange({
    userId, invoiceId: n(source.invoice.id), lines: [{ saleItemId: source.itemId, qty: 1 }],
    replacements: [line(replacement.id, 1, replacement.price)],
    refundMode: 'STORE_CREDIT', exchangeSettlementDecision: 'METHOD'
  })
  const issued = seed.one('SELECT id, amount, status FROM "StoreCredit" WHERE returnId = ? ORDER BY id LIMIT 1', result.returnId)
  if (!issued || n(issued.amount) !== 20000) throw new Error('Selected exchange did not issue the exact 20,000-rial amount')
  results.push({ case: 'selected-exchange-store-credit', returnId: n(result.returnId), issuedAmount: n(issued.amount), status: issued.status })
}

console.log(JSON.stringify({ isolatedDatabase: process.env.HARNESS_DB, results }, null, 2))
await db.$disconnect?.()
