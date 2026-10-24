import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { prisma } from '../db/client'
import { auditOrThrow as audit } from './AuditService'
import { issueStoreCredit, reverseInvoiceRedemptions } from './StoreCreditService'
import { allocateCreditReturn } from '@shared/creditReturnProvenance'
import { CreditRestrictScope, normalizeRestrictScope, parseIdList } from '@shared/credit'
import { toNumberRial } from '@shared/money'
import type { RemainingResult } from '@shared/settlement'

type Client = Prisma.TransactionClient | typeof prisma

/** CENTRAL CHANGE POINT for non-cashable barcode-credit return policy. A policy
 * change must bump this version and ship a new database-enforcement migration. */
export const RETURN_CREDIT_POLICY_VERSION = 1
export const RETURN_CREDIT_POLICY_KEY = 'BARCODE_CREDIT_NEVER_CASHABLE'

/** Single DB writer for a return's real-money-only settlement ceiling. */
export async function appendCreditReturnAllocation(tx: Client, data: any) {
  return tx.creditReturnAllocation.create({ data })
}

export async function authorizeReturnRealMoneyRefund(
  tx: Client,
  input: { returnId: number; amount: number; policyVersion?: number }
) {
  const policyVersion = input.policyVersion ?? RETURN_CREDIT_POLICY_VERSION
  if (policyVersion !== RETURN_CREDIT_POLICY_VERSION || !Number.isSafeInteger(input.amount) || input.amount < 0)
    throw new BusinessError('سقف بازپرداخت وجه واقعی با سیاست مرکزی اعتبار سازگار نیست؛ هیچ تسویه‌ای ثبت نشد.')
  return tx.saleReturn.update({
    where: { id: input.returnId },
    data: { realMoneyRefundAmount: input.amount, creditReturnPolicyVersion: policyVersion }
  })
}

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

type ReturnFundingLine = { saleItemId: number; variantId: number; value: number }

