import { planReturnCreditSources, type ReturnCreditLine } from '@shared/returnCreditPolicy'
import { isExpiredAt } from '@shared/credit'
import { BusinessError } from '../errors'
import type { Prisma } from '@prisma/client'

type FundingBucket =
  | { kind: 'MONEY'; amount: number; sourceKey: string }
  | { kind: 'DEBT'; amount: number; sourceKey: string }
  | {
      kind: 'CREDIT'; amount: number; credit: any; sourceKey: string
      sourceRedemptionId?: number; allocationSaleItemId?: number | null
      pooledOnExchangeInvoice?: boolean
    }

/**
 * Find exactly how much source credit may fund these replacement goods. All-
 * scope credit remains pooled; restricted credit is planned against the actual
 * replacement variants/categories and is capped by eligible line value.
 */
export async function planReplacementSourceCredit(
  tx: Prisma.TransactionClient,
  returnedFunding: FundingBucket[],
  replacements: Array<{ variantId: number; qty: number; unitPrice: number; discount: number; tax: number }>,
  exchangeTotal: number,
  now: Date
): Promise<Extract<FundingBucket, { kind: 'CREDIT' }>[]> {
  const creditBuckets = returnedFunding.filter(
    (bucket): bucket is Extract<FundingBucket, { kind: 'CREDIT' }> => {
      if (bucket.kind !== 'CREDIT' || bucket.amount <= 0) return false
      const status = String(bucket.credit?.status ?? '').toUpperCase()
      return !['EXPIRED', 'CANCELED', 'VOIDED', 'SUSPENDED'].includes(status) && !isExpiredAt(bucket.credit, now)
    }
  )
  if (!creditBuckets.length || exchangeTotal <= 0) return []

  const bySource = new Map<string, { bucket: Extract<FundingBucket, { kind: 'CREDIT' }>; amount: number }>()
  for (const bucket of creditBuckets) {
    const prior = bySource.get(bucket.sourceKey)
    bySource.set(bucket.sourceKey, { bucket, amount: (prior?.amount ?? 0) + bucket.amount })
  }
  const sources = [...bySource.values()]
  const variantIds = [...new Set(replacements.map((line) => Number(line.variantId)))]
  const variants = variantIds.length ? await tx.productVariant.findMany({
    where: { id: { in: variantIds } }, select: { id: true, product: { select: { categoryId: true } } }
  }) : []
  if (variants.length !== variantIds.length)
    throw new BusinessError('یکی از کالاهای جایگزین برای سنجش محدودهٔ اعتبار پیدا نشد؛ هیچ تسویه‌ای ثبت نشد.')
  const variantById = new Map((variants as any[]).map((row) => [Number(row.id), row]))
  const hasCategoryScope = sources.some(({ bucket }) =>
    !bucket.pooledOnExchangeInvoice && String(bucket.credit?.restrictScope ?? 'ALL').toUpperCase() === 'CATEGORY')
  const categories = hasCategoryScope ? await tx.category.findMany({ select: { id: true, parentId: true } }) : []
  const parentById = new Map<number, number | null>((categories as any[]).map((row) =>
    [Number(row.id), row.parentId == null ? null : Number(row.parentId)]))
  const categoryPath = (categoryId: number | null): number[] => {
    const path: number[] = []
    const seen = new Set<number>()
    let current = categoryId
    while (current != null && !seen.has(current) && path.length < 100) {
      seen.add(current)
      path.push(current)
      current = parentById.get(current) ?? null
    }
    return path
  }

  const rawLines = replacements.map((line, index) => {
    const variant = variantById.get(Number(line.variantId))
    const categoryId = variant?.product?.categoryId == null ? null : Number(variant.product.categoryId)
    return {
      saleItemId: index + 1,
      variantId: Number(line.variantId),
      value: Math.max(0, Math.round(Number(line.unitPrice) * Number(line.qty) - Number(line.discount) + Number(line.tax))),
      categoryPath: categoryId == null ? [] : categoryPath(categoryId)
    }
  })
  const rawItemsTotal = rawLines.reduce((sum, line) => sum + line.value, 0)
  const itemBudget = Math.min(Math.max(0, Math.round(exchangeTotal)), rawItemsTotal)
  let lines: ReturnCreditLine[]
  if (rawItemsTotal > 0) {
    const parts = rawLines.map((line) => {
      const exact = itemBudget * line.value / rawItemsTotal
      const floor = Math.floor(exact)
      return { ...line, value: floor, remainder: exact - floor }
    })
    let cents = itemBudget - parts.reduce((sum, line) => sum + line.value, 0)
    for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.saleItemId - b.saleItemId)) {
      if (cents <= 0) break
      part.value++
      cents--
    }
    lines = parts.map(({ remainder: _remainder, ...line }) => line)
  } else {
    lines = []
  }
  // Invoice-level charges can be paid by ALL credit, but are not treated as a
  // restricted product/category line. The synthetic id cannot match a real
  // catalog item and is never persisted as item-level provenance.
  const invoiceLevelValue = Math.max(0, Math.round(exchangeTotal) - itemBudget)
  if (invoiceLevelValue > 0) {
    lines.push({
      saleItemId: lines.length + 1,
      variantId: Number.MAX_SAFE_INTEGER,
      value: invoiceLevelValue,
      categoryPath: []
    })
  }
  if (!lines.length) return []

  const sourceKeyByPlanId = new Map<number, string>()
  const planSources = sources.map(({ bucket, amount }, index) => {
    const redemptionId = index + 1
    sourceKeyByPlanId.set(redemptionId, bucket.sourceKey)
    return {
      redemptionId,
      creditId: Number(bucket.credit.id),
      amount,
      expiresAt: bucket.credit.expiresAt ?? null,
      restrictScope: bucket.pooledOnExchangeInvoice ? 'ALL' : bucket.credit.restrictScope ?? 'ALL',
      restrictVariantIdsJson: bucket.pooledOnExchangeInvoice ? null : bucket.credit.restrictVariantIdsJson ?? null,
      restrictCategoryIdsJson: bucket.pooledOnExchangeInvoice ? null : bucket.credit.restrictCategoryIdsJson ?? null
    }
  })
  let plan
  try {
    plan = planReturnCreditSources({ lines, sources: planSources })
  } catch (error) {
    throw new BusinessError(`محدودهٔ تاریخی اعتبار برای کالای جایگزین قابل اثبات نیست؛ تعویض ثبت نشد. ${String((error as Error)?.message ?? '')}`)
  }
  const bucketBySource = new Map(sources.map(({ bucket }) => [bucket.sourceKey, bucket]))
  return plan.shares.map((share) => {
    const sourceKey = sourceKeyByPlanId.get(share.redemptionId)
    const bucket = sourceKey ? bucketBySource.get(sourceKey) : null
    if (!bucket) throw new BusinessError('منشأ اعتبار قابل‌استفاده روی کالای جایگزین پیدا نشد؛ تعویض ثبت نشد.')
    return { ...bucket, amount: share.amount }
  })
}
