import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { assertManagerPassword } from './AuthService'
import { issueStoreCredit } from './StoreCreditService'
import { CreditSource } from '@shared/credit'
import { cashClaimBalance } from '@shared/returnEntitlement'
import { toNumberRial } from '@shared/money'

type Client = Prisma.TransactionClient | typeof prisma
const secureInt = (v: unknown, name: string, min = 1): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
    throw new BusinessError(`${name} باید عدد صحیح معتبر باشد؛ هیچ مبلغی ثبت نشد.`)
  return v
}
const safeId = (v: unknown, name: string): number => secureInt(v, name)
const stale = () => new BusinessError('وضعیت حق مالی در همین لحظه تغییر کرده است؛ هیچ تخصیص دومی ثبت نشد. صفحه را تازه کنید.')
const safeView = (row: any) => ({
  returnId: Number(row.returnId),
  invoiceId: Number(row.invoiceId),
  requestId: row.requestId == null ? null : Number(row.requestId),
  cashRight: toNumberRial(row.cashRight),
  cashPaid: toNumberRial(row.cashPaid),
  cashReserved: toNumberRial(row.cashReserved),
  cashConverted: toNumberRial(row.cashConverted),
  giftOpportunity: toNumberRial(row.giftOpportunity),
  debtReduced: toNumberRial(row.debtReduced),
  ...cashClaimBalance(row),
  state: String(row.state),
  version: Number(row.version)
})

export async function assertOrdinaryReturnLineage(tx: Client, returnId: number, invoiceId?: number) {
  const checkedReturnId = safeId(returnId, 'شناسه برگشت')
  const checkedInvoiceId = invoiceId == null ? null : safeId(invoiceId, 'شناسه فاکتور')
  const ret = await tx.saleReturn.findUnique({ where: { id: checkedReturnId }, select: {
    id: true, invoiceId: true, voidedAt: true,
    invoice: { select: { orderType: true, sourceInvoiceId: true, exchangeReturnId: true } }
  } })
  if (!ret || (checkedInvoiceId != null && ret.invoiceId !== checkedInvoiceId) ||
      ret.invoice?.orderType === 'EXCHANGE' || ret.invoice?.sourceInvoiceId != null ||
      ret.invoice?.exchangeReturnId != null)
    throw new BusinessError('برگشت فرزند تعویض تا تکمیل lineage و جریان مستقل قابل ثبت یا تغییر نیست.')
  return ret
}

/** New returns only. Existing legacy requests are not guessed into a cash
 * claim; their history remains available for manager-controlled cutover.
 * Caller MUST pass the same tx that creates the SaleReturn and REQUEST.
 */
export async function openCardTransferEntitlement(
  tx: Client,
  input: { returnId: number; invoiceId: number; requestId: number; amount: number; debtReduced?: number;
    giftOpportunity?: number; actorUserId?: number | null }
): Promise<any> {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const invoiceId = safeId(input.invoiceId, 'شناسه فاکتور')
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const amount = secureInt(input.amount, 'حق نقدی')
  const debtReduced = secureInt(input.debtReduced ?? 0, 'کاهش بدهی', 0)
  const giftOpportunity = secureInt(input.giftOpportunity ?? 0, 'سهم اعتبار غیرنقدی', 0)
  const ret = await tx.saleReturn.findUnique({ where: { id: returnId }, select: {
    invoiceId: true, total: true,
    invoice: { select: { orderType: true, sourceInvoiceId: true, exchangeReturnId: true } }
  } })
  // Defense in depth: this exported write service must not turn descriptive
  // child-line provenance into a financial claim, even if a caller bypasses
  // SalesService's normal child-return gate or orderType was misclassified.
  if (ret?.invoice?.orderType === 'EXCHANGE' || ret?.invoice?.sourceInvoiceId != null ||
      ret?.invoice?.exchangeReturnId != null)
    throw new BusinessError('انتساب منشأ برگشت فرزند تعویض به‌تنهایی حق نقدی نمی‌سازد؛ تسویهٔ مالی آن تا تکمیل lineage و entitlement مسدود است.')
  if (!ret || ret.invoiceId !== invoiceId || amount + debtReduced + giftOpportunity > toNumberRial(ret.total))
    throw new BusinessError('حق نقدی، سهم اعتبار و کاهش بدهی با سند برگشت منطبق نیستند؛ حق تازه باز نشد.')
  const existing = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (existing) {
    if (Number(existing.requestId) !== requestId || toNumberRial(existing.cashRight) !== amount ||
        toNumberRial(existing.giftOpportunity) !== giftOpportunity)
      throw stale()
    return safeView(existing)
  }
  const claim = await tx.returnEntitlement.create({
    data: { returnId, invoiceId, requestId, cashRight: amount, cashReserved: amount,
      giftOpportunity, debtReduced }
  })
  await tx.returnEntitlementEvent.create({
    data: {
      entitlementId: claim.id, eventKey: `claim:${returnId}`, kind: 'CASH_RIGHT_OPENED', amount,
      requestId, actorUserId: input.actorUserId ?? null, beforeVersion: 0
    }
  })
  await tx.returnEntitlementEvent.create({
    data: {
      entitlementId: claim.id, eventKey: `reserve:${requestId}`, kind: 'BANK_RESERVED', amount,
      requestId, actorUserId: input.actorUserId ?? null, beforeVersion: 0
    }
  })
  return safeView(claim)
}

