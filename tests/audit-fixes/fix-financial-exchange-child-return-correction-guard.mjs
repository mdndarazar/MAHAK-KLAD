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
const { periodLockService } = await import('../../src/main/services/PeriodLockService.ts')
const { shiftService } = await import('../../src/main/services/ShiftService.ts')
const { recordExchangeFundingReturnLineAllocation } = await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { openCardTransferEntitlement } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { planCreditReturn } = await import('../../src/main/services/CreditReturnService.ts')
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
}, entitlementStateBeforeDirectOpen, 'misclassified child markers still cannot create cash-right events')
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

assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=? AND voidedAt IS NULL', child.id).n, 3)
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
