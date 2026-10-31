import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { isExpiredAt } from '@shared/credit'
import { auditOrThrow as audit } from './AuditService'
import { toNumberRial } from '@shared/money'

type Client = Prisma.TransactionClient

const blocked = () => new BusinessError(
  'بازگرداندن مانده به همان بارکد اعتبار با منشأ و ماندهٔ فعلی قابل اثبات نیست؛ هیچ تغییری ثبت نشد.'
)

/** Restore only a proven remainder of a multi-use SOURCE_GIFT to its original
 * barcode. The immutable adjustment records the returned share separately from
 * the original redemption/payment history. Caller owns the exchange transaction.
 */
export async function restoreExchangeGiftRemainderToSameBarcode(tx: Client, input: {
  returnId: number
  sourceInvoiceId: number
  sourceEventId: number
  redemptionId: number
  amount: number
  actorUserId?: number | null
}) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw blocked()
  const [ret, sourceEvent, redemption] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: input.returnId }, select: {
      id: true, invoiceId: true, kind: true, exchangeInvoiceId: true, voidedAt: true
    } }),
    tx.exchangeFundingEvent.findUnique({ where: { id: input.sourceEventId } }),
    tx.storeCreditRedemption.findUnique({ where: { id: input.redemptionId } })
  ])
  if (!ret || ret.kind !== 'EXCHANGE' || ret.voidedAt != null ||
      Number(ret.invoiceId) !== input.sourceInvoiceId || ret.exchangeInvoiceId == null ||
      !sourceEvent || sourceEvent.kind !== 'SOURCE_GIFT' ||
      Number(sourceEvent.sourceInvoiceId) !== input.sourceInvoiceId ||
      Number(sourceEvent.sourceCreditId) <= 0 || Number(sourceEvent.sourceRedemptionId) !== input.redemptionId ||
      !redemption || redemption.reversedAt != null || redemption.compensatedAt != null ||
      Number(redemption.id) !== input.redemptionId || Number(redemption.invoiceId) !== input.sourceInvoiceId ||
      Number(redemption.creditId) !== Number(sourceEvent.sourceCreditId) || redemption.expiryCaptured !== true)
    throw blocked()

  const credit = await tx.storeCredit.findUnique({ where: { id: Number(sourceEvent.sourceCreditId) } })
  if (!credit || credit.multiUse !== true || credit.deletedAt != null || credit.voidedAt != null ||
      credit.exchangeResidualRightKey != null || !['ACTIVE', 'PARTIALLY_USED'].includes(String(credit.status)) ||
      Number(redemption.amount) !== Number(sourceEvent.amount) || input.amount > Number(redemption.amount) ||
      new Date(credit.expiresAt ?? 0).getTime() !== new Date(redemption.expiryAtRedeem ?? 0).getTime() ||
      isExpiredAt({ amount: Number(credit.amount), status: String(credit.status), expiresAt: credit.expiresAt }))
    throw blocked()

  const priorBalanceEvents = await tx.storeCreditBalanceAdjustment.findMany({
    where: { redemptionId: input.redemptionId }, select: { id: true, kind: true, reversesEventId: true }
  })
  const reversedRestoreIds = new Set(priorBalanceEvents
    .filter((event) => event.kind === 'EXCHANGE_REMAINDER_RESTORATION_REVERSED' && event.reversesEventId != null)
    .map((event) => Number(event.reversesEventId)))
  const hasOpenOrUnknownAdjustment = priorBalanceEvents.some((event) =>
    event.kind !== 'EXCHANGE_REMAINDER_RESTORED' && event.kind !== 'EXCHANGE_REMAINDER_RESTORATION_REVERSED' ||
    (event.kind === 'EXCHANGE_REMAINDER_RESTORED' && !reversedRestoreIds.has(Number(event.id))))
  if (await tx.creditReturnAllocation.count({ where: { redemptionId: input.redemptionId } }) !== 0 ||
      hasOpenOrUnknownAdjustment)
    throw blocked()

  const beforeUsed = toNumberRial(credit.usedAmount)
  const beforeCount = Number(credit.usedCount)
  const face = toNumberRial(credit.amount)
  const afterUsed = beforeUsed - input.amount
  const maxUses = Number(credit.maxUses)
  if (!Number.isSafeInteger(beforeUsed) || !Number.isSafeInteger(beforeCount) ||
      !Number.isSafeInteger(face) || beforeUsed < input.amount || afterUsed < 0 || afterUsed > face ||
      !Number.isSafeInteger(maxUses) || beforeCount <= 0 || beforeCount >= maxUses)
    throw blocked()

  const afterStatus = afterUsed >= face ? 'USED' : 'PARTIALLY_USED'
  const updated = await tx.storeCredit.updateMany({
    where: { id: credit.id, status: credit.status, usedAmount: credit.usedAmount, usedCount: credit.usedCount,
      deletedAt: null, voidedAt: null },
    data: { usedAmount: BigInt(afterUsed), status: afterStatus }
  })
  if (updated.count !== 1) throw blocked()

  const eventKey = `exchange:${input.returnId}:same-barcode-credit:${credit.id}:restore`
  await tx.storeCreditBalanceAdjustment.create({ data: {
    eventKey, creditId: credit.id, returnId: input.returnId, invoiceId: input.sourceInvoiceId,
    redemptionId: input.redemptionId, amount: BigInt(input.amount), kind: 'EXCHANGE_REMAINDER_RESTORED',
    beforeUsedAmount: BigInt(beforeUsed), afterUsedAmount: BigInt(afterUsed),
    beforeUsedCount: beforeCount, afterUsedCount: beforeCount, actorUserId: input.actorUserId ?? null
  } })
  await audit(tx, {
    action: 'CREDIT_REACTIVATE', entity: 'StoreCredit', entityId: credit.id,
    userId: input.actorUserId ?? null,
    before: JSON.stringify({ usedAmount: beforeUsed, usedCount: beforeCount, status: credit.status }),
    after: JSON.stringify({ usedAmount: afterUsed, usedCount: beforeCount, status: afterStatus,
      restoredAmount: input.amount, returnId: input.returnId, redemptionId: input.redemptionId }),
    note: `ماندهٔ ${input.amount} ریالیِ تعویض به همان بارکد چندبارهٔ #${credit.id} بازگشت؛ بارکد تازه‌ای صادر نشد.`
  })
  return { creditId: Number(credit.id), beforeUsed, usedAmount: afterUsed, balance: face - afterUsed,
    amount: input.amount, status: afterStatus }
}