/** The manager's 'paid' click/typed tracking number is a DECLARATION, not
 * independent evidence of bank payout. Keep the ENTIRE reservation frozen,
 * including the shortfall, until a reviewed bank document is archived.
 */
export async function markBankDeclaration(
  tx: Client,
  input: { requestId: number; declaredAmount: number; actorUserId?: number | null }
): Promise<null | ReturnType<typeof safeView>> {
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const claim = await tx.returnEntitlement.findUnique({ where: { requestId } })
  if (!claim) return null // explicitly legacy, no fabricated entitlement
  await assertOrdinaryReturnLineage(tx, Number(claim.returnId), Number(claim.invoiceId))
  const amount = secureInt(input.declaredAmount, 'مبلغ اعلامی')
  if (claim.state === 'UNKNOWN_BANK') {
    const previous = await tx.returnEntitlementEvent.findUnique({ where: { eventKey: `declared:${requestId}` } })
    if (previous && toNumberRial(previous.amount) === amount) return safeView(claim)
    throw stale()
  }
  if (claim.state !== 'OPEN' || toNumberRial(claim.cashReserved) <= 0 || amount > toNumberRial(claim.cashReserved))
    throw stale()
  const marked = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, state: 'OPEN', version: claim.version, cashReserved: claim.cashReserved },
    data: { state: 'UNKNOWN_BANK', version: { increment: 1 }, updatedAt: new Date() }
  })
  if (marked.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({
    data: {
      entitlementId: claim.id, eventKey: `declared:${requestId}`, kind: 'BANK_DECLARED_UNKNOWN',
      amount, requestId, actorUserId: input.actorUserId ?? null,
      evidenceKind: 'MANAGER_DECLARATION_NOT_BANK_PROOF', beforeVersion: claim.version
    }
  })
  return safeView({ ...claim, state: 'UNKNOWN_BANK', version: claim.version + 1 })
}

/** A cancellation is not evidence that no off-system bank payment happened.
 * Keep the full reservation under UNKNOWN, never convert it automatically.
 */
export async function markBankCancellationUnknown(
  tx: Client,
  input: { requestId: number; actorUserId?: number | null; reason: string }
): Promise<boolean> {
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const claim = await tx.returnEntitlement.findUnique({ where: { requestId } })
  if (!claim) return false
  await assertOrdinaryReturnLineage(tx, Number(claim.returnId), Number(claim.invoiceId))
  if (claim.state !== 'OPEN') throw stale()
  const changed = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, version: claim.version, state: 'OPEN' },
    data: { state: 'UNKNOWN_BANK', version: { increment: 1 }, updatedAt: new Date() }
  })
  if (changed.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `cancel-unknown:${requestId}`,
    kind: 'BANK_CANCELED_OUTCOME_UNKNOWN', amount: toNumberRial(claim.cashReserved), requestId,
    actorUserId: input.actorUserId ?? null, evidenceKind: 'MANAGER_DECLARATION_NOT_BANK_PROOF',
    reason: input.reason, beforeVersion: claim.version
  } })
  return true
}

/** A controlled edit of an UNPAID pending request. There must be no gift/debt
 * split or bank declaration; anything else needs a separate correction case.
 */
