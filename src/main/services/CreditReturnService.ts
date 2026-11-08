import { AuditAction, StoreCreditStatus } from '@shared/enums'
import type { Prisma } from '@prisma/client'
import { isExpiredAt, parseIdList } from '@shared/credit'
import { BusinessError } from '../errors'
import { toNumberRial } from '@shared/money'
import { audit } from './AuditService'
import { adjustStoreCreditLineageUsage, ensureStoreCreditLineage, issueStoreCredit } from './StoreCreditService'
import { categoryAncestryPath, categoryParentMap } from '@shared/categoryAncestry'
import { assertCreditScopeUnchangedSinceRedemption } from './creditScopeHistory'
import {
  planReturnCreditSources,
  type ReturnCreditPlan,
  type ReturnCreditLine,
  type ReturnCreditSource
} from '@shared/returnCreditPolicy'

type CreditReturnTx = Prisma.TransactionClient

export type PlannedCreditReturn = {
  plan: ReturnCreditPlan
  redemptionsById: Map<number, any>
  creditsById: Map<number, any>
  priorByRedemption: Map<number, number>
}

function fail(): never {
  throw new BusinessError('منشأ اعتبار برگشتی قابل تطبیق نیست؛ هیچ تسویه‌ای ثبت نشد. فاکتور و سابقه‌ی اعتبار را بررسی کنید.')
}

/** Load original invoice credit sources and call the single shared return policy. */
export async function planCreditReturn(
  tx: CreditReturnTx,
  input: {
    invoiceId: number
    lines: Array<{ saleItemId: number; variantId: number; value: number }>
    debtReduction: number
    activeReturnIds: number[]
  }
): Promise<PlannedCreditReturn> {
  const redemptions = await tx.storeCreditRedemption.findMany({
    where: { invoiceId: input.invoiceId }, orderBy: [{ id: 'asc' }]
  })
  const ids = [...new Set(redemptions.map((row: any) => Number(row.creditId)))]
  const credits = ids.length ? await tx.storeCredit.findMany({ where: { id: { in: ids } } }) : []
  const creditsById = new Map<number, any>()
  for (const rawCredit of credits as any[]) {
    const { credit, lineage } = await ensureStoreCreditLineage(tx as any, rawCredit)
    creditsById.set(Number(credit.id), credit)
    for (const redemption of redemptions as any[]) {
      if (Number(redemption.creditId) === Number(credit.id) && redemption.lineageId != null &&
          Number(redemption.lineageId) !== Number(lineage.id)) fail()
    }
  }
  const redemptionsById = new Map((redemptions as any[]).map((row) => [Number(row.id), row]))
  const openRedemptions = (redemptions as any[]).filter((row) => row.reversedAt == null)
  if (creditsById.size !== ids.length) fail()
  // The redemption table has no immutable scope snapshot. A later audited scope
  // edit makes the present StoreCredit row insufficient evidence for this return.
  for (const redemption of openRedemptions) {
    await assertCreditScopeUnchangedSinceRedemption(tx, {
      creditId: Number(redemption.creditId),
      redemptionAt: redemption.at
    })
  }

  const priorRows = await tx.creditReturnAllocation.findMany({
    where: { invoiceId: input.invoiceId }, orderBy: [{ id: 'asc' }]
  })
  const priorByRedemption = new Map<number, number>()
  // Allocations are append-only facts: a return void/correction must add an
  // explicit compensating event, never erase prior source history.
  for (const row of priorRows as any[]) {
    const id = Number(row.redemptionId)
    priorByRedemption.set(id, (priorByRedemption.get(id) ?? 0) + toNumberRial(row.amount))
  }

  const scopedSources = openRedemptions.filter((row) => {
    const credit = creditsById.get(Number(row.creditId))
    return credit && String(credit.restrictScope ?? 'ALL').toUpperCase() !== 'ALL'
  })
  const variantIds = [...new Set(input.lines.map((line) => Number(line.variantId)))]
  const variants = scopedSources.length
    ? await tx.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: { id: true, product: { select: { categoryId: true } } }
      })
    : []
  if (scopedSources.length && variants.length !== variantIds.length) fail()
  const variantMap = new Map((variants as any[]).map((variant) => [Number(variant.id), variant]))
  const needsCategoryAncestry = scopedSources.some((row) =>
    String(creditsById.get(Number(row.creditId))?.restrictScope ?? '').toUpperCase() === 'CATEGORY')
  const categories = needsCategoryAncestry
    ? await tx.category.findMany({ select: { id: true, parentId: true } })
    : []
  let parentById = new Map<number, number | null>()
  if (needsCategoryAncestry) {
    try {
      parentById = categoryParentMap(categories as Array<{ id: number; parentId: number | null }>)
    } catch (error) {
      throw new BusinessError(String((error as Error)?.message ?? 'زنجیرهٔ دسته‌ها معتبر نیست؛ محدودهٔ اعتبار قابل بررسی نیست.'))
    }
  }
  const categoryPath = (categoryId: number | null): number[] => {
    if (!needsCategoryAncestry) return []
    try {
      return categoryAncestryPath(categoryId, parentById)
    } catch (error) {
      throw new BusinessError(String((error as Error)?.message ?? 'زنجیرهٔ دسته‌ها معتبر نیست؛ محدودهٔ اعتبار قابل بررسی نیست.'))
    }
  }
  const lines: ReturnCreditLine[] = input.lines.map((line) => {
    const variant = variantMap.get(Number(line.variantId))
    return {
      saleItemId: Number(line.saleItemId),
      variantId: Number(line.variantId),
      value: Number(line.value),
      categoryPath: variant?.product?.categoryId == null
        ? [] : categoryPath(Number(variant.product.categoryId))
    }
  })
  const sources: ReturnCreditSource[] = openRedemptions.map((redemption) => {
    const credit = creditsById.get(Number(redemption.creditId))
    return {
      redemptionId: Number(redemption.id),
      creditId: Number(redemption.creditId),
      amount: toNumberRial(redemption.amount),
      priorAmount: priorByRedemption.get(Number(redemption.id)) ?? 0,
      expiresAt: credit?.expiresAt ?? null,
      restrictScope: credit?.restrictScope ?? 'ALL',
      restrictVariantIdsJson: credit?.restrictVariantIdsJson ?? null,
      restrictCategoryIdsJson: credit?.restrictCategoryIdsJson ?? null
    }
  })
  const plan = planReturnCreditSources({ lines, sources, debtReduction: input.debtReduction })
  for (const source of sources) {
    const prior = source.priorAmount ?? 0
    if (prior > source.amount) fail()
  }
  return { plan, redemptionsById, creditsById, priorByRedemption }
}