function creditMatchesReturnLine(credit: any, line: ReturnFundingLine, categoryPath: number[]): boolean {
  const scope = normalizeRestrictScope(credit.restrictScope)
  if (scope === CreditRestrictScope.ALL) return true
  if (scope === CreditRestrictScope.VARIANTS)
    return parseIdList(credit.restrictVariantIdsJson).includes(line.variantId)
  const allowedCategories = new Set(parseIdList(credit.restrictCategoryIdsJson))
  return categoryPath.some((id) => allowedCategories.has(id))
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
    returnLines?: ReturnFundingLine[]
    debtBefore: RemainingResult
    activeReturns: { id: number; kind: string; total: number | bigint }[]
    /** Gift shares already carried into prior exchange children, proved from the source-funding ledger. */
    priorCarriedShares?: { redemptionId: number; amount: number }[]
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
  const fundedPurchase = Math.min(input.grandTotal, input.paidTotal)
  const fundedPreviouslyReturned = input.debtBefore.refundFromReceived
  const debtReduced = Math.min(input.returnedValue, input.debtBefore.remaining)
  const fundedReturning = input.returnedValue - debtReduced
  const carriedByRedemption = new Map<number, number>()
  for (const row of input.priorCarriedShares ?? []) {
    if (!Number.isSafeInteger(row.redemptionId) || row.redemptionId <= 0 ||
        !Number.isSafeInteger(row.amount) || row.amount < 0 || carriedByRedemption.has(row.redemptionId))
      throw unknown()
    carriedByRedemption.set(row.redemptionId, row.amount)
  }
  const priorShares: { redemptionId: number; amount: number }[] = []
  for (const redemption of redemptions) {
    const prior = await tx.creditReturnAllocation.aggregate({
      where: { redemptionId: redemption.id }, _sum: { amount: true }
    })
    const restored = toNumberRial(prior._sum.amount ?? 0)
    const carried = carriedByRedemption.get(Number(redemption.id)) ?? 0
    const cumulative = restored + carried
    if (!Number.isSafeInteger(cumulative) || cumulative > toNumberRial(redemption.amount)) throw unknown()
    priorShares.push({ redemptionId: Number(redemption.id), amount: cumulative })
  }
  if ([...carriedByRedemption.keys()].some((redemptionId) =>
      !redemptions.some((redemption) => Number(redemption.id) === redemptionId))) throw unknown()
  const credits = await tx.storeCredit.findMany({
    where: { id: { in: [...new Set(redemptions.map((r) => Number(r.creditId)))] } },
    select: { id: true, restrictScope: true, restrictCategoryIdsJson: true, restrictVariantIdsJson: true }
  })
  const creditById = new Map(credits.map((credit) => [Number(credit.id), credit]))
  if (credits.length !== new Set(redemptions.map((r) => Number(r.creditId))).size) throw unknown()
  const restrictedCredits = credits.filter((credit) =>
    normalizeRestrictScope(credit.restrictScope) !== CreditRestrictScope.ALL)

  const returnLines = input.returnLines ?? [{ saleItemId: 1, variantId: 1, value: input.returnedValue }]
  if (returnLines.some((line) => !Number.isSafeInteger(line.saleItemId) ||
      !Number.isSafeInteger(line.variantId) || line.variantId <= 0 ||
      !Number.isSafeInteger(line.value) || line.value < 0) ||
      returnLines.reduce((sum, line) => sum + BigInt(line.value), 0n) !== BigInt(input.returnedValue))
    throw unknown()
  if (restrictedCredits.length && input.returnLines == null) throw unknown()

  const variantIds = [...new Set(returnLines.map((line) => line.variantId))]
  const variants = restrictedCredits.length
    ? await tx.productVariant.findMany({ where: { id: { in: variantIds } },
        select: { id: true, product: { select: { categoryId: true } } } })
    : []
  const variantById = new Map(variants.map((variant) => [Number(variant.id), variant]))
  if (restrictedCredits.length && variants.length !== variantIds.length) throw unknown()
  const categoryParent = new Map<number, number | null>()
  if (credits.some((credit) => normalizeRestrictScope(credit.restrictScope) === CreditRestrictScope.CATEGORY)) {
    const categories = await tx.category.findMany({ select: { id: true, parentId: true } })
    for (const category of categories)
      categoryParent.set(Number(category.id), category.parentId == null ? null : Number(category.parentId))
    for (const credit of credits.filter((row) =>
      normalizeRestrictScope(row.restrictScope) === CreditRestrictScope.CATEGORY)) {
      const ids = parseIdList(credit.restrictCategoryIdsJson)
      if (!ids.length || ids.every((id) => !categoryParent.has(id))) throw unknown()
    }
  }
  for (const credit of credits.filter((row) =>
    normalizeRestrictScope(row.restrictScope) === CreditRestrictScope.VARIANTS)) {
    if (!parseIdList(credit.restrictVariantIdsJson).length) throw unknown()
  }
  const categoryPath = (categoryId: number | null): number[] => {
    const path: number[] = []
    const seen = new Set<number>()
    let current = categoryId
    while (current != null && !seen.has(current) && path.length < 100) {
      seen.add(current)
      path.push(current)
      current = categoryParent.get(current) ?? null
    }
    return path
  }

  // Debt is removed before any cash/credit right. For a restricted manager
  // barcode, the remaining returned value is still tied to the returned lines;
  // the voucher can only be restored from matching goods. Ordinary ALL-scope
  // barcodes are pooled at invoice level and therefore apply to any returned
  // item, rather than being prorated across invoice lines.
  let debtLeft = debtReduced
  const lineCapacity = returnLines.slice().sort((a, b) => a.saleItemId - b.saleItemId).map((line) => {
    const debtOnLine = Math.min(line.value, debtLeft)
    debtLeft -= debtOnLine
    const variant = variantById.get(line.variantId)
    return {
      ...line,
      remaining: line.value - debtOnLine,
      categoryPath: categoryPath(variant?.product?.categoryId == null
        ? null : Number(variant.product.categoryId))
    }
  })
  if (debtLeft !== 0) throw unknown()

  const priorByRedemption = new Map(priorShares.map((share) => [share.redemptionId, share.amount]))
  const sharesByRedemption = new Map<number, number>()
  const availableByRedemption = new Map<number, number>()
  for (const redemption of redemptions) {
    const prior = priorByRedemption.get(Number(redemption.id))
    const amount = toNumberRial(redemption.amount)
    if (prior == null || prior < 0 || prior > amount) throw unknown()
    availableByRedemption.set(Number(redemption.id), amount - prior)
    sharesByRedemption.set(Number(redemption.id), 0)
  }

  // Restricted manager credits take their share only from matching returned
  // goods (variant or category scope). This is the sole item-specific case.
  const restrictedRedemptions = redemptions.filter((redemption) => {
    const credit = creditById.get(Number(redemption.creditId))
    return credit && normalizeRestrictScope(credit.restrictScope) !== CreditRestrictScope.ALL
  })
  for (const redemption of restrictedRedemptions) {
    const credit = creditById.get(Number(redemption.creditId))
    if (!credit) throw unknown()
    const eligible = lineCapacity.filter((line) => creditMatchesReturnLine(credit, line, line.categoryPath))
    let remainingVoucher = availableByRedemption.get(Number(redemption.id)) ?? 0
    for (const line of eligible) {
      const amount = Math.min(remainingVoucher, line.remaining)
      if (amount <= 0) continue
      line.remaining -= amount
      remainingVoucher -= amount
      sharesByRedemption.set(Number(redemption.id),
        (sharesByRedemption.get(Number(redemption.id)) ?? 0) + amount)
      if (remainingVoucher === 0) break
    }
  }

  const ordinaryRedemptions = redemptions.filter((redemption) => {
    const credit = creditById.get(Number(redemption.creditId))
    return credit && normalizeRestrictScope(credit.restrictScope) === CreditRestrictScope.ALL
  })
  if (ordinaryRedemptions.length) {
    const ordinaryPrior = ordinaryRedemptions.map((redemption) => ({
      redemptionId: Number(redemption.id), amount: priorByRedemption.get(Number(redemption.id)) ?? 0
    }))
    const ordinaryRemaining = ordinaryRedemptions.reduce((sum, redemption) =>
      sum + (availableByRedemption.get(Number(redemption.id)) ?? 0), 0)
    const restrictedAlreadyRestored = restrictedRedemptions.reduce((sum, redemption) =>
      sum + (priorByRedemption.get(Number(redemption.id)) ?? 0), 0)
    const availableReturnValue = lineCapacity.reduce((sum, line) => sum + line.remaining, 0)
    const ordinaryReturning = Math.min(ordinaryRemaining, availableReturnValue)
    const ordinaryPlanInput = {
      fundedPurchase,
      fundedPreviouslyReturned: Math.max(0, fundedPreviouslyReturned - restrictedAlreadyRestored),
      fundedReturning: ordinaryReturning,
      redemptions: ordinaryRedemptions.map((redemption) => ({
        id: Number(redemption.id), amount: toNumberRial(redemption.amount)
      })),
      priorShares: ordinaryPrior
    }
    let ordinaryPlan: ReturnType<typeof allocateCreditReturn>
    try {
      ordinaryPlan = allocateCreditReturn({ ...ordinaryPlanInput, giftFirst: true })
    } catch {
      // Only invoices with a prior return can legitimately carry the old
      // proportional basis. A new invoice must never fall back to that policy.
      if (!input.activeReturns.length) throw unknown()
      try {
        ordinaryPlan = allocateCreditReturn({
          ...ordinaryPlanInput,
          fundedPurchase: Math.min(input.grandTotal, input.paidTotal),
          fundedPreviouslyReturned,
          fundedReturning,
          giftFirst: false
        })
      } catch { throw unknown() }
    }
    for (const share of ordinaryPlan.shares) {
      sharesByRedemption.set(share.redemptionId, share.amount)
      let remaining = share.amount
      for (const line of lineCapacity) {
        const amount = Math.min(remaining, line.remaining)
        if (amount <= 0) continue
        line.remaining -= amount
        remaining -= amount
        if (remaining === 0) break
      }
      if (remaining !== 0) throw unknown()
    }
  }

  const shares = redemptions.map((redemption) => {
    const amount = sharesByRedemption.get(Number(redemption.id)) ?? 0
    return { redemptionId: Number(redemption.id), parentCreditId: Number(redemption.creditId),
      amount, prior: priorByRedemption.get(Number(redemption.id)) ?? 0 }
  })
  const credit = shares.reduce((sum, share) => sum + share.amount, 0)
  if (!Number.isSafeInteger(credit) || credit > fundedReturning) throw unknown()
  return { credit, cash: fundedReturning - credit, fundedReturning, shares }

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
): Promise<{ restored: number; expiredShare: number; reversedOriginal: number; credits: { creditId: number; amount: number; status: string; returnId: number }[] }> {
  // Keep the write primitive safe independently of its planner/caller.
  await assertOrdinaryReturnInvoice(tx, input.invoiceId)
  const credits: { creditId: number; amount: number; status: string; returnId: number }[] = []
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
        invoiceId: input.invoiceId, redemptionIds: [redemption.id], returnId: input.returnId,
        reason: 'برگشت کامل بدون شاخهٔ پیشین؛ حق ریشه فقط یک‌بار به جانشین منتقل می‌شود', userId: input.userId
      })
      if (reversed !== 1) throw stale()
      const successor = await tx.storeCredit.findFirst({
        where: {
          returnId: input.returnId,
          sourceInvoiceId: input.invoiceId,
          source: String(parent.source ?? 'EXCHANGE'),
          amount: BigInt(s.amount),
          status: 'ACTIVE'
        },
        orderBy: { id: 'desc' }
      })
      if (!successor) throw stale()
      // A spent one-shot H1 is replaced by a fresh barcode, but it must not be
      // spendable until the customer actually receives it. Stage the successor
      // like every other controlled credit-return opportunity and surface it
      // through the handoff workflow below.
      const staged = await tx.storeCredit.updateMany({
        where: { id: successor.id, status: 'ACTIVE', usedAmount: 0, usedCount: 0, deletedAt: null },
        data: { status: 'DRAFT' }
      })
      if (staged.count !== 1) throw stale()
      await tx.creditDelivery.create({ data: {
        creditId: successor.id, sourceKind: 'CREDIT_RETURN_OPPORTUNITY', status: 'PENDING_DELIVERY'
      } })
      credit = { ...successor, status: 'DRAFT' }
      credits.push({ creditId: successor.id, amount: s.amount, status: 'PENDING_DELIVERY', returnId: input.returnId })
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
      credits.push({ creditId: credit.id, amount: s.amount + supplementUnspent, status: 'PENDING_DELIVERY', returnId: input.returnId })
    }
    const allocation = await appendCreditReturnAllocation(tx, {
      returnId: input.returnId, invoiceId: input.invoiceId, redemptionId: s.redemptionId,
      parentCreditId: parent.id, rootCreditId: root.id, originNominal: root.nominal,
      amount: s.amount, supplementUnspent, successorCreditId: credit?.id ?? null,
      kind, originalExpiresAt: root.expiresAt
    })
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