export async function correctPendingEntitlement(
  tx: Client,
  input: { returnId: number; requestId: number; newRight: number; reason: string; actorUserId?: number | null }
): Promise<boolean> {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (!claim) return false
  await assertOrdinaryReturnLineage(tx, returnId, Number(claim.invoiceId))
  const right = secureInt(input.newRight, 'حق اصلاح‌شده')
  if (claim.requestId !== input.requestId || claim.state !== 'OPEN' ||
      toNumberRial(claim.cashPaid) !== 0 || toNumberRial(claim.cashConverted) !== 0 ||
      toNumberRial(claim.debtReduced) !== 0 || toNumberRial(claim.giftOpportunity) !== 0 ||
      toNumberRial(claim.cashRight) !== toNumberRial(claim.cashReserved))
    throw new BusinessError('اصلاح سادهٔ این برگشتِ دارای حق مالی ممکن نیست؛ تسویه/منشأ آن نیاز به پروندهٔ اصلاح شاهددار دارد.')
  if (right === toNumberRial(claim.cashRight)) return true
  const changed = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, version: claim.version, state: 'OPEN', cashRight: claim.cashRight, cashReserved: claim.cashReserved },
    data: { cashRight: right, cashReserved: right, version: { increment: 1 }, updatedAt: new Date() }
  })
  if (changed.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `pending-correction:${claim.id}:${claim.version + 1}`,
    kind: 'PENDING_RIGHT_CORRECTED', amount: right - toNumberRial(claim.cashRight), requestId: input.requestId,
    actorUserId: input.actorUserId ?? null, evidenceKind: 'MANAGER_CORRECTION',
    reason: input.reason, beforeVersion: claim.version
  } })
  return true
}

/** Voiding a source must not delete an obligation or infer that the bank never
 * paid. Quarantine the immutable claim; do not reopen a spendable code.
 */
export async function quarantineEntitlement(
  tx: Client,
  input: { returnId: number; reason: string; actorUserId?: number | null }
): Promise<boolean> {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (!claim) return false
  await assertOrdinaryReturnLineage(tx, returnId, Number(claim.invoiceId))
  if (claim.state === 'QUARANTINED') return true
  const changed = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, version: claim.version, state: claim.state },
    data: { state: 'QUARANTINED', version: { increment: 1 }, updatedAt: new Date() }
  })
  if (changed.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `quarantine:${claim.id}:${claim.version + 1}`,
    kind: 'SOURCE_QUARANTINED', amount: 0, requestId: claim.requestId,
    actorUserId: input.actorUserId ?? null, evidenceKind: 'MANAGER_CORRECTION',
    reason: input.reason, beforeVersion: claim.version
  } })
  return true
}

