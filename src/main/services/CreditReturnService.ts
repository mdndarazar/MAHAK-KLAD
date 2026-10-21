import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { prisma } from '../db/client'
import { auditOrThrow as audit } from './AuditService'
import { issueStoreCredit, reverseInvoiceRedemptions } from './StoreCreditService'
import { allocateCreditReturn } from '@shared/creditReturnProvenance'
import { toNumberRial } from '@shared/money'
import type { RemainingResult } from '@shared/settlement'

type Client = Prisma.TransactionClient | typeof prisma

const unknown = () => new BusinessError(
  'منشأ اعتبار این خرید یا تقسیم برگشت‌های قبلی کامل و قابل اثبات نیست؛ بازپرداخت نقدی/اعتباری متوقف شد. پرونده را بدون حدس به مدیر برای تطبیق ارجاع دهید.'
)
const stale = () => new BusinessError('سهم اعتبار این فاکتور هم‌زمان تغییر کرد؛ هیچ حق تازه‌ای صادر نشد. فاکتور را تازه کنید.')
const childReturnBlocked = () => new BusinessError(
  'برگشت فرزند تعویض هنوز مسیر تسویهٔ مستقل ندارد؛ EXCHANGE_CREDIT وجه دریافتی نیست و حق بازپرداخت محاسبه نشد.'
)
const residualRightReturnBlocked = () => new BusinessError(
  'این فروش با حق ریشه‌دار B/N تسویه شده است؛ بازگشت همان حق باید با تخصیص تجمعی B→N ثبت شود. بازپرداخت نقدی یا صدور اعتبار عمومی مجاز نیست و هیچ اثری ثبت نشد.'
)

async function assertOrdinaryReturnInvoice(tx: Client, invoiceId: number) {
  const invoice = await tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: {
    id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true
  } })
  if (!invoice || invoice.orderType === 'EXCHANGE' || invoice.sourceInvoiceId != null ||
      invoice.exchangeReturnId != null)
    throw childReturnBlocked()
  const parentExchangeReturn = await tx.saleReturn.findFirst({
    where: { exchangeInvoiceId: invoice.id }, select: { id: true }
  })
  if (parentExchangeReturn) throw childReturnBlocked()
  return invoice
}

export interface CreditReturnPlan {
  credit: number
  cash: number
  fundedReturning: number
  shares: { redemptionId: number; parentCreditId: number; amount: number; prior: number }[]
}

/** Called *inside* the return's transaction before a cash amount is chosen.
 * The original sale's Payment/Redemption amounts are read from the DB, never
 * from a seller's code, surname or a client-supplied provenance flag.
 */
