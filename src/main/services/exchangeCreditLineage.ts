import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { toNumberRial } from '@shared/money'
import { adjustStoreCreditLineageUsage, ensureStoreCreditLineage } from './StoreCreditService'

type CreditShare = {
  sourceRedemptionId?: number
  credit: any
  amount: number
}

/**
 * Reverse the shared allowance for a source-credit share restored by an
 * exchange return. Allocation rows are inserted by the caller first so this
 * function can reconcile the immutable event ledger (including prior partial
 * returns) before changing the lineage counters.
 */
export async function reverseRestoredExchangeCreditLineage(
  tx: Prisma.TransactionClient,
  input: {
    returnId: number
    at: Date
    shares: CreditShare[]
    restoredCreditIdBySource: Map<number, number | null>
  }
): Promise<void> {
  const successful = input.shares.filter((share) =>
    input.restoredCreditIdBySource.get(Number(share.credit.id)) != null)
  if (!successful.length) return

  const amountsByRedemption = new Map<number, number>()
  const sourceCreditByRedemption = new Map<number, number>()
  for (const share of successful) {
    const redemptionId = Number(share.sourceRedemptionId)
    const creditId = Number(share.credit.id)
    if (!Number.isSafeInteger(redemptionId) || redemptionId <= 0 || !Number.isSafeInteger(creditId) || creditId <= 0 ||
        !Number.isSafeInteger(Number(share.amount)) || Number(share.amount) <= 0)
      throw new BusinessError('سهم اعتبار تعویض شناسه/مبلغ معتبر ندارد؛ lineage تغییر نکرد.')
    const existingCreditId = sourceCreditByRedemption.get(redemptionId)
    if (existingCreditId != null && existingCreditId !== creditId)
      throw new BusinessError('یک مصرف تاریخی به چند اعتبار منشأ متفاوت نسبت داده شده؛ lineage تغییر نکرد.')
    sourceCreditByRedemption.set(redemptionId, creditId)
    amountsByRedemption.set(redemptionId, (amountsByRedemption.get(redemptionId) ?? 0) + Number(share.amount))
  }

  const redemptionIds = [...amountsByRedemption.keys()]
  const redemptions = await tx.storeCreditRedemption.findMany({ where: { id: { in: redemptionIds } } })
  const redemptionById = new Map((redemptions as any[]).map((row) => [Number(row.id), row]))
  if (redemptionById.size !== redemptionIds.length)
    throw new BusinessError('یکی از مصرف‌های تاریخی تعویض پیدا نشد؛ lineage تغییر نکرد.')

  const currentRows = await tx.creditReturnAllocation.findMany({
    where: { returnId: input.returnId, redemptionId: { in: redemptionIds }, creditRestored: true },
    select: { redemptionId: true, sourceCreditId: true, restoredCreditId: true, amount: true }
  })
  const currentLedgerAmount = new Map<number, number>()
  for (const row of currentRows as any[]) {
    const id = Number(row.redemptionId)
    const expectedRestoredId = input.restoredCreditIdBySource.get(Number(row.sourceCreditId))
    if (expectedRestoredId == null || Number(row.restoredCreditId) !== expectedRestoredId)
      throw new BusinessError('بارکد بازگشتی در دفتر تعویض با اعتبار صادرشده تطبیق ندارد؛ lineage تغییر نکرد.')
    currentLedgerAmount.set(id, (currentLedgerAmount.get(id) ?? 0) + toNumberRial(row.amount))
  }
  for (const [id, amount] of amountsByRedemption) {
    if ((currentLedgerAmount.get(id) ?? 0) !== amount)
      throw new BusinessError('دفتر سهم برگشت تعویض با سهم برنامه‌ریزی‌شده برابر نیست؛ lineage تغییر نکرد.')
  }

  const allAllocations = await tx.creditReturnAllocation.findMany({
    where: { redemptionId: { in: redemptionIds }, creditRestored: true },
    select: { returnId: true, redemptionId: true, amount: true }
  })
  const returnIds = [...new Set((allAllocations as any[]).map((row) => Number(row.returnId)))]
  const activeReturns = returnIds.length
    ? await tx.saleReturn.findMany({ where: { id: { in: returnIds }, voidedAt: null }, select: { id: true } })
    : []
  const activeReturnIds = new Set((activeReturns as any[]).map((row) => Number(row.id)))
  const activeAmountByRedemption = new Map<number, number>()
  for (const row of allAllocations as any[]) {
    if (!activeReturnIds.has(Number(row.returnId))) continue
    const id = Number(row.redemptionId)
    activeAmountByRedemption.set(id, (activeAmountByRedemption.get(id) ?? 0) + toNumberRial(row.amount))
  }

  const usageByLineage = new Map<number, { amount: number; uses: number }>()
  const lineageByCredit = new Map<number, number>()
  for (const share of successful) {
    const creditId = Number(share.credit.id)
    if (!lineageByCredit.has(creditId)) {
      const { lineage } = await ensureStoreCreditLineage(tx as any, share.credit)
      lineageByCredit.set(creditId, Number(lineage.id))
    }
    const lineageId = lineageByCredit.get(creditId)!
    const entry = usageByLineage.get(lineageId) ?? { amount: 0, uses: 0 }
    entry.amount += Number(share.amount)
    usageByLineage.set(lineageId, entry)
  }

  for (const [redemptionId, currentAmount] of amountsByRedemption) {
    const redemption = redemptionById.get(redemptionId)
    const creditId = sourceCreditByRedemption.get(redemptionId)!
    if (!redemption || Number(redemption.creditId) !== creditId ||
        (redemption.lineageId != null && Number(redemption.lineageId) !== lineageByCredit.get(creditId)))
      throw new BusinessError('مصرف و lineage اعتبار تعویض هم‌خوان نیست؛ lineage تغییر نکرد.')
    const activeAmount = activeAmountByRedemption.get(redemptionId) ?? 0
    const redemptionAmount = toNumberRial(redemption.amount)
    if (activeAmount > redemptionAmount)
      throw new BusinessError('سهم‌های فعال برگشتی از مصرف اعتبار بیشتر شده‌اند؛ lineage تغییر نکرد.')
    if (redemption.reversedAt != null)
      throw new BusinessError('مصرف تاریخی تعویض قبلاً معکوس شده است؛ برگشت تکراری lineage را تغییر نداد.')
    if (activeAmount === redemptionAmount) {
      const changed = await tx.storeCreditRedemption.updateMany({
        where: { id: redemptionId, reversedAt: null },
        data: { reversedAt: input.at, reversedReason: `برگشت سهم مصرف‌شده در برگشت #${input.returnId}` }
      })
      if (changed.count !== 1)
        throw new BusinessError('مصرف اعتبار هم‌زمان تغییر کرد؛ lineage برگشت تعویض ثبت نشد.')
      const lineageId = lineageByCredit.get(creditId)!
      const entry = usageByLineage.get(lineageId) ?? { amount: currentAmount, uses: 0 }
      entry.uses += 1
      usageByLineage.set(lineageId, entry)
    }
  }

  for (const [lineageId, usage] of usageByLineage) {
    await adjustStoreCreditLineageUsage(tx as any, {
      lineageId,
      amountDelta: -usage.amount,
      useDelta: -usage.uses
    })
  }
}
