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
const { financialInspectorService } = await import('../../src/main/services/financialInspectorService.ts')
const { bridgeDiagnosticsService } = await import('../../src/main/services/bridgeDiagnosticsService.ts')
const { reportLimitsService } = await import('../../src/main/services/reportLimits.ts')
const { salesLedger } = await import('../../src/main/services/SalesLedger.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { resolveAccountingReadScope, buildStatements } = await import('../../src/main/services/accountingReport.ts')
const { debtAdjustmentsByInvoice } = await import('../../src/main/services/invoiceDebt.ts')
const { calculateReturnTotals } = await import('@shared/accounting')
const { returnedTotalOf } = await import('../../src/main/services/reportShape.ts')
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
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('@shared/receipt')
const { PANEL_KEYS } = await import('@shared/panels')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
seed.setting(SETTING_KEYS.panelLocks, {
  [PANEL_KEYS.salesReports]: false,
  [PANEL_KEYS.bridgeDiagnostics]: false
})
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
const exchangeReturnItem = seed.one('SELECT saleItemId, qty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id LIMIT 1',
  exchange.returnId)
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', exchange.returnId)
await assert.rejects(() => salesService.returnUpdate({
  id: exchange.returnId,
  lines: [{ saleItemId: Number(exchangeReturnItem.saleItemId), qty: Number(exchangeReturnItem.qty) }],
  userId, shiftId, panelPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'exchange kind corruption regression'
}), /تعویض|exchange/iu,
'a corrupted RETURN kind cannot make an exchange return editable while exchangeInvoiceId remains linked')
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('EXCHANGE', exchange.returnId)
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
const ordinaryReplayReturnId = seed.insert('SaleReturn', {
  invoiceId: sale.id, isFull: false, total: 100, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0
})
const ordinaryReplayClaimId = seed.insert('ReturnEntitlement', {
  returnId: ordinaryReplayReturnId, invoiceId: sale.id, requestId: 939393,
  cashRight: 100, cashReserved: 0, cashPaid: 0, cashConverted: 100,
  giftOpportunity: 0, debtReduced: 0, state: 'OPEN', version: 1
})
const ambiguousReplayCodeId = seed.insert('StoreCredit', {
  code: 'AMBIGUOUS-DELIVERY-ORIGIN', amount: 100, usedAmount: 0, usedCount: 0,
  status: 'ACTIVE', expiresAt: null
})
const ambiguousWitnessRef = 'same delivered legacy code witness'
seed.insert('CreditDelivery', {
  creditId: ambiguousReplayCodeId, sourceKind: 'CASH_RIGHT_CONVERSION', status: 'DELIVERED', version: 1,
  deliveredAt: now, deliveredByUserId: userId, witnessKind: 'CUSTOMER_HANDOFF', witnessRef: ambiguousWitnessRef
})
seed.insert('ReturnEntitlementEvent', {
  entitlementId: ordinaryReplayClaimId, eventKey: 'ordinary-first-ambiguous-delivered-origin',
  kind: 'CASH_RIGHT_CONVERTED', amount: 100, creditId: ambiguousReplayCodeId
})
seed.insert('ReturnEntitlementEvent', {
  entitlementId: legacyChildClaimId, eventKey: 'child-second-ambiguous-delivered-origin',
  kind: 'CASH_RIGHT_CONVERTED', amount: 100, creditId: ambiguousReplayCodeId
})
await assert.rejects(() => confirmCreditDelivery({
  creditId: ambiguousReplayCodeId, witnessKind: 'CUSTOMER_HANDOFF', witnessRef: ambiguousWitnessRef,
  managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId
}), /ابهام|چند|فرزند تعویض|lineage|تخصیص منشأ/iu,
'a delivered code with conflicting ordinary and exchange-child origins must not choose one origin by findFirst')
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
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=NULL WHERE id=?').run(child.id)
await assert.rejects(() => openCardTransferEntitlement(db, {
  returnId: legacyChildReturnWithoutClaim, invoiceId: child.id, requestId: 987654325, amount: 1
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'clearing both child markers and corrupting orderType must not erase the parent return inverse-link evidence')
const markerlessParentSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: replacementVariant, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 1000, destination: 'CASH' }]
})
const markerlessChildSale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: replacementVariant, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: [{ methodId: cashMethodId, amount: 1000, destination: 'CASH' }]
})
seed.insert('SaleReturn', {
  invoiceId: markerlessParentSale.id, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'EXCHANGE', exchangeInvoiceId: markerlessChildSale.id, userId, shiftId,
  refundMethod: 'NONE', refundAmount: 0
})
const markerlessChildItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', markerlessChildSale.id).id)
const markerlessReturnEffectsBefore = {
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', markerlessChildSale.id).n,
  cash: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n
}
await assert.rejects(() => salesService.createReturn({
  invoiceId: markerlessChildSale.id, full: false,
  lines: [{ saleItemId: markerlessChildItemId, qty: 1 }],
  refundMethod: 'CASH', refundAmount: 1000, userId, shiftId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'a return on a markerless but parent-linked child invoice must remain fail-closed')
await assert.rejects(() => planCreditReturn(db, {
  invoiceId: markerlessChildSale.id, grandTotal: 1000, paidTotal: 1000, returnedValue: 1000,
  debtBefore: remainingOf({ grandTotal: 1000, received: 1000 }), activeReturns: []
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'direct credit-return planning must recognize inverse exchange lineage without child markers')
await assert.rejects(() => applyCreditReturn(db, {
  invoiceId: markerlessChildSale.id, returnId: legacyChildReturnWithoutClaim, full: false,
  plan: { credit: 0, cash: 0, fundedReturning: 0, shares: [] }
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'direct credit-return application must independently block inverse-linked exchange children')
assert.deepEqual({
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', markerlessChildSale.id).n,
  cash: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n
}, markerlessReturnEffectsBefore, 'markerless child return rejection creates no return, cash refund, or credit')
await assert.rejects(() => salesService.update({
  id: markerlessChildSale.id, userId, shiftId, keepPayments: true,
  lines: [{ variantId: replacementVariant, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }]
}), /سند تعویض|فرزند تعویض|lineage/iu,
'a markerless but parent-linked child invoice cannot be edited as an ordinary sale')
const markerlessNestedExchangeEffectsBefore = {
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn"').n,
  invoices: seed.one('SELECT COUNT(*) n FROM "SaleInvoice"').n,
  cash: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n,
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock)
}
await assert.rejects(() => salesService.createExchange({
  invoiceId: markerlessChildSale.id,
  lines: [{ saleItemId: markerlessChildItemId, qty: 1 }],
  replacements: [{ variantId: replacementVariant, qty: 1 }],
  refundMode: 'STORE_CREDIT', userId, shiftId
}), /فرزند تعویض|lineage|EXCHANGE_CREDIT/iu,
'a markerless exchange child cannot become the parent of another exchange before chained lineage is supported')
assert.deepEqual({
  returns: seed.one('SELECT COUNT(*) n FROM "SaleReturn"').n,
  invoices: seed.one('SELECT COUNT(*) n FROM "SaleInvoice"').n,
  cash: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  credits: seed.one('SELECT COUNT(*) n FROM "StoreCredit"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n,
  stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock)
}, markerlessNestedExchangeEffectsBefore,
'blocked nested exchange creates no return, invoice, payment, credit, funding event, or stock movement')
const markerlessParentReturnId = Number(seed.one(
  'SELECT id FROM "SaleReturn" WHERE invoiceId=? AND kind=? ORDER BY id DESC LIMIT 1',
  markerlessParentSale.id, 'EXCHANGE'
).id)
sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=NULL WHERE id=?').run(markerlessParentReturnId)
const originalUpdatePeriodPreverify = periodLockService.preverify
periodLockService.preverify = async (...args) => {
  const result = await originalUpdatePeriodPreverify.apply(periodLockService, args)
  sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=? WHERE id=?')
    .run(markerlessChildSale.id, markerlessParentReturnId)
  return result
}
try {
  await assert.rejects(() => salesService.update({
    id: markerlessChildSale.id, userId, shiftId, keepPayments: true,
    lines: [{ variantId: replacementVariant, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }]
  }), /سند تعویض|فرزند تعویض|lineage/iu,
  'the sale-edit transaction rechecks inverse exchange lineage added after preflight')
} finally {
  periodLockService.preverify = originalUpdatePeriodPreverify
  sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=? WHERE id=?')
    .run(markerlessChildSale.id, markerlessParentReturnId)
}
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', markerlessParentReturnId)
await assert.rejects(() => planCreditReturn(db, {
  invoiceId: markerlessChildSale.id, grandTotal: 1000, paidTotal: 1000, returnedValue: 1000,
  debtBefore: remainingOf({ grandTotal: 1000, received: 1000 }), activeReturns: []
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'inverse exchangeInvoiceId evidence remains binding even if the linked parent return kind is corrupted')
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('EXCHANGE', markerlessParentReturnId)
const markerlessGoodsReturnId = seed.insert('SaleReturn', {
  invoiceId: markerlessChildSale.id, isFull: false, total: 1000, returnedAt: now,
  returnedAtJalali: toJalaliDate(now), returnedAtTime: now.toTimeString().slice(0, 8),
  kind: 'RETURN', userId, shiftId, refundMethod: 'NONE', refundAmount: 0,
  goodsReceiptRequired: true, restockPending: true
})
const markerlessGoodsItemId = seed.insert('SaleReturnItem', {
  returnId: markerlessGoodsReturnId, saleItemId: markerlessChildItemId,
  variantId: replacementVariant, qty: 1, unitPrice: 1000, lineTotal: 1000, restockedQty: 0
})
const markerlessGoodsStockBefore = Number(seed.one(
  'SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant
).stock)
await assert.rejects(() => returnGoodsService.receive({
  returnId: markerlessGoodsReturnId, returnItemId: markerlessGoodsItemId, qty: 1,
  eventKey: 'markerless-child-intake-001', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'Observed item', physicalConfirmed: true, actorUserId: userId
}), /فرزند تعویض|lineage|تخصیص منشأ/iu,
'physical receipt must reject a markerless child before stock can be restored')
assert.equal(Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', replacementVariant).stock),
  markerlessGoodsStockBefore, 'markerless physical intake rejection leaves stock unchanged')
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnGoodsReceipt" WHERE returnId=?', markerlessGoodsReturnId).n, 0,
  'markerless physical intake rejection writes no witness receipt')
const markerlessChildGoodsView = await returnGoodsService.items(markerlessGoodsReturnId)
assert.equal(markerlessChildGoodsView.unsupportedLineage, true,
  'the physical intake reader must detect the parent exchange link if child markers are missing')
assert.deepEqual(markerlessChildGoodsView.items, [],
  'markerless child lineage must not expose quantities for physical intake')
assert.deepEqual({
  claims: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement"').n,
  events: seed.one('SELECT COUNT(*) n FROM "ReturnEntitlementEvent"').n
}, entitlementStateWithImportedChildClaim, 'misclassified child markers still cannot create cash-right events')
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=?, exchangeReturnId=? WHERE id=?')
  .run(sale.id, exchange.returnId, child.id)

// These legacy return records still have a parent SaleReturn.exchangeInvoiceId
// link, but all child-side markers (including orderType) are intentionally lost.
sql.prepare('UPDATE "SaleInvoice" SET sourceInvoiceId=NULL, exchangeReturnId=NULL, orderType=? WHERE id=?')
  .run('INTERNAL', child.id)
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

const makeExactExchange = async (label, replacementPrice = 1000, refundMode = 'STORE_CREDIT') => {
  const sourceVariantId = variant(`${label} source`)
  const replacementVariantId = variant(`${label} replacement`)
  sql.prepare('UPDATE "ProductVariant" SET salePrice=? WHERE id=?').run(replacementPrice, replacementVariantId)
  const invoice = await salesService.create({
    userId, shiftId,
    lines: [{ variantId: sourceVariantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
    payments: [{ methodId: cashMethodId, amount: 1000, destination: 'CASH' }]
  })
  const sourceLine = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', invoice.id)
  const result = await salesService.createExchange({
    invoiceId: invoice.id,
    lines: [{ saleItemId: Number(sourceLine.id), qty: 1 }],
    replacements: [{ variantId: replacementVariantId, qty: 1 }],
    refundMode, userId, shiftId, managerPassword: DEFAULT_MANAGER_PASSWORD
  })
  return {
    returnId: result.returnId, invoiceId: invoice.id, childInvoiceId: result.exchangeInvoiceId,
    sourceVariantId, replacementVariantId
  }
}

const reconcileKindProbe = await makeExactExchange('reconcile kind probe')
const reconcileEffectsBefore = {
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', reconcileKindProbe.sourceVariantId).stock),
  replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', reconcileKindProbe.replacementVariantId).stock),
  corrections: seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', reconcileKindProbe.returnId)
await assert.rejects(() => salesService.returnReconcileVoid({
  id: reconcileKindProbe.returnId, userId, reason: 'exchange kind corruption regression',
  cashRecovered: 0, cardRecovered: 0, cashPaidOut: 0, cardPaidOut: 0, creditOutcome: 'NONE',
  panelPassword: DEFAULT_MANAGER_PASSWORD
}), /تعویض|exchange|پیوند/iu,
'returnReconcileVoid must fail closed when exchangeInvoiceId contradicts the ordinary RETURN kind')
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', reconcileKindProbe.returnId).voidedAt, null)
assert.equal(seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', reconcileKindProbe.childInvoiceId).voidedAt, null)
assert.deepEqual({
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', reconcileKindProbe.sourceVariantId).stock),
  replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', reconcileKindProbe.replacementVariantId).stock),
  corrections: seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n,
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}, reconcileEffectsBefore, 'a kind/link mismatch cannot create reconciliation, inventory, cash, or ledger effects')

const deleteKindProbe = await makeExactExchange('delete kind probe')
const deleteEffectsBefore = {
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', deleteKindProbe.sourceVariantId).stock),
  replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', deleteKindProbe.replacementVariantId).stock),
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', deleteKindProbe.returnId)
const corruptKindExchangeVoid = await salesService.returnDelete({
  id: deleteKindProbe.returnId, userId, shiftId,
  reason: 'exchange kind corruption regression', panelPassword: DEFAULT_MANAGER_PASSWORD
})
assert.equal(corruptKindExchangeVoid.exchangeVoided, true,
  'a valid reciprocal exchange link must route a corrupted kind through the full exchange void')
assert.ok(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', deleteKindProbe.returnId).voidedAt)
assert.ok(seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', deleteKindProbe.childInvoiceId).voidedAt)
assert.deepEqual({
  sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', deleteKindProbe.sourceVariantId).stock),
  replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', deleteKindProbe.replacementVariantId).stock),
  cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
  fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n
}, {
  sourceStock: deleteEffectsBefore.sourceStock,
  replacementStock: deleteEffectsBefore.replacementStock + 1,
  cashMovements: deleteEffectsBefore.cashMovements,
  fundingEvents: deleteEffectsBefore.fundingEvents + 2
}, 'kind corruption is corrected only by atomically voiding return, child, stock and paired funding effects')

const injectExchangeLinkAfterPreflight = async (probe, operation, label) => {
  sql.prepare('UPDATE "SaleReturn" SET kind=?, exchangeInvoiceId=NULL WHERE id=?')
    .run('RETURN', probe.returnId)
  const effects = () => ({
    sourceStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', probe.sourceVariantId).stock),
    replacementStock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', probe.replacementVariantId).stock),
    cashMovements: seed.one('SELECT COUNT(*) n FROM "CashMovement"').n,
    fundingEvents: seed.one('SELECT COUNT(*) n FROM "ExchangeFundingEvent"').n,
    corrections: seed.one('SELECT COUNT(*) n FROM "ReturnCorrection"').n,
    returnItems: seed.one('SELECT COUNT(*) n FROM "SaleReturnItem" WHERE returnId=?', probe.returnId).n
  })
  const effectsBefore = effects()
  const originalPreverify = periodLockService.preverify
  periodLockService.preverify = async (...args) => {
    const result = await originalPreverify.apply(periodLockService, args)
    sql.prepare('UPDATE "SaleReturn" SET exchangeInvoiceId=? WHERE id=?')
      .run(probe.childInvoiceId, probe.returnId)
    return result
  }
  try {
    await assert.rejects(operation, /تعویض|exchange|پیوند|منشأ مالی/iu, label)
  } finally {
    periodLockService.preverify = originalPreverify
    sql.prepare('UPDATE "SaleReturn" SET kind=?, exchangeInvoiceId=? WHERE id=?')
      .run('EXCHANGE', probe.childInvoiceId, probe.returnId)
  }
  assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', probe.returnId).voidedAt, null)
  assert.equal(seed.one('SELECT voidedAt FROM "SaleInvoice" WHERE id=?', probe.childInvoiceId).voidedAt, null)
  assert.deepEqual(effects(), effectsBefore, `${label}: rejection leaves stock, cash, funding, correction, and item state unchanged`)
}

const updateLinkRace = await makeExactExchange('update inverse-link race')
const updateLinkRaceItem = seed.one(
  'SELECT saleItemId, qty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id LIMIT 1', updateLinkRace.returnId
)
await injectExchangeLinkAfterPreflight(updateLinkRace, () => salesService.returnUpdate({
  id: updateLinkRace.returnId,
  lines: [{ saleItemId: Number(updateLinkRaceItem.saleItemId), qty: Number(updateLinkRaceItem.qty) }],
  userId, shiftId, panelPassword: DEFAULT_MANAGER_PASSWORD, overrideReason: 'inverse exchange link race'
}), 'returnUpdate rechecks the inverse exchange link inside its transaction')

const deleteLinkRace = await makeExactExchange('delete inverse-link race')
await injectExchangeLinkAfterPreflight(deleteLinkRace, () => salesService.returnDelete({
  id: deleteLinkRace.returnId, userId, shiftId,
  reason: 'inverse exchange link race', panelPassword: DEFAULT_MANAGER_PASSWORD
}), 'returnDelete routes a link added after preflight through fail-closed exchange validation')

const reconcileLinkRace = await makeExactExchange('reconcile inverse-link race')
await injectExchangeLinkAfterPreflight(reconcileLinkRace, () => salesService.returnReconcileVoid({
  id: reconcileLinkRace.returnId, userId, reason: 'inverse exchange link race',
  cashRecovered: 0, cardRecovered: 0, cashPaidOut: 0, cardPaidOut: 0,
  creditOutcome: 'NONE', panelPassword: DEFAULT_MANAGER_PASSWORD
}), 'returnReconcileVoid rechecks kind/link consistency inside its transaction')

const reportKindProbe = await makeExactExchange('report kind probe', 800, 'CASH')
const reportC2CProbe = await makeExactExchange('report C2C kind probe', 800, 'CARD_TO_CARD')
const reportDate = toJalaliDate(now)
const staffPerformanceBefore = (await staffReportService.performance({
  fromJalali: reportDate, toJalali: reportDate, userId
})).rows.find((row) => row.userId === userId)
const accountingScope = await resolveAccountingReadScope({ fromJalali: reportDate, toJalali: reportDate })
const accountingBefore = (await buildStatements(accountingScope)).statements
const reportLimitsBefore = await reportLimitsService.limits({ fromJalali: reportDate, toJalali: reportDate })
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id IN (?, ?)')
  .run('RETURN', reportKindProbe.returnId, reportC2CProbe.returnId)
const returnEventTotals = calculateReturnTotals([{
  kind: 'RETURN', exchangeInvoiceId: reportKindProbe.childInvoiceId,
  total: 1000, exchangeTotal: 800, exchangeDiff: -200,
  exchangeSettlement: 'CASH_REFUND', refundMethod: 'CASH', refundAmount: 200
}])
assert.equal(returnEventTotals.exchangeReturned, 1000,
  'shared return totals must classify a persisted exchangeInvoiceId as exchange')
assert.equal(returnEventTotals.simpleReturns, 0,
  'shared return totals must not count an inverse-linked exchange as a simple return')
assert.equal(returnEventTotals.exchangeCashRefunds, 200,
  'shared return totals must preserve cash-refund semantics for an inverse-linked exchange')
assert.equal(returnedTotalOf({ returns: [{
  kind: 'RETURN', exchangeInvoiceId: reportKindProbe.childInvoiceId, total: 1000, returnedAt: now
}] }), 0,
'a linked exchange must stay out of the simple-return total even when a legacy caller uses the report-shape fallback')
const debtTotalsForCorruptExchange = await debtAdjustmentsByInvoice(db, [reportKindProbe.invoiceId])
assert.deepEqual(debtTotalsForCorruptExchange.get(reportKindProbe.invoiceId) ?? {
  returnedValue: 0, refundFromReceived: 0
}, { returnedValue: 0, refundFromReceived: 0 },
'a misclassified exchange refund must not create a simple-return debt reduction or OVERPAY source')
const detailedSalesReport = await salesService.reportRows({
  fromJalali: reportDate, toJalali: reportDate, take: 500
})
const reportSourceInvoice = detailedSalesReport.rows.find((row) => row.id === reportKindProbe.invoiceId)
assert.equal(reportSourceInvoice?.returnedTotal, 0,
  'sales report rows must not subtract a linked exchange as a simple return')
assert.equal(reportSourceInvoice?.exchangeReturnedTotal, 1000,
  'sales report rows must retain returned exchange value after kind corruption')
const staffPerformanceAfter = (await staffReportService.performance({
  fromJalali: reportDate, toJalali: reportDate, userId
})).rows.find((row) => row.userId === userId)
assert.equal(staffPerformanceAfter.exchangeCount, staffPerformanceBefore.exchangeCount,
  'staff performance must classify a linked exchange from its durable inverse link')
assert.equal(staffPerformanceAfter.returnCount, staffPerformanceBefore.returnCount,
  'a corrupted exchange kind must not inflate staff simple-return counts')
assert.equal(staffPerformanceAfter.exchangeTotal, staffPerformanceBefore.exchangeTotal,
  'a corrupted exchange kind must not remove replacement value from staff results')
const staffTransactionRows = await staffReportService.transactions({
  fromJalali: reportDate, toJalali: reportDate, userId, take: 500
})
assert.equal(staffTransactionRows.returns.find((row) => row.id === reportKindProbe.returnId)?.kind, 'EXCHANGE',
  'staff transaction details must label an inverse-linked return as an exchange')
const accountingAfter = (await buildStatements(accountingScope)).statements
const reportLimitsAfter = await reportLimitsService.limits({ fromJalali: reportDate, toJalali: reportDate })
assert.equal(accountingAfter.returns.returnCount, accountingBefore.returns.returnCount,
  'accounting statements must not reclassify a linked exchange as a simple return')
assert.equal(accountingAfter.returns.exchangeCount, accountingBefore.returns.exchangeCount,
  'accounting statements must preserve exchange count from the persisted inverse link')
assert.equal(accountingAfter.returns.simpleReturns, accountingBefore.returns.simpleReturns,
  'corrupt kind must not move exchange value into simple-return totals')
assert.equal(accountingAfter.returns.exchangeReturned, accountingBefore.returns.exchangeReturned,
  'corrupt kind must not remove exchange return value from accounting totals')
assert.deepEqual(accountingAfter.bridge, accountingBefore.bridge,
  'the reconciliation bridge must classify a linked exchange identically despite a corrupted kind')
const limitTotal = (result, key) => result.rows.find((row) => row.key === key).total
assert.equal(limitTotal(reportLimitsAfter, 'returns'), limitTotal(reportLimitsBefore, 'returns'),
  'return pagination limits must not count a linked exchange as a simple return')
assert.equal(limitTotal(reportLimitsAfter, 'exchanges'), limitTotal(reportLimitsBefore, 'exchanges'),
  'exchange pagination limits must retain linked exchanges if kind is corrupted')
const ordinaryReport = await salesService.returnList({
  fromJalali: reportDate, toJalali: reportDate, take: 500
})
assert.equal(ordinaryReport.some((row) => row.id === reportKindProbe.returnId), false,
  'the default ordinary-return report must not misclassify a persisted exchangeInvoiceId as a simple return')
const allReturnRows = await salesService.returnList({
  fromJalali: reportDate, toJalali: reportDate, take: 500, includeExchanges: true
})
assert.equal(allReturnRows.find((row) => row.id === reportKindProbe.returnId)?.isExchange, true,
  'the mixed return report must classify exchange rows from the persisted inverse link')
const exchangeRows = await salesService.exchangeList({
  fromJalali: reportDate, toJalali: reportDate, take: 500
})
assert.equal(exchangeRows.rows.some((row) => row.returnId === reportKindProbe.returnId), true,
  'the exchange report must retain linked exchanges even when the kind discriminator is corrupted')
const exchangeDetails = await salesService.exchangeGet({ id: reportKindProbe.returnId })
assert.equal(exchangeDetails.returnId, reportKindProbe.returnId,
  'exchange detail must use the persisted inverse link as a durable exchange marker')
const reportScope = { fromJalali: reportDate, toJalali: reportDate }
const inspectorSources = await financialInspectorService.sources({
  scope: reportScope, key: 'exchangeCashRefunds'
})
const inspectorSource = inspectorSources.result.sources.find((source) => source.ref.id === reportKindProbe.returnId)
assert.ok(inspectorSource, 'financial inspector keeps the exchange refund source after kind corruption')
const inspectorDocument = await financialInspectorService.document({
  scope: reportScope, key: 'exchangeCashRefunds', ref: inspectorSource.ref
})
assert.match(inspectorDocument.detail.title, /تعویض/,
  'financial inspector document must use the exchange invoice link, not corrupted kind')
const openedBridgeDiagnostics = await bridgeDiagnosticsService.open(reportScope, DEFAULT_MANAGER_PASSWORD)
assert.equal(openedBridgeDiagnostics?.ok, true)
const bridgeDocument = await bridgeDiagnosticsService.documentDetail(
  reportScope, { kind: 'RETURN', id: reportKindProbe.returnId }, 'exchangeCashRefunds'
)
assert.equal(bridgeDocument.detail.docType, 'EXCHANGE',
  'bridge diagnosis must identify the linked exchange rather than a simple return')
assert.equal(bridgeDocument.detail.ref.kind, 'EXCHANGE')
const printKindProbe = await makeExactExchange('print kind probe', 800, 'STORE_CREDIT')
const printCredit = seed.one('SELECT id FROM "StoreCredit" WHERE returnId=?', printKindProbe.returnId)
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', printKindProbe.returnId)
const printedCredit = await printService.creditDocDataFor(
  Number(printCredit.id), await settingsService.receiptTemplate()
)
assert.ok(printedCredit.issueLines.some((line) => /بابت تعویض کالای/.test(line)),
  'customer-facing credit print must keep exchange provenance when kind is corrupted')
const eventLedger = await salesLedger.ledger({ fromJalali: reportDate, toJalali: reportDate })
assert.deepEqual(eventLedger.rows.filter((row) => row.sourceId === reportKindProbe.returnId)
  .map((row) => row.eventType).sort(), ['EXCHANGE_REPLACEMENT', 'EXCHANGE_RETURNED'],
'cash ledger must retain both exchange event types when the kind field is corrupted')
const goodsNoteProbe = await makeExactExchange('goods note kind probe', 800, 'CARD_TO_CARD')
const goodsNoteRequest = seed.one('SELECT id FROM "CardTransferRequest" WHERE returnId=? AND kind=?',
  goodsNoteProbe.returnId, 'REQUEST')
assert.ok(goodsNoteRequest, 'the exchange fixture must have a pending manager transfer request')
const goodsNoteItemId = Number(seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=?',
  goodsNoteProbe.returnId).id)
sql.prepare('UPDATE "SaleReturn" SET kind=? WHERE id=?').run('RETURN', goodsNoteProbe.returnId)
await returnGoodsService.receive({
  returnId: goodsNoteProbe.returnId, returnItemId: goodsNoteItemId, qty: 1,
  eventKey: 'exchange-goods-note-kind-corrupt-001', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'customer item physically received', physicalConfirmed: true, actorUserId: userId
})
const exchangeGoodsStockNote = seed.one('SELECT stockNote FROM "CardTransferRequest" WHERE id=?',
  goodsNoteRequest.id).stockNote
assert.match(exchangeGoodsStockNote, /کالای جایگزین طبق سند تعویض از موجودی کسر شد/,
  'physical receipt note must retain exchange context via exchangeInvoiceId when return kind is corrupt')
console.log('✓ exchange-child return correction paths fail closed for update, void, and reconciliation')