export async function planCreditReturn(
  tx: Client,
  input: {
    invoiceId: number
    grandTotal: number
    paidTotal: number
    returnedValue: number
    debtBefore: RemainingResult
    activeReturns: { id: number; kind: string; total: number | bigint }[]
  }
): Promise<CreditReturnPlan> {
  // EXCHANGE_CREDIT is carried value, not received cash. Descriptive child
  // provenance alone cannot make this ordinary-sale planner issue a refund plan.
  await assertOrdinaryReturnInvoice(tx, input.invoiceId)

  const rows = await tx.payment.findMany({
    where: { invoiceId: input.invoiceId, voidedAt: null },
    select: { id: true, storeCreditId: true, amount: true, kind: true, chequeStatus: true,
      method: { select: { kind: true } } }
  })
  const byPayment = new Map(rows.map((p) => [p.id, p]))
  const nonCashPayments = rows.filter((p) => p.storeCreditId != null || p.method?.kind === 'STORE_CREDIT')
  const residualCreditIds = [...new Set(rows.flatMap((payment) => payment.storeCreditId == null
    ? [] : [Number(payment.storeCreditId)]))]
  if (residualCreditIds.length) {
    const linkedCredits = await tx.storeCredit.findMany({
      where: { id: { in: residualCreditIds } }, select: { id: true, exchangeResidualRightKey: true }
    })
    if (linkedCredits.some((credit) => credit.exchangeResidualRightKey != null))
      throw residualRightReturnBlocked()
  }
  const redemptions = await tx.storeCreditRedemption.findMany({
    where: { invoiceId: input.invoiceId, reversedAt: null }, orderBy: { id: 'asc' },
    select: { id: true, creditId: true, amount: true, paymentId: true, compensatedAt: true }
  })
  if (!nonCashPayments.length && !redemptions.length)
    return { credit: 0, cash: input.returnedValue - Math.min(input.returnedValue, input.debtBefore.remaining),
      fundedReturning: input.returnedValue - Math.min(input.returnedValue, input.debtBefore.remaining), shares: [] }

  // A mismatched legacy Payment/redemption must not be interpreted as cash.
  // Payment.kind=CASH is also used for store-credit purchases in this schema.
  if (redemptions.some((r) => r.compensatedAt != null || !r.paymentId ||
      !byPayment.has(r.paymentId) || byPayment.get(r.paymentId)?.storeCreditId !== r.creditId ||
      toNumberRial(byPayment.get(r.paymentId)?.amount ?? 0) !== toNumberRial(r.amount)) ||
      nonCashPayments.length !== redemptions.length ||
      nonCashPayments.some((p) => !redemptions.some((r) => r.paymentId === p.id))) throw unknown()
  if (input.activeReturns.some((r) => r.kind !== 'RETURN')) throw unknown()
  const giftTotal = redemptions.reduce((sum, r) => sum + toNumberRial(r.amount), 0)
  const fundedPurchase = Math.min(input.grandTotal, input.paidTotal)
  const fundedPreviouslyReturned = input.debtBefore.refundFromReceived
  const debtReduced = Math.min(input.returnedValue, input.debtBefore.remaining)
  const fundedReturning = input.returnedValue - debtReduced
  const priorShares: { redemptionId: number; amount: number }[] = []
  for (const redemption of redemptions) {
    const prior = await tx.creditReturnAllocation.aggregate({
      where: { redemptionId: redemption.id }, _sum: { amount: true }
    })
    priorShares.push({ redemptionId: redemption.id, amount: toNumberRial(prior._sum.amount ?? 0) })
  }
  let result: ReturnType<typeof allocateCreditReturn>
  try {
    result = allocateCreditReturn({ fundedPurchase, fundedPreviouslyReturned, fundedReturning,
      redemptions: redemptions.map((r) => ({ id: r.id, amount: toNumberRial(r.amount) })), priorShares })
  } catch { throw unknown() }
  // A legacy return with no allocation may already have paid out the gift as
  // cash. Never mint B/E on top of that historic claim without reconciliation.
  const priorByRedemption = new Map(priorShares.map((share) => [share.redemptionId, share.amount]))
  for (const share of result.shares) {
    if (priorByRedemption.get(share.redemptionId) !== share.prior) throw unknown()
  }
  return { credit: result.credit, cash: result.cash, fundedReturning,
    shares: result.shares.map((s, i) => ({ ...s, parentCreditId: redemptions[i].creditId })) }
}

/** Resolve an explicit B/E, manager replacement or historic remainder link.
 * No name/code lookup and no speculative link by sourceInvoiceId. A missing
 * root is only tolerated when an immutable branch contains its snapshot.
 */
async function originOf(tx: Client, parentId: number): Promise<{ id: number; nominal: number; expiresAt: Date | null }> {
  let id = parentId
  let snapshot: { id: number; nominal: number; expiresAt: Date | null } | null = null
  const seen = new Set<number>()
  while (!seen.has(id) && seen.size < 50) {
    seen.add(id)
    const branch = await tx.creditReturnAllocation.findUnique({ where: { successorCreditId: id } })
    if (branch) {
      snapshot = { id: branch.rootCreditId, nominal: toNumberRial(branch.originNominal),
        expiresAt: branch.originalExpiresAt }
      id = branch.parentCreditId
      continue
    }
    const replaced = await tx.creditReplacement.findUnique({ where: { successorCreditId: id } })
    if (replaced) { id = replaced.originalCreditId; continue }
    const remainderParent = await tx.storeCredit.findFirst({ where: { remainderCreditId: id }, select: { id: true } })
    if (remainderParent) { id = remainderParent.id; continue }
    const original = await tx.storeCredit.findUnique({ where: { id } })
    if (!original) {
      if (snapshot && snapshot.id === id) return snapshot
      throw unknown()
    }
    const nominal = toNumberRial(original.amount)
    if (nominal <= 0) throw unknown()
    const firstBranch = await tx.creditReturnAllocation.findFirst({
      // A complete, branch-free reversal leaves no parallel B/E right. Only
      // a live/expired allocated branch freezes the root's earlier terms.
      where: { rootCreditId: id, kind: { in: ['BRANCH', 'SUPPLEMENT', 'EXPIRED'] } },
      orderBy: { id: 'asc' }
    })
    // Once ANY B/E branch exists the root's expiry/face value is frozen by
    // the first immutable allocation. A later edit to H1 cannot extend B/E.
    return snapshot && snapshot.id === id ? snapshot : firstBranch
      ? { id, nominal: toNumberRial(firstBranch.originNominal), expiresAt: firstBranch.originalExpiresAt }
      : { id, nominal, expiresAt: original.expiresAt }
  }
  throw unknown()
}

