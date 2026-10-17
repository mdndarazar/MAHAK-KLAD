/** Manager PIN + receipt/witness: atomic transfer of only valid remaining value.
 * Run with: node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-manager-replace.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-manager-replace-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { createManagerCorrectionApprovalSecret } = await import('../../src/main/services/AuthService.ts')
const { issueStoreCredit, findRedeemable, storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { managerReplaceLostCredit } = await import('../../src/main/services/CreditRecoveryService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const managerId = seed.user('named manager')
sql.prepare('UPDATE "User" SET passwordHash = ? WHERE id = ?').run(createManagerCorrectionApprovalSecret('4321'), managerId)
const cat = seed.category('Manager replacement')
const product = seed.product('Item', cat)
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = 100 WHERE id = ?').run(variant)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, userId: managerId,
  openedAt: Date.now() - 10000, dayJalali: toJalaliDate(new Date()) })
const sale = await salesService.create({ userId: managerId, shiftId,
  lines: [{ variantId: variant, qty: 1, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 100, destination: 'CASH' }] })
const original = await db.$transaction((tx) => issueStoreCredit(tx, {
  amount: 300, source: 'MANUAL', sourceInvoiceId: sale.id, days: 30,
  multiUse: true, maxUses: 10, note: 'هدیهٔ آزمایشی دارای مانده', userId: managerId
}))
const priorExpires = new Date(original.expiresAt).getTime()
await salesService.create({ userId: managerId, shiftId,
  lines: [{ variantId: variant, qty: 1, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [], storeCreditCode: original.code, storeCreditIdempotencyKey: 'replace-before-spend-100' })
const before = seed.one('SELECT usedAmount, status FROM "StoreCredit" WHERE id = ?', original.id)
assert.equal(Number(before.usedAmount), 100)
const claim = { creditId: original.id, receiptNo: sale.receiptNo,
  receiptRef: `رسید چاپی فاکتور ${sale.receiptNo} ارائه شد`,
  witnessRef: 'مدیر سند اصلی و توضیح فقدان کد را بررسی کرد',
  reason: 'مشتری کد چاپی را گم کرده است',
  approvingManagerId: managerId, managerPin: '4321', actorUserId: managerId }
await assert.rejects(() => managerReplaceLostCredit({ ...claim, receiptNo: sale.receiptNo + 1 }), /رسید/)
await assert.rejects(() => managerReplaceLostCredit({ ...claim, managerPin: 'wrong' }), /رمز شخصی/)
const replacement = await managerReplaceLostCredit(claim)
assert.equal(replacement.transferredAmount, 200)
const successor = seed.one('SELECT * FROM "StoreCredit" WHERE id = ?', replacement.successorCreditId)
assert.equal(successor.status, 'DRAFT')
assert.equal(Number(successor.amount), 200)
assert.equal(new Date(successor.expiresAt).getTime(), priorExpires, 'gift retains original expiry')
assert.equal(seed.one('SELECT status FROM "StoreCredit" WHERE id = ?', original.id).status, 'CANCELED')
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id = ?', original.id).usedAmount, 100)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CreditReplacement" WHERE originalCreditId = ?', original.id).n, 1)
const originalDetail = await storeCreditService.detail({ id: original.id })
const successorDetail = await storeCreditService.detail({ id: successor.id })
assert.equal(originalDetail.replacement.successorCreditId, successor.id)
assert.equal(successorDetail.delivery.status, 'PENDING_DELIVERY')
assert.equal(successorDetail.replacement.transferredAmount, 200)
await assert.rejects(() => printService.creditHtml(successor.id), /پیش‌نمایش|جانشین/)
await assert.rejects(() => printService.creditBatchDocs({ ids: [successor.id] }), /گروهی|تحویل‌نشده/)
assert.doesNotMatch(JSON.stringify({ originalDetail, successorDetail }), new RegExp(original.code + '|' + successor.code),
  'detail/refresh may show linked case but never disclose either credential')
await assert.rejects(() => findRedeemable(db, original.code), /باطل/)
await assert.rejects(() => findRedeemable(db, successor.code), /پیش‌نویس/)
await assert.rejects(() => managerReplaceLostCredit(claim), /تعیین تکلیف|جانشین/)
console.log('✓ named manager PIN + matching receipt; exactly 200 transferred; old usage preserved, both codes initially locked')

// Printing is NOT delivery: no transition until the separate witnessed step.
assert.equal(seed.one('SELECT status FROM "CreditDelivery" WHERE creditId = ?', successor.id).status, 'PENDING_DELIVERY')
assert.equal((await confirmCreditDelivery({ creditId: successor.id,
  witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'تحویل حضوری به گیرندهٔ پرونده',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: managerId })).status, 'DELIVERED')
assert.equal((await findRedeemable(db, successor.code)).id, successor.id)
await salesService.create({ userId: managerId, shiftId,
  lines: [{ variantId: variant, qty: 2, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [], storeCreditCode: successor.code, storeCreditIdempotencyKey: 'replace-after-spend-200' })
assert.equal(seed.one('SELECT usedAmount FROM "StoreCredit" WHERE id = ?', successor.id).usedAmount, 200)
console.log('✓ print alone not delivery; witnessed successor spends exactly remaining 200 once')

// Recovering a B branch must preserve its H1 origin for any later E return.
const v400 = seed.variant(product), v50 = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=400 WHERE id=?').run(v400)
sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=50 WHERE id=?').run(v50)
const h1 = await db.$transaction((tx) => issueStoreCredit(tx, {
  amount: 1000, source: 'MANUAL', days: 30, multiUse: false, maxUses: 1, carryRemainder: false,
  userId: managerId
}))
const mixed = await salesService.create({ userId: managerId, shiftId,
  lines: [{ variantId: variant, qty: 1, unitPrice: 100, discount: 0, tax: 0 },
    { variantId: v400, qty: 1, unitPrice: 400, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 200, destination: 'CASH' }],
  storeCreditCode: h1.code, storeCreditAmount: 300, storeCreditIdempotencyKey: 'manager-chain-h1'
})
const mixedItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', mixed.id, variant).id
const partial = await salesService.createReturn({ invoiceId: mixed.id, full: false,
  lines: [{ saleItemId: mixedItem, qty: 1 }], refundMethod: 'CASH', refundAmount: 40,
  userId: managerId, shiftId })
const bId = partial.creditOpportunity.pendingDelivery[0].creditId
await confirmCreditDelivery({ creditId: bId, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'مشتری برگهٔ B را با شاهد دریافت کرد', managerPassword: DEFAULT_MANAGER_PASSWORD,
  actorUserId: managerId })
const bRecovery = await managerReplaceLostCredit({ creditId: bId, receiptNo: mixed.receiptNo,
  receiptRef: `رسید فاکتور ${mixed.receiptNo} به مدیر ارائه شد`,
  witnessRef: 'مدیر کد B را در حضور مشتری تطبیق داد', reason: 'گم‌شدن برگهٔ B نزد مشتری',
  approvingManagerId: managerId, managerPin: '4321', actorUserId: managerId })
const bReplacement = seed.one('SELECT * FROM "StoreCredit" WHERE id=?', bRecovery.successorCreditId)
assert.equal(bReplacement.amount, 60)
assert.equal(new Date(bReplacement.expiresAt).getTime(), new Date(h1.expiresAt).getTime())
await confirmCreditDelivery({ creditId: bReplacement.id, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'مشتری جانشین کد B را با شاهد تحویل گرفت', managerPassword: DEFAULT_MANAGER_PASSWORD,
  actorUserId: managerId })
const spentB = await salesService.create({ userId: managerId, shiftId,
  lines: [{ variantId: v50, qty: 2, unitPrice: 50, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 50, destination: 'CASH' }],
  storeCreditCode: bReplacement.code, storeCreditAmount: 50, storeCreditIdempotencyKey: 'manager-chain-successor-spend'
})
const eReturn = await salesService.createReturn({ invoiceId: spentB.id, full: false,
  lines: [{ saleItemId: seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', spentB.id).id, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 25, userId: managerId, shiftId })
assert.equal(eReturn.creditOpportunity.restored, 25)
assert.equal(seed.one('SELECT rootCreditId FROM "CreditReturnAllocation" WHERE returnId=?', eReturn.id).rootCreditId, h1.id)
console.log('✓ manager recovery of B preserves H1 root and expiry; later E is 25, not a new cash right')
