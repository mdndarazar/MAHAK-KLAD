/** Independent CURRENT-BEHAVIOUR probe; not a post-cure acceptance test.
 * All data live in a fresh throwaway harness SQLite, never a customer DB.
 * Run: HARNESS_BIGINT=1 node --import ./test/harness/register.mjs tools/audit-probes/credit-exchange-round3-paid-credit-expiry.mjs
 * No real-money expiry policy is decided by this probe. It checks whether the
 * present 7-day exchange instrument has an independent preserved claim.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'paid-credit-expiry-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const RealDate = Date
let offset = 0
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset) }
  static now() { return RealDate.now() + offset }
}
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('paid-credit-expiry'), cat = seed.category('c')
const cashMethod = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'Cash', isActive: 1 })
const shift = n => seed.insert('Shift', {
  name: `shift-${n}`, number: n, userId, openedAt: Date.now() - 60_000,
  dayJalali: toJalaliDate(new Date()), staffConfirmed: 1
})
const variant = price => {
  const id = seed.variant(seed.product('p', cat))
  sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=10 WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const attempt = async fn => {
  try { await fn(); return { accepted: true } }
  catch (e) { return { accepted: false, error: String(e?.message ?? e).split('\n')[0] } }
}
const s1 = shift(1), originalVariant = variant(1_000_000), replacement = variant(900_000)
const futureVariant = variant(100_000)
const sale = await salesService.create({ userId, shiftId: s1, lines: [line(originalVariant, 1_000_000)],
  payments: [{ methodId: cashMethod, amount: 1_000_000, destination: 'CASH' }] })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
const exchange = await salesService.createExchange({ invoiceId: sale.id, lines: [{ saleItemId, qty: 1 }],
  replacements: [line(replacement, 900_000)], refundMode: 'STORE_CREDIT', userId, shiftId: s1 })
const n = seed.one('SELECT id, code, amount, status, expiresAt FROM "StoreCredit" WHERE returnId=?', exchange.returnId)
if (!n) throw new Error('Control exchange did not issue a StoreCredit; fixture invalid')
const before = await attempt(() => findRedeemable(db, n.code))
const priorClaims = seed.count('ReturnEntitlement', 'returnId=?', exchange.returnId)
const priorDelivery = seed.count('CreditDelivery', 'creditId=?', n.id)
const invoicesBefore = seed.count('SaleInvoice')
// Move the actual clock forward; never backdate a redemption/expiry snapshot.
offset = 8 * 24 * 60 * 60 * 1000
globalThis.Date = ShiftedDate
sql.prepare('UPDATE "Shift" SET closedAt=? WHERE id=?').run(Date.now(), s1)
const s2 = shift(2)
const after = await attempt(() => findRedeemable(db, n.code))
const spend = await attempt(() => salesService.create({ userId, shiftId: s2,
  lines: [line(futureVariant, 100_000)], payments: [], storeCreditCode: n.code,
  storeCreditAmount: 100_000, storeCreditIdempotencyKey: 'paid-credit-after-expiry' }))
for (const result of [before, after, spend])
  if (result.error) result.error = result.error.replaceAll(n.code, '[REDACTED]').slice(0, 180)
console.log(JSON.stringify({ scenario: 'ALL_CASH_CHEAPER_EXCHANGE_REAL_MONEY_INSTRUMENT_AFTER_8_DAYS',
  originalCashReceived: 1_000_000, childTotal: 900_000,
  n: { id: n.id, amount: Number(n.amount), status: n.status,
    expiresAt: new RealDate(Number(n.expiresAt)).toISOString().slice(0, 10) },
  before, after, saleAttempt: spend,
  returnEntitlementRows: priorClaims, controlledDeliveryRows: priorDelivery,
  invoiceRowsAddedByDeniedSpend: seed.count('SaleInvoice') - invoicesBefore,
  futureVariantStock: seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', futureVariant).stock
}))