/** Issue a separate, locked B/E branch only for a proven non-cash share.
 * The ledger row's amount is the share of *this* sale's return; an unusable
 * one-shot parent's remainder may be transferred once, in a separate field.
 * Neither is a cash right or bank evidence. Caller owns the transaction.
 */
export async function applyCreditReturn(
  tx: Client,
  input: { invoiceId: number; returnId: number; full: boolean; userId?: number | null; plan: CreditReturnPlan }
): Promise<{ restored: number; expiredShare: number; reversedOriginal: number; credits: { creditId: number; amount: number; status: string }[] }> {
  // Keep the write primitive safe independently of its planner/caller.
  await assertOrdinaryReturnInvoice(tx, input.invoiceId)
  const credits: { creditId: number; amount: number; status: string }[] = []
  // 'restored' is the non-cash accounting share, including an expired
  // opportunity. Only restored - expiredShare can be spendable again.
  let expiredShare = 0
  let reversedOriginal = 0
  const now = new Date()
  for (const s of input.plan.shares) {
    if (!s.amount) continue
    const parent = await tx.storeCredit.findUnique({ where: { id: s.parentCreditId } })
    const redemption = await tx.storeCreditRedemption.findUnique({ where: { id: s.redemptionId } })
    if (parent?.exchangeResidualRightKey != null) throw residualRightReturnBlocked()
    if (!parent || !redemption || redemption.invoiceId !== input.invoiceId ||
        redemption.creditId !== parent.id || redemption.reversedAt || redemption.compensatedAt) throw stale()
    // An old redemption without an expiry snapshot is a legacy UNKNOWN,
    // never proof that a now-edited gift still has its original deadline.
    if (redemption.expiryCaptured !== true) throw unknown()
    const root = await originOf(tx, parent.id)
    const capturedExpiry = redemption.expiryAtRedeem?.getTime() ?? null
    if (capturedExpiry !== (root.expiresAt?.getTime() ?? null)) throw unknown()
    const prior = await tx.creditReturnAllocation.aggregate({
      // ORIGINAL_REVERSED has already returned its entire redemption to H1;
      // it must not consume H1's capacity again in a *later* purchase/return.
      where: { parentCreditId: parent.id, kind: { in: ['BRANCH', 'SUPPLEMENT', 'EXPIRED'] } },
      _sum: { amount: true, supplementUnspent: true }
    })
    const previouslyAllocated = toNumberRial(prior._sum.amount ?? 0)
    const previousSupplement = toNumberRial(prior._sum.supplementUnspent ?? 0)
    const used = toNumberRial(parent.usedAmount)
    if (previouslyAllocated + s.amount > used || used > toNumberRial(parent.amount)) throw unknown()
    const hasPriorBranch = await tx.creditReturnAllocation.count({
      where: { redemptionId: redemption.id, kind: { in: ['BRANCH', 'SUPPLEMENT', 'EXPIRED'] } }
    })
    const parentAfterReversalUsed = used - toNumberRial(redemption.amount)
    const expired = root.expiresAt != null && new Date(root.expiresAt).getTime() <= now.getTime()
    // A full return after H1's original deadline is still recorded, but
    // cannot make an expired opportunity ACTIVE (nor issue a fresh B/E).
    const mayReactivateOriginal = input.full && !expired && !hasPriorBranch &&
      !parent.remainderCreditId && parentAfterReversalUsed >= previouslyAllocated &&
      !parent.deletedAt && !parent.voidedAt && parent.status !== 'CANCELED'
    let kind = expired ? 'EXPIRED' : 'BRANCH'
    if (expired) expiredShare += s.amount
    let supplementUnspent = 0
    let credit: any = null
    if (mayReactivateOriginal) {
      // Restores the original H1 (e.g. 1M with 300k used and a hidden 700k
      // remainder) iff no previous branch of this redemption exists.
      const reversed = await reverseInvoiceRedemptions(tx, {
        invoiceId: input.invoiceId, redemptionIds: [redemption.id],
        reason: 'برگشت کامل بدون شاخهٔ پیشین؛ احیای همان فرصت اصلی', userId: input.userId
      })
      if (reversed !== 1) throw stale()
      reversedOriginal++
      kind = 'ORIGINAL_REVERSED'
    } else if (!expired) {
      // Only a USED, unusable one-shot parent may move its dormant balance;
      // not a still-active credit, an already-transferred replacement, an
      // archived/voided credit, or a historic remainder successor.
      if (input.full && parent.status === 'USED' && !parent.deletedAt && !parent.voidedAt &&
          !parent.remainderCreditId && previousSupplement === 0 &&
          used === previouslyAllocated + s.amount) {
        const replacement = await tx.creditReplacement.findUnique({ where: { originalCreditId: parent.id } })
        if (!replacement) supplementUnspent = toNumberRial(parent.amount) - used
      }
      kind = supplementUnspent > 0 ? 'SUPPLEMENT' : 'BRANCH'
      credit = await issueStoreCredit(tx, {
        amount: s.amount + supplementUnspent, source: 'EXCHANGE', returnId: input.returnId,
        sourceInvoiceId: input.invoiceId, userId: input.userId ?? null,
        expiresAtExact: root.expiresAt, days: null, status: 'DRAFT', multiUse: true,
        restrictScope: parent.restrictScope, restrictCategoryIds: parent.restrictCategoryIdsJson
          ? JSON.parse(parent.restrictCategoryIdsJson) : null,
        restrictVariantIds: parent.restrictVariantIdsJson ? JSON.parse(parent.restrictVariantIdsJson) : null,
        minPurchase: toNumberRial(parent.minPurchase), maxPerTransaction: toNumberRial(parent.maxPerTransaction),
        customerLocked: parent.customerLocked, customerId: parent.customerId,
        customerName: parent.customerName, holderCompany: parent.holderCompany,
        holderNationalId: parent.holderNationalId, holderPhone: parent.holderPhone,
        holderAddress: parent.holderAddress, holderAgent: parent.holderAgent,
        note: `بازگشت سهم اعتبار غیرنقدیِ فاکتور #${input.invoiceId}`
      })
      await tx.creditDelivery.create({ data: {
        creditId: credit.id, sourceKind: 'CREDIT_RETURN_OPPORTUNITY', status: 'PENDING_DELIVERY'
      } })
      credits.push({ creditId: credit.id, amount: s.amount + supplementUnspent, status: 'PENDING_DELIVERY' })
    }
    const allocation = await tx.creditReturnAllocation.create({ data: {
      returnId: input.returnId, invoiceId: input.invoiceId, redemptionId: s.redemptionId,
      parentCreditId: parent.id, rootCreditId: root.id, originNominal: root.nominal,
      amount: s.amount, supplementUnspent, successorCreditId: credit?.id ?? null,
      kind, originalExpiresAt: root.expiresAt
    } })
    if (input.full && !mayReactivateOriginal) {
      const marked = await tx.storeCreditRedemption.updateMany({
        where: { id: redemption.id, reversedAt: null, compensatedAt: null, amount: redemption.amount },
        data: { compensatedAt: now, compensatedReturnId: input.returnId }
      })
      if (marked.count !== 1) throw stale()
    }
    await audit(tx, { action: 'CREDIT_RETURN_OPPORTUNITY', entity: 'CreditReturnAllocation',
      entityId: allocation.id, userId: input.userId ?? null,
      after: JSON.stringify({ invoiceId: input.invoiceId, returnId: input.returnId,
        redemptionId: redemption.id, parentCreditId: parent.id, rootCreditId: root.id,
        share: s.amount, supplementUnspent, successorCreditId: credit?.id ?? null,
        kind, expiresAt: root.expiresAt }),
      note: `سهم غیرنقدی برگشت #${input.returnId} از اعتبار #${parent.id}: ${s.amount} ریال؛ ${kind}` })
  }
  return { restored: input.plan.credit, expiredShare, reversedOriginal, credits }
}
