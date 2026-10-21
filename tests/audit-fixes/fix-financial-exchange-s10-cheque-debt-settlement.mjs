/** S10 production-service integration: versioned two-manager policy gates,
 * same-share cheque debt settlement, and independently reconciled late-cheque
 * suspense with exact apply/refund amounts, cash movement and retry guarantees.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-exchange-s10-cheque-debt-settlement.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-s10-cheque-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashMovementTotals } = await import('../../src/main/services/accountingReport.ts')
const { cashMovementService } = await import('../../src/main/services/CashMovementService.ts')
const { exchangeChequePolicyService } = await import('../../src/main/services/ExchangeChequePolicyService.ts')
const { createManagerCorrectionApprovalSecret } = await import('../../src/main/services/AuthService.ts')
const { getCurrentExchangeFundingSources, exchangeFundingBalance } =
  await import('../../src/main/services/ExchangeFundingLedgerService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('S10 manager one')
const managerTwoId = seed.user('S10 manager two')
sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret('S10-PIN-ONE'), userId)
sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret('S10-PIN-TWO'), managerTwoId)
const customerId = seed.customer('S10 named customer', '09120000110')
const categoryId = seed.category('S10 category')
const productId = seed.product('S10 item', categoryId)
const cashMethodId = seed.insert('PaymentMethod', {
  key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1, sortOrder: 1
})
const cardMethodId = seed.insert('PaymentMethod', {
  key: 'CARD', label: 'Card', kind: 'CARD', isActive: 1, sortOrder: 2
})
const shiftId = seed.insert('Shift', {
  name: 'S10 shift', number: 1, userId,
  dayJalali: toJalaliDate(new Date()), openedAt: Date.now() - 10_000
})
let sku = 0
const variant = (label, price) => {
  const id = seed.variant(productId, `S10-${label}-${++sku}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, qty, unitPrice) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })
const exchange = (input) => salesService.createExchange(input, { goodsReceiptRequired: false })

async function makePolicyTestParent(label) {
  const parentVariant = variant(`${label}-parent`, 400_000)
  const childVariant = variant(`${label}-child`, 500_000)
  const parent = await salesService.create({
    customerId, userId, shiftId, lines: [line(parentVariant, 3, 400_000)],
    payments: [{ methodId: cashMethodId, amount: 1_200_000, destination: 'CASH' }]
  })
  const parentItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', parent.id)
  return { parent, parentItem, childVariant }
}

async function tryPolicyCheque(source, key) {
  return exchange({
    invoiceId: source.parent.id, lines: [{ saleItemId: source.parentItem.id, qty: 3 }],
    replacements: [line(source.childVariant, 3, 500_000)],
    chequeNo: `S10-${key}`, bankName: 'Test Bank', dueDateJalali: '1405/08/01',
    userId, shiftId, idempotencyKey: `s10-${key}-exchange-cheque-request-0001`
  })
}

async function approvePolicy({ enabled, minimumDelta, proposerId, proposerPin, approverId, approverPin, tag }) {
  const proposed = await exchangeChequePolicyService.propose({
    enabled, minimumDelta, reason: `سیاست S10 برای ${tag} تغییر می‌کند`,
    evidenceRef: `S10-${tag}-policy-evidence`, proposerUserId: proposerId, proposerPin
  })
  return { proposed, approved: await exchangeChequePolicyService.approve({
    proposalId: proposed.pending.id, approvingManagerUserId: approverId, approvingManagerPin: approverPin,
    approvalReason: `تأیید مستقل مدیر دوم برای ${tag}`, approvalEvidenceRef: `S10-${tag}-approval-evidence`
  }) }
}

async function exercisePolicyControls() {
  const source = await makePolicyTestParent('policy-controls')
  await assert.rejects(() => tryPolicyCheque(source, 'disabled-initial'), /خاموش/u,
    'a valid cheque request is rejected server-side while manager policy is disabled')
  assert.equal(seed.count('SaleInvoice', "orderType='EXCHANGE'"), 0,
    'disabled policy rejection rolls back the exchange invoice')

  const proposal = await exchangeChequePolicyService.propose({
    enabled: true, minimumDelta: 350_000, reason: 'آستانه اولیه برای آزمون S10',
    evidenceRef: 'S10-policy-first-proposal', proposerUserId: userId, proposerPin: 'S10-PIN-ONE'
  })
  assert.equal(proposal.active.version, 0, 'proposal alone does not change active policy')
  await assert.rejects(() => exchangeChequePolicyService.approve({
    proposalId: proposal.pending.id, approvingManagerUserId: userId, approvingManagerPin: 'S10-PIN-ONE',
    approvalReason: 'همان مدیر نمی‌تواند تأیید کند', approvalEvidenceRef: 'S10-same-manager-attempt'
  }), /دو مدیر/u, 'proposer cannot self-approve policy')
  const active1 = await exchangeChequePolicyService.approve({
    proposalId: proposal.pending.id, approvingManagerUserId: managerTwoId, approvingManagerPin: 'S10-PIN-TWO',
    approvalReason: 'مدیر دوم مستقل بررسی کرد', approvalEvidenceRef: 'S10-independent-policy-approval'
  })
  assert.deepEqual([active1.active.version, active1.active.enabled, active1.active.minimumDelta], [1, true, 350_000])
  await assert.rejects(() => tryPolicyCheque(source, 'below-threshold'), /حداقل سیاست چک/u,
    'the server rejects a cheque below the active minimum')
  assert.equal(seed.count('SaleInvoice', "orderType='EXCHANGE'"), 0,
    'below-threshold rejection also rolls back the exchange')

  const active2 = (await approvePolicy({
    enabled: true, minimumDelta: 300_000, proposerId: managerTwoId, proposerPin: 'S10-PIN-TWO',
    approverId: userId, approverPin: 'S10-PIN-ONE', tag: 'lower-threshold'
  })).approved
  assert.deepEqual([active2.active.version, active2.active.enabled, active2.active.minimumDelta], [2, true, 300_000])
  const accepted = await tryPolicyCheque(source, 'at-threshold')
  const snapshot = seed.one('SELECT evidenceRef FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    accepted.exchangeInvoiceId, 'DEBT_OPEN')
  assert.match(snapshot.evidenceRef, /chequePolicyVersion:2/u,
    'the exact approved version is captured in immutable cheque funding evidence')
  await salesService.addPayment({
    invoiceId: accepted.exchangeInvoiceId, amount: 300_000, methodId: cashMethodId,
    destination: 'CASH', reference: 'S10 policy fixture debt settlement', userId,
    idempotencyKey: 's10-policy-fixture-debt-settlement-0001'
  })

  return { source, accepted }
}

async function makeChequeExchange(label) {
  const parentVariant = variant(`${label}-parent`, 400_000)
  const childVariant = variant(`${label}-child`, 500_000)
  const parent = await salesService.create({
    customerId, userId, shiftId, lines: [line(parentVariant, 3, 400_000)],
    payments: [{ methodId: cashMethodId, amount: 1_200_000, destination: 'CASH' }]
  })
  const parentItem = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', parent.id)
  const cashMovementBefore = seed.count('CashMovement', '1=1')
  const result = await exchange({
    invoiceId: parent.id,
    lines: [{ saleItemId: parentItem.id, qty: 3 }],
    replacements: [line(childVariant, 3, 500_000)],
    chequeNo: `S10-${label}-300K`, bankName: 'Test Bank', dueDateJalali: '1405/08/01',
    userId, shiftId, idempotencyKey: `s10-${label}-exchange-cheque-request-0001`
  })
  assert.equal(result.diff, 300_000)
  assert.equal(result.settlement, 'CHEQUE_PENDING')
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementBefore,
    'creating a pending cheque is not a cash movement')
  const cheque = seed.one('SELECT id, kind, amount, chequeStatus, chequeNo FROM "Payment" WHERE invoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'CHEQUE')
  assert.ok(cheque)
  assert.equal(cheque.chequeStatus, 'PENDING')
  assert.equal(cheque.amount, 300_000)
  const debtOpen = seed.one('SELECT id, kind, amount, debtId, sourcePaymentId FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'DEBT_OPEN')
  assert.ok(debtOpen)
  assert.equal(debtOpen.amount, 300_000)
  assert.equal(debtOpen.debtId, result.exchangeInvoiceId)
  assert.equal(debtOpen.sourcePaymentId, cheque.id)
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 300_000,
    'pending cheque backs the same 300K debt share')
  const funding = await getCurrentExchangeFundingSources(db, result.exchangeInvoiceId)
  assert.deepEqual(funding.unresolved, [], 'pending cheque is represented by debt, not unknown/transferable money')
  assert.equal(funding.debt, 300_000)
  assert.equal(funding.sources.reduce((sum, source) => sum + source.available, 0), 1_200_000)
  return { result, cheque }
}

async function bounce(chequeId) {
  const changed = await salesService.setChequeStatus({
    id: chequeId, status: 'BOUNCED', managerPassword: DEFAULT_MANAGER_PASSWORD, userId
  })
  assert.equal(changed.cheque.chequeStatus, 'BOUNCED')
}

async function assertNewChequeBlocked() {
  const targetVariant = variant('blocked-new-cheque', 200_000)
  const invoice = await salesService.create({
    customerId, userId, shiftId, lines: [line(targetVariant, 1, 200_000)], payments: []
  })
  await assert.rejects(() => salesService.addPayment({
    invoiceId: invoice.id, kind: 'CHEQUE', amount: 100_000,
    chequeNo: 'S10-BLOCKED', bankName: 'Test Bank', dueDateJalali: '1405/08/01', userId
  }), /بدهی چک باز/u,
  'the same customer cannot receive another cheque while the exchange debt is open')
  assert.equal(seed.count('Payment', `invoiceId=${invoice.id}`), 0,
    'blocked cheque attempt creates no payment row')
  const authorized = await salesService.addPayment({
    invoiceId: invoice.id, kind: 'CHEQUE', amount: 100_000,
    chequeNo: 'S10-MANAGER-OVERRIDE', bankName: 'Test Bank', dueDateJalali: '1405/08/01',
    chequeDebtOverride: true, managerPassword: DEFAULT_MANAGER_PASSWORD,
    overrideReason: 'مدیر با رسید پیگیری بانکی این استثنا را تأیید کرد', userId
  })
  assert.equal(authorized.payment.chequeStatus, 'PENDING',
    'an authorized manager override is permitted and remains separately evidenced/pending')
  const overrideAudit = seed.rows(`SELECT action, after FROM "AuditLog" WHERE entity='Payment' AND entityId=? ORDER BY id DESC LIMIT 1`,
    authorized.payment.id)[0]
  assert.ok(overrideAudit)
  assert.match(overrideAudit.after, /مدیر با رسید پیگیری بانکی/u)
  return invoice
}

async function settleByCash() {
  const { result, cheque } = await makeChequeExchange('cash')
  await bounce(cheque.id)
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 300_000,
    'bounce changes the same cheque status and leaves the original debt open')
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_OPEN'`), 1,
    'bounce did not append a second DEBT_OPEN')
  assert.equal(seed.count('ExchangeResidualRightEvent', `relatedInvoiceId=${result.exchangeInvoiceId}`), 0,
    'bounce creates no new customer-money right')
  const postDebtChequeInvoice = await assertNewChequeBlocked()
  const paymentCountBeforeRejectedSettlements = seed.count('Payment', `invoiceId=${result.exchangeInvoiceId}`)
  await assert.rejects(() => salesService.addPayment({
    invoiceId: result.exchangeInvoiceId, amount: 300_001, methodId: cashMethodId,
    destination: 'CASH', reference: 'Over-limit witness', userId
  }), /بدهی باز/u, 'debt settlement cannot exceed its open balance even with ordinary overpay confirmation')
  await assert.rejects(() => salesService.addPayment({
    invoiceId: result.exchangeInvoiceId, amount: 300_000, methodId: cashMethodId,
    destination: 'CASH', userId
  }), /شاهد دریافت/u, 'settlement evidence is required')
  assert.equal(seed.count('Payment', `invoiceId=${result.exchangeInvoiceId}`), paymentCountBeforeRejectedSettlements,
    'rejected excess/evidence-free settlement creates no tender')

  const cashMovementsBefore = seed.count('CashMovement', '1=1')
  const drawerDepositsBefore = (await cashMovementTotals({ shiftId })).deposits
  const cashSettlementRequest = {
    invoiceId: result.exchangeInvoiceId, amount: 300_000, methodId: cashMethodId,
    destination: 'CASH', reference: 'Cash witness S10-001', userId,
    idempotencyKey: 's10-cash-debt-settlement-payment-0001'
  }
  const paid = await salesService.addPayment(cashSettlementRequest)
  const paidReplay = await salesService.addPayment(cashSettlementRequest)
  assert.equal(paidReplay.payment.id, paid.payment.id, 'same-key retry returns the one committed debt settlement')
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore + 1,
    'settlement retry does not create a second drawer movement')
  assert.equal((await cashMovementTotals({ shiftId })).deposits, drawerDepositsBefore,
    'the linked movement is not added twice to drawer deposits already counted from Payment')
  const movementReport = await cashMovementService.list({ shiftId })
  assert.ok(movementReport.rows.some((row) => row.refType === 'ExchangeDebtSettlement' && row.refId === paid.payment.id),
    'the physical movement remains visible/auditable in the detailed cash-movement list')
  assert.equal(movementReport.totals.deposits, drawerDepositsBefore,
    'cash-movement list totals do not double-count the linked payment mirror')
  assert.equal(paid.remaining, 0)
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 0)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore + 1,
    'cash settlement creates one real CashMovement')
  const settled = seed.one('SELECT kind, amount, debtId, sourcePaymentId, sourceMethodKind, sourceDestination, evidenceRef FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'DEBT_SETTLE')
  assert.deepEqual([settled.kind, settled.amount, settled.debtId, settled.sourceMethodKind, settled.sourceDestination],
    ['DEBT_SETTLE', -300_000, result.exchangeInvoiceId, 'CASH', 'CASH'])
  assert.equal(settled.sourcePaymentId, paid.payment.id)
  assert.equal(settled.evidenceRef, 'Cash witness S10-001')
  assert.equal(seed.count('CashMovement', `refType='ExchangeDebtSettlement' AND refId=${paid.payment.id} AND type='CASH_IN'`), 1)
  const releasedRestriction = await salesService.addPayment({
    invoiceId: postDebtChequeInvoice.id, kind: 'CHEQUE', amount: 100_000,
    chequeNo: 'S10-AFTER-SETTLEMENT', bankName: 'Test Bank', dueDateJalali: '1405/08/01', userId
  })
  assert.equal(releasedRestriction.payment.chequeStatus, 'PENDING',
    'full settlement releases the same customer from the new-cheque restriction')

  // Re-applying the bounce after settlement must not reopen the same debt.
  await bounce(cheque.id)
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 0)
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_OPEN'`), 1)
  const current = await getCurrentExchangeFundingSources(db, result.exchangeInvoiceId)
  assert.deepEqual(current.unresolved, [])
  assert.equal(current.debt, 0)
  assert.equal(current.sources.reduce((sum, source) => sum + source.available, 0), 1_500_000)
}

async function settleByCard() {
  const { result, cheque } = await makeChequeExchange('card')
  await bounce(cheque.id)
  const cashMovementsBefore = seed.count('CashMovement', '1=1')
  const paid = await salesService.addPayment({
    invoiceId: result.exchangeInvoiceId, amount: 300_000, methodId: cardMethodId,
    destination: 'CARD', reference: 'POS-BANK-TRACE-S10-002', userId,
    idempotencyKey: 's10-card-debt-settlement-payment-0001'
  })
  assert.equal(paid.remaining, 0)
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 0)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore,
    'card settlement is not a cash-drawer movement')
  const settled = seed.one('SELECT kind, amount, debtId, sourcePaymentId, sourceMethodKind, sourceDestination, evidenceRef FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'DEBT_SETTLE')
  assert.deepEqual([settled.kind, settled.amount, settled.debtId, settled.sourceMethodKind, settled.sourceDestination],
    ['DEBT_SETTLE', -300_000, result.exchangeInvoiceId, 'CARD', 'CARD'])
  assert.equal(settled.sourcePaymentId, paid.payment.id)
  assert.equal(settled.evidenceRef, 'POS-BANK-TRACE-S10-002')
  const current = await getCurrentExchangeFundingSources(db, result.exchangeInvoiceId)
  assert.deepEqual(current.unresolved, [])
  assert.equal(current.debt, 0)
}

async function bounceAfterOffsetDoesNotReopenDebt() {
  const { result, cheque } = await makeChequeExchange('bounce-after-offset')
  await salesService.addPayment({
    invoiceId: result.exchangeInvoiceId, amount: 300_000, methodId: cashMethodId,
    destination: 'CASH', reference: 'Cash paid before bounce', userId,
    idempotencyKey: 's10-offset-before-bounce-payment-0001'
  })
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 0)
  const debtSettleCount = seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_SETTLE'`)
  await bounce(cheque.id)
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 0,
    'bouncing the original pending cheque after cash offset does not reopen debt')
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_OPEN'`), 1)
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_SETTLE'`), debtSettleCount)
  assert.equal(seed.count('ExchangeResidualRightEvent', `relatedInvoiceId=${result.exchangeInvoiceId}`), 0)
}

async function lateChequeGoesToSuspenseAndPartiallyResolves() {
  const { result, cheque } = await makeChequeExchange('late-partial')
  const cashMovementsBefore = seed.count('CashMovement', '1=1')
  await salesService.addPayment({
    invoiceId: result.exchangeInvoiceId, amount: 200_000, methodId: cashMethodId,
    destination: 'CASH', reference: 'Cash partly settled before late cheque', userId,
    idempotencyKey: 's10-late-partial-cash-settlement-payment-0001'
  })
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 100_000)
  const cleared = await salesService.setChequeStatus({
    id: cheque.id, status: 'CLEARED', destination: 'MANAGER',
    managerPassword: DEFAULT_MANAGER_PASSWORD, userId
  })
  assert.equal(cleared.cheque.chequeStatus, 'SUSPENSE', 'late cheque is quarantined rather than counted twice')
  assert.equal(cleared.paidTotal, 1_400_000)
  assert.equal(cleared.remaining, 100_000)
  const preview = await salesService.exchangeChequeSuspensePreview({ paymentId: cheque.id })
  assert.deepEqual([preview.faceAmount, preview.openDebt, preview.applyAmount, preview.refundAmount],
    [300_000, 100_000, 100_000, 200_000])
  for (const mutation of [
    () => salesService.updatePayment({ id: cheque.id, note: 'bypass attempt' }),
    () => salesService.deletePayment({ id: cheque.id, userId, reason: 'delete suspense' }),
    () => salesService.setChequeStatus({ id: cheque.id, status: 'PENDING', managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
  ]) await assert.rejects(mutation, /SUSPENSE|پشتوانهٔ بدهی|تعیین تکلیف/u,
    'suspense/debt backing cannot be edited, deleted, or status-bypassed')

  const request = {
    paymentId: cheque.id, reason: 'تطبیق دیررس چک با صورت‌حساب بانکی',
    reconciliationEvidenceRef: 'BANK-STATEMENT-S10-PARTIAL', refundEvidenceRef: 'CASH-REFUND-S10-PARTIAL',
    refundDestination: 'CASH', proposerManagerUserId: userId, proposerManagerPin: 'S10-PIN-ONE',
    approverManagerUserId: managerTwoId, approverManagerPin: 'S10-PIN-TWO',
    approverReason: 'مدیر دوم اصل چک و رسید پرداخت را مستقلاً بررسی کرد',
    approverEvidenceRef: 'MANAGER-CHECK-S10-PARTIAL', userId
  }
  const resolved = await salesService.resolveExchangeChequeSuspense(request)
  assert.deepEqual([resolved.appliedAmount, resolved.refundAmount, resolved.debtAfter], [100_000, 200_000, 0])
  const cashMovementId = resolved.refundMovementId
  assert.ok(cashMovementId, 'cash refund is linked to one actual CashMovement')
  const replay = await salesService.resolveExchangeChequeSuspense(request)
  assert.equal(replay.replayed, true, 'same two-manager resolution/evidence is idempotent')
  assert.equal(replay.refundMovementId, cashMovementId)
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore + 2,
    'cash debt settlement and actual cash refund each create exactly one movement')
  assert.equal(seed.count('CashMovement', `refType='ExchangeChequeSuspenseRefund' AND refId=${cheque.id} AND type='EXCHANGE_REFUND'`), 1)
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_SETTLE'`), 2,
    'the late cheque settles only the 100K debt remaining; it does not settle the earlier 200K twice')
  const resolution = seed.one('SELECT amount, evidenceRef FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'SUSPENSE_CHEQUE_RESOLVED')
  assert.equal(resolution.amount, 300_000, 'immutable resolution marker preserves the actual cheque face amount')
  const refund = seed.one('SELECT amount, sourceDestination FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'SUSPENSE_CHEQUE_REFUNDED')
  assert.deepEqual([refund.amount, refund.sourceDestination], [200_000, 'CASH'])
  const updatedCheque = seed.one('SELECT amount, chequeStatus FROM "Payment" WHERE id=?', cheque.id)
  assert.deepEqual([updatedCheque.amount, updatedCheque.chequeStatus], [100_000, 'CLEARED'],
    'only the portion applied to the remaining debt is counted as a cleared payment')
  assert.equal(await exchangeFundingBalance(db, `debt:${result.exchangeInvoiceId}`), 0)
  assert.equal(seed.count('ExchangeResidualRightEvent', `relatedInvoiceId=${result.exchangeInvoiceId}`), 0,
    'suspense resolution creates no earlier refund/right')
  const current = await getCurrentExchangeFundingSources(db, result.exchangeInvoiceId)
  assert.equal(current.debt, 0)
  assert.equal(current.sources.reduce((sum, source) => sum + source.available, 0), 1_500_000)
  assert.deepEqual(current.unresolved, [])
}

async function lateChequeFullyRefundsWithoutDrawerMovement() {
  const { result, cheque } = await makeChequeExchange('late-full')
  const cashMovementsBefore = seed.count('CashMovement', '1=1')
  await salesService.addPayment({
    invoiceId: result.exchangeInvoiceId, amount: 300_000, methodId: cashMethodId,
    destination: 'CASH', reference: 'Cash fully settled before late cheque', userId,
    idempotencyKey: 's10-late-full-cash-settlement-payment-0001'
  })
  const cleared = await salesService.setChequeStatus({
    id: cheque.id, status: 'CLEARED', destination: 'MANAGER',
    managerPassword: DEFAULT_MANAGER_PASSWORD, userId
  })
  assert.equal(cleared.cheque.chequeStatus, 'SUSPENSE')
  const request = {
    paymentId: cheque.id, reason: 'چک پس از تسویه کامل بدهی وصول شد',
    reconciliationEvidenceRef: 'BANK-STATEMENT-S10-FULL', refundEvidenceRef: 'BANK-TRANSFER-S10-FULL',
    refundDestination: 'MANAGER', proposerManagerUserId: managerTwoId, proposerManagerPin: 'S10-PIN-TWO',
    approverManagerUserId: userId, approverManagerPin: 'S10-PIN-ONE',
    approverReason: 'تأیید مستقل انتقال واقعی مازاد به مشتری',
    approverEvidenceRef: 'MANAGER-CHECK-S10-FULL', userId
  }
  const resolved = await salesService.resolveExchangeChequeSuspense(request)
  assert.deepEqual([resolved.appliedAmount, resolved.refundAmount, resolved.debtAfter], [0, 300_000, 0])
  assert.equal(resolved.refundMovementId, null, 'bank/manager-account refund does not create a drawer movement')
  assert.equal(seed.count('CashMovement', '1=1'), cashMovementsBefore + 1,
    'only the earlier actual cash debt settlement moved the drawer')
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='DEBT_SETTLE'`), 1)
  assert.equal(seed.count('ExchangeFundingEvent', `sourceInvoiceId=${result.exchangeInvoiceId} AND kind='SUSPENSE_CHEQUE_REFUNDED'`), 1)
  assert.equal(seed.one('SELECT amount FROM "ExchangeFundingEvent" WHERE sourceInvoiceId=? AND kind=?',
    result.exchangeInvoiceId, 'SUSPENSE_CHEQUE_REFUNDED').amount, 300_000)
  assert.equal(seed.one('SELECT chequeStatus FROM "Payment" WHERE id=?', cheque.id).chequeStatus, 'SUSPENSE_REFUNDED')
  assert.equal(seed.count('ExchangeResidualRightEvent', `relatedInvoiceId=${result.exchangeInvoiceId}`), 0,
    'full refund does not recreate a previous N/B right')
  const current = await getCurrentExchangeFundingSources(db, result.exchangeInvoiceId)
  assert.equal(current.debt, 0)
  assert.deepEqual(current.unresolved, [])
}

async function disablePolicyWithoutRetroactivity() {
  const firstSnapshot = seed.one('SELECT evidenceRef FROM "ExchangeFundingEvent" WHERE kind=? AND evidenceRef LIKE ? LIMIT 1',
    'DEBT_OPEN', '%chequePolicyVersion:2%')
  assert.ok(firstSnapshot, 'version 2 is present on a committed exchange snapshot')
  const { approved } = await approvePolicy({
    enabled: false, minimumDelta: 0, proposerId: userId, proposerPin: 'S10-PIN-ONE',
    approverId: managerTwoId, approverPin: 'S10-PIN-TWO', tag: 'disable'
  })
  assert.deepEqual([approved.active.version, approved.active.enabled], [3, false])
  assert.equal(seed.one('SELECT evidenceRef FROM "ExchangeFundingEvent" WHERE kind=? AND evidenceRef LIKE ? LIMIT 1',
    'DEBT_OPEN', '%chequePolicyVersion:2%').evidenceRef, firstSnapshot.evidenceRef,
    'changing policy to v3 does not rewrite earlier v2 funding evidence')
  const source = await makePolicyTestParent('disabled-again')
  await assert.rejects(() => tryPolicyCheque(source, 'disabled-after-v3'), /خاموش/u,
    'server rejects new cheque exchange after policy is disabled')
}

await exercisePolicyControls()
await settleByCash()
await settleByCard()
await bounceAfterOffsetDoesNotReopenDebt()
await lateChequeGoesToSuspenseAndPartiallyResolves()
await lateChequeFullyRefundsWithoutDrawerMovement()
await disablePolicyWithoutRetroactivity()
console.log('S10 exchange cheque policy/debt/suspense: PASS (versioned approvals, disabled/minimum gates, cash/card, full/partial resolution, retry and mutation guards)')
