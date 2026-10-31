import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { verifyManagerCorrectionApproval } from './AuthService'
import { issueStoreCredit } from './StoreCreditService'
import { AuditAction } from '@shared/enums'
import { CreditSource, effectiveStatus, isExpiredAt, parseIdList, remainingOf, usesLeftOf } from '@shared/credit'
import { audit } from './AuditService'
import { toNumberRial } from '@shared/money'

const needed = (raw: unknown, label: string, min: number) => {
  const s = String(raw ?? '').trim()
  if (s.length < min || s.length > 300) throw new BusinessError(`${label} باید شاهد/توضیح مشخصی داشته باشد (حداقل ${min} نویسه).`)
  return s
}

/** A lost instrument is *not* evidence that the holder of a matching name is
 * its owner. A named, active manager attests a receipt and physical evidence
 * before an atomic transfer of only its currently valid remainder. The old
 * code remains in history but can no longer be spent. A successor stays DRAFT
 * until separately printed and witnessed at handoff.
 */
export async function managerReplaceLostCredit(input: {
  creditId: number
  receiptNo?: number | null
  receiptRef: string
  witnessRef: string
  reason: string
  approvingManagerId: number
  managerPin: string
  actorUserId?: number | null
}) {
  if (typeof input?.creditId !== 'number' || !Number.isSafeInteger(input.creditId) || input.creditId <= 0)
    throw new BusinessError('شناسهٔ اعتبار گم‌شده معتبر نیست.')
  const receiptRef = needed(input.receiptRef, 'نشانی رسید/پرونده', 8)
  const witnessRef = needed(input.witnessRef, 'شاهدِ بررسی مدیر', 8)
  const reason = needed(input.reason, 'دلیل جایگزینی', 8)
  const approved = await verifyManagerCorrectionApproval({ managerUserId: input.approvingManagerId,
    password: input.managerPin, action: 'جایگزینی کد گم‌شده و انتقال مانده' })

  return prisma.$transaction(async (tx) => {
    const source = await tx.storeCredit.findUnique({ where: { id: input.creditId } })
    if (!source || source.deletedAt != null || source.voidedAt != null)
      throw new BusinessError('کد مبدأ معتبر نیست یا قبلاً تعیین تکلیف شده است؛ مانده‌ای منتقل نشد.')
    if (source.exchangeResidualRightKey != null)
      throw new BusinessError('کد B/N به ماندهٔ زندهٔ دفتر حق وصل است؛ جایگزینی عمومیِ اعتبار آن را از lineage جدا می‌کند. فعلاً پروندهٔ حق را برای جایگزینی متصل به همان rightKey بررسی کنید.')
    if (await tx.creditReplacement.findUnique({ where: { originalCreditId: source.id } }))
      throw new BusinessError('برای این کد قبلاً جانشین ساخته شده است؛ چاپ دوباره یا تحویل همان پرونده را بررسی کنید.')
    const status = effectiveStatus({ status: source.status, expiresAt: source.expiresAt, amount: toNumberRial(source.amount) })
    const amount = remainingOf({ amount: toNumberRial(source.amount), usedAmount: toNumberRial(source.usedAmount), status: source.status })
    if (!['ACTIVE', 'PARTIALLY_USED'].includes(status) || isExpiredAt({ amount: toNumberRial(source.amount), status: source.status, expiresAt: source.expiresAt }) || amount <= 0 ||
        (source.multiUse === true || source.carryRemainder === false) && usesLeftOf({
          amount: toNumberRial(source.amount), status: source.status,
          maxUses: source.maxUses, usedCount: source.usedCount
        }) <= 0)
      throw new BusinessError('این کد ماندهٔ معتبر و خرج‌پذیر ندارد؛ انقضا یا فرصت استفادهٔ ازدست‌رفته احیا نمی‌شود.')
    if (source.sourceInvoiceId != null) {
      const inv = await tx.saleInvoice.findUnique({ where: { id: source.sourceInvoiceId }, select: { receiptNo: true } })
      if (!inv || input.receiptNo !== inv.receiptNo)
        throw new BusinessError('شمارهٔ رسیدِ ارائه‌شده با فاکتور منشأ اعتبار برابر نیست؛ جستجوی نام مدرک مالکیت نیست.')
    }
    // When the source is itself a not-yet-delivered replacement, there is no
    // proof it was lost by the customer; avoid printing a second parallel code.
    const pending = await tx.creditDelivery.findUnique({ where: { creditId: source.id } })
    if (pending?.status === 'PENDING_DELIVERY')
      throw new BusinessError('این جانشین هنوز تحویل نشده است؛ کد تازه صادر نکنید. چاپ/تحویل همان پرونده را پیگیری کنید.')

    const canceled = await tx.storeCredit.updateMany({
      where: { id: source.id, status: source.status, amount: source.amount,
        usedAmount: source.usedAmount, usedCount: source.usedCount, deletedAt: null, voidedAt: null },
      data: { status: 'CANCELED', voidedAt: new Date(), voidedReason: `انتقال ماندهٔ معتبر به جانشین با تأیید مدیر #${approved.userId}` }
    })
    if (canceled.count !== 1) throw new BusinessError('ماندهٔ اعتبار در همین لحظه تغییر کرد؛ هیچ جانشینی صادر نشد. صفحه را تازه کنید.')
    const isReturn = source.source === CreditSource.EXCHANGE && source.returnId != null
    const successor = await issueStoreCredit(tx, {
      amount, source: source.source,
      sourceInvoiceId: source.sourceInvoiceId,
      returnId: source.returnId,
      exchangeInvoiceId: source.exchangeInvoiceId,
      customerId: source.customerId,
      customerName: source.customerName,
      holderCompany: source.holderCompany,
      holderNationalId: source.holderNationalId,
      holderPhone: source.holderPhone,
      holderAddress: source.holderAddress,
      holderAgent: source.holderAgent,
      holderNote: source.holderNote,
      days: source.issuedDays,
      expiresAtExact: source.expiresAt,
      multiUse: isReturn ? true : source.multiUse,
      // The manager cannot turn a gift into a return credit or re-grant unused
      // uses; only the value valid at this instant moves to the successor.
      maxUses: isReturn ? undefined : Math.min(1000, Math.max(1, Number(source.maxUses) - Number(source.usedCount))),
      carryRemainder: source.carryRemainder,
      restrictScope: source.restrictScope,
      restrictCategoryIds: parseIdList(source.restrictCategoryIdsJson),
      restrictVariantIds: parseIdList(source.restrictVariantIdsJson),
      minPurchase: toNumberRial(source.minPurchase),
      maxPerTransaction: toNumberRial(source.maxPerTransaction),
      customerLocked: source.customerLocked,
      length: source.code.length,
      status: 'DRAFT',
      note: `جانشین ماندهٔ معتبر اعتبار #${source.id} با تأیید مدیر #${approved.userId}`,
      userId: input.actorUserId ?? null
    })
    await tx.creditDelivery.create({ data: {
      creditId: successor.id, originCreditId: source.id, sourceKind: 'MANAGER_REPLACEMENT'
    } })
    await tx.creditReplacement.create({ data: {
      originalCreditId: source.id, successorCreditId: successor.id, transferredAmount: amount,
      receiptRef, witnessRef, reason, approvingManagerId: approved.userId,
      actorUserId: input.actorUserId ?? null
    } })
    await audit(tx, {
      action: AuditAction.CREDIT_VOID, entity: 'CreditReplacement', entityId: successor.id,
      userId: approved.userId,
      before: JSON.stringify({ originalCreditId: source.id, amount: toNumberRial(source.amount),
        usedAmount: toNumberRial(source.usedAmount), validRemaining: amount }),
      after: JSON.stringify({ successorCreditId: successor.id, amount, status: 'DRAFT',
        approvingManagerId: approved.userId, receiptRef, witnessRef, reason, credentialRedacted: true }),
      note: `ماندهٔ معتبر ${amount} ریال از اعتبار #${source.id} به جانشین #${successor.id} منتقل شد؛ قبل از تحویل شاهددار قابل مصرف نیست.`
    })
    return { originalCreditId: source.id, successorCreditId: successor.id,
      transferredAmount: amount, deliveryStatus: 'PENDING_DELIVERY' as const }
  })
}
