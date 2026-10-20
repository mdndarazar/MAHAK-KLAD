/**
 * A synthetic/legacy ordinary return directly attached to an EXCHANGE child
 * invoice must not use correction paths that do not yet reverse child-line
 * provenance or prove settlement entitlement. Normal createReturn on such an
 * invoice remains closed; these rows model legacy or direct-DB data.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-child-return-correction-guard.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-child-return-correction-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { pendingRestockService } = await import('../../src/main/services/PendingRestockService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { prepareGoodsCorrection, applyGoodsCorrection } = await import('../../src/main/services/ReturnGoodsCorrectionService.ts')
const { periodLockService } = await import('../../src/main/services/PeriodLockService.ts')
const { shiftService } = await import('../../src/main/services/ShiftService.ts')
const { recordExchangeFundingReturnLineAllocation } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { openCardTransferEntitlement, convertCashRight, confirmCreditDelivery,
  reconcileBankDocument, correctPendingEntitlement, markBankDeclaration,
  markBankCancellationUnknown, quarantineEntitlement } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { planCreditReturn, applyCreditReturn } = await import('../../src/main/services/CreditReturnService.ts')
const { remainingOf } = await import('../../src/shared/settlement.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('child return correction guard')
const categoryId = seed.category('child return correction guard')
const productId = seed.product('child return correction guard', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const now = new Date()
const shiftId = seed.insert('Shift', {
  name: 'child return correction shift', number: 1, userId,
  dayJalali: toJalaliDate(now), openedAt: now.getTime() - 10_000
})
const variant = (label) => {
  const id = seed.variant(productId, label)
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=1000 WHERE id=?').run(id)
  return id
}
const sourceVariant = variant('source')
const replacementVariant = variant('replacement')
const sale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: sourceVariant, qty: 3, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 3000, destination: 'CASH' }]
})
const sourceItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id)
const exchange = await salesService.createExchange({
  invoiceId: sale.id,
  lines: [{ saleItemId: sourceItemId, qty: 3 }],
  replacements: [{ variantId: replacementVariant, qty: 3 }],
  refundMode: 'STORE_CREDIT', userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD
})
const child = seed.one('SELECT id, orderType FROM "SaleInvoice" WHERE id=?', exchange.exchangeInvoiceId)
assert.equal(child.orderType, 'EXCHANGE')
const childItem = seed.one('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', child.id)
const misclassifiedBefore = {
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', child.id).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}
sql.prepare('UPDATE "SaleInvoice" SET orderType=? WHERE id=?').run('INTERNAL', child.id)
await assert.rejects(() => salesService.returnProvenancePreview({
  invoiceId: child.id, lines: [{ saleItemId: Number(childItem.id), qty: 1 }]
}), /تخصیص منشأ به قلم/,
'provenance preview must not expose ordinary-sale refund rights for an exchange child with a corrupted orderType')
await assert.rejects(() => salesService.createReturn({
  invoiceId: child.id, full: false,
  lines: [{ saleItemId: Number(childItem.id), qty: 1 }],
  refundMethod: 'CASH', refundAmount: 1000, userId, shiftId
}), /تخصیص منشأ به قلم/,
'non-null exchange lineage markers keep the ordinary-return gate closed even if orderType is corrupted')
assert.deepEqual({
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', child.id).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}, misclassifiedBefore)
// Either lineage marker alone is enough to route to the child-return hold;
// a corrupt orderType must never fall through to the ordinary refund preview.
sql.prepare('UPDATE "SaleInvoice" SET exchangeReturnId=NULL WHERE id=?').run(child.id)
await assert.rejects(() => salesService.returnProvenancePreview({
  invoiceId: child.id, lines: [{ saleItemId: Number(childItem.id), qty: 1 }]
}), /تخصیص منشأ به قلم/,
'sourceInvoiceId alone must identify a misclassified exchange child')
await assert.rejects(() => salesService.createReturn({
  invoiceId: child.id, lines: [{ saleItemId: Number(childItem.id), qty: 1 }],
  refundMethod: 'CASH', refundAmount: 1000, userId, shiftId
}), /تخصیص منشأ به قلم/,
'sourceInvoiceId alone must block the ordinary refund mutation too')
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=? WHERE id=?')
  .run(exchange.returnId, child.id)
await assert.rejects(() => salesService.returnProvenancePreview({
  invoiceId: child.id, lines: [{ saleItemId: Number(childItem.id), qty: 1 }]
}), /تخصیص منشأ به قلم/,
'exchangeReturnId alone must identify a misclassified exchange child')
await assert.rejects(() => salesService.createReturn({
  invoiceId: child.id, lines: [{ saleItemId: Number(childItem.id), qty: 1 }],
  refundMethod: 'CASH', refundAmount: 1000, userId, shiftId
}), /تخصیص منشأ به قلم/,
'exchangeReturnId alone must block the ordinary refund mutation too')
assert.deepEqual({
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', child.id).n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}, misclassifiedBefore, 'marker-only child paths leave the ordinary refund system untouched')
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=?, exchangeReturnId=? WHERE id=?')
  .run(sale.id, exchange.returnId, child.id)
sql.prepare('UPDATE "SaleInvoice" SET orderType=? WHERE id=?').run('EXCHANGE', child.id)
const returnIds = []
for (let index = 0; index < 3; index++) {
  const id = seed.insert('SaleReturn', {
    invoiceId: child.id, isFull: false, total: 1000, returnedAt: now,
    returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
    kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
  })
  const returnItemId = seed.insert('SaleReturnItem', {
    returnId: id, saleItemId: Number(childItem.id), variantId: Number(childItem.variantId),
    qty: 1, unitPrice: 1000, lineTotal: 1000, restockedQty: 0
  })
  returnIds.push(id)
  await db.$transaction((tx) => recordExchangeFundingReturnLineAllocation(tx, {
    returnId: id, returnItemId
  }))
}
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=? AND voidedAt IS NULL', child.id).n, 3)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation" WHERE childInvoiceId=? AND eventKind=?',
  child.id, 'ALLOCATION').n, 3,
  'the child returns have valid descriptive source allocation but no financial entitlement')
const entitlementStateBeforeDirectOpen = {
  claims: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => openCardTransferEntitlement(db, {
  returnId: returnIds[0], invoiceId: child.id, requestId: 987654321, amount: 1
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'direct entitlement service calls must not convert descriptive child provenance into a cash right')
assert.deepEqual({
  claims: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, entitlementStateBeforeDirectOpen, 'the rejected child claim attempt leaves no financial events')
await assert.rejects(() => planCreditReturn(db, {
  invoiceId: child.id, grandTotal: 3000, paidTotal: 3000, returnedValue: 1000,
  debtBefore: remainingOf({ grandTotal: 3000, received: 3000 }),
  activeReturns: [{ id: returnIds[0], kind: 'RETURN', total: 1000 }]
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'direct return planning must not treat EXCHANGE_CREDIT as received cash')
const giftMethodId = seed.insert('PaymentMethod', {
  key: 'CHILD-DIRECT-GIFT', label: 'Synthetic child gift', kind: 'STORE_CREDIT', isActive: 1
})
const syntheticGiftId = seed.insert('StoreCredit', {
  code: 'CHILD-DIRECT-ROOT', amount: 100, usedAmount: 100, usedCount: 1, status: 'USED', expiresAt: null
})
const syntheticPaymentId = seed.insert('Payment', {
  invoiceId: child.id, methodId: giftMethodId, amount: 100, kind: 'CASH', storeCreditId: syntheticGiftId
})
const syntheticRedemptionId = seed.insert('StoreCreditRedemption', {
  creditId: syntheticGiftId, code: 'CHILD-DIRECT-ROOT', amount: 100, remainderAfter: 0,
  invoiceId: child.id, paymentId: syntheticPaymentId, idempotencyKey: 'child-direct-redemption',
  expiryCaptured: true, expiryAtRedeem: null
})
const directCreditEffectsBefore = {
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  allocations: seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation"').n,
  deliveries: seed.one('SELECT COUNT(*) n FROM "CreditDelivery"').n
}
await assert.rejects(() => applyCreditReturn(db, {
  invoiceId: child.id, returnId: returnIds[0], full: false, userId,
  plan: { credit: 100, cash: 0, fundedReturning: 100,
    shares: [{ redemptionId: syntheticRedemptionId, parentCreditId: syntheticGiftId, amount: 100, prior: 0 }] }
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'direct credit-return application must not issue a DRAFT B/E for an exchange child')
assert.deepEqual({
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  allocations: seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation"').n,
  deliveries: seed.one('SELECT COUNT(*) n FROM "CreditDelivery"').n
}, directCreditEffectsBefore, 'child credit-return rejection writes no successor, allocation, or delivery')
const importedChildBranchCreditId = seed.insert('StoreCredit', {
  code: 'CHILD-DIRECT-BRANCH', amount: 100, usedAmount: 0, usedCount: 0,
  status: 'DRAFT', expiresAt: null
})
seed.insert('CreditDelivery', { creditId: importedChildBranchCreditId,
  sourceKind: 'CREDIT_RETURN_OPPORTUNITY', status: 'PENDING_DELIVERY' })
seed.insert('CreditReturnAllocation', {
  returnId: returnIds[2], invoiceId: child.id, redemptionId: syntheticRedemptionId,
  parentCreditId: syntheticGiftId, rootCreditId: syntheticGiftId, originNominal: 100,
  amount: 100, supplementUnspent: 0, successorCreditId: importedChildBranchCreditId,
  kind: 'BRANCH', originalExpiresAt: null
})
const deliveryEffectsBefore = {
  status: seed.one('SELECT status FROM "StoreCredit" WHERE id=?', importedChildBranchCreditId).status,
  deliveryStatus: seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', importedChildBranchCreditId).status,
  delivered: seed.one('SELECT COUNT(*) n FROM "CreditDelivery" WHERE creditId=? AND status=?',
    importedChildBranchCreditId, 'DELIVERED').n
}
await assert.rejects(() => confirmCreditDelivery({
  creditId: importedChildBranchCreditId, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'customer received printed child code',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a legacy child-return B/E cannot become spendable through direct witnessed delivery')
assert.deepEqual({
  status: seed.one('SELECT status FROM "StoreCredit" WHERE id=?', importedChildBranchCreditId).status,
  deliveryStatus: seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', importedChildBranchCreditId).status,
  delivered: seed.one('SELECT COUNT(*) n FROM "CreditDelivery" WHERE creditId=? AND status=?',
    importedChildBranchCreditId, 'DELIVERED').n
}, deliveryEffectsBefore, 'blocked child delivery does not activate the code or record a handoff')
const legacyChildClaimId = seed.insert('ReturnEntitlement', {
  returnId: returnIds[1], invoiceId: child.id, cashRight: 100, cashReserved: 0,
  cashPaid: 0, cashConverted: 0, giftOpportunity: 0, debtReduced: 0, state: 'OPEN', version: 0
})
assert.ok(legacyChildClaimId > 0)
const quarantineBefore = {
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', legacyChildClaimId).state,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', legacyChildClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => quarantineEntitlement(db, {
  returnId: returnIds[1], reason: 'attempt to quarantine exchange child claim', actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a source quarantine must not mutate an exchange child entitlement directly')
assert.deepEqual({
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', legacyChildClaimId).state,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', legacyChildClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, quarantineBefore, 'blocked child quarantine leaves state, version, and journal unchanged')
const bankRequestId = seed.insert('CardTransferRequest', {
  kind: 'REQUEST', status: 'PAID', operationKind: 'RETURN', returnId: returnIds[0],
  sourceInvoiceId: child.id, amount: 100, paidAmount: 100, paidAt: new Date()
})
const legacyChildBankClaimId = seed.insert('ReturnEntitlement', {
  returnId: returnIds[0], invoiceId: child.id, requestId: bankRequestId,
  cashRight: 100, cashReserved: 100, cashPaid: 0, cashConverted: 0,
  giftOpportunity: 0, debtReduced: 0, state: 'UNKNOWN_BANK', version: 0
})
assert.ok(legacyChildBankClaimId > 0)
const bankReconciliationEffectsBefore = {
  cashPaid: seed.one('SELECT cashPaid FROM "ReturnEntitlement" WHERE id=?', legacyChildBankClaimId).cashPaid,
  cashReserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', legacyChildBankClaimId).cashReserved,
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', legacyChildBankClaimId).state,
  evidence: seed.one('SELECT COUNT(*) n FROM "BankStatementEvidence" WHERE requestId=?', bankRequestId).n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => reconcileBankDocument({
  requestId: bankRequestId, confirmedAmount: 100,
  document: { name: 'child-bank.pdf', bytes: Buffer.from('%PDF-1.7\\nstatement child 100\\n%%EOF\\n') },
  reviewNote: 'تطبیق حساب و تاریخ و مبلغ سند بانکی فرزند',
  attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a bank document must not settle a legacy child claim as paid cash')
assert.deepEqual({
  cashPaid: seed.one('SELECT cashPaid FROM "ReturnEntitlement" WHERE id=?', legacyChildBankClaimId).cashPaid,
  cashReserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', legacyChildBankClaimId).cashReserved,
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', legacyChildBankClaimId).state,
  evidence: seed.one('SELECT COUNT(*) n FROM "BankStatementEvidence" WHERE requestId=?', bankRequestId).n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, bankReconciliationEffectsBefore, 'rejected child bank review creates no payout evidence or paid amount')
const pendingChildClaimId = seed.insert('ReturnEntitlement', {
  returnId: returnIds[2], invoiceId: child.id, requestId: 818181,
  cashRight: 100, cashReserved: 100, cashPaid: 0, cashConverted: 0,
  giftOpportunity: 0, debtReduced: 0, state: 'OPEN', version: 0
})
seed.insert('CardTransferRequest', {
  id: 818181, kind: 'REQUEST', status: 'PENDING', operationKind: 'RETURN',
  returnId: returnIds[2], sourceInvoiceId: child.id, amount: 100, returnTotal: 100
})
sql.prepare('UPDATE "SaleReturn" SET restockPending=1, goodsReceiptRequired=1 WHERE id=?').run(returnIds[2])
const childGoodsItemId = seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=?', returnIds[2]).id
const childGoodsBefore = {
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', childItem.variantId).stock),
  restockedQty: seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE id=?', childGoodsItemId).restockedQty,
  pending: seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', returnIds[2]).restockPending,
  receipts: seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', returnIds[2]).n
}
await assert.rejects(() => returnGoodsService.receive({
  returnId: returnIds[2], returnItemId: Number(childGoodsItemId), qty: 1,
  eventKey: 'child-goods-receipt-blocked', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'physical child return item verified', physicalConfirmed: true, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a physical-goods receipt must not bypass unsupported exchange-child return lineage')
assert.deepEqual({
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', childItem.variantId).stock),
  restockedQty: seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE id=?', childGoodsItemId).restockedQty,
  pending: seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', returnIds[2]).restockPending,
  receipts: seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', returnIds[2]).n
}, childGoodsBefore, 'blocked physical child receipt adds no inventory or receipt row')
const importedChildReceiptKey = 'imported-child-goods-replay'
seed.insert('ReturnGoodsReceipt', {
  eventKey: importedChildReceiptKey, returnId: returnIds[2], returnItemId: Number(childGoodsItemId),
  variantId: Number(childItem.variantId), qty: 1, actorUserId: userId,
  witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'legacy physical receipt witness'
})
await assert.rejects(() => returnGoodsService.receive({
  returnId: returnIds[2], returnItemId: Number(childGoodsItemId), qty: 1,
  eventKey: importedChildReceiptKey, witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'legacy physical receipt witness', physicalConfirmed: true, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a stored child receipt idempotency key must not replay as valid after lineage is checked')
const childGoodsView = await returnGoodsService.items(returnIds[2])
assert.equal(childGoodsView.unsupportedLineage, true,
  'the physical intake reader must mark unsupported exchange-child lineage')
assert.deepEqual(childGoodsView.items, [],
  'the physical intake reader must not expose selectable/receivable child return quantities')
const childCorrectionReturn = {
  id: returnIds[2], invoiceId: child.id, goodsReceiptRequired: true,
  items: [{ id: Number(childGoodsItemId), saleItemId: Number(childItem.id),
    variantId: Number(childItem.variantId), qty: 1, restockedQty: 0 }]
}
await assert.rejects(() => prepareGoodsCorrection(db, childCorrectionReturn),
  /فرزند تعویض|lineage|تخصیص منشأ/iu,
  'a direct goods-correction plan must not be built for unsupported exchange-child lineage')
const childApplyBefore = {
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', childItem.variantId).stock),
  movements: seed.one('SELECT COUNT(*) n FROM "StockMovement"').n
}
await assert.rejects(() => applyGoodsCorrection(db,
  { id: returnIds[2], invoiceId: child.id },
  { sources: [{ id: null, receiptId: null, returnItemId: Number(childGoodsItemId),
    variantId: Number(childItem.variantId), allocationId: null, sourceKind: 'STORE',
    warehouseId: null, warehouseName: '', secondaryStockItemId: null,
    stockItemName: null, stockItemCode: null, qty: 1 }], allocationDebits: [] },
  { correctionId: 999999, receiptNo: null, userId, reason: 'direct child goods correction', at: now }
), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a direct goods-correction apply must not reverse stock for an exchange-child return')
assert.deepEqual({
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', childItem.variantId).stock),
  movements: seed.one('SELECT COUNT(*) n FROM "StockMovement"').n
}, childApplyBefore, 'blocked child goods correction writes no inventory movement')
const pendingChildCorrectionBefore = {
  cashRight: seed.one('SELECT cashRight FROM "ReturnEntitlement" WHERE id=?', pendingChildClaimId).cashRight,
  cashReserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', pendingChildClaimId).cashReserved,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', pendingChildClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => correctPendingEntitlement(db, {
  returnId: returnIds[2], requestId: 818181, newRight: 500,
  reason: 'attempt to enlarge imported child cash right', actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a pending-right correction must not enlarge a legacy child claim')
assert.deepEqual({
  cashRight: seed.one('SELECT cashRight FROM "ReturnEntitlement" WHERE id=?', pendingChildClaimId).cashRight,
  cashReserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', pendingChildClaimId).cashReserved,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', pendingChildClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, pendingChildCorrectionBefore, 'blocked child right correction changes neither projection nor journal')
const extraChildReturn = () => seed.insert('SaleReturn', {
  invoiceId: child.id, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const declarationReturnId = extraChildReturn()
const declarationRequestId = 919191
const declarationClaimId = seed.insert('ReturnEntitlement', {
  returnId: declarationReturnId, invoiceId: child.id, requestId: declarationRequestId,
  cashRight: 100, cashReserved: 100, cashPaid: 0, cashConverted: 0,
  giftOpportunity: 0, debtReduced: 0, state: 'OPEN', version: 0
})
const declarationBefore = {
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', declarationClaimId).state,
  reserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', declarationClaimId).cashReserved,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', declarationClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => markBankDeclaration(db, {
  requestId: declarationRequestId, declaredAmount: 100, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a manager payout declaration must not mutate an exchange child claim')
assert.deepEqual({
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', declarationClaimId).state,
  reserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', declarationClaimId).cashReserved,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', declarationClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, declarationBefore, 'blocked child bank declaration leaves state, reservation, version, and journal unchanged')

const cancellationReturnId = extraChildReturn()
const cancellationRequestId = 929292
const cancellationClaimId = seed.insert('ReturnEntitlement', {
  returnId: cancellationReturnId, invoiceId: child.id, requestId: cancellationRequestId,
  cashRight: 100, cashReserved: 100, cashPaid: 0, cashConverted: 0,
  giftOpportunity: 0, debtReduced: 0, state: 'OPEN', version: 0
})
const cancellationBefore = {
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', cancellationClaimId).state,
  reserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', cancellationClaimId).cashReserved,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', cancellationClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => markBankCancellationUnknown(db, {
  requestId: cancellationRequestId, reason: 'legacy child bank request cancellation', actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a bank cancellation must not transition an exchange child claim to unknown')
assert.deepEqual({
  state: seed.one('SELECT state FROM "ReturnEntitlement" WHERE id=?', cancellationClaimId).state,
  reserved: seed.one('SELECT cashReserved FROM "ReturnEntitlement" WHERE id=?', cancellationClaimId).cashReserved,
  version: seed.one('SELECT version FROM "ReturnEntitlement" WHERE id=?', cancellationClaimId).version,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, cancellationBefore, 'blocked child cancellation leaves state, reservation, version, and journal unchanged')

const restockProbeSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: replacementVariant, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 1000, destination: 'CASH' }]
})
sql.prepare('UPDATE "SaleInvoice" SET orderType=?, sourceInvoiceId=?, exchangeReturnId=? WHERE id=?')
  .run('EXCHANGE', sale.id, exchange.returnId, restockProbeSale.id)
const restockProbeItem = seed.one('SELECT id, variantId FROM "SaleInvoiceItem" WHERE invoiceId=?', restockProbeSale.id)
const restockChildReturn = seed.insert('SaleReturn', {
  invoiceId: restockProbeSale.id, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0, restockPending: true
})
const restockChildItemId = seed.insert('SaleReturnItem', {
  returnId: restockChildReturn, saleItemId: Number(restockProbeItem.id),
  variantId: Number(restockProbeItem.variantId), qty: 1, unitPrice: 1000, lineTotal: 1000, restockedQty: 0
})
sql.prepare('UPDATE "SaleReturn" SET restockPending=1, goodsReceiptRequired=0 WHERE id=?').run(restockChildReturn)
const restockBefore = {
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', restockProbeItem.variantId).stock),
  restockedQty: seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE id=?', restockChildItemId).restockedQty,
  restockPending: seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', restockChildReturn).restockPending,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}
await assert.rejects(() => pendingRestockService.releaseReturnStock(db, {
  returnId: restockChildReturn, reason: 'direct legacy child stock release'
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a direct legacy restock release must not bypass the exchange-child return hold')
assert.deepEqual({
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', restockProbeItem.variantId).stock),
  restockedQty: seed.one('SELECT restockedQty FROM "SaleReturnItem" WHERE id=?', restockChildItemId).restockedQty,
  restockPending: seed.one('SELECT restockPending FROM "SaleReturn" WHERE id=?', restockChildReturn).restockPending,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}, restockBefore, 'blocked child restock release leaves inventory and return state unchanged')

const legacyChildReturnWithoutClaim = extraChildReturn()
const makeLegacyChildRequest = (returnId, status = 'PENDING') => seed.insert('CardTransferRequest', {
  kind: 'REQUEST', status, operationKind: 'RETURN', returnId, sourceInvoiceId: child.id,
  amount: 100, returnTotal: 100, paidAmount: status === 'PAID' ? 100 : null,
  paidAt: status === 'PAID' ? now : null
})
const legacyPayRequestId = makeLegacyChildRequest(legacyChildReturnWithoutClaim)
const payRequestBefore = seed.one('SELECT status, paidAmount, paidAt FROM "CardTransferRequest" WHERE id=?', legacyPayRequestId)
const legacyPayEffectsBefore = {
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}
await assert.rejects(() => cardTransferService.pay({
  id: legacyPayRequestId, paidAmount: 100, managerPassword: DEFAULT_MANAGER_PASSWORD, userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a legacy child transfer with no entitlement must not use the payout declaration fallback')
assert.deepEqual(seed.one('SELECT status, paidAmount, paidAt FROM "CardTransferRequest" WHERE id=?', legacyPayRequestId),
  payRequestBefore, 'blocked legacy child payout leaves request payment fields unchanged')
assert.deepEqual({
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}, legacyPayEffectsBefore, 'blocked legacy child payout writes no stock, claim, or audit effects')

const legacyCancelReturn = extraChildReturn()
const legacyCancelRequestId = makeLegacyChildRequest(legacyCancelReturn)
const cancelRequestBefore = seed.one('SELECT status, canceledAt, cancelReason FROM "CardTransferRequest" WHERE id=?', legacyCancelRequestId)
await assert.rejects(() => cardTransferService.cancel({
  id: legacyCancelRequestId, reason: 'cancel child legacy payout',
  managerPassword: DEFAULT_MANAGER_PASSWORD, userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a legacy child transfer without an entitlement must not be canceled as if its outcome were ordinary')
assert.deepEqual(seed.one('SELECT status, canceledAt, cancelReason FROM "CardTransferRequest" WHERE id=?', legacyCancelRequestId),
  cancelRequestBefore, 'blocked legacy child cancellation leaves the request unchanged')

const legacyAdjustReturn = extraChildReturn()
const legacyAdjustRequestId = makeLegacyChildRequest(legacyAdjustReturn, 'PAID')
const adjustmentCountBefore = seed.one('SELECT COUNT(*) n FROM "CardTransferRequest" WHERE adjustsRequestId=?', legacyAdjustRequestId).n
await assert.rejects(() => cardTransferService.adjust({
  id: legacyAdjustRequestId, amount: -10, reason: 'reverse legacy child payout',
  managerPassword: DEFAULT_MANAGER_PASSWORD, userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a legacy child payout must not accept a manual correction outside the entitlement ledger')
assert.equal(seed.one('SELECT COUNT(*) n FROM "CardTransferRequest" WHERE adjustsRequestId=?', legacyAdjustRequestId).n,
  adjustmentCountBefore, 'blocked legacy child adjustment creates no correction event')
assert.equal(seed.one('SELECT status FROM "CardTransferRequest" WHERE id=?', legacyAdjustRequestId).status, 'PAID',
  'blocked legacy child adjustment leaves the original request unchanged')

const conversionEffectsBefore = {
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n,
  deliveries: seed.one('SELECT COUNT(*) n FROM "CreditDelivery"').n,
  converted: seed.one('SELECT cashConverted FROM "ReturnEntitlement" WHERE id=?', legacyChildClaimId).cashConverted
}
await assert.rejects(() => convertCashRight({
  returnId: returnIds[1], amount: 1, expectedVersion: 0,
  idempotencyKey: 'child-cash-right-conversion', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a pre-existing or imported child claim cannot be converted into spendable credit')
assert.deepEqual({
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n,
  deliveries: seed.one('SELECT COUNT(*) n FROM "CreditDelivery"').n,
  converted: seed.one('SELECT cashConverted FROM "ReturnEntitlement" WHERE id=?', legacyChildClaimId).cashConverted
}, conversionEffectsBefore, 'blocked child conversion changes no claim projection, event, code, or delivery')
// Simulate an already-imported child conversion (a legacy/forged entitlement
// and DRAFT code) and ensure handoff cannot activate it either.
sql.prepare('UPDATE "ReturnEntitlement" SET cashConverted=? WHERE id=?').run(100, legacyChildClaimId)
const importedCashCodeId = seed.insert('StoreCredit', {
  code: 'CHILD-DIRECT-CASH', amount: 100, usedAmount: 0, usedCount: 0,
  status: 'DRAFT', expiresAt: null
})
seed.insert('CreditDelivery', { creditId: importedCashCodeId,
  sourceKind: 'CASH_RIGHT_CONVERSION', status: 'PENDING_DELIVERY' })
seed.insert('ReturnEntitlementEvent', {
  entitlementId: legacyChildClaimId, eventKey: 'child-imported-cash-conversion',
  kind: 'CASH_RIGHT_CONVERTED', amount: 100, creditId: importedCashCodeId
})
const cashDeliveryBefore = {
  codeStatus: seed.one('SELECT status FROM "StoreCredit" WHERE id=?', importedCashCodeId).status,
  deliveryStatus: seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', importedCashCodeId).status,
  eventCount: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
await assert.rejects(() => confirmCreditDelivery({
  creditId: importedCashCodeId, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'customer received old converted code',
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a legacy child cash-right conversion cannot be activated by direct handoff')
assert.deepEqual({
  codeStatus: seed.one('SELECT status FROM "StoreCredit" WHERE id=?', importedCashCodeId).status,
  deliveryStatus: seed.one('SELECT status FROM "CreditDelivery" WHERE creditId=?', importedCashCodeId).status,
  eventCount: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, cashDeliveryBefore, 'blocked legacy child cash-right delivery remains DRAFT and unhanded')
const replayedChildCodeId = seed.insert('StoreCredit', {
  code: 'CHILD-DELIVERED-REPLAY', amount: 100, usedAmount: 0, usedCount: 0,
  status: 'ACTIVE', expiresAt: null
})
const deliveredWitnessRef = 'legacy child barcode was already handed over'
seed.insert('CreditDelivery', {
  creditId: replayedChildCodeId, sourceKind: 'CASH_RIGHT_CONVERSION', status: 'DELIVERED', version: 1,
  deliveredAt: now, deliveredByUserId: userId, witnessKind: 'CUSTOMER_HANDOFF', witnessRef: deliveredWitnessRef
})
seed.insert('ReturnEntitlementEvent', {
  entitlementId: legacyChildClaimId, eventKey: 'child-delivered-replay-conversion',
  kind: 'CASH_RIGHT_CONVERTED', amount: 100, creditId: replayedChildCodeId
})
await assert.rejects(() => confirmCreditDelivery({
  creditId: replayedChildCodeId, witnessKind: 'CUSTOMER_HANDOFF', witnessRef: deliveredWitnessRef,
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a delivered-child idempotency replay must revalidate the return lineage before claiming success')
const entitlementStateWithImportedChildClaim = {
  claims: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}
// A corrupted/misclassified orderType must not bypass the direct entitlement
// service guard; either lineage marker independently preserves the hold.
sql.prepare('UPDATE "SaleInvoice" SET orderType=? WHERE id=?').run('INTERNAL', child.id)
await assert.rejects(() => openCardTransferEntitlement(db, {
  returnId: returnIds[0], invoiceId: child.id, requestId: 987654322, amount: 1
}), /فرزند تعویض|lineage|تخصیص منشأ/iu)
await assert.rejects(() => planCreditReturn(db, {
  invoiceId: child.id, grandTotal: 3000, paidTotal: 3000, returnedValue: 1000,
  debtBefore: remainingOf({ grandTotal: 3000, received: 3000 }), activeReturns: []
}), /فرزند تعویض|EXCHANGE_CREDIT/iu,
'source markers must also protect the planner when orderType is corrupted')
sql.prepare('UPDATE "SaleInvoice" SET exchangeReturnId=NULL WHERE id=?').run(child.id)
await assert.rejects(() => openCardTransferEntitlement(db, {
  returnId: returnIds[0], invoiceId: child.id, requestId: 987654323, amount: 1
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'sourceInvoiceId alone must preserve the entitlement hold')
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=? WHERE id=?')
  .run(exchange.returnId, child.id)
await assert.rejects(() => openCardTransferEntitlement(db, {
  returnId: returnIds[0], invoiceId: child.id, requestId: 987654324, amount: 1
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'exchangeReturnId alone must preserve the entitlement hold')
assert.deepEqual({
  claims: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, entitlementStateWithImportedChildClaim, 'misclassified child markers still cannot create cash-right events')
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=?, exchangeReturnId=? WHERE id=?')
  .run(sale.id, exchange.returnId, child.id)

const blocked = /برگشت فرزند|تخصیص منشأ|تعویض/iu
const mutationEffectsBefore = {
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock),
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  corrections: seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n,
  correctionEffects: seed.one('SELECT COUNT(*) n FROM "ReturnCorrectionEffect"').n,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}
const beforeUpdate = seed.one('SELECT total, voidedAt FROM "SaleReturn" WHERE id=?', returnIds[0])
await assert.rejects(() => salesService.returnUpdate({
  id: returnIds[0], lines: [{ saleItemId: Number(childItem.id), qty: 1 }],
  userId, overrideReason: 'guard regression test'
}), blocked, 'child lineage must be rejected before the edit password gate')
assert.deepEqual(seed.one('SELECT total, voidedAt FROM "SaleReturn" WHERE id=?', returnIds[0]), beforeUpdate)

const beforeDelete = seed.one('SELECT voidedAt, voidReason FROM "SaleReturn" WHERE id=?', returnIds[1])
await assert.rejects(() => salesService.returnDelete({
  id: returnIds[1], userId, reason: 'guard regression test'
}), blocked, 'child lineage must be rejected before the void password gate')
assert.deepEqual(seed.one('SELECT voidedAt, voidReason FROM "SaleReturn" WHERE id=?', returnIds[1]), beforeDelete)

const correctionCountBefore = seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n
await assert.rejects(() => salesService.returnReconcileVoid({
  id: returnIds[2], userId, reason: 'guard regression test',
  cashRecovered: 0, cardRecovered: 0, creditOutcome: 'NONE'
}), blocked, 'child lineage must be rejected before the reconciliation password gate')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n, correctionCountBefore)
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', returnIds[2]).voidedAt, null)

// Simulate lineage markers appearing after the preflight read but before the
// mutation transaction. The in-transaction guard must re-read and reject too.
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=NULL WHERE id=?').run(child.id)
const originalPreverify = periodLockService.preverify
periodLockService.preverify = async (...args) => {
  const result = await originalPreverify.apply(periodLockService, args)
  sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=?, exchangeReturnId=? WHERE id=?')
    .run(sale.id, exchange.returnId, child.id)
  return result
}
try {
  await assert.rejects(() => salesService.returnUpdate({
    id: returnIds[0], lines: [{ saleItemId: Number(childItem.id), qty: 1 }],
    userId, panelPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'lineage changed before transaction'
  }), blocked, 'the transaction must reject lineage added after preflight')
} finally {
  periodLockService.preverify = originalPreverify
  sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=NULL WHERE id=?').run(child.id)
}
assert.deepEqual({
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock),
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  corrections: seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n,
  correctionEffects: seed.one('SELECT COUNT(*) n FROM "ReturnCorrectionEffect"').n,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}, mutationEffectsBefore, 'the in-transaction lineage recheck is side-effect-free')

const rejectAfterShiftMarkerRace = async (action, label) => {
  sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=NULL WHERE id=?').run(child.id)
  const originalShiftForNow = shiftService.shiftForNow
  shiftService.shiftForNow = async (...args) => {
    const shift = await originalShiftForNow.apply(shiftService, args)
    sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=?, exchangeReturnId=? WHERE id=?')
      .run(sale.id, exchange.returnId, child.id)
    return shift
  }
  try {
    await assert.rejects(action, blocked, label)
  } finally {
    shiftService.shiftForNow = originalShiftForNow
    sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=NULL WHERE id=?').run(child.id)
  }
}
await rejectAfterShiftMarkerRace(() => salesService.returnDelete({
  id: returnIds[1], userId, reason: 'lineage changed before delete transaction',
  panelPassword: DEFAULT_MANAGER_PASSWORD
}), 'returnDelete must recheck lineage inside its transaction')
await rejectAfterShiftMarkerRace(() => salesService.returnReconcileVoid({
  id: returnIds[2], userId, reason: 'lineage changed before reconciliation transaction',
  panelPassword: DEFAULT_MANAGER_PASSWORD, cashRecovered: 0, cardRecovered: 0, creditOutcome: 'NONE'
}), 'returnReconcileVoid must recheck lineage inside its transaction')
sql.prepare('UPDATE "SaleInvoice" SET orderType=? WHERE id=?').run('EXCHANGE', child.id)

assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=? AND voidedAt IS NULL', child.id).n, 8,
  'three correction fixtures, two bank fixtures, and three legacy transfer-route fixtures remain active')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation" WHERE childInvoiceId=? AND eventKind=?',
  child.id, 'ALLOCATION').n, 3)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ExchangeFundingReturnLineAllocation" WHERE childInvoiceId=? AND eventKind=?',
  child.id, 'REVERSAL').n, 0,
  'blocked correction paths did not write the missing reversal rows')
assert.deepEqual({
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock),
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  corrections: seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n,
  correctionEffects: seed.one('SELECT COUNT(*) n FROM "ReturnCorrectionEffect"').n,
  audits: seed.one('SELECT COUNT(*) n FROM "AuditLog"').n
}, mutationEffectsBefore, 'all child-return correction attempts leave stock, cash, credit, ledger, and audit effects untouched')
console.log('✓ exchange-child return correction paths fail closed for update, void, and reconciliation')
