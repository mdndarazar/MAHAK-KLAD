import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-r2-b02-lineage-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'lineage.db')

const [{ harnessClient }, { makeSeeder }, { salesService }, { storeCreditService, issueStoreCredit, redeemStoreCredit }, { DEFAULT_MANAGER_PASSWORD }, { toJalaliDate }] = await Promise.all([
  import('../../test/harness/stubs/prismaClient.mjs'),
  import('../../test/harness/seed.mjs'),
  import('../../src/main/services/SalesService.ts'),
  import('../../src/main/services/StoreCreditService.ts'),
  import('../../src/shared/receipt.ts'),
  import('../../src/shared/jalali.ts')
])

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('R2-B02 credit lineage manager')
const today = toJalaliDate(new Date())
const categoryId = seed.category('R2-B02 apparel')
const productId = seed.product('R2-B02 clothing', categoryId)
const shiftId = seed.insert('Shift', { name: 'R2-B02 lineage shift', number: 1, dayJalali: today, openedAt: Date.now(), userId })
const cashMethodId = seed.insert('PaymentMethod', { key: 'R2-B02-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
let variantNo = 0
const makeVariant = (price) => {
  const id = seed.variant(productId, `R2-B02-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET isActive=1, stock=200, salePrice=? WHERE id=?').run(price, id)
  return id
}
const readLineage = (id) => seed.one('SELECT * FROM "StoreCreditLineage" WHERE id=?', id)
const redemption = (invoiceId) => seed.one('SELECT * FROM "StoreCreditRedemption" WHERE invoiceId=? ORDER BY id LIMIT 1', invoiceId)
const saleItems = (invoiceId) => seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
const createSale = ({ lines, cash = 0, code = null }) => salesService.create({
  debtor: { firstName: 'مشتری', lastName: 'تستی', phone: '09120000000' },
  userId,
  shiftId,
  lines: lines.map((line) => ({ variantId: line.variantId, qty: 1, unitPrice: line.amount, discount: 0, tax: 0 })),
  payments: cash > 0 ? [{ methodId: cashMethodId, amount: cash, destination: 'CASH' }] : [],
  ...(code ? { storeCreditCode: code, storeCreditIdempotencyKey: `r2-b02-${Date.now()}-${Math.random()}` } : {})
})
const createNoRefundReturn = ({ invoiceId, saleItemId, note }) => salesService.createReturn({
  invoiceId,
  full: false,
  lines: [{ saleItemId, qty: 1 }],
  refundMethod: 'NONE',
  refundDecision: 'DECLINED',
  refundNote: note,
  confirmOverpay: true,
  userId,
  shiftId
})
const issueRoot = async (amount) => {
  const row = await storeCreditService.issueManual({
    amount,
    multiUse: true,
    maxUses: 2,
    carryRemainder: true,
    userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  return { ...row, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', row.id).code }
}

// A 5M root funds 5M of an 80M invoice. Returning the first 20M item restores
// the entire source-credit redemption as one 5M successor, and releases the
// same shared amount/use allowance instead of creating a new budget.
const root = await issueRoot(5_000_000)
const rootSale = await createSale({
  lines: [20_000_000, 20_000_000, 20_000_000, 20_000_000].map((amount) => ({ variantId: makeVariant(amount), amount })),
  cash: 75_000_000,
  code: root.code
})
const rootRedemption = redemption(rootSale.id)
assert.equal(Number(rootRedemption.amount), 5_000_000)
assert.equal(Number(rootRedemption.lineageId), Number(root.id))
assert.equal(Number(readLineage(root.id).usedAmount), 5_000_000)
assert.equal(Number(readLineage(root.id).usedCount), 1)

const rootFirstItem = saleItems(rootSale.id)[0]
const firstReturn = await createNoRefundReturn({ invoiceId: rootSale.id, saleItemId: rootFirstItem.id, note: 'بدون بازپرداخت برای آزمون lineage' })
assert.equal(Number(firstReturn.returnCreditAmount), 5_000_000)
const firstSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', firstReturn.id)
assert.ok(firstSuccessor)
assert.equal(Number(firstSuccessor.lineageId), Number(root.id))
assert.equal(Number(firstSuccessor.amount), 5_000_000)
assert.equal(Number(readLineage(root.id).usedAmount), 0)
assert.equal(Number(readLineage(root.id).usedCount), 0)
assert.ok(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', rootRedemption.id).reversedAt)

// Create a second descendant through the same internal issuance path. Even if
// a caller supplies different local rules, every descendant snapshots the
// root's max-use policy; its spending shares the root budget with the return
// successor above.
const sibling = await issueStoreCredit(db, {
  amount: 5_000_000,
  source: 'MANUAL',
  lineageId: Number(root.id),
  days: null,
  maxUses: 1,
  multiUse: false,
  carryRemainder: false,
  length: 8,
  note: 'sibling lineage acceptance test'
})
assert.equal(Number(sibling.lineageId), Number(root.id))
assert.equal(Number(sibling.maxUses), 2)
assert.equal(sibling.multiUse, true)
assert.equal(sibling.carryRemainder, true)

// The first descendant consumes 4M. A second descendant asks for 2M, but the
// lineage has only 1M left, so the shared allowance—not its local 5M barcode
// amount—caps this redemption at 1M. The second use reaches the root's global
// maxUses of two.
const firstDescendantSale = await createSale({
  lines: [
    { variantId: makeVariant(4_000_000), amount: 4_000_000 },
    { variantId: makeVariant(1_000_000), amount: 1_000_000 }
  ],
  cash: 1_000_000,
  code: firstSuccessor.code
})
assert.equal(Number(redemption(firstDescendantSale.id).amount), 4_000_000)
assert.equal(Number(readLineage(root.id).usedAmount), 4_000_000)
assert.equal(Number(readLineage(root.id).usedCount), 1)
const sharedPreview = await storeCreditService.preview({
  code: sibling.code,
  applicable: 2_000_000,
  invoiceTotal: 2_000_000,
  lines: [{ variantId: makeVariant(2_000_000), categoryId: categoryId, categoryPath: [categoryId], qty: 1, lineTotal: 2_000_000 }],
  userId
})
assert.equal(sharedPreview.applied, 1_000_000, 'POS preview uses the remaining amount of the shared lineage')

const secondDescendantSale = await createSale({
  lines: [{ variantId: makeVariant(2_000_000), amount: 2_000_000 }],
  code: sibling.code
})
assert.equal(Number(redemption(secondDescendantSale.id).amount), 1_000_000)
assert.equal(Number(readLineage(root.id).usedAmount), 5_000_000)
assert.equal(Number(readLineage(root.id).usedCount), 2)

const blockedVariant = makeVariant(1_000_000)
const blockedInvoice = seed.invoice({ grandTotal: 1_000_000, receiptNo: 900_001 })
seed.invoiceItem(blockedInvoice.id, { variantId: blockedVariant, qty: 1, lineTotal: 1_000_000 })
await assert.rejects(
  () => db.$transaction((tx) => redeemStoreCredit(tx, {
    code: sibling.code,
    invoiceId: blockedInvoice.id,
    receiptNo: blockedInvoice.receiptNo,
    applicable: 500_000,
    invoiceTotal: blockedInvoice.grandTotal
  })),
  /باقی‌مانده‌ی این اعتبار صفر است/
)
assert.equal(Number(readLineage(root.id).usedAmount), 5_000_000, 'rejected use must leave shared amount unchanged')
assert.equal(Number(readLineage(root.id).usedCount), 2, 'rejected use must leave shared count unchanged')

// A separate 10M lineage proves that maxUses is global even when both barcode
// balances and the root amount still have ample room.
const useLimitedRoot = await issueRoot(10_000_000)
const useLimitedSibling = await issueStoreCredit(db, {
  amount: 10_000_000,
  source: 'MANUAL',
  lineageId: Number(useLimitedRoot.id),
  days: null,
  maxUses: 1,
  multiUse: false,
  carryRemainder: false,
  length: 8,
  note: 'shared maxUses acceptance test'
})
await createSale({ lines: [{ variantId: makeVariant(1_000_000), amount: 1_000_000 }], code: useLimitedRoot.code })
await createSale({ lines: [{ variantId: makeVariant(1_000_000), amount: 1_000_000 }], code: useLimitedSibling.code })
assert.equal(Number(readLineage(useLimitedRoot.id).usedAmount), 2_000_000)
assert.equal(Number(readLineage(useLimitedRoot.id).usedCount), 2)
const useLimitVariant = makeVariant(1_000_000)
const useLimitInvoice = seed.invoice({ grandTotal: 1_000_000, receiptNo: 950_000 })
seed.invoiceItem(useLimitInvoice.id, { variantId: useLimitVariant, qty: 1, lineTotal: 1_000_000 })
await assert.rejects(
  () => db.$transaction((tx) => redeemStoreCredit(tx, {
    code: useLimitedSibling.code,
    invoiceId: useLimitInvoice.id,
    receiptNo: useLimitInvoice.receiptNo,
    applicable: 500_000,
    invoiceTotal: useLimitInvoice.grandTotal
  })),
  /دفعات مجاز مصرف این اعتبار تمام شده است/
)
assert.equal(Number(readLineage(useLimitedRoot.id).usedAmount), 2_000_000, 'max-use rejection does not change shared amount')
assert.equal(Number(readLineage(useLimitedRoot.id).usedCount), 2, 'max-use rejection does not change shared count')

// Returning a fully consumed descendant redemption restores the source barcode
// in place. Voiding that partial return re-applies the 4M use and reopens the
// redemption; neither the credit nor the shared lineage may remain double-live.
const firstDescendantItem = saleItems(firstDescendantSale.id)[0]
const inPlaceReturn = await createNoRefundReturn({
  invoiceId: firstDescendantSale.id,
  saleItemId: firstDescendantItem.id,
  note: 'برگشت جزئی مصرف اعتبار برای آزمون ابطال'
})
assert.equal(Number(inPlaceReturn.returnCreditAmount), 4_000_000)
const inPlaceAllocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=? AND amount>0', inPlaceReturn.id)
assert.equal(Number(inPlaceAllocation.restoredCreditId), Number(firstSuccessor.id), 'in-place restore points to the original descendant barcode')
assert.equal(Number(readLineage(root.id).usedAmount), 1_000_000)
assert.equal(Number(readLineage(root.id).usedCount), 1)
const firstDescendantRedemption = redemption(firstDescendantSale.id)
assert.ok(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', firstDescendantRedemption.id).reversedAt)

const inPlaceVoid = await salesService.returnDelete({
  id: inPlaceReturn.id,
  userId,
  reason: 'ابطال برگشت lineage درجا',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(inPlaceVoid.voided, true)
assert.equal(Number(readLineage(root.id).usedAmount), 5_000_000)
assert.equal(Number(readLineage(root.id).usedCount), 2)
const restoredFirstDescendant = seed.one('SELECT usedAmount,usedCount,status FROM "StoreCredit" WHERE id=?', firstSuccessor.id)
assert.equal(Number(restoredFirstDescendant.usedAmount), 4_000_000)
assert.equal(Number(restoredFirstDescendant.usedCount), 1)
assert.equal(restoredFirstDescendant.status, 'PARTIALLY_USED')
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', firstDescendantRedemption.id).reversedAt, null)

// A USED source creates a successor on a partial return. Voiding that return
// cancels the unused successor and restores the source's shared counters.
const root2 = await issueRoot(5_000_000)
const usedRootSale = await createSale({
  lines: [
    { variantId: makeVariant(4_000_000), amount: 4_000_000 },
    { variantId: makeVariant(1_000_000), amount: 1_000_000 }
  ],
  code: root2.code
})
assert.equal(Number(readLineage(root2.id).usedAmount), 5_000_000)
assert.equal(Number(readLineage(root2.id).usedCount), 1)
const usedRootRedemption = redemption(usedRootSale.id)
const usedRootPartialReturn = await createNoRefundReturn({
  invoiceId: usedRootSale.id,
  saleItemId: saleItems(usedRootSale.id)[0].id,
  note: 'برگشت جزئی از اعتبار مصرف‌شده'
})
assert.equal(Number(usedRootPartialReturn.returnCreditAmount), 4_000_000)
const usedRootSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id LIMIT 1', usedRootPartialReturn.id)
assert.ok(usedRootSuccessor)
assert.equal(Number(usedRootSuccessor.lineageId), Number(root2.id))
assert.equal(Number(readLineage(root2.id).usedAmount), 1_000_000)
assert.equal(Number(readLineage(root2.id).usedCount), 1, 'partial return does not release a use until that redemption is fully reversed')
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', usedRootRedemption.id).reversedAt, null)

const successorVoid = await salesService.returnDelete({
  id: usedRootPartialReturn.id,
  userId,
  reason: 'ابطال successor مصرف‌نشده',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(successorVoid.voided, true)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', usedRootSuccessor.id).status, 'CANCELED')
assert.equal(Number(readLineage(root2.id).usedAmount), 5_000_000)
assert.equal(Number(readLineage(root2.id).usedCount), 1)
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', usedRootRedemption.id).reversedAt, null)

// Direct exchange return also restores source-credit lineage. Its unused source
// successor and money-backed refund voucher can then be voided together without
// leaving the source use reversed or splitting the shared allowance.
const exchangeRoot = await issueRoot(5_000_000)
const exchangeSale = await createSale({
  lines: [20_000_000, 20_000_000, 20_000_000, 20_000_000].map((amount) => ({ variantId: makeVariant(amount), amount })),
  cash: 75_000_000,
  code: exchangeRoot.code
})
const exchangeRedemption = redemption(exchangeSale.id)
const exchangeResult = await salesService.createExchange({
  userId,
  shiftId,
  invoiceId: exchangeSale.id,
  lines: [{ saleItemId: saleItems(exchangeSale.id)[0].id, qty: 1 }],
  replacements: [{ variantId: makeVariant(10_000_000), qty: 1, unitPrice: 10_000_000, discount: 0, tax: 0 }],
  refundMode: 'STORE_CREDIT'
})
assert.equal(Number(exchangeResult.sourceCreditRestoredAmount), 5_000_000)
assert.equal(Number(readLineage(exchangeRoot.id).usedAmount), 0)
assert.equal(Number(readLineage(exchangeRoot.id).usedCount), 0)
const exchangeSuccessor = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? AND lineageId=? ORDER BY id LIMIT 1',
  exchangeResult.returnId, exchangeRoot.id)
assert.ok(exchangeSuccessor)
const exchangeAllocation = seed.one('SELECT * FROM "CreditReturnAllocation" WHERE returnId=? AND sourceCreditId=? AND amount>0',
  exchangeResult.returnId, exchangeRoot.id)
assert.equal(Number(exchangeAllocation.restoredCreditId), Number(exchangeSuccessor.id))
assert.ok(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', exchangeRedemption.id).reversedAt)
const exchangeVoid = await salesService.returnDelete({
  id: exchangeResult.returnId,
  userId,
  reason: 'ابطال تعویض lineage مصرف‌نشده',
  panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(exchangeVoid.voided, true)
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id=?', exchangeSuccessor.id).status, 'CANCELED')
assert.equal(Number(readLineage(exchangeRoot.id).usedAmount), 5_000_000)
assert.equal(Number(readLineage(exchangeRoot.id).usedCount), 1)
assert.equal(seed.one('SELECT reversedAt FROM "StoreCreditRedemption" WHERE id=?', exchangeRedemption.id).reversedAt, null)

console.log('✓ R2-B02 shared lineage amount/use caps, returns, exchange source restoration, and safe void reversal passed')
await db.$disconnect?.()