/**
 * Apply and persist a planned source return inside the caller's transaction.
 * The append-only allocation ledger is also the cumulative cap for future
 * partial returns; retries cannot restore the same source value twice.
 */
export async function restoreCreditReturnSources(
  tx: CreditReturnTx,
  input: {
    invoiceId: number
    returnId: number
    userId?: number | null
    at: Date
    planned: PlannedCreditReturn
  }
): Promise<{ amount: number; restoredAmount: number; closedExpiredAmount: number; successors: any[]; restoredSources: number }> {
  const shares = input.planned.plan.shares
  const successors: any[] = []
  let amountTotal = 0
  let restoredAmount = 0
  let closedExpiredAmount = 0
  let restoredSources = 0
  const sharesByCredit = new Map<number, typeof shares>()
  const sharesByRedemption = new Map<number, typeof shares>()
  for (const share of shares) {
    const redemption = input.planned.redemptionsById.get(share.redemptionId)
    const credit = input.planned.creditsById.get(share.creditId)
    if (!redemption || !credit || share.amount <= 0) fail()
    sharesByCredit.set(share.creditId, [...(sharesByCredit.get(share.creditId) ?? []), share])
    sharesByRedemption.set(share.redemptionId, [...(sharesByRedemption.get(share.redemptionId) ?? []), share])
    amountTotal += share.amount
  }

  // Apply every live-source mutation once per credit ID. One returned item can
  // split a restricted redemption over several eligible lines; applying those
  // shares independently would re-use the same optimistic snapshot and falsely
  // trip the real concurrent-use guard on the second share.
  const liveRestoredByCredit = new Set<number>()
  for (const [creditId, creditShares] of sharesByCredit) {
    const credit = input.planned.creditsById.get(creditId)
    if (!credit) fail()
    const expired = String(credit.status) === StoreCreditStatus.EXPIRED || isExpiredAt(credit, input.at)
    const status = String(credit.status)
    if (expired || status === StoreCreditStatus.USED || ['CANCELED', 'VOIDED', 'SUSPENDED'].includes(status)) continue

    const restoreAmount = creditShares.reduce((sum, share) => sum + share.amount, 0)
    const previousUsed = toNumberRial(credit.usedAmount)
    if (previousUsed < restoreAmount) fail()
    const fullyRestoredRedemptions = [...new Set(creditShares.map((share) => share.redemptionId))]
      .filter((redemptionId) => {
        const redemption = input.planned.redemptionsById.get(redemptionId)
        if (!redemption) fail()
        const returnedInThisOperation = (sharesByRedemption.get(redemptionId) ?? [])
          .reduce((sum, share) => sum + share.amount, 0)
        const priorForRedemption = input.planned.priorByRedemption.get(redemptionId) ?? 0
        return priorForRedemption + returnedInThisOperation >= toNumberRial(redemption.amount)
      }).length
    const nextUsed = previousUsed - restoreAmount
    const nextCount = Math.max(0, Math.round(Number(credit.usedCount ?? 0)) - fullyRestoredRedemptions)
    const nextStatus = nextUsed === 0 ? StoreCreditStatus.ACTIVE : StoreCreditStatus.PARTIALLY_USED
    const changed = await tx.storeCredit.updateMany({
      where: {
        id: creditId,
        status: credit.status,
        usedAmount: credit.usedAmount,
        usedCount: credit.usedCount
      },
      data: { usedAmount: nextUsed, usedCount: nextCount, status: nextStatus }
    })
    if (changed.count !== 1) fail()
    liveRestoredByCredit.add(creditId)
  }

  const successorByShare = new Map<(typeof shares)[number], any>()
  const lineageUsageById = new Map<number, { amount: number; uses: number }>()
  for (const share of shares) {
    const redemption = input.planned.redemptionsById.get(share.redemptionId)
    const credit = input.planned.creditsById.get(share.creditId)
    if (!redemption || !credit) fail()
    const scope = String(credit.restrictScope ?? 'ALL').toUpperCase()
    const expired = String(credit.status) === StoreCreditStatus.EXPIRED || isExpiredAt(credit, input.at)
    let outcome = expired ? 'EXPIRED_SHARE_CLOSED' : 'SOURCE_RESTORED'

    if (!expired && String(credit.status) === StoreCreditStatus.USED) {
      // Keep one successor per source share, as agreed; never reactivate a USED code.
      const successor = await issueStoreCredit(tx, {
        amount: share.amount,
        source: String(credit.source ?? 'EXCHANGE'),
        lineageId: Number(credit.lineageId ?? credit.id),
        returnId: input.returnId,
        sourceInvoiceId: credit.sourceInvoiceId ?? input.invoiceId,
        customerId: credit.customerId ?? null,
        customerName: credit.customerName ?? null,
        expiresAtExact: credit.expiresAt ?? null,
        length: Math.max(6, String(credit.code ?? '').length),
        maxUses: Math.max(1, Number(credit.maxUses ?? 1)),
        multiUse: credit.multiUse === true,
        carryRemainder: credit.carryRemainder !== false,
        restrictScope: scope,
        restrictCategoryIds: parseIdList(credit.restrictCategoryIdsJson),
        restrictVariantIds: parseIdList(credit.restrictVariantIdsJson),
        minPurchase: toNumberRial(credit.minPurchase ?? 0),
        maxPerTransaction: toNumberRial(credit.maxPerTransaction ?? 0),
        customerLocked: credit.customerLocked === true,
        holderCompany: credit.holderCompany ?? null,
        holderNationalId: credit.holderNationalId ?? null,
        holderPhone: credit.holderPhone ?? null,
        holderAddress: credit.holderAddress ?? null,
        holderAgent: credit.holderAgent ?? null,
        holderNote: credit.holderNote ?? null,
        note: `جانشین سهم برگشتی از بارکد مصرف‌شده #${credit.id} · ${share.amount} ریال`,
        userId: input.userId ?? null,
        issuedAt: input.at
      })
      successors.push(successor)
      successorByShare.set(share, successor)
      outcome = 'USED_SOURCE_SUCCESSOR_ISSUED'
    } else if (!expired && !liveRestoredByCredit.has(share.creditId)) {
      outcome = 'SOURCE_STATUS_PRESERVED'
    }

    const creditRestored = outcome !== 'EXPIRED_SHARE_CLOSED' && outcome !== 'SOURCE_STATUS_PRESERVED'
    if (creditRestored) restoredAmount += share.amount
    if (expired) closedExpiredAmount += share.amount
    const eventKey = `return-credit:v${input.planned.plan.policyVersion}:r${input.returnId}:d${share.redemptionId}:i${share.saleItemId ?? 'POOL'}`
    await tx.creditReturnAllocation.create({ data: {
      eventKey,
      invoiceId: input.invoiceId,
      returnId: input.returnId,
      redemptionId: share.redemptionId,
      sourceCreditId: share.creditId,
      restoredCreditId: creditRestored
        ? Number(successorByShare.get(share)?.id ?? credit.id)
        : null,
      amount: share.amount,
      creditRestored,
      settlementAdjusted: true,
      restrictScope: scope,
      saleItemId: share.saleItemId,
      policyVersion: input.planned.plan.policyVersion,
      createdAt: input.at
    } })
    restoredSources++

    const redemptionShares = sharesByRedemption.get(share.redemptionId) ?? []
    const cumulative = (input.planned.priorByRedemption.get(share.redemptionId) ?? 0) +
      redemptionShares.reduce((sum, row) => sum + row.amount, 0)
    const fullyRestoredUse = cumulative >= toNumberRial(redemption.amount)
    let reversedNow = false
    if (creditRestored && fullyRestoredUse && !redemption.reversedAt) {
      // Multiple item shares can reference one redemption; reverse it exactly once.
      const changed = await tx.storeCreditRedemption.updateMany({
        where: { id: share.redemptionId, reversedAt: null },
        data: { reversedAt: input.at, reversedReason: `برگشت سهم مصرف‌شده در برگشت #${input.returnId}` }
      })
      if (changed.count !== 1) fail()
      redemption.reversedAt = input.at
      reversedNow = true
    }
    if (creditRestored) {
      const lineageId = Number(credit.lineageId ?? credit.id)
      const priorLineageUse = lineageUsageById.get(lineageId) ?? { amount: 0, uses: 0 }
      priorLineageUse.amount += share.amount
      if (reversedNow) priorLineageUse.uses += 1
      lineageUsageById.set(lineageId, priorLineageUse)
    }

    await audit(tx, {
      action: AuditAction.CREDIT_REACTIVATE,
      entity: 'StoreCredit',
      entityId: share.creditId,
      userId: input.userId ?? null,
      after: JSON.stringify({
        returnId: input.returnId,
        redemptionId: share.redemptionId,
        restoredAmount: share.amount,
        expired,
        outcome,
        successorCreditId: successorByShare.get(share)?.id ?? null,
        policyVersion: input.planned.plan.policyVersion,
        scope,
        saleItemId: share.saleItemId
      }),
      note: expired
        ? `سهم ${share.amount} ریالی اعتبار منقضی #${share.creditId} در برگشت #${input.returnId} ثبت شد؛ نه احیا شد و نه به پول تبدیل شد.`
        : outcome === 'SOURCE_STATUS_PRESERVED'
          ? `سهم برگشتی #${share.creditId} ثبت شد اما وضعیت ${credit.status} طبق قاعده حفظ شد؛ سهم به پول تبدیل نشد.`
          : `سهم ${share.amount} ریالی اعتبار #${share.creditId} طبق قانون بازگشت اعتبار در برگشت #${input.returnId} به منشأ خود بازگشت.`
    })
  }

  for (const [lineageId, usage] of lineageUsageById) {
    await adjustStoreCreditLineageUsage(tx as any, {
      lineageId,
      amountDelta: -usage.amount,
      useDelta: -usage.uses
    })
  }

  // A zero-share row is a positive fact: this return was evaluated against the
  // unchanged historical scope, but this redemption did not fund these goods.
  // It lets later returns consume the separate money source without mistaking
  // the unspent restricted credit for provenance that belonged to this item.
  for (const [redemptionId, redemption] of input.planned.redemptionsById) {
    if (sharesByRedemption.has(redemptionId)) continue
    const credit = input.planned.creditsById.get(Number(redemption.creditId))
    if (!credit) fail()
    await tx.creditReturnAllocation.create({ data: {
      eventKey: `return-credit:v${input.planned.plan.policyVersion}:r${input.returnId}:d${redemptionId}:iNO_SHARE`,
      invoiceId: input.invoiceId,
      returnId: input.returnId,
      redemptionId,
      sourceCreditId: Number(credit.id),
      amount: 0,
      creditRestored: false,
      settlementAdjusted: true,
      restrictScope: String(credit.restrictScope ?? 'ALL'),
      saleItemId: null,
      policyVersion: input.planned.plan.policyVersion,
      createdAt: input.at
    } })
  }
  return { amount: amountTotal, restoredAmount, closedExpiredAmount, successors, restoredSources }
}
