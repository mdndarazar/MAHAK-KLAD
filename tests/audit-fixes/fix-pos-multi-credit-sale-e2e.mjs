import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-pos-multi-credit-sale-'))
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
const userId = seed.user('POS multi-credit')
const categoryId = seed.category('POS multi-credit category')
const productId = seed.product('POS multi-credit item', categoryId)
const variantId = seed.variant(productId, 'POS-MULTI-01')
sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=1000 WHERE id=?').run(variantId)
const shiftId = seed.insert('Shift', { name: 'POS multi-credit', number: 1, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cashMethod = seed.insert('PaymentMethod', { key: 'POS-MULTI-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const newCredit = async (amount) => {
  const safe = await storeCreditService.issueManual({
    amount, multiUse: false, carryRemainder: true, userId, managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  return { id: safe.id, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', safe.id).code }
}
const used = await newCredit(200)
const intentionallyUnused = await newCredit(100)
sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run('2099-01-01T00:00:00.000Z', used.id)
sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run('2099-02-01T00:00:00.000Z', intentionallyUnused.id)
const key = 'pos-multi-credit-retry-2026'
const input = {
  userId,
  shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethod, amount: 800, destination: 'CASH' }],
  storeCredits: [
    { code: intentionallyUnused.code },
    { code: used.code },
    { code: 'NOT-A-REAL-CREDIT' }
  ],
  saleRequestIdempotencyKey: key
}
const created = await salesService.create(input)
assert.equal(Number(created.grandTotal), 1000)
assert.equal(Number(created.storeCreditApplied), 200)
assert.equal(Number(created.paidTotal), 1000)
assert.equal(created.idempotentReplay, false)
assert.deepEqual(created.storeCreditOutcomes.map((row) => row.status).sort(), ['APPLIED', 'REJECTED', 'UNUSED'])
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', used.id).usedAmount), 200)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', used.id).status, 'USED')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', intentionallyUnused.id).usedAmount), 0,
  'a valid but unneeded barcode remains wholly unused')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', intentionallyUnused.id).status, 'ACTIVE')
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId=? AND reversedAt IS NULL', created.id).n, 1)

const replay = await salesService.create({
  ...input,
  storeCredits: [...input.storeCredits].reverse()
})
assert.equal(replay.id, created.id, 'retry with barcode order changed resolves the same invoice')
assert.equal(replay.idempotentReplay, true)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE saleRequestKey=?', key).n, 1,
  'idempotent retry cannot create a second invoice')
assert.equal(seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId=? AND reversedAt IS NULL', created.id).n, 1,
  'idempotent retry cannot consume credit twice')

// The server, not just the renderer, enforces the wholesale one-barcode cap.
const wholesaleA = await newCredit(100)
const wholesaleB = await newCredit(100)
const invoicesBeforeRejectedWholesale = seed.count('SaleInvoice', '1=1')
await assert.rejects(() => salesService.create({
  userId,
  shiftId,
  orderType: 'WHOLESALE',
  lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [],
  storeCredits: [{ code: wholesaleA.code }, { code: wholesaleB.code }]
}), /فقط یک بارکد/)
assert.equal(seed.count('SaleInvoice', '1=1'), invoicesBeforeRejectedWholesale,
  'wholesale multi-barcode input is rejected before any invoice is written')

const restrictedA = await storeCreditService.issueManual({
  amount: 800, multiUse: false, carryRemainder: true, restrictScope: 'VARIANTS',
  restrictVariantIds: [variantId], userId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
const restrictedB = await storeCreditService.issueManual({
  amount: 800, multiUse: false, carryRemainder: true, restrictScope: 'VARIANTS',
  restrictVariantIds: [variantId], userId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
const restrictedCodeA = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', restrictedA.id).code
const restrictedCodeB = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', restrictedB.id).code
const restrictedSale = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [],
  storeCredits: [{ code: restrictedCodeA }, { code: restrictedCodeB }],
  saleRequestIdempotencyKey: 'pos-restricted-credit-capacity-2026'
})
assert.equal(Number(restrictedSale.storeCreditApplied), 1000,
  'restricted credits cumulatively cover no more than the matching sale-line value')
const restrictedRedemptions = seed.rows(
  'SELECT creditId,amount FROM "StoreCreditRedemption" WHERE invoiceId=? AND reversedAt IS NULL ORDER BY seq',
  restrictedSale.id
)
assert.deepEqual(restrictedRedemptions.map((row) => Number(row.amount)), [800, 200])
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', restrictedB.id).usedAmount), 200)

const expired = await newCredit(100)
sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expired.id)
const expiredSale = await salesService.create({
  userId,
  shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethod, amount: 1000, destination: 'CASH' }],
  storeCredits: [{ code: expired.code }],
  saleRequestIdempotencyKey: 'pos-multi-credit-expired-sale-2026'
})
assert.equal(expiredSale.settled, true, 'an expired barcode does not block a fully paid sale')
assert.equal(expiredSale.storeCreditOutcomes[0].status, 'REJECTED')
assert.equal(Number(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id=?', expired.id).usedAmount), 0)
console.log('✓ POS multi-credit sale: invalid/expired/unneeded codes do not block sale, FEFO source alone is consumed, reordered retry replays once')