/** Reverse the same-barcode restoration when its exchange is voided. The
 * returned amount is added back to usedAmount (not paid out or reissued), so
 * subsequent spends remain accounted for. The adjustment pair is append-only.
 */
export async function reverseExchangeGiftRemainderOnVoid(tx: Client, input: {
  returnId: number
  actorUserId?: number | null
}) {
  const restorations = await tx.storeCreditBalanceAdjustment.findMany({
    where: { returnId: input.returnId, kind: 'EXCHANGE_REMAINDER_RESTORED' }, orderBy: { id: 'asc' }
  })
  if (!restorations.length) return 0
  if (restorations.length !== 1) throw blocked()
  const restoration = restorations[0]
  const existingReversal = await tx.storeCreditBalanceAdjustment.findFirst({
    where: { reversesEventId: Number(restoration.id) }
  })
  if (existingReversal) throw blocked()
  const credit = await tx.storeCredit.findUnique({ where: { id: Number(restoration.creditId) } })
  if (!credit || credit.deletedAt != null || credit.voidedAt != null) throw blocked()

  const beforeUsed = toNumberRial(credit.usedAmount)
  const beforeCount = Number(credit.usedCount)
  const face = toNumberRial(credit.amount)
  const amount = toNumberRial(restoration.amount)
  const afterUsed = beforeUsed + amount
  if (!Number.isSafeInteger(beforeUsed) || !Number.isSafeInteger(beforeCount) ||
      !Number.isSafeInteger(face) || !Number.isSafeInteger(amount) || amount <= 0 || afterUsed > face)
    throw new BusinessError('ابطال تعویض ممکن نیست: موجودی همان بارکد برای لغو سهمِ بازگردانده‌شده کافی نیست؛ هیچ تغییری ثبت نشد.')

  const isExpired = isExpiredAt({ amount: face, status: String(credit.status), expiresAt: credit.expiresAt })
  const afterStatus = isExpired ? 'EXPIRED'
    : afterUsed >= face || beforeCount >= Number(credit.maxUses) ? 'USED' : 'PARTIALLY_USED'
  const updated = await tx.storeCredit.updateMany({
    where: { id: credit.id, status: credit.status, usedAmount: credit.usedAmount, usedCount: credit.usedCount,
      deletedAt: null, voidedAt: null },
    data: { usedAmount: BigInt(afterUsed), status: afterStatus }
  })
  if (updated.count !== 1) throw blocked()

  await tx.storeCreditBalanceAdjustment.create({ data: {
    eventKey: `void:${restoration.eventKey}`, creditId: credit.id, returnId: input.returnId,
    invoiceId: Number(restoration.invoiceId), redemptionId: Number(restoration.redemptionId),
    amount: BigInt(amount), kind: 'EXCHANGE_REMAINDER_RESTORATION_REVERSED',
    beforeUsedAmount: BigInt(beforeUsed), afterUsedAmount: BigInt(afterUsed),
    beforeUsedCount: beforeCount, afterUsedCount: beforeCount,
    reversesEventId: Number(restoration.id), actorUserId: input.actorUserId ?? null
  } })
  await audit(tx, {
    action: 'CREDIT_REACTIVATE', entity: 'StoreCredit', entityId: credit.id,
    userId: input.actorUserId ?? null,
    before: JSON.stringify({ usedAmount: beforeUsed, usedCount: beforeCount, status: credit.status }),
    after: JSON.stringify({ usedAmount: afterUsed, usedCount: beforeCount, status: afterStatus,
      reversedRestoration: amount, returnId: input.returnId, adjustmentId: restoration.id }),
    note: `ابطال تعویض ${input.returnId} سهم ${amount} ریالیِ بازگردانده‌شده به همان بارکد #${credit.id} را لغو کرد.`
  })
  return amount
}