const documentMime = (name: string, bytes: Uint8Array): string => {
  const n = name.toLowerCase()
  if (n.endsWith('.pdf') && Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-') return 'application/pdf'
  if (n.endsWith('.csv') && !Buffer.from(bytes).includes(0) && bytes.length > 10) return 'text/csv'
  throw new BusinessError('شاهد بانک باید فایل PDF صورت‌حساب یا CSV خروجی بانک باشد؛ عکس، شماره پیگیری و PIN کافی نیست.')
}

/** Document is selected/read in MAIN (not an arbitrary renderer-provided
 * digest). It is archived inside SQLite and therefore included by BackupService.
 * This records a HUMAN REVIEW of a bank document, not a bank API confirmation.
 * The bank evidence must show the actual payout, not only a claimed amount.
 */
export async function reconcileBankDocument(input: {
  requestId: number
  confirmedAmount: number
  document: { name: string; bytes: Uint8Array }
  reviewNote: string
  attestedBankAccountReview: boolean
  managerPassword?: string | null
  actorUserId?: number | null
}) {
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const amount = secureInt(input.confirmedAmount, 'مبلغ صورت‌حساب')
  const note = String(input.reviewNote ?? '').trim()
  if (note.length < 10 || input.attestedBankAccountReview !== true)
    throw new BusinessError('مدیر باید تطبیق صورت‌حساب بانک با حساب/تاریخ/مبلغ را صریحاً تأیید و دلیل حداقل ۱۰ نویسه ثبت کند.')
  const bytes = input.document?.bytes
  if (!(bytes instanceof Uint8Array) || bytes.length < 15 || bytes.length > 5_000_000)
    throw new BusinessError('فایل شاهد بانک وجود ندارد یا حجم آن معتبر نیست (حداکثر ۵ مگابایت).')
  const name = String(input.document?.name ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120)
  const mimeType = documentMime(name, bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  await assertManagerPassword(input.managerPassword, 'تطبیق سند پرداخت کارت‌به‌کارت با صورت‌حساب بانک')

  return prisma.$transaction(async (tx) => {
    const claim = await tx.returnEntitlement.findUnique({ where: { requestId } })
    if (!claim) throw new BusinessError('این درخواست فاقد حق مالیِ قابل‌تبدیل است؛ پروندهٔ قدیمی به رسیدگی مدیر نیاز دارد.')
    await assertOrdinaryReturnLineage(tx, Number(claim.returnId), Number(claim.invoiceId))
    const existing = await tx.bankStatementEvidence.findUnique({ where: { requestId } })
    if (existing) {
      if (existing.sha256 !== digest || toNumberRial(existing.confirmedAmount) !== amount) throw stale()
      return { ...safeView(claim), evidenceId: existing.id, replayed: true }
    }
    const req = await tx.cardTransferRequest.findUnique({ where: { id: requestId } })
    if (!req || req.kind !== 'REQUEST' || !['PAID', 'ADJUSTED'].includes(req.status) || !req.paidAt)
      throw new BusinessError('این درخواست هنوز پرداختِ اعلام‌شده ندارد؛ سند بانک را به درخواست درست وصل کنید.')
    if (amount !== toNumberRial(req.paidAmount) || amount > toNumberRial(req.amount))
      throw new BusinessError('مبلغ صورت‌حساب با اعلام پرداخت همین درخواست یکسان نیست؛ پرونده تا رسیدگی اختلاف مسدود می‌ماند.')
    if (claim.state !== 'UNKNOWN_BANK' || toNumberRial(claim.cashReserved) !== toNumberRial(req.amount))
      throw stale()
    const next = {
      cashPaid: toNumberRial(claim.cashPaid) + amount,
      cashReserved: 0,
      cashConverted: toNumberRial(claim.cashConverted),
      cashRight: toNumberRial(claim.cashRight)
    }
    const state = cashClaimBalance(next).overAllocated ? 'OVER_ALLOCATED' : 'OPEN'
    const updated = await tx.returnEntitlement.updateMany({
      where: { id: claim.id, version: claim.version, state: 'UNKNOWN_BANK', cashReserved: claim.cashReserved },
      data: { cashPaid: next.cashPaid, cashReserved: 0, state, version: { increment: 1 }, updatedAt: new Date() }
    })
    if (updated.count !== 1) throw stale()
    const evidence = await tx.bankStatementEvidence.create({
      data: {
        requestId, confirmedAmount: amount, sha256: digest, fileName: name,
        mimeType, documentBase64: Buffer.from(bytes).toString('base64'),
        reviewedByUserId: input.actorUserId ?? null, reviewNote: note
      }
    })
    await tx.returnEntitlementEvent.create({
      data: {
        entitlementId: claim.id, eventKey: `bank-reviewed:${requestId}`, kind: 'BANK_DOCUMENT_REVIEWED',
        amount, requestId, actorUserId: input.actorUserId ?? null,
        evidenceKind: 'BANK_STATEMENT_REVIEWED_BY_MANAGER', evidenceHash: digest,
        reason: note, beforeVersion: claim.version
      }
    })
    return { ...safeView({ ...claim, ...next, state, version: claim.version + 1 }), evidenceId: evidence.id, replayed: false }
  })
}

/** Only a MANAGER can exchange verified, unallocated cash rights for a
 * no-expiry multi-use StoreCredit. A pending/unknown bank attempt never opens
 * the 400 remainder. A DRAFT code requires a separate witnessed handoff.
 */
export async function convertCashRight(input: {
  returnId: number
  amount: number
  expectedVersion: number
  idempotencyKey: string
  managerPassword?: string | null
  actorUserId?: number | null
}) {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const amount = secureInt(input.amount, 'مبلغ تبدیل')
  const version = secureInt(input.expectedVersion, 'نسخهٔ حق مالی', 0)
  const key = String(input.idempotencyKey ?? '').trim()
  if (key.length < 8 || key.length > 200)
    throw new BusinessError('کلید یکتای عملیات تبدیل معتبر نیست؛ برای تلاش تازه کلید تازه بگیرید.')
  const eventKey = `convert:${returnId}:${createHash('sha256').update(key).digest('hex')}`
  await assertManagerPassword(input.managerPassword, 'تبدیل آگاهانهٔ حق نقدی به کد اعتبار بدون انقضا')

  return prisma.$transaction(async (tx) => {
    const previous = await tx.returnEntitlementEvent.findUnique({ where: { eventKey } })
    if (previous) {
      if (toNumberRial(previous.amount) !== amount || !previous.creditId) throw stale()
      const priorClaim = await tx.returnEntitlement.findUnique({ where: { id: previous.entitlementId } })
      if (!priorClaim) throw stale()
      await assertOrdinaryReturnLineage(tx, returnId, Number(priorClaim.invoiceId))
      const delivery = await tx.creditDelivery.findUnique({ where: { creditId: previous.creditId } })
      return { creditId: previous.creditId, publicReference: `اعتبار #${previous.creditId}`,
        deliveryStatus: delivery?.status ?? 'PENDING_DELIVERY', replayed: true }
    }
    const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
    if (!claim || claim.state !== 'OPEN' || claim.version !== version)
      throw new BusinessError('حق مالی هنوز باز/تطبیق‌شده نیست یا نسخهٔ آن تغییر کرده است؛ تبدیل انجام نشد.')
    const ret = await assertOrdinaryReturnLineage(tx, returnId, Number(claim.invoiceId))
    const balance = cashClaimBalance(claim)
    if (balance.overAllocated || amount > balance.open)
      throw new BusinessError('مبلغ مورد درخواست از حق نقدی باز بیشتر است؛ کدی صادر نشد. پرداخت و رزرو بانک را بررسی کنید.')
    if (ret.voidedAt != null)
      throw new BusinessError('سند برگشت معتبر برای تبدیل حق مالی وجود ندارد؛ کدی صادر نشد.')
    const invoice = await tx.saleInvoice.findUnique({ where: { id: ret.invoiceId }, select: { customerId: true } })
    const changed = await tx.returnEntitlement.updateMany({
      where: { id: claim.id, version, state: 'OPEN', cashPaid: claim.cashPaid,
        cashReserved: claim.cashReserved, cashConverted: claim.cashConverted, cashRight: claim.cashRight },
      data: { cashConverted: toNumberRial(claim.cashConverted) + amount, version: { increment: 1 }, updatedAt: new Date() }
    })
    if (changed.count !== 1) throw stale()
    const credit = await issueStoreCredit(tx, {
      amount, source: CreditSource.EXCHANGE, days: null, expiresAtExact: null,
      multiUse: true, maxUses: 1000, status: 'DRAFT',
      returnId, sourceInvoiceId: ret.invoiceId, customerId: invoice?.customerId ?? null,
      note: `تبدیل آگاهانهٔ حق واقعیِ بازپرداخت سند برگشت #${returnId} به اعتبار بدون انقضا`,
      userId: input.actorUserId ?? null
    })
    await tx.creditDelivery.create({ data: { creditId: credit.id, sourceKind: 'CASH_RIGHT_CONVERSION' } })
    await tx.returnEntitlementEvent.create({
      data: { entitlementId: claim.id, eventKey, kind: 'CASH_RIGHT_CONVERTED', amount,
        requestId: claim.requestId, creditId: credit.id, actorUserId: input.actorUserId ?? null,
        evidenceKind: 'MANAGER_DECISION', beforeVersion: version }
    })
    return { creditId: credit.id, publicReference: `اعتبار #${credit.id}`, deliveryStatus: 'PENDING_DELIVERY', replayed: false }
  })
}

/** Print != delivery. A DRAFT replacement/conversion cannot be spent before
 * this witnessed handoff. Replayed confirmations do not reactivate twice.
 */
export async function confirmCreditDelivery(input: {
  creditId: number
  witnessKind: 'CUSTOMER_HANDOFF' | 'COURIER_ACK'
  witnessRef: string
  managerPassword?: string | null
  actorUserId?: number | null
}) {
  const creditId = safeId(input.creditId, 'شناسه اعتبار')
  const ref = String(input.witnessRef ?? '').trim()
  if (!['CUSTOMER_HANDOFF', 'COURIER_ACK'].includes(input.witnessKind) || ref.length < 8)
    throw new BusinessError('برای تحویل اعتبار، نوع شاهد و توضیح مشخصِ تحویل (حداقل ۸ نویسه) لازم است.')
  await assertManagerPassword(input.managerPassword, 'تأیید تحویل شاهددار کد اعتبار')
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.creditDelivery.findUnique({ where: { creditId } })
    if (!delivery) throw new BusinessError('برای این اعتبار پروندهٔ تحویل کنترل‌شده وجود ندارد.')
    if (delivery.status === 'DELIVERED') {
      if (delivery.witnessKind === input.witnessKind && delivery.witnessRef === ref)
        return { creditId, status: 'DELIVERED', replayed: true }
      throw stale()
    }
    if (delivery.status !== 'PENDING_DELIVERY') throw stale()
    const credit = await tx.storeCredit.findUnique({ where: { id: creditId } })
    if (!credit || credit.status !== 'DRAFT' || credit.deletedAt != null || credit.voidedAt != null)
      throw new BusinessError('کد اعتبار دیگر در حالت انتظار تحویل نیست؛ تحویل ثبت نشد.')
    if (delivery.originCreditId != null) {
      const replaced = await tx.creditReplacement.findUnique({ where: { successorCreditId: creditId } })
      const old = await tx.storeCredit.findUnique({ where: { id: delivery.originCreditId } })
      if (!replaced || replaced.originalCreditId !== delivery.originCreditId || old?.status !== 'CANCELED')
        throw new BusinessError('زنجیرهٔ جانشینی کد/ابطال مبدأ قابل تأیید نیست؛ کد فعال نشد.')
    } else if (delivery.sourceKind === 'CASH_RIGHT_CONVERSION') {
      const event = await tx.returnEntitlementEvent.findFirst({ where: { creditId, kind: 'CASH_RIGHT_CONVERTED' } })
      const claim = event ? await tx.returnEntitlement.findUnique({ where: { id: event.entitlementId } }) : null
      if (!claim || claim.state !== 'OPEN' || claim.cashConverted < credit.amount)
        throw new BusinessError('حق نقدی منشأ این اعتبار در وضعیت امن نیست؛ تحویل/فعال‌سازی تا تطبیق مدیر متوقف است.')
      await assertOrdinaryReturnLineage(tx, Number(claim.returnId), Number(claim.invoiceId))
    } else if (delivery.sourceKind === 'CREDIT_RETURN_OPPORTUNITY') {
      const branch = await tx.creditReturnAllocation.findUnique({ where: { successorCreditId: creditId } })
      const ret = branch
        ? await assertOrdinaryReturnLineage(tx, Number(branch.returnId), Number(branch.invoiceId))
        : null
      if (!branch || !ret || ret.voidedAt != null || ret.invoiceId !== branch.invoiceId ||
          toNumberRial(branch.amount) + toNumberRial(branch.supplementUnspent) !== toNumberRial(credit.amount) ||
          (branch.originalExpiresAt?.getTime() ?? null) !== (credit.expiresAt?.getTime() ?? null))
        throw new BusinessError('منشأ B/E یا مبلغ/انقضای اصلی قابل تطبیق نیست؛ کد فعال نشد.')
    }
    const at = new Date()
    if (credit.expiresAt && credit.expiresAt <= at)
      throw new BusinessError('انقضای اصلی این اعتبار گذشته است؛ تحویل کد، فرصت منقضی را احیا نمی‌کند.')
    const marked = await tx.creditDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING_DELIVERY', version: delivery.version },
      data: { status: 'DELIVERED', deliveredAt: at, deliveredByUserId: input.actorUserId ?? null,
        witnessKind: input.witnessKind, witnessRef: ref, version: { increment: 1 } }
    })
    if (marked.count !== 1) throw stale()
    const activated = await tx.storeCredit.updateMany({
      where: { id: creditId, status: 'DRAFT', usedAmount: 0, deletedAt: null }, data: { status: 'ACTIVE' }
    })
    if (activated.count !== 1) throw stale()
    const issuance = await tx.returnEntitlementEvent.findFirst({ where: { creditId, kind: 'CASH_RIGHT_CONVERTED' } })
    if (issuance) {
      await tx.returnEntitlementEvent.create({ data: {
        entitlementId: issuance.entitlementId, eventKey: `delivered:${creditId}`, kind: 'CREDIT_DELIVERED', amount: 0,
        creditId, actorUserId: input.actorUserId ?? null, evidenceKind: input.witnessKind, reason: ref,
        beforeVersion: delivery.version
      } })
    }
    return { creditId, status: 'DELIVERED', replayed: false }
  })
}

export async function viewReturnEntitlement(returnId: number) {
  const row = await prisma.returnEntitlement.findUnique({ where: { returnId: safeId(returnId, 'شناسه برگشت') } })
  if (!row) return null
  return safeView(row)
}
