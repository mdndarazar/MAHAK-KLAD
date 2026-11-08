import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { StoreCreditStatus } from '@shared/enums'
import { toNumberRial } from '@shared/money'
import { adjustStoreCreditLineageUsage, ensureStoreCreditLineage } from './StoreCreditService'

/**
 * Undo the credit side of a return void, atomically with the caller's other
 * void operations. In-place restorations are re-applied to their original
 * barcode; successor barcodes are validated here and canceled by the caller.
 */
export async function reverseReturnCreditRestorations(
  tx: Prisma.TransactionClient,
  input: { returnId: number; creditsIssuedByReturn: any[] }
): Promise<{ amount: number; reopenedRedemptions: number }> {
  const allocations = await tx.creditReturnAllocation.findMany({
    where: { returnId: input.returnId, creditRestored: true, amount: { gt: 0 } }
  })
  if (!allocations.length) return { amount: 0, reopenedRedemptions: 0 }

  const sourceIds = [...new Set((allocations as any[]).map((row) => Number(row.sourceCreditId)))]
  const restoredIds = [...new Set((allocations as any[]).map((row) => Number(row.restoredCreditId ?? 0)))]
  const redemptionIds = [...new Set((allocations as any[]).map((row) => Number(row.redemptionId)))]
  if (restoredIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      sourceIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      redemptionIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new BusinessError(
      `ابطال برگشت ${input.returnId} ممکن نیست: دفتر سهم اعتبار به بارکد بازگشتی وصل نیست؛ ` +
      'برای جلوگیری از زنده‌ماندن اعتبارِ بی‌پشتوانه هیچ تغییری ثبت نشد.'
    )

  const sourceRows = await tx.storeCredit.findMany({ where: { id: { in: sourceIds } } })
  const restoredRows = await tx.storeCredit.findMany({ where: { id: { in: restoredIds } } })
  const redemptionRows = await tx.storeCreditRedemption.findMany({ where: { id: { in: redemptionIds } } })
  const sourceById = new Map((sourceRows as any[]).map((row) => [Number(row.id), row]))
  const restoredById = new Map((restoredRows as any[]).map((row) => [Number(row.id), row]))
  const redemptionById = new Map((redemptionRows as any[]).map((row) => [Number(row.id), row]))
  if (sourceById.size !== sourceIds.length || restoredById.size !== restoredIds.length || redemptionById.size !== redemptionIds.length)
    throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: یکی از بارکدها یا مصرف‌های منشأ پیدا نشد؛ هیچ تغییری ثبت نشد.`)

  const issuedByReturn = new Map((input.creditsIssuedByReturn as any[]).map((row) => [Number(row.id), row]))
  const amountByRestoredCredit = new Map<number, number>()
  const amountBySourceCredit = new Map<number, number>()
  const amountByRedemption = new Map<number, number>()
  const lineageByCredit = new Map<number, number>()
  const lineageAmount = new Map<number, number>()

  for (const allocation of allocations as any[]) {
    const sourceCreditId = Number(allocation.sourceCreditId)
    const restoredCreditId = Number(allocation.restoredCreditId)
    const redemptionId = Number(allocation.redemptionId)
    const amount = toNumberRial(allocation.amount)
    const source = sourceById.get(sourceCreditId)
    const restored = restoredById.get(restoredCreditId)
    const redemption = redemptionById.get(redemptionId)
    if (!source || !restored || !redemption || Number(redemption.creditId) !== sourceCreditId || amount <= 0)
      throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: سهم ثبت‌شده با مصرف اصلی تطبیق ندارد؛ هیچ تغییری ثبت نشد.`)

    const sourceLineage = await ensureStoreCreditLineage(tx as any, source)
    const restoredLineage = await ensureStoreCreditLineage(tx as any, restored)
    if (Number(sourceLineage.lineage.id) !== Number(restoredLineage.lineage.id) ||
        (redemption.lineageId != null && Number(redemption.lineageId) !== Number(sourceLineage.lineage.id)))
      throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: اعتبار برگشتی از lineage منشأ جدا شده است؛ هیچ تغییری ثبت نشد.`)
    lineageByCredit.set(sourceCreditId, Number(sourceLineage.lineage.id))

    if (restoredCreditId !== sourceCreditId) {
      const issued = issuedByReturn.get(restoredCreditId)
      if (!issued || Number(issued.returnId) !== input.returnId)
        throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: جانشین اعتبار #${restoredCreditId} متعلق به همین برگشت نیست؛ هیچ تغییری ثبت نشد.`)
      amountByRestoredCredit.set(restoredCreditId, (amountByRestoredCredit.get(restoredCreditId) ?? 0) + amount)
    } else {
      amountBySourceCredit.set(sourceCreditId, (amountBySourceCredit.get(sourceCreditId) ?? 0) + amount)
    }
    amountByRedemption.set(redemptionId, (amountByRedemption.get(redemptionId) ?? 0) + amount)
    const lineageId = Number(sourceLineage.lineage.id)
    lineageAmount.set(lineageId, (lineageAmount.get(lineageId) ?? 0) + amount)
  }

  for (const [restoredCreditId, restoredAmount] of amountByRestoredCredit) {
    const restored = restoredById.get(restoredCreditId)
    if (toNumberRial(restored?.amount ?? 0) !== restoredAmount)
      throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: مبلغ جانشین #${restoredCreditId} با دفتر سهم برابر نیست.`)
    const used = toNumberRial(restored?.usedAmount ?? 0)
    if (used > 0 || Number(restored?.usedCount ?? 0) > 0)
      throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: جانشین اعتبار #${restoredCreditId} پس از صدور مصرف شده است.`)
  }

  const allAllocations = await tx.creditReturnAllocation.findMany({
    where: { redemptionId: { in: redemptionIds }, creditRestored: true },
    select: { returnId: true, redemptionId: true, amount: true }
  })
  const allReturnIds = [...new Set((allAllocations as any[]).map((row) => Number(row.returnId)))]
  const activeReturns = allReturnIds.length
    ? await tx.saleReturn.findMany({ where: { id: { in: allReturnIds }, voidedAt: null }, select: { id: true } })
    : []
  const activeReturnIds = new Set((activeReturns as any[]).map((row) => Number(row.id)))
  const activeTotalByRedemption = new Map<number, number>()
  const activeOtherByRedemption = new Map<number, number>()
  for (const row of allAllocations as any[]) {
    if (!activeReturnIds.has(Number(row.returnId))) continue
    const id = Number(row.redemptionId)
    const amount = toNumberRial(row.amount)
    activeTotalByRedemption.set(id, (activeTotalByRedemption.get(id) ?? 0) + amount)
    if (Number(row.returnId) !== input.returnId)
      activeOtherByRedemption.set(id, (activeOtherByRedemption.get(id) ?? 0) + amount)
  }

  const reopenByLineage = new Map<number, number>()
  const reopenBySource = new Map<number, number>()
  for (const [redemptionId, voidedAmount] of amountByRedemption) {
    const redemption = redemptionById.get(redemptionId)
    const activeTotal = activeTotalByRedemption.get(redemptionId) ?? 0
    const activeOther = activeOtherByRedemption.get(redemptionId) ?? 0
    const redemptionAmount = toNumberRial(redemption.amount)
    if (activeTotal > redemptionAmount || voidedAmount > activeTotal)
      throw new BusinessError(`ابطال برگشت ${input.returnId} ممکن نیست: جمع سهم‌های مصرف #${redemptionId} ناسازگار است.`)
    if (redemption.reversedAt != null && activeTotal === redemptionAmount && activeOther < redemptionAmount) {
      reopenByLineage.set(Number(redemption.lineageId ?? lineageByCredit.get(Number(redemption.creditId))),
        (reopenByLineage.get(Number(redemption.lineageId ?? lineageByCredit.get(Number(redemption.creditId)))) ?? 0) + 1)
      const sourceCreditId = Number(redemption.creditId)
      if (amountBySourceCredit.has(sourceCreditId))
        reopenBySource.set(sourceCreditId, (reopenBySource.get(sourceCreditId) ?? 0) + 1)
    }
  }

  for (const [sourceCreditId, amount] of amountBySourceCredit) {
    const source = sourceById.get(sourceCreditId)
    const currentUsed = toNumberRial(source.usedAmount ?? 0)
    const nextUsed = currentUsed + amount
    const issuedAmount = toNumberRial(source.amount)
    if (nextUsed > issuedAmount)
      throw new BusinessError(
        `ابطال برگشت ${input.returnId} ممکن نیست: از اعتبار منشأ #${sourceCreditId} بعد از برگشت دوباره استفاده شده است؛ ` +
        'موجودی کافی برای برگرداندن همان سهم ندارد.'
      )
    const nextCount = Math.max(0, Math.round(Number(source.usedCount ?? 0))) + (reopenBySource.get(sourceCreditId) ?? 0)
    const state = String(source.status)
    const preserveClosed = [StoreCreditStatus.EXPIRED, StoreCreditStatus.CANCELED, 'VOIDED', StoreCreditStatus.SUSPENDED].includes(state as any)
    const nextStatus = preserveClosed
      ? state
      : nextUsed >= issuedAmount && nextUsed > 0
        ? StoreCreditStatus.USED
        : nextUsed > 0
          ? StoreCreditStatus.PARTIALLY_USED
          : StoreCreditStatus.ACTIVE
    const changed = await tx.storeCredit.updateMany({
      where: { id: sourceCreditId, status: source.status, usedAmount: source.usedAmount, usedCount: source.usedCount },
      data: { usedAmount: nextUsed, usedCount: nextCount, status: nextStatus }
    })
    if (changed.count !== 1)
      throw new BusinessError(`اعتبار منشأ #${sourceCreditId} هم‌زمان تغییر کرد؛ ابطال برگشت بدون تغییر دوباره بررسی شود.`)
  }

  let reopenedRedemptions = 0
  for (const [redemptionId, voidedAmount] of amountByRedemption) {
    const redemption = redemptionById.get(redemptionId)
    const activeTotal = activeTotalByRedemption.get(redemptionId) ?? 0
    const activeOther = activeOtherByRedemption.get(redemptionId) ?? 0
    const redemptionAmount = toNumberRial(redemption.amount)
    if (redemption.reversedAt != null && activeTotal === redemptionAmount && activeOther < redemptionAmount) {
      const changed = await tx.storeCreditRedemption.updateMany({
        where: { id: redemptionId, reversedAt: { not: null } },
        data: { reversedAt: null, reversedReason: null }
      })
      if (changed.count !== 1)
        throw new BusinessError(`مصرف اعتبار #${redemptionId} هم‌زمان تغییر کرد؛ ابطال برگشت بدون تغییر متوقف شد.`)
      reopenedRedemptions++
    }
  }

  for (const [lineageId, amount] of lineageAmount) {
    await adjustStoreCreditLineageUsage(tx as any, {
      lineageId,
      amountDelta: amount,
      useDelta: reopenByLineage.get(lineageId) ?? 0
    })
  }

  return { amount: [...lineageAmount.values()].reduce((sum, value) => sum + value, 0), reopenedRedemptions }
}
