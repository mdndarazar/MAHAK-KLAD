import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { CHEQUE_METHOD_KEY } from '@shared/enums'
import { allocateExchangeFundingByLine } from '@shared/exchangeFundingAllocation'
import { allocateExchangeFundingLineReturn, type ExchangeReturnSourceKind } from '@shared/exchangeFundingLineReturn'
import { allocateLineNet } from '@shared/returnValue'
import { toNumberRial } from '@shared/money'

type LedgerClient = Prisma.TransactionClient | {
  exchangeFundingEvent: any
  exchangeFundingLineAllocation: any
  exchangeFundingReturnLineAllocation: any
  saleInvoice: any
  saleInvoiceItem: any
  payment: any
  paymentChequeStatusHistory?: any
  storeCreditRedemption: any
  storeCredit: any
  saleReturn: any
  saleReturnItem: any
  exchangeResidualRightEvent?: any
  creditDelivery?: any
}

type FundingEventInput = {
  eventKey: string
  kind: string
  amount: number
  shareId: string
  rootShareId: string
  sourceInvoiceId?: number | null
  childInvoiceId?: number | null
  returnId?: number | null
  relatedReturnId?: number | null
  sourcePaymentId?: number | null
  sourceRedemptionId?: number | null
  sourceCreditId?: number | null
  parentEventId?: number | null
  debtId?: number | null
  sourceMethodKind?: string | null
  sourceDestination?: string | null
  evidenceKind?: string
  evidenceRef?: string | null
  actorUserId?: number | null
  reversesEventId?: number | null
}

const invalid = () => new BusinessError('رویداد منشأ مالی معتبر نیست؛ هیچ انتقالی ثبت نشد.')
const mismatch = () => new BusinessError('کلید عملیات قبلی با دادهٔ این درخواست سازگار نیست؛ هیچ رویداد تازه‌ای ثبت نشد.')
const insufficient = () => new BusinessError('ماندهٔ سهم اثبات‌شده برای این انتقال کافی نیست؛ هیچ انتقالی ثبت نشد.')
const SNAPSHOT_STATE_KINDS = new Set(['SNAPSHOT_STALE', 'SNAPSHOT_RECONCILED'])

async function isExchangeChildInvoiceWithLineage(tx: LedgerClient, invoice: any): Promise<boolean> {
  if (!invoice) return false
  if (invoice.orderType === 'EXCHANGE' || invoice.sourceInvoiceId != null || invoice.exchangeReturnId != null)
    return true
  const invoiceId = Number(invoice.id)
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) return false
  // A stale/corrupted invoice can lose all child-side markers. Its parent's
  // exchangeInvoiceId remains durable evidence and is enough to disallow the
  // ordinary-sale funding reader and snapshot writer.
  return !!(await tx.saleReturn.findFirst({ where: { exchangeInvoiceId: invoiceId }, select: { id: true } }))
}

const nullableNumber = (value: unknown) => value == null ? null : Number(value)
const normalized = (row: any) => ({
  eventKey: String(row.eventKey), kind: String(row.kind), amount: toNumberRial(row.amount),
  shareId: String(row.shareId), rootShareId: String(row.rootShareId),
  sourceInvoiceId: nullableNumber(row.sourceInvoiceId), childInvoiceId: nullableNumber(row.childInvoiceId),
  returnId: nullableNumber(row.returnId), relatedReturnId: nullableNumber(row.relatedReturnId),
  sourcePaymentId: nullableNumber(row.sourcePaymentId),
  sourceRedemptionId: nullableNumber(row.sourceRedemptionId), sourceCreditId: nullableNumber(row.sourceCreditId),
  parentEventId: nullableNumber(row.parentEventId), debtId: nullableNumber(row.debtId),
  sourceMethodKind: row.sourceMethodKind == null ? null : String(row.sourceMethodKind),
  sourceDestination: row.sourceDestination == null ? null : String(row.sourceDestination),
  evidenceKind: String(row.evidenceKind ?? 'SYSTEM'), evidenceRef: row.evidenceRef == null ? null : String(row.evidenceRef),
  actorUserId: nullableNumber(row.actorUserId), reversesEventId: nullableNumber(row.reversesEventId)
})

function prepare(input: FundingEventInput) {
  const isSnapshotState = !!input && SNAPSHOT_STATE_KINDS.has(String(input.kind))
  if (!input || typeof input.eventKey !== 'string' || input.eventKey.trim().length < 8 || input.eventKey.length > 240 ||
      typeof input.kind !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.kind) ||
      !Number.isSafeInteger(input.amount) || (isSnapshotState ? input.amount !== 0 : input.amount === 0) ||
      typeof input.shareId !== 'string' || !input.shareId.trim() || input.shareId.length > 200 ||
      typeof input.rootShareId !== 'string' || !input.rootShareId.trim() || input.rootShareId.length > 200)
    throw invalid()
  const ids = [input.sourceInvoiceId, input.childInvoiceId, input.returnId, input.relatedReturnId, input.sourcePaymentId,
    input.sourceRedemptionId, input.sourceCreditId, input.parentEventId, input.debtId,
    input.actorUserId, input.reversesEventId]
  if (!ids.every((value) => value == null || (Number.isSafeInteger(value) && value > 0))) throw invalid()
  if (isSnapshotState && (input.sourceInvoiceId == null || input.childInvoiceId != null || input.returnId != null ||
      input.relatedReturnId != null || input.sourcePaymentId != null || input.sourceRedemptionId != null || input.sourceCreditId != null ||
      input.parentEventId != null || input.debtId != null || input.reversesEventId != null ||
      input.shareId !== `snapshot:${input.sourceInvoiceId}` || input.rootShareId !== `snapshot:${input.sourceInvoiceId}`))
    throw invalid()
  if (input.evidenceKind != null && (typeof input.evidenceKind !== 'string' || input.evidenceKind.length > 80)) throw invalid()
  if (input.evidenceRef != null && (typeof input.evidenceRef !== 'string' || input.evidenceRef.length > 500)) throw invalid()
  return {
    eventKey: input.eventKey.trim(), kind: input.kind, amount: BigInt(input.amount),
    shareId: input.shareId.trim(), rootShareId: input.rootShareId.trim(),
    sourceInvoiceId: input.sourceInvoiceId ?? null, childInvoiceId: input.childInvoiceId ?? null,
    returnId: input.returnId ?? null, relatedReturnId: input.relatedReturnId ?? null,
    sourcePaymentId: input.sourcePaymentId ?? null,
    sourceRedemptionId: input.sourceRedemptionId ?? null, sourceCreditId: input.sourceCreditId ?? null,
    parentEventId: input.parentEventId ?? null, debtId: input.debtId ?? null,
    sourceMethodKind: input.sourceMethodKind ?? null, sourceDestination: input.sourceDestination ?? null,
    evidenceKind: input.evidenceKind ?? 'SYSTEM', evidenceRef: input.evidenceRef ?? null,
    actorUserId: input.actorUserId ?? null, reversesEventId: input.reversesEventId ?? null
  }
}

function sameEvent(row: any, data: ReturnType<typeof prepare>) {
  const actual = normalized(row)
  return actual.eventKey === data.eventKey && actual.kind === data.kind && actual.amount === Number(data.amount) &&
    actual.shareId === data.shareId && actual.rootShareId === data.rootShareId &&
    actual.sourceInvoiceId === data.sourceInvoiceId && actual.childInvoiceId === data.childInvoiceId &&
    actual.returnId === data.returnId && actual.relatedReturnId === data.relatedReturnId &&
    actual.sourcePaymentId === data.sourcePaymentId &&
    actual.sourceRedemptionId === data.sourceRedemptionId && actual.sourceCreditId === data.sourceCreditId &&
    actual.parentEventId === data.parentEventId && actual.debtId === data.debtId &&
    actual.sourceMethodKind === data.sourceMethodKind && actual.sourceDestination === data.sourceDestination &&
    actual.evidenceKind === data.evidenceKind && actual.evidenceRef === data.evidenceRef &&
    actual.actorUserId === data.actorUserId && actual.reversesEventId === data.reversesEventId
}

/** Append a provenance event inside the caller's transaction. */
export async function appendExchangeFundingEvent(tx: LedgerClient, input: FundingEventInput) {
  const data = prepare(input)
  const prior = await tx.exchangeFundingEvent.findUnique({ where: { eventKey: data.eventKey } })
  if (prior) {
    if (!sameEvent(prior, data)) throw mismatch()
    return { event: prior, replayed: true }
  }
  if (data.reversesEventId != null) {
    const source = await tx.exchangeFundingEvent.findUnique({ where: { id: data.reversesEventId } })
    if (!source || source.reversesEventId != null || toNumberRial(source.amount) !== -Number(data.amount) ||
        source.shareId !== data.shareId || source.rootShareId !== data.rootShareId || !data.kind.startsWith('VOID_'))
      throw invalid()
  }
  const event = await tx.exchangeFundingEvent.create({ data })
  return { event, replayed: false }
}

/** Signed running balance for one immutable source share. */
export async function exchangeFundingBalance(tx: LedgerClient, shareId: string): Promise<number> {
  if (typeof shareId !== 'string' || !shareId.trim() || shareId.length > 200) throw invalid()
  const total = await tx.exchangeFundingEvent.aggregate({
    where: { shareId: shareId.trim() }, _sum: { amount: true }
  })
  return toNumberRial(total?._sum?.amount ?? 0)
}

async function latestFundingSnapshotState(tx: LedgerClient, invoiceId: number) {
  return tx.exchangeFundingEvent.findFirst({
    where: {
      sourceInvoiceId: invoiceId,
      shareId: `snapshot:${invoiceId}`,
      kind: { in: [...SNAPSHOT_STATE_KINDS] }
    },
    orderBy: { id: 'desc' },
    select: { id: true, kind: true }
  })
}

async function appendFundingSnapshotState(
  tx: LedgerClient,
  invoiceId: number,
  revision: number,
  state: 'STALE' | 'RECONCILED'
) {
  const kind = state === 'STALE' ? 'SNAPSHOT_STALE' : 'SNAPSHOT_RECONCILED'
  return appendExchangeFundingEvent(tx, {
    eventKey: `sale:${invoiceId}:funding-state:${state.toLowerCase()}:r${revision}`,
    kind,
    amount: 0,
    shareId: `snapshot:${invoiceId}`,
    rootShareId: `snapshot:${invoiceId}`,
    sourceInvoiceId: invoiceId,
    evidenceKind: state === 'STALE' ? 'ACTIVE_RETURN_REQUIRES_WITNESSED_CORRECTION' : 'PAYMENT_SNAPSHOT_REVISION',
    evidenceRef: `sale:${invoiceId}:r${revision}`
  })
}

async function fundingSnapshotRequiresCorrection(tx: LedgerClient, invoiceId: number): Promise<boolean> {
  const state = await latestFundingSnapshotState(tx, invoiceId)
  return state?.kind === 'SNAPSHOT_STALE'
}

// Every transferable source kind has a tender-specific proof path. SOURCE_N
// means a committed, delivered residual-right credit, never today's cash.
const PROVEN_SOURCE_KINDS = new Set(['SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE', 'SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B'])

const sameNullableId = (left: unknown, right: unknown) =>
  (left == null ? null : Number(left)) === (right == null ? null : Number(right))

function dateMillis(value: unknown): number | null {
  if (value == null) return null
  const time = value instanceof Date ? value.getTime() : new Date(value as any).getTime()
  return Number.isFinite(time) ? time : Number.NaN
}

async function eventHasReversal(tx: LedgerClient, eventId: number): Promise<boolean> {
  return !!(await tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: eventId }, select: { id: true } }))
}

async function latestSaleFundingRevision(tx: LedgerClient, invoiceId: number): Promise<number> {
  const rows = await tx.exchangeFundingEvent.findMany({
    where: { sourceInvoiceId: invoiceId }, select: { eventKey: true }
  })
  const pattern = new RegExp(`^sale:${invoiceId}:r(\\d+):`)
  return rows.reduce((max: number, row: any) => {
    const match = pattern.exec(String(row.eventKey))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
}

async function hasReturnedResidualRightPayment(tx: LedgerClient, input: {
  invoiceId: number; paymentId: number; creditId: number; sourceEventId: number; amount: number; rightKind: 'N' | 'B'
}): Promise<boolean> {
  const credit = await tx.storeCredit.findUnique({ where: { id: input.creditId }, select: {
    exchangeResidualRightKey: true, voidedAt: true, deletedAt: true
  } })
  const rightKey = String(credit?.exchangeResidualRightKey ?? '')
  const opening = rightKey ? await tx.exchangeResidualRightEvent.findFirst({ where: { rightKey, eventKind: 'OPENED' } }) : null
  if (!rightKey || credit?.voidedAt != null || credit?.deletedAt != null || opening?.rightKind !== input.rightKind) return false
  const outs = await tx.exchangeFundingEvent.findMany({ where: {
    parentEventId: input.sourceEventId, kind: 'RETURN_TRANSFER_OUT', reversesEventId: null
  } }) as any[]
  for (const out of outs) {
    if (Math.abs(toNumberRial(out.amount)) !== input.amount ||
        Number(out.childInvoiceId) !== input.invoiceId || out.evidenceKind !== 'EXCHANGE_CHILD_RETURN') continue
    const into = await tx.exchangeFundingEvent.findUnique({
      where: { eventKey: `${String(out.eventKey).slice(0, -4)}:in` }
    })
    const matchedOut = into ? await matchingReturnTransferOutForIn(tx, into) : null
    if (!into || Number(into.relatedReturnId) <= 0 ||
        Number(into.parentEventId) !== input.sourceEventId || Number(matchedOut?.id) !== Number(out.id)) continue
    const [ret, allocations, restorations] = await Promise.all([
      tx.saleReturn.findUnique({ where: { id: Number(into.relatedReturnId) } }),
      tx.exchangeFundingReturnLineAllocation.findMany({ where: {
        returnId: Number(into.relatedReturnId), sourceEventId: input.sourceEventId,
        eventKind: 'ALLOCATION'
      } }),
      tx.exchangeResidualRightEvent.findMany({ where: {
        rightKey, relatedReturnId: Number(into.relatedReturnId), relatedPaymentId: input.paymentId,
        eventKind: 'RESTORED'
      } })
    ])
    if (!ret || ret.kind !== 'RETURN' || ret.voidedAt != null || Number(ret.invoiceId) !== input.invoiceId ||
        !(allocations as any[]).some((row) => Math.abs(toNumberRial(row.amountDelta)) === input.amount) ||
        !(restorations as any[]).some((row) => toNumberRial(row.amount) === input.amount)) continue
    return true
  }
  return false
}

async function hasPersistedBRightPayment(tx: LedgerClient, input: {
  invoiceId: number; paymentId: number; creditId: number; redemptionId: number; amount: number;
  rootShareId: string; allowExpiredForReturnAttribution?: boolean
}): Promise<boolean> {
  if (!tx.exchangeResidualRightEvent || !tx.creditDelivery) return false
  const [credit, redemption, delivery] = await Promise.all([
    tx.storeCredit.findUnique({ where: { id: input.creditId } }),
    tx.storeCreditRedemption.findUnique({ where: { id: input.redemptionId } }),
    tx.creditDelivery.findUnique({ where: { creditId: input.creditId } })
  ])
  const rightKey = String(credit?.exchangeResidualRightKey ?? '')
  if (!rightKey || credit?.voidedAt != null || credit?.deletedAt != null ||
      credit?.source !== 'EXCHANGE' || delivery?.status !== 'DELIVERED' ||
      Number(redemption?.creditId) !== input.creditId || Number(redemption?.invoiceId) !== input.invoiceId ||
      Number(redemption?.paymentId) !== input.paymentId || redemption?.reversedAt != null ||
      redemption?.compensatedAt != null || redemption?.expiryCaptured !== true ||
      toNumberRial(redemption.amount) !== input.amount ||
      !['USED', 'PARTIALLY_USED', 'EXPIRED'].includes(String(credit.status))) return false
  const events = await tx.exchangeResidualRightEvent.findMany({ where: { rightKey }, orderBy: { id: 'asc' } }) as any[]
  const opening = events.find((row) => row.eventKind === 'OPENED')
  const openingExpiry = dateMillis(opening?.expiresAt)
  const creditExpiry = dateMillis(credit.expiresAt)
  const redeemedExpiry = dateMillis(redemption.expiryAtRedeem)
  const redeemedAt = dateMillis(redemption.at)
  const expiredNow = openingExpiry != null && Number.isFinite(openingExpiry) && openingExpiry <= Date.now()
  const commits = events.filter((row) => row.eventKind === 'COMMITTED' &&
    Number(row.relatedPaymentId) === input.paymentId)
  return !!opening && opening.rightKind === 'B' && opening.rootShareId === input.rootShareId &&
    openingExpiry != null && openingExpiry === creditExpiry && openingExpiry === redeemedExpiry &&
    redeemedAt != null && Number.isFinite(redeemedAt) && redeemedAt < openingExpiry &&
    (!expiredNow || input.allowExpiredForReturnAttribution === true) &&
    commits.reduce((sum, row) => sum + toNumberRial(row.amount), 0) >= input.amount &&
    commits.some((row) => toNumberRial(row.amount) === input.amount && Number(row.relatedInvoiceId) === input.invoiceId)
}

async function hasPersistedNRightPayment(tx: LedgerClient, input: {
  invoiceId: number; paymentId: number; creditId: number; redemptionId: number; amount: number; rootShareId: string
}): Promise<boolean> {
  if (!tx.exchangeResidualRightEvent || !tx.creditDelivery) return false
  const [credit, redemption, delivery] = await Promise.all([
    tx.storeCredit.findUnique({ where: { id: input.creditId } }),
    tx.storeCreditRedemption.findUnique({ where: { id: input.redemptionId } }),
    tx.creditDelivery.findUnique({ where: { creditId: input.creditId } })
  ])
  const rightKey = String(credit?.exchangeResidualRightKey ?? '')
  if (!rightKey || credit?.voidedAt != null || credit?.deletedAt != null ||
      credit?.source !== 'EXCHANGE' || delivery?.status !== 'DELIVERED' ||
      Number(redemption?.creditId) !== input.creditId || Number(redemption?.invoiceId) !== input.invoiceId ||
      Number(redemption?.paymentId) !== input.paymentId || redemption?.reversedAt != null ||
      redemption?.compensatedAt != null || toNumberRial(redemption.amount) !== input.amount ||
      String(credit.status) !== 'USED' && String(credit.status) !== 'PARTIALLY_USED' && String(credit.status) !== 'EXPIRED')
    return false
  const events = await tx.exchangeResidualRightEvent.findMany({ where: { rightKey }, orderBy: { id: 'asc' } }) as any[]
  const opening = events.find((row) => row.eventKind === 'OPENED')
  const committed = events.filter((row) => row.eventKind === 'COMMITTED' &&
    Number(row.relatedPaymentId) === input.paymentId)
  return !!opening && opening.rightKind === 'N' && opening.rootShareId === input.rootShareId &&
    committed.reduce((sum, row) => sum + toNumberRial(row.amount), 0) >= input.amount &&
    committed.some((row) => toNumberRial(row.amount) === input.amount && Number(row.relatedInvoiceId) === input.invoiceId)
}

async function hasPersistedSourcePayment(
  tx: LedgerClient,
  event: any,
  options: { allowExpiredGiftForReturnAttribution?: boolean; allowReturnedResidualRight?: boolean } = {}
): Promise<boolean> {
  const invoiceId = Number(event?.sourceInvoiceId)
  const paymentId = Number(event?.sourcePaymentId)
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || !Number.isSafeInteger(paymentId) || paymentId <= 0 ||
      event.evidenceKind !== 'PAYMENT_ROW' || event.evidenceRef !== `Payment:${paymentId}` ||
      toNumberRial(event.amount) <= 0)
    return false

  const revisionMatch = new RegExp(`^sale:${invoiceId}:r(\\d+):payment:${paymentId}:funded$`)
    .exec(String(event.eventKey))
  if (!revisionMatch) return false
  const revision = Number(revisionMatch[1])
  if (!Number.isSafeInteger(revision) || revision <= 0 ||
      await latestSaleFundingRevision(tx, invoiceId) !== revision)
    return false

  const [invoice, payment] = await Promise.all([
    tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: { id: true, voidedAt: true, status: true } }),
    tx.payment.findUnique({ where: { id: paymentId }, select: {
      id: true, invoiceId: true, amount: true, kind: true, chequeStatus: true,
      storeCreditId: true, destination: true, voidedAt: true, method: { select: { kind: true } }
    } })
  ])
  if (!invoice || invoice.voidedAt != null || ['DRAFT', 'CANCELED'].includes(String(invoice.status)) ||
      !payment || Number(payment.invoiceId) !== invoiceId || payment.voidedAt != null)
    return false

  const methodKind = String(payment.method?.kind ?? '').toUpperCase()
  const entryKind = String(payment.kind ?? 'CASH').toUpperCase()
  const paymentAmount = toNumberRial(payment.amount)
  const sourceAmount = toNumberRial(event.amount)
  const overpayKey = `sale:${invoiceId}:r${revision}:payment:${paymentId}:overpay`
  const overpay = await tx.exchangeFundingEvent.findUnique({ where: { eventKey: overpayKey } })
  let overpayAmount = 0
  if (overpay) {
    if (overpay.kind !== 'SOURCE_OVERPAY' || Number(overpay.sourceInvoiceId) !== invoiceId ||
        Number(overpay.sourcePaymentId) !== paymentId || toNumberRial(overpay.amount) <= 0 ||
        overpay.shareId !== `overpay:${paymentId}` || overpay.rootShareId !== `payment:${paymentId}` ||
        overpay.evidenceKind !== 'PAYMENT_ROW_EXCESS' || overpay.evidenceRef !== `Payment:${paymentId}` ||
        String(overpay.sourceMethodKind ?? '').toUpperCase() !== methodKind ||
        (overpay.sourceDestination == null ? null : String(overpay.sourceDestination)) !==
          (payment.destination == null ? null : String(payment.destination)) ||
        await eventHasReversal(tx, Number(overpay.id)))
      return false
    overpayAmount = toNumberRial(overpay.amount)
  }
  // The immutable snapshot must account for the entire saved Payment row,
  // including its separately quarantined excess, not just a still-positive bit.
  if (BigInt(sourceAmount) + BigInt(overpayAmount) !== BigInt(paymentAmount) || paymentAmount <= 0 ||
      String(event.sourceMethodKind ?? '').toUpperCase() !== methodKind ||
      (event.sourceDestination == null ? null : String(event.sourceDestination)) !==
        (payment.destination == null ? null : String(payment.destination)))
    return false

  if (event.kind === 'SOURCE_GIFT') {
    const creditId = Number(event.sourceCreditId)
    const redemptionId = Number(event.sourceRedemptionId)
    if (!Number.isSafeInteger(creditId) || creditId <= 0 || !Number.isSafeInteger(redemptionId) || redemptionId <= 0 ||
        payment.storeCreditId == null || Number(payment.storeCreditId) !== creditId || methodKind !== 'STORE_CREDIT' ||
        entryKind !== 'CASH' || event.shareId !== `redemption:${redemptionId}` || event.rootShareId !== `credit:${creditId}`)
      return false
    const activeRedemptions = await tx.storeCreditRedemption.findMany({
      where: { invoiceId, paymentId, reversedAt: null },
      select: { id: true, creditId: true, amount: true, compensatedAt: true, expiryCaptured: true, expiryAtRedeem: true, at: true }
    })
    if (activeRedemptions.length !== 1) return false
    const redemption = activeRedemptions[0]
    if (Number(redemption.id) !== redemptionId || Number(redemption.creditId) !== creditId ||
        toNumberRial(redemption.amount) !== paymentAmount || redemption.compensatedAt != null ||
        redemption.expiryCaptured !== true)
      return false
    const credit = await tx.storeCredit.findUnique({ where: { id: creditId }, select: {
      id: true, amount: true, usedAmount: true, status: true, expiresAt: true, voidedAt: true, deletedAt: true
    } })
    const capturedExpiry = dateMillis(redemption.expiryAtRedeem)
    const currentExpiry = dateMillis(credit?.expiresAt)
    const redeemedAt = dateMillis(redemption.at)
    const allowExpiredGiftForReturnAttribution = options.allowExpiredGiftForReturnAttribution === true
    const expiredNow = capturedExpiry != null && Number.isFinite(capturedExpiry) && capturedExpiry <= Date.now()
    const status = String(credit?.status ?? '')
    const statusProven = ['USED', 'PARTIALLY_USED'].includes(status) ||
      (allowExpiredGiftForReturnAttribution && expiredNow && status === 'EXPIRED')
    if (!credit || credit.voidedAt != null || credit.deletedAt != null || !statusProven ||
        toNumberRial(credit.usedAmount) < paymentAmount || toNumberRial(credit.amount) < toNumberRial(credit.usedAmount) ||
        capturedExpiry !== currentExpiry ||
        (capturedExpiry != null && (!Number.isFinite(capturedExpiry) || redeemedAt == null ||
          !Number.isFinite(redeemedAt) || redeemedAt >= capturedExpiry)) ||
        (expiredNow && !allowExpiredGiftForReturnAttribution))
      return false
    return true
  }

  if (event.kind === 'SOURCE_N') {
    const creditId = Number(event.sourceCreditId)
    const redemptionId = Number(event.sourceRedemptionId)
    if (!Number.isSafeInteger(creditId) || creditId <= 0 || !Number.isSafeInteger(redemptionId) || redemptionId <= 0 ||
        payment.storeCreditId == null || Number(payment.storeCreditId) !== creditId || methodKind !== 'STORE_CREDIT' ||
        entryKind !== 'CASH' || event.shareId !== `redemption:${redemptionId}`) return false
    const persisted = await hasPersistedNRightPayment(tx, { invoiceId, paymentId, creditId, redemptionId,
      amount: paymentAmount, rootShareId: String(event.rootShareId) })
    if (!persisted && !(options.allowReturnedResidualRight && await hasReturnedResidualRightPayment(tx, {
      invoiceId, paymentId, creditId, sourceEventId: Number(event.id), amount: sourceAmount, rightKind: 'N'
    }))) return false
    return true
  }

  if (event.kind === 'SOURCE_B') {
    const creditId = Number(event.sourceCreditId)
    const redemptionId = Number(event.sourceRedemptionId)
    if (!Number.isSafeInteger(creditId) || creditId <= 0 || !Number.isSafeInteger(redemptionId) || redemptionId <= 0 ||
        payment.storeCreditId == null || Number(payment.storeCreditId) !== creditId || methodKind !== 'STORE_CREDIT' ||
        entryKind !== 'CASH' || event.shareId !== `redemption:${redemptionId}`) return false
    const proof = await hasPersistedBRightPayment(tx, { invoiceId, paymentId, creditId, redemptionId,
      amount: paymentAmount, rootShareId: String(event.rootShareId),
      allowExpiredForReturnAttribution: options.allowExpiredGiftForReturnAttribution === true })
    if (!proof && !(options.allowReturnedResidualRight && await hasReturnedResidualRightPayment(tx, {
      invoiceId, paymentId, creditId, sourceEventId: Number(event.id), amount: sourceAmount, rightKind: 'B'
    }))) return false
    return true
  }

  if (event.sourceCreditId != null || event.sourceRedemptionId != null || payment.storeCreditId != null ||
      event.shareId !== `payment:${paymentId}` || event.rootShareId !== `payment:${paymentId}`)
    return false
  if (event.kind === 'SOURCE_CASH') return entryKind === 'CASH' && methodKind === 'CASH'
  if (event.kind === 'SOURCE_CARD') return entryKind === 'CASH' && methodKind === 'CARD'
  if (event.kind === 'SOURCE_CHEQUE') return entryKind === 'CHEQUE' && payment.chequeStatus === 'CLEARED'
  return false
}

async function matchingTransferOutForIn(tx: LedgerClient, into: any): Promise<any | null> {
  const eventKey = String(into?.eventKey ?? '')
  const parentEventId = Number(into?.parentEventId)
  const sourceInvoiceId = Number(into?.sourceInvoiceId)
  const childInvoiceId = Number(into?.childInvoiceId)
  const returnId = Number(into?.returnId)
  if (into?.kind !== 'TRANSFER_IN' || !eventKey.endsWith(':in') ||
      ![parentEventId, sourceInvoiceId, childInvoiceId, returnId].every((id) => Number.isSafeInteger(id) && id > 0) ||
      toNumberRial(into.amount) <= 0)
    return null

  const parent = await tx.exchangeFundingEvent.findUnique({ where: { id: parentEventId } })
  const out = await tx.exchangeFundingEvent.findUnique({
    where: { eventKey: `${eventKey.slice(0, -3)}:out` }
  })
  const parentScopeMatches = parent && (PROVEN_SOURCE_KINDS.has(String(parent.kind))
    ? Number(parent.sourceInvoiceId) === sourceInvoiceId
    : parent.kind === 'TRANSFER_IN' && Number(parent.childInvoiceId) === sourceInvoiceId)
  if (!parent || !parentScopeMatches || !out || out.kind !== 'TRANSFER_OUT' || out.shareId !== parent.shareId ||
      out.shareId === into.shareId || parent.rootShareId !== into.rootShareId ||
      out.rootShareId !== into.rootShareId || !sameNullableId(out.parentEventId, into.parentEventId) ||
      !sameNullableId(out.sourceInvoiceId, into.sourceInvoiceId) ||
      !sameNullableId(out.childInvoiceId, into.childInvoiceId) || !sameNullableId(out.returnId, into.returnId) ||
      toNumberRial(out.amount) !== -toNumberRial(into.amount) ||
      out.evidenceKind !== 'EXCHANGE_TRANSFER' || into.evidenceKind !== 'EXCHANGE_TRANSFER' ||
      out.evidenceKind !== into.evidenceKind || out.evidenceRef !== into.evidenceRef ||
      !sameNullableId(out.actorUserId, into.actorUserId) || out.sourcePaymentId != null || into.sourcePaymentId != null ||
      out.sourceRedemptionId != null || into.sourceRedemptionId != null || out.sourceCreditId != null ||
      into.sourceCreditId != null || out.debtId != null || into.debtId != null ||
      out.sourceMethodKind != null || into.sourceMethodKind != null ||
      out.sourceDestination != null || into.sourceDestination != null ||
      out.reversesEventId != null || into.reversesEventId != null)
    return null
  return out
}

async function activeExchangeLink(
  tx: LedgerClient,
  sourceInvoiceId: number,
  childInvoiceId: number,
  returnId: number
): Promise<any | null> {
  if (sourceInvoiceId === childInvoiceId) return null
  const [source, child, ret] = await Promise.all([
    tx.saleInvoice.findUnique({ where: { id: sourceInvoiceId }, select: { id: true, voidedAt: true, status: true } }),
    tx.saleInvoice.findUnique({ where: { id: childInvoiceId }, select: {
      id: true, grandTotal: true, voidedAt: true, status: true,
      orderType: true, sourceInvoiceId: true, exchangeReturnId: true
    } }),
    tx.saleReturn.findUnique({ where: { id: returnId }, select: {
      id: true, invoiceId: true, total: true, kind: true, voidedAt: true,
      exchangeInvoiceId: true, exchangeTotal: true
    } })
  ])
  const active = !!source && source.voidedAt == null && !['DRAFT', 'CANCELED'].includes(String(source.status)) &&
    !!child && child.voidedAt == null && !['DRAFT', 'CANCELED'].includes(String(child.status)) &&
    child.orderType === 'EXCHANGE' && Number(child.sourceInvoiceId) === sourceInvoiceId &&
    Number(child.exchangeReturnId) === returnId &&
    // Reciprocal lineage IDs are stronger proof than the mutable legacy discriminator.
    !!ret && ret.voidedAt == null && Number(ret.invoiceId) === sourceInvoiceId &&
    Number(ret.exchangeInvoiceId) === childInvoiceId && toNumberRial(ret.total) > 0 &&
    ret.exchangeTotal != null && child.grandTotal != null &&
    toNumberRial(ret.exchangeTotal) === toNumberRial(child.grandTotal)
  return active ? ret : null
}

async function transferPairReversalState(tx: LedgerClient, out: any, into: any): Promise<'ACTIVE' | 'REVERSED' | null> {
  const [outVoid, inVoid] = await Promise.all([
    tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(out.id) } }),
    tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(into.id) } })
  ])
  if (!outVoid && !inVoid) return 'ACTIVE'
  if (!outVoid || !inVoid) return null

  const outKey = String(out.eventKey ?? '')
  const inKey = String(into.eventKey ?? '')
  const outVoidKey = String(outVoid.eventKey ?? '')
  const inVoidKey = String(inVoid.eventKey ?? '')
  if (!outKey.endsWith(':out') || !inKey.endsWith(':in') ||
      !outVoidKey.endsWith(':out:void') || !inVoidKey.endsWith(':in:void') ||
      outVoidKey.slice(0, -9) !== inVoidKey.slice(0, -8) ||
      outVoid.kind !== 'VOID_TRANSFER_OUT' || inVoid.kind !== 'VOID_TRANSFER_IN' ||
      Number(outVoid.reversesEventId) !== Number(out.id) ||
      Number(inVoid.reversesEventId) !== Number(into.id) ||
      toNumberRial(outVoid.amount) !== -toNumberRial(out.amount) ||
      toNumberRial(inVoid.amount) !== -toNumberRial(into.amount) ||
      outVoid.shareId !== out.shareId || inVoid.shareId !== into.shareId ||
      outVoid.rootShareId !== out.rootShareId || inVoid.rootShareId !== into.rootShareId ||
      !sameNullableId(outVoid.sourceInvoiceId, out.sourceInvoiceId) ||
      !sameNullableId(inVoid.sourceInvoiceId, into.sourceInvoiceId) ||
      !sameNullableId(outVoid.childInvoiceId, out.childInvoiceId) ||
      !sameNullableId(inVoid.childInvoiceId, into.childInvoiceId) ||
      !sameNullableId(outVoid.returnId, out.returnId) || !sameNullableId(inVoid.returnId, into.returnId) ||
      !sameNullableId(outVoid.parentEventId, out.parentEventId) ||
      !sameNullableId(inVoid.parentEventId, into.parentEventId) ||
      outVoid.evidenceKind !== 'SALE_INVOICE_VOID' || inVoid.evidenceKind !== 'SALE_INVOICE_VOID' ||
      outVoid.evidenceRef !== inVoid.evidenceRef || !sameNullableId(outVoid.actorUserId, inVoid.actorUserId))
    return null
  return 'REVERSED'
}

async function activeTransferValueForReturn(
  tx: LedgerClient,
  sourceInvoiceId: number,
  childInvoiceId: number,
  returnId: number
): Promise<number | null> {
  const events = await tx.exchangeFundingEvent.findMany({
    where: { returnId, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } }
  })
  const outs = events.filter((event: any) => event.kind === 'TRANSFER_OUT')
  const ins = events.filter((event: any) => event.kind === 'TRANSFER_IN')
  if (outs.length !== ins.length || events.some((event: any) =>
    Number(event.sourceInvoiceId) !== sourceInvoiceId || Number(event.childInvoiceId) !== childInvoiceId))
    return null
  const matchedOutIds = new Set<number>()
  let total = 0n
  for (const into of ins) {
    const out = await matchingTransferOutForIn(tx, into)
    if (!out || !outs.some((candidate: any) => Number(candidate.id) === Number(out.id)) ||
        matchedOutIds.has(Number(out.id)))
      return null
    matchedOutIds.add(Number(out.id))
    const state = await transferPairReversalState(tx, out, into)
    if (state == null) return null
    if (state === 'ACTIVE') total += BigInt(toNumberRial(into.amount))
  }
  if (matchedOutIds.size !== outs.length || total > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(total)
}

async function hasActiveTransferPair(tx: LedgerClient, into: any): Promise<boolean> {
  const out = await matchingTransferOutForIn(tx, into)
  if (!out || await eventHasReversal(tx, Number(out.id)) || await eventHasReversal(tx, Number(into.id))) return false
  return !!(await activeExchangeLink(tx, Number(into.sourceInvoiceId), Number(into.childInvoiceId), Number(into.returnId)))
}

async function provenSourceRootEvent(
  tx: LedgerClient,
  event: any,
  options: { allowExpiredGiftForReturnAttribution?: boolean } = {}
): Promise<any | null> {
  let current = event
  const seen = new Set<number>()
  const transferInTimes: Array<number | null> = []
  for (let depth = 0; depth < 50; depth++) {
    const id = Number(current?.id)
    const shareId = typeof current?.shareId === 'string' ? current.shareId : ''
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !shareId.trim()) return null
    seen.add(id)
    if (PROVEN_SOURCE_KINDS.has(String(current.kind))) {
      const rootAmount = toNumberRial(current.amount)
      if (!Number.isSafeInteger(rootAmount) || rootAmount <= 0) return null
      if (await eventHasReversal(tx, id)) return null
      if (!await hasPersistedSourcePayment(tx, current, options)) return null
      if (String(current.kind) === 'SOURCE_GIFT' &&
          options.allowExpiredGiftForReturnAttribution === true) {
        const redemption = await tx.storeCreditRedemption.findUnique({
          where: { id: Number(current.sourceRedemptionId) }, select: { expiryAtRedeem: true }
        })
        const expiry = dateMillis(redemption?.expiryAtRedeem)
        if (expiry != null && expiry <= Date.now() &&
            (!Number.isFinite(expiry) ||
              transferInTimes.some((at) => at == null || !Number.isFinite(at) || at >= expiry)))
          return null
      }
      const rootBalance = await exchangeFundingBalance(tx, shareId)
      if (!Number.isSafeInteger(rootBalance) || rootBalance < 0) return null
      return current
    }
    if (current.kind !== 'TRANSFER_IN' || current.parentEventId == null) return null
    const carriedAmount = toNumberRial(current.amount)
    if (!Number.isSafeInteger(carriedAmount) || carriedAmount <= 0) return null
    if (!await hasActiveTransferPair(tx, current)) return null
    const carriedBalance = await exchangeFundingBalance(tx, shareId)
    if (!Number.isSafeInteger(carriedBalance) || carriedBalance < 0) return null
    transferInTimes.push(dateMillis(current.createdAt))
    current = await tx.exchangeFundingEvent.findUnique({ where: { id: Number(current.parentEventId) } })
    if (!current) return null
  }
  return null
}

async function hasProvableTransferLineage(
  tx: LedgerClient, event: any, options: { allowExpiredGiftForReturnAttribution?: boolean } = {}
): Promise<boolean> {
  return (await provenSourceRootEvent(tx, event, options)) != null
}

/** Read only the latest persisted-sale snapshot and verify every transferable
 * source against its live Payment/redemption row. This deliberately does not
 * reconstruct provenance for legacy invoices or treat an EXCHANGE_CREDIT
 * payment as a source. The expired-gift attribution option is for historical
 * rights/report reconstruction only; transferExchangeFundingShare always
 * revalidates with the strict default. Callers must separately decide how
 * debt/unknown shares affect the specific return.
 */
export async function getCurrentSaleFundingSources(
  tx: LedgerClient, invoiceId: number, options: { allowExpiredGiftForReturnAttribution?: boolean } = {}
) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const invoice = await tx.saleInvoice.findUnique({
    where: { id: invoiceId }, select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true,
      voidedAt: true, status: true, grandTotal: true
    }
  })
  if (!invoice) throw new BusinessError('فاکتور برای خواندن منشأ مالی پیدا نشد؛ هیچ سهمی حدس زده نشد.')
  if (await isExchangeChildInvoiceWithLineage(tx, invoice))
    throw new BusinessError('فاکتور تعویض/فرزند تعویض برای خواندن منشأ به مسیر مستقل نیاز دارد؛ هیچ سهم فروش عادی برنگردانده شد.')
  if (invoice.voidedAt != null || ['DRAFT', 'CANCELED'].includes(String(invoice.status)))
    throw new BusinessError('فاکتور لغوشده یا نهایی‌نشده منبع تعویض نیست.')

  const [revision, stale, returnRows] = await Promise.all([
    latestSaleFundingRevision(tx, invoiceId),
    fundingSnapshotRequiresCorrection(tx, invoiceId),
    tx.saleReturn.findMany({ where: { invoiceId, voidedAt: null }, select: { id: true } })
  ])
  const base = {
    invoiceId,
    revision,
    snapshotExists: revision > 0,
    stale,
    activeReturnIds: (returnRows as any[]).map((row) => Number(row.id)),
    sources: [] as Array<{
      event: any
      available: number
      sourceKind: string
      sourceMethodKind: string | null
      sourceDestination: string | null
    }>,
    unresolved: [] as Array<{ eventId: number; kind: string; amount: number }>,
    debt: 0,
    overpay: 0
  }
  if (revision === 0 || stale) return base

  const prefix = `sale:${invoiceId}:r${revision}:`
  const rows = await tx.exchangeFundingEvent.findMany({
    where: { sourceInvoiceId: invoiceId, eventKey: { startsWith: prefix } },
    orderBy: { id: 'asc' }
  })
  if (!rows.length)
    throw new BusinessError('نسخهٔ منشأ مالی خالی است؛ انتقال بر پایهٔ snapshot ناقص انجام نشد.')

  let allocatedInvoiceValue = 0
  let snapshotDebt = 0
  for (const event of rows as any[]) {
    const kind = String(event.kind ?? '')
    const amount = toNumberRial(event.amount)
    const eventId = Number(event.id)
    if (kind.startsWith('VOID_') || amount === 0) continue
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(amount) || amount < 0) throw invalid()
    if (await eventHasReversal(tx, eventId)) {
      base.unresolved.push({ eventId, kind: 'REVERSED_CURRENT_SNAPSHOT_EVENT', amount })
      continue
    }
    if (['SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE', 'SOURCE_GIFT', 'SOURCE_UNKNOWN'].includes(kind)) {
      allocatedInvoiceValue += amount
      if (PROVEN_SOURCE_KINDS.has(kind)) {
        if (!await hasProvableTransferLineage(tx, event, {
          allowExpiredGiftForReturnAttribution: options.allowExpiredGiftForReturnAttribution === true
        })) {
          base.unresolved.push({ eventId, kind: 'UNPROVEN_SOURCE', amount })
          continue
        }
        const available = await exchangeFundingBalance(tx, String(event.shareId))
        if (!Number.isSafeInteger(available) || available < 0) {
          base.unresolved.push({ eventId, kind: 'INVALID_SOURCE_BALANCE', amount })
          continue
        }
        base.sources.push({
          event,
          available,
          sourceKind: kind,
          sourceMethodKind: event.sourceMethodKind == null ? null : String(event.sourceMethodKind),
          sourceDestination: event.sourceDestination == null ? null : String(event.sourceDestination)
        })
      } else {
        // Unknown money is represented in invoice value but never transferable.
        base.unresolved.push({ eventId, kind, amount })
      }
    } else if (kind === 'SOURCE_OVERPAY') {
      base.overpay += amount
    } else if (kind === 'DEBT_OPEN') {
      snapshotDebt += amount
    } else {
      // Unknown and not-yet-cleared instruments stay explicit blockers. In
      // particular, an uncleared cheque is never promoted to source money.
      base.unresolved.push({ eventId, kind, amount })
    }
  }
  base.debt = await exchangeFundingBalance(tx, `debt:${invoiceId}`)
  if (!Number.isSafeInteger(base.debt) || base.debt < 0) {
    base.unresolved.push({ eventId: 0, kind: 'INVALID_DEBT_BALANCE', amount: Math.abs(base.debt) })
    base.debt = 0
  }
  if (!Number.isSafeInteger(snapshotDebt) || snapshotDebt !== base.debt)
    base.unresolved.push({ eventId: 0, kind: 'DEBT_SNAPSHOT_MISMATCH', amount: snapshotDebt - base.debt })
  const invoiceTotal = toNumberRial(invoice.grandTotal)
  if (!Number.isSafeInteger(invoiceTotal) || invoiceTotal < 0 ||
      !Number.isSafeInteger(allocatedInvoiceValue + base.debt) || allocatedInvoiceValue + base.debt !== invoiceTotal)
    base.unresolved.push({ eventId: 0, kind: 'SNAPSHOT_RECONCILIATION_MISMATCH',
      amount: allocatedInvoiceValue + base.debt - invoiceTotal })
  if (!Number.isSafeInteger(base.overpay))
    base.unresolved.push({ eventId: 0, kind: 'INVALID_OVERPAY_BALANCE', amount: base.overpay })
  return base
}

/** Stable key for one proven source share on one replacement item. */
function exchangeFundingLineAllocationEventKey(childInvoiceId: number, sourceEventId: number, saleItemId: number) {
  return `exchange-line:${childInvoiceId}:source:${sourceEventId}:item:${saleItemId}`
}

/** Read the child side of an EXCHANGE invoice from its validated incoming
 * transfer pairs. The display Payment(EXCHANGE_CREDIT) is only reconciled to
 * those transfers; it is never promoted to an independent cash source. New
 * tenders, debt, missing pairs, and mismatched invoice totals stay unresolved.
 */
export async function getCurrentExchangeFundingSources(
  tx: LedgerClient, invoiceId: number, options: {
    allowReturnBalanceChanges?: boolean
    allowExpiredGiftForReturnAttribution?: boolean
  } = {}
) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const invoice = await tx.saleInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true, orderType: true, voidedAt: true, status: true, grandTotal: true, paidTotal: true, deliveryFee: true,
      sourceInvoiceId: true, exchangeReturnId: true,
      items: { select: { id: true, qty: true, unitPrice: true, lineTotal: true, discount: true, tax: true } }
    }
  })
  if (!invoice) throw new BusinessError('سند تعویض برای خواندن زنجیرهٔ منشأ پیدا نشد.')
  if (invoice.orderType !== 'EXCHANGE')
    throw new BusinessError('خواندن منشأ فرزند فقط برای فاکتور نوع تعویض انجام می‌شود.')
  if (invoice.voidedAt != null || ['DRAFT', 'CANCELED'].includes(String(invoice.status)))
    throw new BusinessError('سند تعویض لغوشده یا نهایی‌نشده منبع زنده نیست.')

  const [transferEvents, payments, returnRows, redemptionCount] = await Promise.all([
    tx.exchangeFundingEvent.findMany({
      where: { childInvoiceId: invoiceId, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
      orderBy: { id: 'asc' }
    }),
    tx.payment.findMany({
      where: { invoiceId, voidedAt: null }, orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      include: { method: { select: { kind: true, key: true } } }
    }),
    tx.saleReturn.findMany({ where: { invoiceId, voidedAt: null }, select: { id: true } }),
    tx.storeCreditRedemption.count({ where: { invoiceId, reversedAt: null } })
  ])
  const base = {
    invoiceId,
    sourceInvoiceId: invoice.sourceInvoiceId == null ? null : Number(invoice.sourceInvoiceId),
    returnId: invoice.exchangeReturnId == null ? null : Number(invoice.exchangeReturnId),
    revision: 0,
    snapshotExists: (transferEvents as any[]).length > 0,
    stale: false,
    activeReturnIds: (returnRows as any[]).map((row) => Number(row.id)),
    sources: [] as Array<{
      event: any
      available: number
      sourceKind: string
      sourceMethodKind: string | null
      sourceDestination: string | null
    }>,
    lineItemSnapshots: [] as Array<{ saleItemId: number; qty: number; netValue: number }>,
    lineAllocations: [] as Array<{
      sourceEventId: number
      saleItemId: number
      sourceKind: 'SOURCE_GIFT' | 'SOURCE_N' | 'SOURCE_B' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE'
      amount: number
    }>,
    lineAllocationStatus: 'UNAVAILABLE' as 'UNAVAILABLE' | 'READ_ONLY_RECONCILED' | 'PERSISTED_RECONCILED',
    unresolved: [] as Array<{ eventId: number; kind: string; amount: number }>,
    debt: 0,
    debtOffset: 0,
    overpay: 0
  }
  const outs = (transferEvents as any[]).filter((event) => event.kind === 'TRANSFER_OUT')
  const ins = (transferEvents as any[]).filter((event) => event.kind === 'TRANSFER_IN')
  const matchedOutIds = new Set<number>()
  let incomingTotal = 0n
  if (outs.length !== ins.length)
    base.unresolved.push({ eventId: 0, kind: 'UNPAIRED_EXCHANGE_TRANSFER', amount: Math.abs(outs.length - ins.length) })

  for (const into of ins) {
    const eventId = Number(into.id)
    const amount = toNumberRial(into.amount)
    const out = await matchingTransferOutForIn(tx, into)
    if (!out || !outs.some((candidate) => Number(candidate.id) === Number(out.id)) ||
        matchedOutIds.has(Number(out.id)) || Number(into.childInvoiceId) !== invoiceId ||
        Number(into.sourceInvoiceId) !== Number(invoice.sourceInvoiceId) ||
        Number(into.returnId) !== Number(invoice.exchangeReturnId) ||
        !Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(amount) || amount <= 0) {
      base.unresolved.push({ eventId: Number.isSafeInteger(eventId) ? eventId : 0,
        kind: 'INVALID_EXCHANGE_TRANSFER_LINK', amount: Number.isSafeInteger(amount) ? amount : 0 })
      continue
    }
    matchedOutIds.add(Number(out.id))
    const state = await transferPairReversalState(tx, out, into)
    if (state !== 'ACTIVE') {
      base.unresolved.push({ eventId, kind: state === 'REVERSED' ? 'REVERSED_EXCHANGE_TRANSFER' : 'INVALID_EXCHANGE_TRANSFER_PAIR', amount })
      continue
    }
    incomingTotal += BigInt(amount)
    const root = await provenSourceRootEvent(tx, into, {
      allowExpiredGiftForReturnAttribution: options.allowReturnBalanceChanges === true &&
        options.allowExpiredGiftForReturnAttribution === true
    })
    if (!root) {
      base.unresolved.push({ eventId, kind: 'UNPROVEN_EXCHANGE_LINEAGE', amount })
      continue
    }
    const available = await exchangeFundingBalance(tx, String(into.shareId))
    if (!Number.isSafeInteger(available) || available < 0) {
      base.unresolved.push({ eventId, kind: 'INVALID_TRANSFERRED_SHARE_BALANCE', amount })
      continue
    }
    base.sources.push({
      event: into,
      available,
      sourceKind: String(root.kind),
      sourceMethodKind: root.sourceMethodKind == null ? null : String(root.sourceMethodKind),
      sourceDestination: root.sourceDestination == null ? null : String(root.sourceDestination)
    })
  }
  if (matchedOutIds.size !== outs.length)
    base.unresolved.push({ eventId: 0, kind: 'UNMATCHED_EXCHANGE_TRANSFER_OUT', amount: outs.length - matchedOutIds.size })
  if (incomingTotal > BigInt(Number.MAX_SAFE_INTEGER))
    base.unresolved.push({ eventId: 0, kind: 'INVALID_EXCHANGE_TRANSFER_TOTAL', amount: 0 })

  let exchangeCreditTotal = 0
  let childTenderTotal = 0
  let chequeDebtBackingTotal = 0
  const fundingRevision = await latestSaleFundingRevision(tx, invoiceId)
  const tenderSnapshotRows = fundingRevision > 0
    ? await tx.exchangeFundingEvent.findMany({ where: {
        sourceInvoiceId: invoiceId,
        eventKey: { startsWith: `sale:${invoiceId}:r${fundingRevision}:` }
      }, orderBy: { id: 'asc' } }) as any[]
    : []
  for (const payment of payments as any[]) {
    const amount = toNumberRial(payment.amount)
    const methodKind = String(payment.method?.kind ?? '').toUpperCase()
    const methodKey = String(payment.method?.key ?? '').toUpperCase()
    const hasExchangeCreditSignal = methodKind === 'EXCHANGE_CREDIT' || methodKey === 'EXCHANGE_CREDIT'
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'INVALID_CHILD_PAYMENT', amount: Number.isSafeInteger(amount) ? amount : 0 })
    } else if (hasExchangeCreditSignal) {
      if (methodKind !== 'EXCHANGE_CREDIT' || methodKey !== 'EXCHANGE_CREDIT' ||
          payment.storeCreditId != null || payment.destination != null ||
          String(payment.kind ?? 'CASH').toUpperCase() !== 'CASH') {
        base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'MALFORMED_EXCHANGE_CREDIT_PAYMENT', amount })
      } else {
        exchangeCreditTotal += amount
      }
    } else {
      const entryKind = String(payment.kind ?? 'CASH').toUpperCase()
      const chequeStatus = String(payment.chequeStatus ?? '').toUpperCase()
      if (entryKind === 'CHEQUE' && ['PENDING', 'BOUNCED'].includes(chequeStatus)) {
        const backing = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
          row.kind === 'DEBT_OPEN' && Number(row.debtId) === invoiceId)
        const backingEvidence = String(backing?.evidenceRef ?? '')
        const policyEvidenceMatches = backingEvidence === `Payment:${payment.id}` ||
          new RegExp(`^Payment:${Number(payment.id)};chequePolicyVersion:[1-9][0-9]*$`).test(backingEvidence)
        if (!backing || toNumberRial(backing.amount) !== amount ||
            backing.shareId !== `debt:${invoiceId}` || !policyEvidenceMatches) {
          base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'UNBACKED_PENDING_EXCHANGE_CHEQUE', amount })
        } else chequeDebtBackingTotal += amount
      } else if (entryKind === 'CHEQUE' && chequeStatus === 'DEBT_OFFSET') {
        const backing = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
          row.kind === 'DEBT_OPEN' && Number(row.debtId) === invoiceId)
        const offset = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
          row.kind === 'DEBT_OFFSET' && Number(row.debtId) === invoiceId)
        if (!backing || toNumberRial(backing.amount) !== amount || !offset ||
            toNumberRial(offset.amount) >= 0 || -toNumberRial(offset.amount) !== amount)
          base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'UNWITNESSED_DEBT_OFFSET_CHEQUE', amount })
        else chequeDebtBackingTotal += amount
      } else if (entryKind === 'CHEQUE' && ['SUSPENSE', 'SUSPENSE_REFUNDED'].includes(chequeStatus)) {
        const suspense = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
          row.kind === 'SUSPENSE_CHEQUE_LATE')
        if (!suspense) base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'UNWITNESSED_CHEQUE_SUSPENSE', amount })
        if (chequeStatus === 'SUSPENSE_REFUNDED') {
          const resolution = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
            row.kind === 'SUSPENSE_CHEQUE_RESOLVED')
          const refund = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
            row.kind === 'SUSPENSE_CHEQUE_REFUNDED')
          if (!resolution || !refund)
            base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'UNWITNESSED_SUSPENSE_CHEQUE_REFUND', amount })
        }
      } else {
        childTenderTotal += amount
        const source = tenderSnapshotRows.find((row) => Number(row.sourcePaymentId) === Number(payment.id) &&
          PROVEN_SOURCE_KINDS.has(String(row.kind)))
        if (!source || toNumberRial(source.amount) !== amount ||
            !await hasPersistedSourcePayment(tx, source, {
              allowExpiredGiftForReturnAttribution: options.allowReturnBalanceChanges === true &&
                options.allowExpiredGiftForReturnAttribution === true,
              allowReturnedResidualRight: options.allowReturnBalanceChanges === true
            })) {
          base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'UNJOURNALED_CHILD_PAYMENT', amount })
          continue
        }
        const available = await exchangeFundingBalance(tx, String(source.shareId))
        if (!Number.isSafeInteger(available) || available < 0) {
          base.unresolved.push({ eventId: Number(source.id) || 0, kind: 'INVALID_CHILD_TENDER_BALANCE', amount })
          continue
        }
        base.sources.push({ event: source, available, sourceKind: String(source.kind),
          sourceMethodKind: source.sourceMethodKind == null ? null : String(source.sourceMethodKind),
          sourceDestination: source.sourceDestination == null ? null : String(source.sourceDestination) })
      }
    }
  }
  const debtOffsetEvents = tenderSnapshotRows.filter((event) => event.kind === 'DEBT_OFFSET')
  for (const offset of debtOffsetEvents) {
    const amount = toNumberRial(offset.amount)
    const returnId = Number(offset.returnId)
    const paymentId = Number(offset.sourcePaymentId)
    const [ret, payment, history, reversal] = await Promise.all([
      Number.isSafeInteger(returnId) && returnId > 0
        ? tx.saleReturn.findUnique({ where: { id: returnId }, select: {
            id: true, invoiceId: true, kind: true, debtReduction: true, exchangeInvoiceId: true, voidedAt: true
          } }) : null,
      Number.isSafeInteger(paymentId) && paymentId > 0
        ? tx.payment.findUnique({ where: { id: paymentId }, select: { id: true, invoiceId: true, amount: true, kind: true } }) : null,
      Number.isSafeInteger(paymentId) && paymentId > 0 && tx.paymentChequeStatusHistory
        ? tx.paymentChequeStatusHistory.findMany({ where: { paymentId }, orderBy: { id: 'asc' } }) : [],
      tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(offset.id) } })
    ])
    const baseValid = Number.isSafeInteger(amount) && amount < 0 && !!ret && ret.kind === 'EXCHANGE' &&
      Number(ret.invoiceId) === invoiceId && Number(ret.exchangeInvoiceId) === Number(offset.childInvoiceId) &&
      toNumberRial(ret.debtReduction) === -amount && Number(offset.sourceInvoiceId) === invoiceId &&
      Number(offset.debtId) === invoiceId && offset.shareId === `debt:${invoiceId}` &&
      offset.evidenceKind === 'EXCHANGE_DEBT_OFFSET' && offset.evidenceRef === `SaleReturn:${returnId}` &&
      (offset.sourceMethodKind == null || ['PENDING', 'BOUNCED'].includes(String(offset.sourceMethodKind)))
    const offsetHistoryIndex = (history as any[]).findIndex((row) => row.status === 'DEBT_OFFSET')
    const restoredStatus = ['PENDING', 'BOUNCED'].includes(String(offset.sourceMethodKind))
      ? String(offset.sourceMethodKind)
      : offsetHistoryIndex > 0 ? String((history as any[])[offsetHistoryIndex - 1]?.status ?? '') : null
    const paymentValid = !!payment && Number(payment.invoiceId) === invoiceId && payment.kind === 'CHEQUE' &&
      toNumberRial(payment.amount) === -amount && offsetHistoryIndex >= 0
    let reversalValid = false
    if (reversal) {
      const prefix = `sale:${invoiceId}:r1:debt-offset:return:${returnId}`
      const historyId = Number(String(reversal.evidenceRef ?? '').match(/PaymentChequeStatusHistory:(\d+)$/)?.[1] ?? 0)
      const restoredHistory = Number.isSafeInteger(historyId) && historyId > 0 && tx.paymentChequeStatusHistory
        ? await tx.paymentChequeStatusHistory.findUnique({ where: { id: historyId } }) : null
      reversalValid = reversal.kind === 'VOID_DEBT_OFFSET' && reversal.eventKey === `${prefix}:void` &&
        toNumberRial(reversal.amount) === -amount && Number(reversal.reversesEventId) === Number(offset.id) &&
        reversal.shareId === offset.shareId && reversal.rootShareId === offset.rootShareId &&
        Number(reversal.sourceInvoiceId) === invoiceId && Number(reversal.childInvoiceId) === Number(offset.childInvoiceId) &&
        Number(reversal.returnId) === returnId && Number(reversal.sourcePaymentId) === paymentId &&
        Number(reversal.debtId) === invoiceId && reversal.sourceMethodKind === offset.sourceMethodKind &&
        reversal.evidenceKind === 'EXCHANGE_VOID' &&
        !!restoredHistory && Number(restoredHistory.paymentId) === paymentId &&
        restoredStatus != null && restoredHistory.status === restoredStatus
    }
    if (!baseValid || !paymentValid || (!reversal && ret?.voidedAt != null) || (reversal && !reversalValid)) {
      base.unresolved.push({ eventId: Number(offset.id) || 0, kind: 'INVALID_DEBT_OFFSET_EVIDENCE', amount })
      continue
    }
    if (!reversal) base.debtOffset += -amount
  }
  if (redemptionCount > (payments as any[]).filter((payment) => payment.storeCreditId != null).length)
    base.unresolved.push({ eventId: 0, kind: 'INVALID_CHILD_REDEMPTION_COUNT', amount: redemptionCount })

  const invoiceTotal = toNumberRial(invoice.grandTotal)
  const paidTotal = toNumberRial(invoice.paidTotal)
  const transferred = Number(incomingTotal)
  if (!Number.isSafeInteger(invoiceTotal) || invoiceTotal < 0 || !Number.isSafeInteger(paidTotal) || paidTotal < 0 ||
      !Number.isSafeInteger(exchangeCreditTotal) || !Number.isSafeInteger(childTenderTotal) || !Number.isSafeInteger(transferred)) {
    base.unresolved.push({ eventId: 0, kind: 'INVALID_EXCHANGE_INVOICE_SETTLEMENT', amount: 0 })
  } else {
    const invoiceDebt = Math.max(0, invoiceTotal - paidTotal)
    const hasDebtLedger = tenderSnapshotRows.some((event) => event.kind === 'DEBT_OPEN')
    const ledgerDebt = await exchangeFundingBalance(tx, `debt:${invoiceId}`)
    base.debt = hasDebtLedger ? ledgerDebt : invoiceDebt
    if (hasDebtLedger) {
      if (!Number.isSafeInteger(base.debt) || base.debt < 0 ||
          base.debt + base.debtOffset !== invoiceDebt)
        base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_DEBT_LEDGER_MISMATCH',
          amount: base.debt + base.debtOffset - invoiceDebt })
      if (base.debt > chequeDebtBackingTotal)
        base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_DEBT_EXCEEDS_CHEQUE_BACKING', amount: base.debt - chequeDebtBackingTotal })
    } else if (base.debt > 0) {
      base.unresolved.push({ eventId: 0, kind: 'UNRESOLVED_EXCHANGE_CHILD_DEBT', amount: base.debt })
    }
    base.overpay = Math.max(0, paidTotal - invoiceTotal)
    if (base.overpay > 0)
      base.unresolved.push({ eventId: 0, kind: 'UNRESOLVED_EXCHANGE_CHILD_OVERPAY', amount: base.overpay })
    if (paidTotal !== exchangeCreditTotal + childTenderTotal)
      base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_CHILD_PAID_TOTAL_MISMATCH',
        amount: paidTotal - exchangeCreditTotal - childTenderTotal })
  }
  if (Number.isSafeInteger(exchangeCreditTotal) && Number.isSafeInteger(transferred) && transferred !== exchangeCreditTotal)
    base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_TRANSFER_PAYMENT_MISMATCH',
      amount: transferred - exchangeCreditTotal })
  if (Number.isSafeInteger(invoiceTotal) && Number.isSafeInteger(transferred) &&
      Number.isSafeInteger(childTenderTotal) && Number.isSafeInteger(base.debt) &&
      transferred + childTenderTotal + base.debt + base.debtOffset !== invoiceTotal)
    base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_TRANSFER_INVOICE_MISMATCH',
      amount: transferred + childTenderTotal + base.debt + base.debtOffset - invoiceTotal })
  if (!base.snapshotExists && Number.isSafeInteger(invoiceTotal) && invoiceTotal > 0)
    base.unresolved.push({ eventId: 0, kind: 'MISSING_EXCHANGE_TRANSFER_SNAPSHOT', amount: invoiceTotal })

  // This projection alone is descriptive, not a return or nested-exchange permit.
  // The return reader validates its own allocations; createExchange separately
  // authorizes S3 only after its same-transaction full-source and lineage checks.
  // The default view continues to require untouched balances and no active returns.
  const allowReturnBalanceChanges = options.allowReturnBalanceChanges === true
  if (base.unresolved.length === 0 && (allowReturnBalanceChanges || base.activeReturnIds.length === 0) &&
      Number.isSafeInteger(invoiceTotal) && invoiceTotal > 0 && base.sources.length > 0) {
    const sourceTotal = base.sources.reduce((sum, source) =>
      sum + BigInt(toNumberRial(source.event.amount)), 0n)
    const availableTotal = base.sources.reduce((sum, source) => sum + BigInt(source.available), 0n)
    const fundedInvoiceValue = invoiceTotal - base.debt - base.debtOffset
    const sourceAmountsValid = Number.isSafeInteger(fundedInvoiceValue) && fundedInvoiceValue >= 0 &&
      sourceTotal <= BigInt(Number.MAX_SAFE_INTEGER) && sourceTotal === BigInt(fundedInvoiceValue)
    const untouchedBalancesValid = allowReturnBalanceChanges || (
      base.sources.every((source) => source.available === toNumberRial(source.event.amount)) &&
      availableTotal === BigInt(fundedInvoiceValue)
    )
    if (!sourceAmountsValid || !untouchedBalancesValid) {
      const outOfRange = sourceTotal > BigInt(Number.MAX_SAFE_INTEGER) || availableTotal > BigInt(Number.MAX_SAFE_INTEGER)
      base.unresolved.push({ eventId: 0,
        kind: outOfRange ? 'INVALID_EXCHANGE_LINE_SCOPE_BALANCE' : 'EXCHANGE_LINE_SOURCE_BALANCE_MISMATCH',
        amount: outOfRange ? 0 : Number(availableTotal - BigInt(fundedInvoiceValue)) })
    } else if (base.debt === 0 && base.debtOffset === 0) {
      try {
        const lineNet = allocateLineNet(invoice as any)
        const lineItemSnapshots = (invoice.items as any[]).map((item) => ({
          saleItemId: Number(item.id),
          qty: Number(item.qty),
          netValue: Number(lineNet.get(Number(item.id)) ?? 0)
        }))
        if (!lineItemSnapshots.every((item) => Number.isSafeInteger(item.saleItemId) && item.saleItemId > 0 &&
            Number.isSafeInteger(item.qty) && item.qty > 0 && Number.isSafeInteger(item.netValue) && item.netValue >= 0))
          throw new RangeError('Exchange item quantity/value snapshot is invalid')
        base.lineItemSnapshots = lineItemSnapshots
        const lines = lineItemSnapshots.map(({ saleItemId, netValue }) => ({ saleItemId, amount: netValue }))
        base.lineAllocations = allocateExchangeFundingByLine(lines, base.sources.map((source) => ({
          sourceEventId: Number(source.event.id),
          sourceKind: source.sourceKind as 'SOURCE_GIFT' | 'SOURCE_N' | 'SOURCE_B' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE',
          amount: toNumberRial(source.event.amount)
        })))
        base.lineAllocationStatus = 'READ_ONLY_RECONCILED'
      } catch {
        base.lineItemSnapshots = []
        base.lineAllocations = []
        base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_LINE_ALLOCATION_UNRESOLVED', amount: invoiceTotal })
      }
    }
  }
  if (base.lineAllocationStatus === 'READ_ONLY_RECONCILED') {
    const persisted = await tx.exchangeFundingLineAllocation.findMany({
      where: { childInvoiceId: invoiceId },
      orderBy: [{ sourceEventId: 'asc' }, { saleItemId: 'asc' }]
    })
    if ((persisted as any[]).length > 0) {
      const sourceInvoiceId = Number(invoice.sourceInvoiceId)
      const returnId = Number(invoice.exchangeReturnId)
      const lineSnapshotsById = new Map(base.lineItemSnapshots.map((line) => [line.saleItemId, line]))
      const expected = base.lineAllocations.map((allocation) => {
        const line = lineSnapshotsById.get(allocation.saleItemId)
        return {
          eventKey: exchangeFundingLineAllocationEventKey(invoiceId, allocation.sourceEventId, allocation.saleItemId),
          sourceInvoiceId,
          childInvoiceId: invoiceId,
          returnId,
          sourceEventId: allocation.sourceEventId,
          saleItemId: allocation.saleItemId,
          saleItemQty: line?.qty ?? 0,
          saleItemValue: line?.netValue ?? 0,
          sourceKind: allocation.sourceKind,
          amount: allocation.amount
        }
      })
      const matches = (persisted as any[]).length === expected.length &&
        (persisted as any[]).every((row, index) => {
          const candidate = expected[index]
          try {
            return String(row.eventKey) === candidate.eventKey &&
              Number(row.sourceInvoiceId) === candidate.sourceInvoiceId &&
              Number(row.childInvoiceId) === candidate.childInvoiceId &&
              Number(row.returnId) === candidate.returnId &&
              Number(row.sourceEventId) === candidate.sourceEventId &&
              Number(row.saleItemId) === candidate.saleItemId &&
              Number(row.saleItemQty) === candidate.saleItemQty &&
              toNumberRial(row.saleItemValue) === candidate.saleItemValue &&
              String(row.sourceKind) === candidate.sourceKind &&
              toNumberRial(row.amount) === candidate.amount
          } catch {
            return false
          }
        })
      if (matches) {
        base.lineAllocationStatus = 'PERSISTED_RECONCILED'
      } else {
        base.lineAllocations = []
        base.lineAllocationStatus = 'UNAVAILABLE'
        base.unresolved.push({ eventId: 0,
          kind: 'PERSISTED_EXCHANGE_LINE_ALLOCATION_MISMATCH', amount: invoiceTotal })
      }
    }
  }
  return base
}

/** Persist the exact child-item matrix in the caller's exchange transaction.
 * It is immutable descriptive provenance only: it does not create refund rights
 * or authorize an exchange by itself; S3 authorization belongs to createExchange's
 * complete same-transaction lineage and balance preflight.
 */
export async function recordExchangeFundingLineAllocations(tx: LedgerClient, invoiceId: number) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const view = await getCurrentExchangeFundingSources(tx, invoiceId)
  if ((view.debt > 0 || view.debtOffset > 0) && view.unresolved.length === 0)
    return { invoiceId, allocationCount: 0, replayed: false, deferred: true,
      reason: view.debt > 0 ? 'OPEN_EXCHANGE_DEBT' : 'EXCHANGE_DEBT_OFFSET_HISTORY' }
  if (view.lineAllocationStatus === 'PERSISTED_RECONCILED')
    return { invoiceId, allocationCount: view.lineAllocations.length, replayed: true }
  if (view.lineAllocationStatus !== 'READ_ONLY_RECONCILED' || view.unresolved.length > 0 ||
      view.activeReturnIds.length > 0 || !Number.isSafeInteger(view.sourceInvoiceId) ||
      Number(view.sourceInvoiceId) <= 0 || !Number.isSafeInteger(view.returnId) || Number(view.returnId) <= 0 ||
      view.lineAllocations.length === 0)
    throw new BusinessError('تخصیص قلمی منشأ تعویض قابل تطبیق نیست؛ هیچ ردیفی ثبت نشد.')

  const sourcesById = new Map(view.sources.map((source) => [Number(source.event.id), source]))
  const lineSnapshotsById = new Map(view.lineItemSnapshots.map((line) => [line.saleItemId, line]))
  for (const allocation of view.lineAllocations) {
    const source = sourcesById.get(allocation.sourceEventId)
    const line = lineSnapshotsById.get(allocation.saleItemId)
    const transferSource = source?.event.kind === 'TRANSFER_IN' &&
      Number(source.event.sourceInvoiceId) === Number(view.sourceInvoiceId) &&
      Number(source.event.childInvoiceId) === invoiceId && Number(source.event.returnId) === Number(view.returnId)
    const directTenderSource = !!source && PROVEN_SOURCE_KINDS.has(String(source.event.kind)) &&
      Number(source.event.sourceInvoiceId) === invoiceId &&
      await hasPersistedSourcePayment(tx, source.event, { allowExpiredGiftForReturnAttribution: true })
    if (!source || (!transferSource && !directTenderSource) ||
        source.sourceKind !== allocation.sourceKind || !Number.isSafeInteger(allocation.amount) || allocation.amount <= 0 ||
        !line || !Number.isSafeInteger(line.qty) || line.qty <= 0 ||
        !Number.isSafeInteger(line.netValue) || line.netValue <= 0)
      throw new BusinessError('پیوند تخصیص قلمی با رویداد انتقال/ tender اثبات‌شده سازگار نیست؛ هیچ ردیفی ثبت نشد.')

    await tx.exchangeFundingLineAllocation.create({
      data: {
        eventKey: exchangeFundingLineAllocationEventKey(invoiceId, allocation.sourceEventId, allocation.saleItemId),
        sourceInvoiceId: Number(view.sourceInvoiceId),
        childInvoiceId: invoiceId,
        returnId: Number(view.returnId),
        sourceEventId: allocation.sourceEventId,
        saleItemId: allocation.saleItemId,
        saleItemQty: line.qty,
        saleItemValue: BigInt(line.netValue),
        sourceKind: allocation.sourceKind,
        amount: BigInt(allocation.amount)
      }
    })
  }
  return { invoiceId, allocationCount: view.lineAllocations.length, replayed: false }
}

function exchangeFundingReturnLineAllocationEventKey(returnItemId: number, sourceEventId: number) {
  return `exchange-return-item:${returnItemId}:source:${sourceEventId}:allocation:v1`
}

function exchangeFundingReturnLineReversalEventKey(returnItemId: number, sourceEventId: number) {
  return `exchange-return-item:${returnItemId}:source:${sourceEventId}:reversal:v1`
}

const RETURN_ALLOCATION_NUMERIC_FIELDS = new Set([
  'returnId', 'returnItemId', 'sourceInvoiceId', 'childInvoiceId', 'saleItemId', 'sourceEventId',
  'saleItemQty', 'saleItemValue', 'sourceItemAmount', 'returnedQtyBefore', 'returningQty',
  'returnedQtyAfter', 'priorReturnValue', 'returnValue', 'cumulativeReturnValue',
  'priorAmount', 'amountDelta', 'cumulativeAmount', 'allocationVersion', 'reversesAllocationId'
])

function returnAllocationRowMatches(row: any, expected: Record<string, any>) {
  return Object.entries(expected).every(([field, value]) => {
    if (field === 'reversesAllocationId' && value == null)
      return row[field] == null
    const actual = RETURN_ALLOCATION_NUMERIC_FIELDS.has(field)
      ? (row[field] == null ? null : toNumberRial(row[field]))
      : String(row[field] ?? '')
    return actual === value
  })
}

/** Persist source attribution for one already-created child return item.
 * The helper re-reads the immutable child matrix and all earlier active return
 * allocations; no renderer-supplied source IDs or amounts are trusted. It only
 * writes descriptive accounting attribution, never settlement or entitlement.
 */
export async function recordExchangeFundingReturnLineAllocation(tx: LedgerClient, input: {
  returnId: number
  returnItemId: number
  allocationPolicy?: 'PROPORTIONAL_FLOOR'
}) {
  if (!Number.isSafeInteger(input?.returnId) || input.returnId <= 0 ||
      !Number.isSafeInteger(input?.returnItemId) || input.returnItemId <= 0)
    throw invalid()
  const [ret, returnItem] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: input.returnId } }),
    tx.saleReturnItem.findUnique({ where: { id: input.returnItemId } })
  ])
  if (!ret || !returnItem || Number(returnItem.returnId) !== Number(ret.id) ||
      !['RETURN', 'EXCHANGE'].includes(String(ret.kind)) || ret.voidedAt != null)
    throw new BusinessError('پیوند برگشتِ قلم فرزند معتبر یا فعال نیست؛ هیچ انتسابی ثبت نشد.')

  const returnItems = await tx.saleReturnItem.findMany({
    where: { returnId: Number(ret.id) }, select: { id: true, saleItemId: true }
  }) as any[]
  const returnItemIds = new Set<number>()
  const saleItemIds = new Set<number>()
  for (const item of returnItems) {
    const itemId = Number(item.id)
    const saleItemId = Number(item.saleItemId)
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || returnItemIds.has(itemId) ||
        !Number.isSafeInteger(saleItemId) || saleItemId <= 0 || saleItemIds.has(saleItemId))
      throw new BusinessError('برگشت برای یک قلم فروش چند ردیف تکراری دارد؛ تخصیص تجمعی مبهم است و چیزی ثبت نشد.')
    returnItemIds.add(itemId)
    saleItemIds.add(saleItemId)
  }
  if (!returnItemIds.has(input.returnItemId))
    throw new BusinessError('قلم انتخاب‌شده در همین برگشت نیست؛ هیچ انتسابی ثبت نشد.')

  const childInvoiceId = Number(ret.invoiceId)
  const [invoice, saleItem] = await Promise.all([
    tx.saleInvoice.findUnique({ where: { id: childInvoiceId }, include: { items: true } }),
    tx.saleInvoiceItem.findUnique({ where: { id: Number(returnItem.saleItemId) } })
  ])
  if (!invoice || invoice.orderType !== 'EXCHANGE' || invoice.voidedAt != null ||
      !saleItem || Number(saleItem.invoiceId) !== childInvoiceId ||
      Number(returnItem.variantId) !== Number(saleItem.variantId))
    throw new BusinessError('فاکتور/قلم برگشتی فرزند با scope دفتر منشأ سازگار نیست؛ هیچ انتسابی ثبت نشد.')

  const funding = await getCurrentExchangeFundingSources(tx, childInvoiceId, {
    allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
  })
  if (!funding.snapshotExists || funding.unresolved.length > 0 ||
      funding.lineAllocationStatus !== 'PERSISTED_RECONCILED' ||
      funding.sourceInvoiceId == null || funding.returnId == null ||
      Number(invoice.sourceInvoiceId) !== funding.sourceInvoiceId ||
      Number(invoice.exchangeReturnId) !== funding.returnId)
    throw new BusinessError('lineage یا ماتریس immutable فرزند قابل تطبیق نیست؛ هیچ انتساب برگشتی ثبت نشد.')

  const lineSnapshot = funding.lineItemSnapshots.find((row) => row.saleItemId === Number(returnItem.saleItemId))
  if (!lineSnapshot || lineSnapshot.qty !== Number(saleItem.qty) ||
      !Number.isSafeInteger(lineSnapshot.netValue) || lineSnapshot.netValue < 0 ||
      toNumberRial(returnItem.lineTotal) < 0)
    throw new BusinessError('snapshot تعداد/ارزش قلم فرزند نامعتبر است؛ هیچ انتسابی ثبت نشد.')
  const sourceRows = funding.lineAllocations.filter((row) => row.saleItemId === Number(returnItem.saleItemId))
  const sources = sourceRows.map((row) => ({
    sourceEventId: Number(row.sourceEventId),
    sourceKind: String(row.sourceKind) as ExchangeReturnSourceKind,
    amount: Number(row.amount)
  }))
  if (sources.reduce((sum, row) => sum + row.amount, 0) !== lineSnapshot.netValue)
    throw new BusinessError('جمع سهم‌های منشأ قلم فرزند با snapshot قیمت برابر نیست؛ هیچ انتسابی ثبت نشد.')

  const activeReturns = await tx.saleReturn.findMany({
    where: { invoiceId: childInvoiceId, voidedAt: null },
    include: { items: true }, orderBy: { id: 'asc' }
  })
  const history = (activeReturns as any[]).flatMap((activeReturn) =>
    (activeReturn.items as any[]).filter((item) => Number(item.saleItemId) === Number(returnItem.saleItemId))
      .map((item) => ({ ret: activeReturn, item })))
  if (!history.some((entry) => Number(entry.item.id) === Number(returnItem.id)) ||
      history.some((entry) => Number(entry.ret.id) > Number(ret.id)))
    throw new BusinessError('ترتیب/وضعیت برگشت‌های فعال قلم فرزند ناسازگار است؛ هیچ انتسابی ثبت نشد.')

  let returnedQty = 0
  let priorAllocations: Array<{ sourceEventId: number; amount: number }> = []
  for (const entry of history.filter((candidate) => Number(candidate.ret.id) < Number(ret.id))) {
    const priorQty = Number(entry.item.qty)
    let allocation
    try {
      allocation = allocateExchangeFundingLineReturn({
        saleItemId: Number(returnItem.saleItemId), saleItemQty: lineSnapshot.qty,
        saleItemValue: lineSnapshot.netValue, previouslyReturnedQty: returnedQty,
        returningQty: priorQty, sources, allocationPolicy: input.allocationPolicy,
        ...(returnedQty > 0 && lineSnapshot.netValue > 0 ? { priorAllocations } : {})
      })
    } catch {
      throw new BusinessError('تاریخچهٔ تجمعی تخصیص برگشت قلم فرزند ناقص یا ناسازگار است؛ هیچ انتسابی ثبت نشد.')
    }
    if (allocation.returnValue !== toNumberRial(entry.item.lineTotal))
      throw new BusinessError('مبلغ تاریخی برگشت قلم با snapshot تجمعی سازگار نیست؛ هیچ انتسابی ثبت نشد.')
    const persisted = await tx.exchangeFundingReturnLineAllocation.findMany({
      where: { returnItemId: Number(entry.item.id) },
      orderBy: [{ sourceEventId: 'asc' }, { id: 'asc' }]
    }) as any[]
    const expected = allocation.shares.map((share) => ({
      eventKey: exchangeFundingReturnLineAllocationEventKey(Number(entry.item.id), share.sourceEventId),
      eventKind: 'ALLOCATION', returnId: Number(entry.ret.id), returnItemId: Number(entry.item.id),
      sourceInvoiceId: funding.sourceInvoiceId, childInvoiceId, saleItemId: Number(returnItem.saleItemId),
      sourceEventId: share.sourceEventId, sourceKind: share.sourceKind,
      saleItemQty: lineSnapshot.qty, saleItemValue: lineSnapshot.netValue,
      sourceItemAmount: sources.find((source) => source.sourceEventId === share.sourceEventId)?.amount,
      returnedQtyBefore: returnedQty, returningQty: priorQty, returnedQtyAfter: allocation.returnedQtyAfter,
      priorReturnValue: allocation.cumulativeReturnValue - allocation.returnValue,
      returnValue: allocation.returnValue, cumulativeReturnValue: allocation.cumulativeReturnValue,
      priorAmount: share.prior, amountDelta: share.amount, cumulativeAmount: share.cumulative,
      allocationVersion: input.allocationPolicy === 'PROPORTIONAL_FLOOR' ? 2 : 1, reversesAllocationId: null
    }))
    if (persisted.length !== expected.length || expected.some((row) =>
      !persisted.some((candidate) => candidate.eventKind === 'ALLOCATION' && returnAllocationRowMatches(candidate, row))))
      throw new BusinessError('ردیف تخصیص قبلی برگشت فرزند مفقود/متناقض است؛ هیچ تخصیص تازه‌ای ثبت نشد.')
    returnedQty = allocation.returnedQtyAfter
    priorAllocations = allocation.shares.map((share) => ({ sourceEventId: share.sourceEventId, amount: share.cumulative }))
  }

  let current
  try {
    current = allocateExchangeFundingLineReturn({
      saleItemId: Number(returnItem.saleItemId), saleItemQty: lineSnapshot.qty,
      saleItemValue: lineSnapshot.netValue, previouslyReturnedQty: returnedQty,
      returningQty: Number(returnItem.qty), sources, allocationPolicy: input.allocationPolicy,
      ...(returnedQty > 0 && lineSnapshot.netValue > 0 ? { priorAllocations } : {})
    })
  } catch {
    throw new BusinessError('تعداد/سهم تجمعی برگشت قلم فرزند نامعتبر یا فاقد سابقهٔ لازم است؛ هیچ انتسابی ثبت نشد.')
  }
  if (current.returnValue !== toNumberRial(returnItem.lineTotal))
    throw new BusinessError('ارزش قلم برگشتی با مقدار تجمعی ریالی برابر نیست؛ هیچ انتسابی ثبت نشد.')

  const expectedRows = current.shares.map((share) => {
    const sourceItemAmount = sources.find((source) => source.sourceEventId === share.sourceEventId)?.amount
    if (sourceItemAmount == null || !Number.isSafeInteger(sourceItemAmount) || sourceItemAmount <= 0)
      throw new BusinessError('سهم منبع در ماتریس immutable قلم پیدا نشد؛ هیچ انتسابی ثبت نشد.')
    return {
      eventKey: exchangeFundingReturnLineAllocationEventKey(Number(returnItem.id), share.sourceEventId),
      eventKind: 'ALLOCATION', returnId: Number(ret.id), returnItemId: Number(returnItem.id),
      sourceInvoiceId: funding.sourceInvoiceId, childInvoiceId, saleItemId: Number(returnItem.saleItemId),
      sourceEventId: share.sourceEventId, sourceKind: share.sourceKind,
      saleItemQty: lineSnapshot.qty, saleItemValue: lineSnapshot.netValue,
      sourceItemAmount,
      returnedQtyBefore: returnedQty, returningQty: Number(returnItem.qty),
      returnedQtyAfter: current.returnedQtyAfter,
      priorReturnValue: current.cumulativeReturnValue - current.returnValue,
      returnValue: current.returnValue, cumulativeReturnValue: current.cumulativeReturnValue,
      priorAmount: share.prior, amountDelta: share.amount, cumulativeAmount: share.cumulative,
      allocationVersion: input.allocationPolicy === 'PROPORTIONAL_FLOOR' ? 2 : 1, reversesAllocationId: null
    }
  })
  const existing = await tx.exchangeFundingReturnLineAllocation.findMany({
    where: { returnItemId: Number(returnItem.id) },
    orderBy: [{ sourceEventId: 'asc' }, { id: 'asc' }]
  }) as any[]
  if (existing.length > 0) {
    if (existing.length !== expectedRows.length || expectedRows.some((row) =>
      !existing.some((candidate) => candidate.eventKind === 'ALLOCATION' && returnAllocationRowMatches(candidate, row))))
      throw mismatch()
    return { returnId: Number(ret.id), returnItemId: Number(returnItem.id),
      allocationCount: expectedRows.length, replayed: true, shares: current.shares }
  }
  for (const row of expectedRows) {
    await tx.exchangeFundingReturnLineAllocation.create({
      data: {
        ...row,
        saleItemValue: BigInt(row.saleItemValue), sourceItemAmount: BigInt(row.sourceItemAmount),
        priorReturnValue: BigInt(row.priorReturnValue), returnValue: BigInt(row.returnValue),
        cumulativeReturnValue: BigInt(row.cumulativeReturnValue), priorAmount: BigInt(row.priorAmount),
        amountDelta: BigInt(row.amountDelta), cumulativeAmount: BigInt(row.cumulativeAmount)
      }
    })
  }
  return { returnId: Number(ret.id), returnItemId: Number(returnItem.id),
    allocationCount: expectedRows.length, replayed: false, shares: current.shares }
}

/** Append the exact inverse rows for one child-return attribution. This only
 * reverses the descriptive source allocation; the caller separately proves
 * that cash/credit settlement and physical stock can also be voided.
 */
export async function reverseExchangeFundingReturnLineAllocationsForReturn(tx: LedgerClient, input: {
  returnId: number
}) {
  if (!Number.isSafeInteger(input?.returnId) || input.returnId <= 0) throw invalid()
  const ret = await tx.saleReturn.findUnique({
    where: { id: input.returnId },
    include: { items: true, invoice: { select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true
    } } }
  })
  if (!ret) throw new BusinessError('برگشت برای reversal دفتر تخصیص پیدا نکرد.')
  const childInvoice = ret.invoice as any
  const parentExchangeReturn = childInvoice?.id != null
    ? await tx.saleReturn.findFirst({ where: { exchangeInvoiceId: Number(childInvoice.id) }, select: { id: true } })
    : null
  const isExchangeChild = childInvoice?.orderType === 'EXCHANGE' ||
    childInvoice?.sourceInvoiceId != null || childInvoice?.exchangeReturnId != null || !!parentExchangeReturn
  if (isExchangeChild && ret.kind === 'RETURN') {
    const seenSaleItemIds = new Set<number>()
    for (const item of ret.items as any[]) {
      const saleItemId = Number(item.saleItemId)
      if (!Number.isSafeInteger(saleItemId) || saleItemId <= 0 || seenSaleItemIds.has(saleItemId))
        throw new BusinessError('برگشت فرزند برای یک قلم فروش چند ردیف تکراری دارد؛ تخصیص تجمعی مبهم است.')
      seenSaleItemIds.add(saleItemId)
    }
  }
  const ledgerRows = await tx.exchangeFundingReturnLineAllocation.findMany({
    where: { returnId: input.returnId },
    orderBy: [{ returnItemId: 'asc' }, { sourceEventId: 'asc' }, { id: 'asc' }]
  }) as any[]
  const rows = ledgerRows.filter((row) => row.eventKind === 'ALLOCATION')
  if (ledgerRows.some((row) => row.eventKind !== 'ALLOCATION' && row.eventKind !== 'REVERSAL'))
    throw mismatch()
  const allocationIds = new Set(rows.map((row) => Number(row.id)))
  const reversalRows = ledgerRows.filter((row) => row.eventKind === 'REVERSAL')
  if (reversalRows.some((row) => !Number.isSafeInteger(Number(row.reversesAllocationId)) ||
      Number(row.reversesAllocationId) <= 0 || !allocationIds.has(Number(row.reversesAllocationId))))
    throw new BusinessError('ردیف reversal یتیم یا متصل به تخصیص دیگری است؛ دفتر برگشت قابل تطبیق نیست.')
  if (rows.length === 0) {
    if (isExchangeChild && ret.kind === 'RETURN' && (ret.items as any[]).length > 0)
      throw new BusinessError('برگشت فرزند فاقد تخصیص قلمی است؛ reversal کامل اثبات نمی‌شود.')
    return { reversed: 0, items: 0, replayed: false }
  }
  if (ret.kind !== 'RETURN' || !childInvoice || childInvoice.orderType !== 'EXCHANGE' ||
      Number(childInvoice.id) !== Number(ret.invoiceId) ||
      !Number.isSafeInteger(Number(childInvoice.sourceInvoiceId)) || Number(childInvoice.sourceInvoiceId) <= 0 ||
      !Number.isSafeInteger(Number(childInvoice.exchangeReturnId)) || Number(childInvoice.exchangeReturnId) <= 0)
    throw new BusinessError('scope فاکتور/برگشت فرزند با دفتر تخصیص سازگار نیست؛ reversal ثبت نشد.')

  const childLineAllocations = await tx.exchangeFundingLineAllocation.findMany({
    where: { childInvoiceId: Number(childInvoice.id) },
    orderBy: [{ sourceEventId: 'asc' }, { saleItemId: 'asc' }]
  }) as any[]
  const sourceKinds = new Set(['SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'])
  const lineAllocationByCell = new Map<string, any>()
  for (const source of childLineAllocations) {
    const sourceInvoiceId = Number(source.sourceInvoiceId)
    const childInvoiceId = Number(source.childInvoiceId)
    const returnId = Number(source.returnId)
    const saleItemId = Number(source.saleItemId)
    const sourceEventId = Number(source.sourceEventId)
    const saleItemQty = Number(source.saleItemQty)
    const saleItemValue = toNumberRial(source.saleItemValue)
    const amount = toNumberRial(source.amount)
    const key = `${saleItemId}:${sourceEventId}`
    if (!Number.isSafeInteger(sourceInvoiceId) || sourceInvoiceId !== Number(childInvoice.sourceInvoiceId) ||
        childInvoiceId !== Number(childInvoice.id) || returnId !== Number(childInvoice.exchangeReturnId) ||
        !Number.isSafeInteger(saleItemId) || saleItemId <= 0 ||
        !Number.isSafeInteger(sourceEventId) || sourceEventId <= 0 ||
        !Number.isSafeInteger(saleItemQty) || saleItemQty <= 0 ||
        !Number.isSafeInteger(saleItemValue) || saleItemValue <= 0 ||
        !Number.isSafeInteger(amount) || amount <= 0 || amount > saleItemValue ||
        !sourceKinds.has(String(source.sourceKind)) || lineAllocationByCell.has(key))
      throw new BusinessError('ماتریس immutable منشأ قلم فرزند ناسازگار است؛ reversal ثبت نشد.')
    lineAllocationByCell.set(key, source)
  }
  if (childLineAllocations.length === 0)
    throw new BusinessError('ماتریس immutable منشأ قلم فرزند پیدا نشد؛ reversal ثبت نشد.')

  const returnItems = (ret.items as any[]).slice().sort((a, b) => Number(a.id) - Number(b.id))
  const returnItemIds = returnItems.map((item) => Number(item.id))
  const uniqueReturnItemIds = new Set(returnItemIds)
  const allocationByReturnItem = new Map<number, any[]>()
  for (const row of rows) {
    const key = Number(row.returnItemId)
    const bucket = allocationByReturnItem.get(key) ?? []
    bucket.push(row)
    allocationByReturnItem.set(key, bucket)
  }
  if (returnItems.length === 0 || uniqueReturnItemIds.size !== returnItems.length ||
      returnItems.some((item) => Number(item.returnId) !== input.returnId ||
        !Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0 ||
        !Number.isSafeInteger(Number(item.saleItemId)) || Number(item.saleItemId) <= 0) ||
      allocationByReturnItem.size !== returnItems.length ||
      returnItemIds.some((returnItemId) => !allocationByReturnItem.has(returnItemId)))
    throw new BusinessError('برگشت فرزند حداقل یک قلمِ فاقد تخصیص منشأ دارد؛ reversal کامل ثبت نشد.')
  const items = await tx.saleReturnItem.findMany({ where: { id: { in: returnItemIds } } }) as any[]
  if (items.length !== returnItemIds.length || items.some((item) => Number(item.returnId) !== input.returnId))
    throw new BusinessError('پیوند ردیف‌های دفتر با قلم فیزیکی برگشت ناسازگار است؛ reversal ثبت نشد.')
  const returnItemLedgerRows = await tx.exchangeFundingReturnLineAllocation.findMany({
    where: { returnItemId: { in: returnItemIds } },
    orderBy: [{ returnItemId: 'asc' }, { sourceEventId: 'asc' }, { id: 'asc' }]
  }) as any[]
  const returnLedgerRowIds = new Set(ledgerRows.map((row) => Number(row.id)))
  if (returnItemLedgerRows.length !== ledgerRows.length ||
      returnItemLedgerRows.some((row) => Number(row.returnId) !== input.returnId ||
        !returnLedgerRowIds.has(Number(row.id))))
    throw new BusinessError('ردیف دفتر برگشت زیر شناسهٔ برگشت یا قلم دیگری پنهان شده است؛ reversal ثبت نشد.')
  const saleItemIds = [...new Set(items.map((item) => Number(item.saleItemId)))]
  const laterActive = await tx.saleReturnItem.findMany({
    where: {
      saleItemId: { in: saleItemIds },
      returnId: { not: input.returnId },
      return: { voidedAt: null, id: { gt: input.returnId } }
    }, select: { id: true, saleItemId: true, returnId: true }
  }) as any[]
  if (laterActive.length > 0)
    throw new BusinessError('برگشت قدیمی‌ترِ همین قلم قابل ابطال نیست؛ ابتدا برگشت فعالِ جدیدتر را تعیین‌تکلیف کنید (LIFO).')

  // Re-derive every active allocation from the immutable child matrix and the
  // preceding active physical returns before writing any inverse. The ledger
  // rows are append-only, but a structurally valid forged row must not be
  // treated as proof of its own cumulative history.
  if (ret.voidedAt != null) {
    if (reversalRows.length !== rows.length)
      throw new BusinessError('برگشت ابطال‌شده reversal کامل ندارد؛ هیچ ردیف معکوسی افزوده نشد.')
  } else {
    for (const item of returnItems) {
      try {
        await recordExchangeFundingReturnLineAllocation(tx, {
          returnId: input.returnId, returnItemId: Number(item.id)
        })
      } catch {
        throw new BusinessError('تاریخچه/سهم تجمعی دفتر برگشت با برگشت‌های فیزیکی فعال سازگار نیست؛ reversal ثبت نشد.')
      }
    }
  }

  let reversed = 0
  let replayed = true
  for (const row of rows) {
    const rowItem = items.find((item) => Number(item.id) === Number(row.returnItemId))
    const sourceLine = lineAllocationByCell.get(`${Number(row.saleItemId)}:${Number(row.sourceEventId)}`)
    const amountDelta = toNumberRial(row.amountDelta)
    if (!rowItem || !sourceLine || Number(row.returnId) !== input.returnId ||
        Number(row.returnItemId) !== Number(rowItem.id) ||
        Number(row.saleItemId) !== Number(rowItem.saleItemId) ||
        Number(row.sourceInvoiceId) !== Number(childInvoice.sourceInvoiceId) ||
        Number(row.childInvoiceId) !== Number(ret.invoiceId) ||
        String(row.sourceKind) !== String(sourceLine.sourceKind) ||
        Number(row.saleItemQty) !== Number(sourceLine.saleItemQty) ||
        toNumberRial(row.saleItemValue) !== toNumberRial(sourceLine.saleItemValue) ||
        toNumberRial(row.sourceItemAmount) !== toNumberRial(sourceLine.amount) ||
        Number(row.returningQty) !== Number(rowItem.qty) ||
        toNumberRial(row.returnValue) !== toNumberRial(rowItem.lineTotal) ||
        Number(row.allocationVersion) !== 1 ||
        String(row.eventKey) !== exchangeFundingReturnLineAllocationEventKey(Number(row.returnItemId), Number(row.sourceEventId)) ||
        !Number.isSafeInteger(amountDelta) || amountDelta < 0 || amountDelta > toNumberRial(sourceLine.amount) ||
        toNumberRial(row.cumulativeAmount) > toNumberRial(sourceLine.amount))
      throw new BusinessError('snapshot تخصیص برگشت با ماتریس immutable منشأ ناسازگار است؛ reversal ثبت نشد.')
    const reversalKey = exchangeFundingReturnLineReversalEventKey(Number(row.returnItemId), Number(row.sourceEventId))
    const existing = await tx.exchangeFundingReturnLineAllocation.findUnique({ where: { reversesAllocationId: Number(row.id) } })
    const reversal = {
      eventKey: reversalKey, eventKind: 'REVERSAL', returnId: Number(row.returnId),
      returnItemId: Number(row.returnItemId), sourceInvoiceId: Number(row.sourceInvoiceId),
      childInvoiceId: Number(row.childInvoiceId), saleItemId: Number(row.saleItemId),
      sourceEventId: Number(row.sourceEventId), sourceKind: String(row.sourceKind),
      saleItemQty: Number(row.saleItemQty), saleItemValue: toNumberRial(row.saleItemValue),
      sourceItemAmount: toNumberRial(row.sourceItemAmount),
      returnedQtyBefore: Number(row.returnedQtyBefore), returningQty: Number(row.returningQty),
      returnedQtyAfter: Number(row.returnedQtyAfter), priorReturnValue: toNumberRial(row.priorReturnValue),
      returnValue: toNumberRial(row.returnValue), cumulativeReturnValue: toNumberRial(row.cumulativeReturnValue),
      priorAmount: toNumberRial(row.cumulativeAmount), amountDelta: -toNumberRial(row.amountDelta),
      cumulativeAmount: toNumberRial(row.priorAmount), allocationVersion: Number(row.allocationVersion),
      reversesAllocationId: Number(row.id)
    }
    if (existing) {
      if (existing.eventKind !== 'REVERSAL' || !returnAllocationRowMatches(existing, reversal))
        throw mismatch()
      reversed++
      continue
    }
    const byKey = await tx.exchangeFundingReturnLineAllocation.findUnique({ where: { eventKey: reversalKey } })
    if (byKey) throw mismatch()
    await tx.exchangeFundingReturnLineAllocation.create({
      data: {
        ...reversal,
        saleItemValue: BigInt(reversal.saleItemValue), sourceItemAmount: BigInt(reversal.sourceItemAmount),
        priorReturnValue: BigInt(reversal.priorReturnValue), returnValue: BigInt(reversal.returnValue),
        cumulativeReturnValue: BigInt(reversal.cumulativeReturnValue), priorAmount: BigInt(reversal.priorAmount),
        amountDelta: BigInt(reversal.amountDelta), cumulativeAmount: BigInt(reversal.cumulativeAmount)
      }
    })
    reversed++
    replayed = false
  }
  return { reversed, items: returnItemIds.length, replayed }
}

/** Capture persisted tender/redemption rows for an ordinary sale. This does not
 * read renderer provenance and deliberately quarantines malformed credit joins
 * and unsupported tenders as SOURCE_UNKNOWN. EXCHANGE invoices need their own
 * returned-goods allocation path and are rejected here.
 */
export async function recordSaleFundingSnapshot(tx: LedgerClient, invoiceId: number, revision = 1) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || !Number.isSafeInteger(revision) || revision <= 0) throw invalid()
  const invoice = await tx.saleInvoice.findUnique({
    where: { id: invoiceId }, select: {
      id: true, grandTotal: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true
    }
  })
  if (!invoice) throw new BusinessError('فاکتور برای ثبت منشأ مالی پیدا نشد؛ عملیات متوقف شد.')
  if (await isExchangeChildInvoiceWithLineage(tx, invoice))
    throw new BusinessError('سند تعویض/فرزند تعویض به تخصیص مستقل ارزش برگشتی نیاز دارد؛ snapshot فروش عادی روی آن اعمال نشد.')
  if (await tx.saleReturn.count({ where: { invoiceId, voidedAt: null } }))
    throw new BusinessError('برای فاکتور دارای برگشت قبلی، snapshot منشأ تاریخی حدس زده نمی‌شود؛ تطبیق شاهددار لازم است.')
  const priorTransfer = await tx.exchangeFundingEvent.findFirst({
    where: { sourceInvoiceId: invoiceId, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } }, select: { id: true }
  })
  if (priorTransfer)
    throw new BusinessError('پس از انتقال منشأ به سند تعویض، snapshot مبدأ بازنویسی نمی‌شود؛ اصلاح شاهددار لازم است.')

  const snapshotHistory = await tx.exchangeFundingEvent.findMany({ where: { sourceInvoiceId: invoiceId } })
  const revisionPattern = new RegExp(`^sale:${invoiceId}:r(\\d+):`)
  const revisionRows = snapshotHistory.filter((row: any) => revisionPattern.test(String(row.eventKey)))
  const maximumRevision = revisionRows.reduce((max: number, row: any) => {
    const match = revisionPattern.exec(String(row.eventKey))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  const targetPrefix = `sale:${invoiceId}:r${revision}:`
  const targetRows = revisionRows.filter((row: any) => String(row.eventKey).startsWith(targetPrefix))
  if (targetRows.length) {
    if (maximumRevision !== revision) throw mismatch()
  } else {
    if (maximumRevision !== revision - 1)
      throw new BusinessError('نسخهٔ snapshot باید پیاپی و پس از نسخهٔ قبلی ثبت شود؛ هیچ منشأ تازه‌ای افزوده نشد.')
    for (const row of revisionRows) {
      const match = revisionPattern.exec(String(row.eventKey))
      if (!match || Number(match[1]) >= revision || String(row.kind).startsWith('VOID_')) continue
      if (!await eventHasReversal(tx, Number(row.id)))
        throw new BusinessError('نسخهٔ قبلی snapshot هنوز به‌طور کامل ابطال نشده است؛ از مسیر اصلاح snapshot استفاده شود.')
    }
  }

  const [payments, redemptions] = await Promise.all([
    tx.payment.findMany({ where: { invoiceId, voidedAt: null }, orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      include: { method: { select: { kind: true } } } }),
    tx.storeCreditRedemption.findMany({ where: { invoiceId, reversedAt: null }, orderBy: { id: 'asc' } })
  ])
  const byPayment = new Map<number, any[]>()
  for (const redemption of redemptions as any[]) {
    if (redemption.paymentId == null) continue
    const list = byPayment.get(Number(redemption.paymentId)) ?? []
    list.push(redemption)
    byPayment.set(Number(redemption.paymentId), list)
  }
  const livePaymentIds = new Set((payments as any[]).map((p) => Number(p.id)))
  const orphanedRedemption = (redemptions as any[]).some((r) => r.paymentId == null || !livePaymentIds.has(Number(r.paymentId)))
  let remainingInvoiceValue = toNumberRial(invoice.grandTotal)
  if (remainingInvoiceValue < 0) throw invalid()
  let funded = 0, gift = 0, real = 0, unknown = 0, overpay = 0
  const events: any[] = []

  for (const payment of payments as any[]) {
    const paymentAmount = toNumberRial(payment.amount)
    if (paymentAmount <= 0) throw invalid()
    const redemptionRows = byPayment.get(Number(payment.id)) ?? []
    const methodKind = String(payment.method?.kind ?? '').toUpperCase()
    const entryKind = String(payment.kind ?? 'CASH').toUpperCase()
    const creditShape = payment.storeCreditId != null || methodKind === 'STORE_CREDIT'
    let sourceKind = 'SOURCE_UNKNOWN'
    let sourceCreditId: number | null = null
    let sourceRedemptionId: number | null = null
    let sourceRootShareId: string | null = null
    if (entryKind === 'CHEQUE' && payment.chequeStatus !== 'CLEARED') {
      const bounced = payment.chequeStatus === 'BOUNCED'
      const quarantined = await appendExchangeFundingEvent(tx, {
        eventKey: `sale:${invoiceId}:r${revision}:payment:${payment.id}:${bounced ? 'bounced' : 'pending'}-cheque`,
        kind: bounced ? 'BOUNCED_CHEQUE' : 'PENDING_CHEQUE', amount: paymentAmount,
        shareId: `${bounced ? 'bounced' : 'pending'}-cheque:${payment.id}`, rootShareId: `payment:${payment.id}`,
        sourceInvoiceId: invoiceId, sourcePaymentId: Number(payment.id),
        sourceMethodKind: methodKind || null,
        evidenceKind: bounced ? 'BOUNCED_CHEQUE_ROW' : 'UNCLEARED_CHEQUE_ROW',
        evidenceRef: `Payment:${payment.id}`
      })
      events.push(quarantined.event)
      continue
    }
    if (!orphanedRedemption && redemptionRows.length === 1) {
      const redemption = redemptionRows[0]
      if (creditShape && Number(redemption.creditId) === Number(payment.storeCreditId) &&
          toNumberRial(redemption.amount) === paymentAmount && redemption.compensatedAt == null) {
        sourceKind = 'SOURCE_GIFT'
        sourceCreditId = Number(redemption.creditId)
        sourceRedemptionId = Number(redemption.id)
        const credit = await tx.storeCredit.findUnique({ where: { id: Number(redemption.creditId) },
          select: { exchangeResidualRightKey: true } })
        if (credit?.exchangeResidualRightKey && tx.exchangeResidualRightEvent) {
          const opening = await tx.exchangeResidualRightEvent.findFirst({ where: {
            rightKey: credit.exchangeResidualRightKey, eventKind: 'OPENED'
          } })
          if (opening?.rightKind === 'N' || opening?.rightKind === 'B') {
            sourceKind = opening.rightKind === 'N' ? 'SOURCE_N' : 'SOURCE_B'
            sourceRootShareId = String(opening.rootShareId)
          }
        }
      }
    } else if (!orphanedRedemption && redemptionRows.length === 0 && !creditShape) {
      if (entryKind === 'CHEQUE') sourceKind = payment.chequeStatus === 'CLEARED' ? 'SOURCE_CHEQUE' : 'SOURCE_UNKNOWN'
      else if (methodKind === 'CASH' || methodKind === 'CARD') sourceKind = `SOURCE_${methodKind}`
    }
    const allocated = Math.min(remainingInvoiceValue, paymentAmount)
    const excess = paymentAmount - allocated
    const creditSource = sourceKind === 'SOURCE_GIFT' || sourceKind === 'SOURCE_N' || sourceKind === 'SOURCE_B'
    const shareId = creditSource ? `redemption:${sourceRedemptionId}` : `payment:${payment.id}`
    const rootShareId = sourceKind === 'SOURCE_N' || sourceKind === 'SOURCE_B' ? String(sourceRootShareId) :
      sourceKind === 'SOURCE_GIFT' ? `credit:${sourceCreditId}` : `payment:${payment.id}`
    if (allocated > 0) {
      const recorded = await appendExchangeFundingEvent(tx, {
        eventKey: `sale:${invoiceId}:r${revision}:payment:${payment.id}:funded`, kind: sourceKind, amount: allocated,
        shareId, rootShareId, sourceInvoiceId: invoiceId, sourcePaymentId: Number(payment.id),
        sourceRedemptionId, sourceCreditId, sourceMethodKind: methodKind || null,
        sourceDestination: payment.destination ?? null,
        evidenceKind: sourceKind === 'SOURCE_UNKNOWN' ? 'UNRESOLVED_PAYMENT_ROW' : 'PAYMENT_ROW',
        evidenceRef: `Payment:${payment.id}`
      })
      events.push(recorded.event)
      if (sourceKind === 'SOURCE_GIFT') gift += allocated
      else if (['SOURCE_N', 'SOURCE_B', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'].includes(sourceKind)) real += allocated
      else unknown += allocated
      funded += allocated
      remainingInvoiceValue -= allocated
    }
    if (excess > 0) {
      const extra = await appendExchangeFundingEvent(tx, {
        eventKey: `sale:${invoiceId}:r${revision}:payment:${payment.id}:overpay`, kind: 'SOURCE_OVERPAY', amount: excess,
        shareId: `overpay:${payment.id}`, rootShareId: `payment:${payment.id}`,
        sourceInvoiceId: invoiceId, sourcePaymentId: Number(payment.id),
        sourceMethodKind: methodKind || null, sourceDestination: payment.destination ?? null,
        evidenceKind: 'PAYMENT_ROW_EXCESS', evidenceRef: `Payment:${payment.id}`
      })
      events.push(extra.event)
      overpay += excess
    }
  }
  let debt = 0
  if (remainingInvoiceValue > 0) {
    debt = remainingInvoiceValue
    const opened = await appendExchangeFundingEvent(tx, {
      eventKey: `sale:${invoiceId}:r${revision}:debt`, kind: 'DEBT_OPEN', amount: debt,
      shareId: `debt:${invoiceId}`, rootShareId: `debt:${invoiceId}`,
      sourceInvoiceId: invoiceId, debtId: invoiceId,
      evidenceKind: 'INVOICE_BALANCE', evidenceRef: `SaleInvoice:${invoiceId}`
    })
    events.push(opened.event)
  }
  return { events, funded, gift, real, unknown, debt, overpay }
}

/** Record a debt reduction funded by returned exchange value, never by the
 * uncleared cheque itself. The signed event consumes only the debt share and
 * stays separate from the carried paid-source shares.
 */
export async function recordExchangeDebtOffset(tx: LedgerClient, input: {
  invoiceId: number
  childInvoiceId: number
  returnId: number
  paymentId: number
  amount: number
  chequeStatusBefore: 'PENDING' | 'BOUNCED'
  actorUserId?: number | null
}) {
  if (![input.invoiceId, input.childInvoiceId, input.returnId, input.paymentId, input.amount]
      .every((value) => Number.isSafeInteger(value) && value > 0) ||
      !['PENDING', 'BOUNCED'].includes(input.chequeStatusBefore)) throw invalid()
  const eventKey = `sale:${input.invoiceId}:r1:debt-offset:return:${input.returnId}`
  const prior = await tx.exchangeFundingEvent.findUnique({ where: { eventKey } })
  if (prior) {
    if (prior.kind !== 'DEBT_OFFSET' || toNumberRial(prior.amount) !== -input.amount ||
        Number(prior.sourceInvoiceId) !== input.invoiceId || Number(prior.childInvoiceId) !== input.childInvoiceId ||
        Number(prior.returnId) !== input.returnId || Number(prior.sourcePaymentId) !== input.paymentId ||
        Number(prior.debtId) !== input.invoiceId || prior.shareId !== `debt:${input.invoiceId}` ||
        (prior.sourceMethodKind != null && prior.sourceMethodKind !== input.chequeStatusBefore) ||
        prior.evidenceKind !== 'EXCHANGE_DEBT_OFFSET' || prior.evidenceRef !== `SaleReturn:${input.returnId}`)
      throw mismatch()
    return { event: prior, replayed: true }
  }
  const [open, ret, payment, backing] = await Promise.all([
    exchangeFundingBalance(tx, `debt:${input.invoiceId}`),
    tx.saleReturn.findUnique({ where: { id: input.returnId } }),
    tx.payment.findUnique({ where: { id: input.paymentId } }),
    tx.exchangeFundingEvent.findFirst({ where: {
      sourceInvoiceId: input.invoiceId, sourcePaymentId: input.paymentId, kind: 'DEBT_OPEN', debtId: input.invoiceId
    } })
  ])
  if (!Number.isSafeInteger(open) || input.amount > open || !ret || ret.voidedAt != null ||
      ret.kind !== 'EXCHANGE' || Number(ret.invoiceId) !== input.invoiceId ||
      Number(ret.exchangeInvoiceId) !== input.childInvoiceId || toNumberRial(ret.debtReduction) !== input.amount ||
      !payment || Number(payment.invoiceId) !== input.invoiceId || payment.kind !== 'CHEQUE' ||
      payment.chequeStatus !== 'DEBT_OFFSET' || toNumberRial(payment.amount) !== input.amount ||
      !backing || toNumberRial(backing.amount) !== input.amount)
    throw new BusinessError('کاهش بدهی با سند برگشت/چکِ بدهی باز قابل تطبیق نیست؛ هیچ مبلغی به carry افزوده نشد.')
  return appendExchangeFundingEvent(tx, {
    eventKey, kind: 'DEBT_OFFSET', amount: -input.amount,
    shareId: `debt:${input.invoiceId}`, rootShareId: `debt:${input.invoiceId}`,
    sourceInvoiceId: input.invoiceId, childInvoiceId: input.childInvoiceId,
    returnId: input.returnId, sourcePaymentId: input.paymentId, debtId: input.invoiceId,
    sourceMethodKind: input.chequeStatusBefore,
    evidenceKind: 'EXCHANGE_DEBT_OFFSET', evidenceRef: `SaleReturn:${input.returnId}`,
    actorUserId: input.actorUserId ?? null
  })
}

/** Reverse an S11 debt offset only while the original cheque is still in its
 * offset state. The source cheque status and the debt share are restored by
 * linked append-only evidence; a later clearance, suspense route, or manual
 * resolution makes pair void unsafe and is rejected.
 */
export async function reverseExchangeDebtOffsetForReturn(tx: LedgerClient, input: {
  returnId: number
  actorUserId?: number | null
}) {
  if (!Number.isSafeInteger(input?.returnId) || input.returnId <= 0 ||
      (input.actorUserId != null && (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0))) throw invalid()
  const ret = await tx.saleReturn.findUnique({ where: { id: input.returnId }, select: {
    id: true, invoiceId: true, kind: true, debtReduction: true, exchangeInvoiceId: true, voidedAt: true,
    exchangeSettlement: true
  } })
  const eventKey = ret ? `sale:${ret.invoiceId}:r1:debt-offset:return:${ret.id}` : ''
  const offset = eventKey ? await tx.exchangeFundingEvent.findUnique({ where: { eventKey } }) : null
  if (!offset) {
    if (ret && ret.exchangeSettlement === 'S11_DEBT_OFFSET_RIGHTS' && toNumberRial(ret.debtReduction) > 0)
      throw new BusinessError('ابطال تعویض ممکن نیست: کاهش بدهی S11 شاهد رویداد جبرانیِ قابل‌اثبات ندارد؛ از مسیر تسویه/اصلاح بدهی استفاده کنید.')
    return { reversed: false, amount: 0, paymentId: null, previousStatus: null }
  }
  const amount = -toNumberRial(offset.amount)
  const paymentId = Number(offset.sourcePaymentId)
  if (!ret || ret.voidedAt != null || ret.kind !== 'EXCHANGE' ||
      ret.exchangeSettlement !== 'S11_DEBT_OFFSET_RIGHTS' || !Number.isSafeInteger(amount) || amount <= 0 ||
      toNumberRial(ret.debtReduction) !== amount || Number(offset.sourceInvoiceId) !== Number(ret.invoiceId) ||
      Number(offset.childInvoiceId) !== Number(ret.exchangeInvoiceId) || Number(offset.returnId) !== Number(ret.id) ||
      Number(offset.debtId) !== Number(ret.invoiceId) || offset.shareId !== `debt:${ret.invoiceId}` ||
      offset.kind !== 'DEBT_OFFSET' || offset.evidenceKind !== 'EXCHANGE_DEBT_OFFSET' ||
      offset.evidenceRef !== `SaleReturn:${ret.id}` ||
      (offset.sourceMethodKind != null && !['PENDING', 'BOUNCED'].includes(String(offset.sourceMethodKind))))
    throw new BusinessError('ابطال تعویض ممکن نیست: رویداد کاهش بدهی/چک با سند برگشت تطبیق ندارد؛ اصلاح شاهددار لازم است.')
  const priorReversal = await tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(offset.id) } })
  if (priorReversal) throw new BusinessError('ابطال تعویض ممکن نیست: کاهش بدهی این برگشت قبلاً معکوس شده یا رویداد معکوس آن متعارض است.')
  const payment = await tx.payment.findUnique({ where: { id: paymentId } })
  const [history, laterEffects, debtBalance] = await Promise.all([
    tx.paymentChequeStatusHistory.findMany({ where: { paymentId }, orderBy: { id: 'asc' } }),
    tx.exchangeFundingEvent.findMany({ where: { sourcePaymentId: paymentId, kind: { in: [
      'CHEQUE_CLEARED', 'SUSPENSE_CHEQUE_LATE', 'SUSPENSE_CHEQUE_RESOLVED',
      'SUSPENSE_CHEQUE_REFUNDED', 'DEBT_SETTLE'
    ] } }, select: { id: true, kind: true } }),
    exchangeFundingBalance(tx, `debt:${ret.invoiceId}`)
  ])
  const latestHistory = history[history.length - 1]
  const offsetHistoryIndex = (history as Array<{ status?: string | null }>).findIndex(
    (row: { status?: string | null }) => row.status === 'DEBT_OFFSET'
  )
  const previousStatusValue = ['PENDING', 'BOUNCED'].includes(String(offset.sourceMethodKind))
    ? String(offset.sourceMethodKind)
    : offsetHistoryIndex > 0 ? String(history[offsetHistoryIndex - 1]?.status ?? '') : null
  const previousStatus: 'PENDING' | 'BOUNCED' | null =
    previousStatusValue === 'PENDING' || previousStatusValue === 'BOUNCED' ? previousStatusValue : null
  if (!payment || Number(payment.invoiceId) !== Number(ret.invoiceId) || payment.kind !== 'CHEQUE' ||
      payment.chequeStatus !== 'DEBT_OFFSET' || toNumberRial(payment.amount) !== amount ||
      latestHistory?.status !== 'DEBT_OFFSET' || previousStatus == null ||
      !Number.isSafeInteger(debtBalance) || debtBalance < 0 || laterEffects.length > 0)
    throw new BusinessError(
      'ابطال تعویض ممکن نیست: چکِ کاهش‌دهندهٔ بدهی پس از offset تسویه، وارد suspense یا اصلاح شده است؛ ' +
      'رویداد معتبرِ برگشت بدهی موجود نیست. ابتدا از مسیر تسویه/رسیدگی چک اقدام کنید.'
    )
  const reversalKey = `${eventKey}:void`
  const changed = await tx.payment.updateMany({
    where: { id: paymentId, chequeStatus: 'DEBT_OFFSET' },
    data: { chequeStatus: previousStatus, clearedAt: null, clearedAtJalali: null,
      clearedShiftId: null, clearedByUserId: null, destination: null,
      note: [String(payment.note ?? '').trim(),
        `S12: offset بدهی با ابطال تعویض ${ret.id} معکوس شد؛ چک منبع پرداخت نیست`]
        .filter(Boolean).join(' · ') }
  })
  if (changed.count !== 1) throw new BusinessError('ابطال تعویض ممکن نیست: وضعیت چک همزمان تغییر کرد؛ دوباره بخوانید و تلاش کنید.')
  const restoredHistory = await tx.paymentChequeStatusHistory.create({ data: {
    paymentId, status: previousStatus, userId: input.actorUserId ?? null, changedAt: new Date()
  } })
  const appended = await appendExchangeFundingEvent(tx, {
    eventKey: reversalKey, kind: 'VOID_DEBT_OFFSET', amount,
    shareId: String(offset.shareId), rootShareId: String(offset.rootShareId),
    sourceInvoiceId: Number(ret.invoiceId), childInvoiceId: Number(ret.exchangeInvoiceId),
    returnId: Number(ret.id), sourcePaymentId: paymentId, debtId: Number(ret.invoiceId),
    sourceMethodKind: offset.sourceMethodKind == null ? null : String(offset.sourceMethodKind), reversesEventId: Number(offset.id),
    evidenceKind: 'EXCHANGE_VOID',
    evidenceRef: `SaleReturn:${ret.id}:PaymentChequeStatusHistory:${restoredHistory.id}`,
    actorUserId: input.actorUserId ?? null
  })
  return { reversed: !appended.replayed, amount, paymentId, previousStatus: String(previousStatus) }
}

/** Record one witnessed payment that settles an exchange-child debt. The signed
 * DEBT_SETTLE stays on the original debt share; its matching source event proves
 * the newly received tender for later lineage without turning the debt event
 * itself into cash/card.
 */
export async function recordExchangeDebtSettlement(tx: LedgerClient, input: {
  invoiceId: number
  paymentId: number
  amount: number
  tender: 'CASH' | 'CARD' | 'CHEQUE'
  sourceMethodKind?: string | null
  destination: string | null
  evidenceRef: string
  actorUserId?: number | null
}) {
  if (!Number.isSafeInteger(input.invoiceId) || input.invoiceId <= 0 ||
      !Number.isSafeInteger(input.paymentId) || input.paymentId <= 0 ||
      !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
      !['CASH', 'CARD', 'CHEQUE'].includes(input.tender) ||
      typeof input.evidenceRef !== 'string' || input.evidenceRef.trim().length < 3 ||
      input.evidenceRef.length > 500) throw invalid()
  const debtShare = `debt:${input.invoiceId}`
  const settleKey = `sale:${input.invoiceId}:r1:debt-settle:payment:${input.paymentId}`
  const sourceKey = `sale:${input.invoiceId}:r1:payment:${input.paymentId}:funded`
  const [priorSettle, priorSource] = await Promise.all([
    tx.exchangeFundingEvent.findUnique({ where: { eventKey: settleKey } }),
    tx.exchangeFundingEvent.findUnique({ where: { eventKey: sourceKey } })
  ])
  const sourceKind = `SOURCE_${input.tender}`
  if (priorSettle || priorSource) {
    if (!priorSettle || !priorSource || toNumberRial(priorSettle.amount) !== -input.amount ||
        priorSettle.debtId !== input.invoiceId || priorSettle.sourcePaymentId !== input.paymentId ||
        priorSource.kind !== sourceKind || toNumberRial(priorSource.amount) !== input.amount ||
        priorSource.sourcePaymentId !== input.paymentId) throw mismatch()
    return { settleEvent: priorSettle, sourceEvent: priorSource, replayed: true }
  }
  const open = await exchangeFundingBalance(tx, debtShare)
  if (!Number.isSafeInteger(open) || open < 0 || input.amount > open)
    throw new BusinessError('مبلغ تسویه از بدهی بازِ همین تعویض بیشتر است؛ هیچ تسویه‌ای ثبت نشد.')
  const settle = await appendExchangeFundingEvent(tx, {
    eventKey: settleKey, kind: 'DEBT_SETTLE', amount: -input.amount,
    shareId: debtShare, rootShareId: debtShare, sourceInvoiceId: input.invoiceId,
    sourcePaymentId: input.paymentId, debtId: input.invoiceId,
    sourceMethodKind: input.tender, sourceDestination: input.destination,
    evidenceKind: 'WITNESSED_PAYMENT', evidenceRef: input.evidenceRef.trim(), actorUserId: input.actorUserId ?? null
  })
  const source = await appendExchangeFundingEvent(tx, {
    eventKey: sourceKey, kind: sourceKind, amount: input.amount,
    shareId: `payment:${input.paymentId}`, rootShareId: `payment:${input.paymentId}`,
    sourceInvoiceId: input.invoiceId, sourcePaymentId: input.paymentId,
    sourceMethodKind: input.sourceMethodKind ?? input.tender, sourceDestination: input.destination,
    evidenceKind: 'PAYMENT_ROW', evidenceRef: `Payment:${input.paymentId}`, actorUserId: input.actorUserId ?? null
  })
  return { settleEvent: settle.event, sourceEvent: source.event, replayed: false }
}

/** Append-only status evidence. This event never changes debt balance or creates
 * a cash/right source; only the payment's authoritative status transition does.
 */
export async function recordExchangeChequeStatusEvent(tx: LedgerClient, input: {
  invoiceId: number
  paymentId: number
  amount: number
  status: 'CHEQUE_BOUNCED' | 'CHEQUE_CLEARED' | 'SUSPENSE_CHEQUE_LATE'
  statusHistoryId: number
  actorUserId?: number | null
  evidenceRef?: string | null
}) {
  if (!Number.isSafeInteger(input.invoiceId) || input.invoiceId <= 0 ||
      !Number.isSafeInteger(input.paymentId) || input.paymentId <= 0 ||
      !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
      !Number.isSafeInteger(input.statusHistoryId) || input.statusHistoryId <= 0) throw invalid()
  const shareId = `cheque:${input.paymentId}`
  return appendExchangeFundingEvent(tx, {
    eventKey: `sale:${input.invoiceId}:r1:cheque:${input.paymentId}:history:${input.statusHistoryId}:${input.status}`,
    kind: input.status, amount: input.amount, shareId, rootShareId: shareId,
    sourceInvoiceId: input.invoiceId, sourcePaymentId: input.paymentId, debtId: input.invoiceId,
    evidenceKind: 'CHEQUE_STATUS_HISTORY',
    evidenceRef: input.evidenceRef ?? `PaymentChequeStatusHistory:${input.statusHistoryId}`,
    actorUserId: input.actorUserId ?? null
  })
}

/**
 * Append the independently reconciled refund leg of a late-cleared cheque.
 * It is deliberately a suspense event, never a SOURCE_* right or debt tender.
 */
export async function recordExchangeSuspenseChequeRefund(tx: LedgerClient, input: {
  invoiceId: number
  paymentId: number
  amount: number
  evidenceRef: string
  refundDestination: string
  actorUserId?: number | null
}) {
  if (!Number.isSafeInteger(input.invoiceId) || input.invoiceId <= 0 ||
      !Number.isSafeInteger(input.paymentId) || input.paymentId <= 0 ||
      !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
      typeof input.evidenceRef !== 'string' || input.evidenceRef.trim().length < 8 ||
      !['CASH', 'MANAGER'].includes(input.refundDestination)) throw invalid()
  const eventKey = `sale:${input.invoiceId}:r1:suspense-cheque-refund:payment:${input.paymentId}`
  const prior = await tx.exchangeFundingEvent.findUnique({ where: { eventKey } })
  if (prior) {
    if (prior.kind !== 'SUSPENSE_CHEQUE_REFUNDED' || Number(prior.amount) !== input.amount ||
        Number(prior.debtId) !== input.invoiceId || Number(prior.sourcePaymentId) !== input.paymentId ||
        prior.sourceDestination !== input.refundDestination || prior.evidenceRef !== input.evidenceRef.trim())
      throw mismatch()
    return { event: prior, replayed: true }
  }
  const appended = await appendExchangeFundingEvent(tx, {
    eventKey, kind: 'SUSPENSE_CHEQUE_REFUNDED', amount: input.amount,
    shareId: `suspense-cheque:${input.paymentId}`, rootShareId: `suspense-cheque:${input.paymentId}`,
    sourceInvoiceId: input.invoiceId, sourcePaymentId: input.paymentId, debtId: input.invoiceId,
    sourceMethodKind: 'CHEQUE', sourceDestination: input.refundDestination,
    evidenceKind: 'INDEPENDENT_RECONCILIATION_AND_REFUND', evidenceRef: input.evidenceRef.trim(),
    actorUserId: input.actorUserId ?? null
  })
  return { event: appended.event, replayed: false }
}

/** Commit the independent two-manager suspense disposition and, when needed,
 * its one actual refund leg. The marker is unique per original cheque.
 */
export async function recordExchangeSuspenseChequeResolution(tx: LedgerClient, input: {
  invoiceId: number
  paymentId: number
  faceAmount: number
  appliedToDebt: number
  refundedAmount: number
  evidenceRef: string
  refundDestination: string | null
  actorUserId?: number | null
}) {
  if (!Number.isSafeInteger(input.invoiceId) || input.invoiceId <= 0 ||
      !Number.isSafeInteger(input.paymentId) || input.paymentId <= 0 ||
      !Number.isSafeInteger(input.faceAmount) || input.faceAmount <= 0 ||
      !Number.isSafeInteger(input.appliedToDebt) || input.appliedToDebt < 0 ||
      !Number.isSafeInteger(input.refundedAmount) || input.refundedAmount < 0 ||
      input.appliedToDebt + input.refundedAmount !== input.faceAmount ||
      typeof input.evidenceRef !== 'string' || input.evidenceRef.trim().length < 8 ||
      (input.refundedAmount > 0 && !['CASH', 'MANAGER'].includes(String(input.refundDestination)))) throw invalid()
  const eventKey = `sale:${input.invoiceId}:r1:suspense-cheque-resolution:payment:${input.paymentId}`
  const prior = await tx.exchangeFundingEvent.findUnique({ where: { eventKey } })
  if (prior) {
    if (prior.kind !== 'SUSPENSE_CHEQUE_RESOLVED' || Number(prior.amount) !== input.faceAmount ||
        Number(prior.debtId) !== input.invoiceId || Number(prior.sourcePaymentId) !== input.paymentId ||
        prior.evidenceRef !== input.evidenceRef.trim()) throw mismatch()
    return { event: prior, refundEvent: input.refundedAmount > 0
      ? await tx.exchangeFundingEvent.findUnique({ where: {
          eventKey: `sale:${input.invoiceId}:r1:suspense-cheque-refund:payment:${input.paymentId}`
        } }) : null, replayed: true }
  }
  const resolved = await appendExchangeFundingEvent(tx, {
    eventKey, kind: 'SUSPENSE_CHEQUE_RESOLVED', amount: input.faceAmount,
    shareId: `suspense-cheque:${input.paymentId}`, rootShareId: `suspense-cheque:${input.paymentId}`,
    sourceInvoiceId: input.invoiceId, sourcePaymentId: input.paymentId, debtId: input.invoiceId,
    sourceMethodKind: 'CHEQUE', sourceDestination: 'MANAGER',
    evidenceKind: 'INDEPENDENT_RECONCILIATION_TWO_MANAGER', evidenceRef: input.evidenceRef.trim(),
    actorUserId: input.actorUserId ?? null
  })
  const refundEvent = input.refundedAmount > 0
    ? await recordExchangeSuspenseChequeRefund(tx, {
        invoiceId: input.invoiceId, paymentId: input.paymentId, amount: input.refundedAmount,
        evidenceRef: input.evidenceRef.trim(), refundDestination: String(input.refundDestination),
        actorUserId: input.actorUserId ?? null
      })
    : null
  return { event: resolved.event, refundEvent: refundEvent?.event ?? null, replayed: false }
}

/** Persist the tender paid on an EXCHANGE child in addition to its transfer-in
 * carry. The internal EXCHANGE_CREDIT row is intentionally excluded: it merely
 * reconciles the parent's returned goods. Each new tender is still proved from
 * its saved Payment/redemption row and contributes its own immutable source.
 */
export async function recordExchangeChildTenderFundingSnapshot(
  tx: LedgerClient, invoiceId: number, options: { chequePolicyVersion?: number } = {}
) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const invoice = await tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: {
    id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true, grandTotal: true
  } })
  if (!invoice || invoice.orderType !== 'EXCHANGE' || Number(invoice.sourceInvoiceId) <= 0 ||
      Number(invoice.exchangeReturnId) <= 0) throw invalid()
  const existing = await tx.exchangeFundingEvent.findMany({
    where: { sourceInvoiceId: invoiceId, eventKey: { startsWith: `sale:${invoiceId}:r1:payment:` } },
    orderBy: { id: 'asc' }
  }) as any[]
  const [payments, redemptions] = await Promise.all([
    tx.payment.findMany({ where: { invoiceId, voidedAt: null }, orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      include: { method: { select: { kind: true, key: true } } } }),
    tx.storeCreditRedemption.findMany({ where: { invoiceId, reversedAt: null }, orderBy: { id: 'asc' } })
  ])
  const byPayment = new Map<number, any[]>()
  for (const redemption of redemptions as any[]) {
    if (redemption.paymentId == null) continue
    const rows = byPayment.get(Number(redemption.paymentId)) ?? []
    rows.push(redemption); byPayment.set(Number(redemption.paymentId), rows)
  }
  const tenderRows = (payments as any[]).filter((payment) => {
    const method = String(payment.method?.kind ?? '').toUpperCase()
    return method !== 'EXCHANGE_CREDIT'
  })
  const expected = new Set(tenderRows.map((payment) => Number(payment.id)))
  if (existing.length) {
    if (existing.length !== expected.size || [...expected].some((paymentId) =>
        !existing.some((event) => Number(event.sourcePaymentId) === paymentId && !String(event.kind).startsWith('VOID_'))))
      throw mismatch()
    return { events: existing, replayed: true }
  }
  const exchangeCredit = (payments as any[]).filter((payment) =>
    String(payment.method?.kind ?? '').toUpperCase() === 'EXCHANGE_CREDIT')
  if (exchangeCredit.some((payment) => payment.storeCreditId != null || payment.destination != null ||
      String(payment.kind ?? 'CASH').toUpperCase() !== 'CASH') ||
      exchangeCredit.reduce((sum, payment) => sum + toNumberRial(payment.amount), 0) <= 0)
    throw invalid()
  const events: any[] = []
  let tenderTotal = 0
  for (const payment of tenderRows) {
    const amount = toNumberRial(payment.amount)
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid()
    tenderTotal += amount
    const methodKind = String(payment.method?.key ?? '').toUpperCase() === CHEQUE_METHOD_KEY
      ? 'CHEQUE' : String(payment.method?.kind ?? '').toUpperCase()
    const entryKind = String(payment.kind ?? 'CASH').toUpperCase()
    const rows = byPayment.get(Number(payment.id)) ?? []
    if (rows.length === 0 && payment.storeCreditId == null && methodKind === 'CHEQUE' &&
        entryKind === 'CHEQUE' && payment.chequeStatus === 'PENDING') {
      const opened = await appendExchangeFundingEvent(tx, {
        eventKey: `sale:${invoiceId}:r1:debt-open:payment:${payment.id}`,
        kind: 'DEBT_OPEN', amount, shareId: `debt:${invoiceId}`, rootShareId: `debt:${invoiceId}`,
        sourceInvoiceId: invoiceId, sourcePaymentId: Number(payment.id), debtId: invoiceId,
        sourceMethodKind: methodKind, evidenceKind: 'PENDING_CHEQUE_BACKING',
        evidenceRef: options.chequePolicyVersion != null
          ? `Payment:${payment.id};chequePolicyVersion:${options.chequePolicyVersion}`
          : `Payment:${payment.id}`,
        actorUserId: payment.createdByUserId ?? null
      })
      events.push(opened.event)
      continue
    }
    let kind = 'SOURCE_UNKNOWN'
    let creditId: number | null = null
    let redemptionId: number | null = null
    let rootShareId = `payment:${payment.id}`
    let shareId = `payment:${payment.id}`
    if (rows.length === 1 && payment.storeCreditId != null &&
        Number(rows[0].creditId) === Number(payment.storeCreditId) &&
        toNumberRial(rows[0].amount) === amount && rows[0].compensatedAt == null &&
        methodKind === 'STORE_CREDIT' && entryKind === 'CASH') {
      creditId = Number(rows[0].creditId); redemptionId = Number(rows[0].id)
      kind = 'SOURCE_GIFT'; shareId = `redemption:${redemptionId}`; rootShareId = `credit:${creditId}`
      const credit = await tx.storeCredit.findUnique({ where: { id: creditId }, select: { exchangeResidualRightKey: true } })
      if (credit?.exchangeResidualRightKey && tx.exchangeResidualRightEvent) {
        const opening = await tx.exchangeResidualRightEvent.findFirst({ where: {
          rightKey: credit.exchangeResidualRightKey, eventKind: 'OPENED'
        } })
        if (opening?.rightKind === 'N' || opening?.rightKind === 'B') {
          kind = opening.rightKind === 'N' ? 'SOURCE_N' : 'SOURCE_B'
          rootShareId = String(opening.rootShareId)
        }
      }
    } else if (rows.length === 0 && payment.storeCreditId == null && entryKind === 'CASH') {
      if (methodKind === 'CASH' || methodKind === 'CARD') kind = `SOURCE_${methodKind}`
      else if (methodKind === 'CHEQUE' && payment.chequeStatus === 'CLEARED') kind = 'SOURCE_CHEQUE'
    }
    const recorded = await appendExchangeFundingEvent(tx, {
      eventKey: `sale:${invoiceId}:r1:payment:${payment.id}:funded`, kind, amount,
      shareId, rootShareId, sourceInvoiceId: invoiceId, sourcePaymentId: Number(payment.id),
      sourceRedemptionId: redemptionId, sourceCreditId: creditId,
      sourceMethodKind: methodKind || null, sourceDestination: payment.destination ?? null,
      evidenceKind: kind === 'SOURCE_UNKNOWN' ? 'UNRESOLVED_PAYMENT_ROW' : 'PAYMENT_ROW',
      evidenceRef: `Payment:${payment.id}`
    })
    events.push(recorded.event)
  }
  const internalTotal = exchangeCredit.reduce((sum, payment) => sum + toNumberRial(payment.amount), 0)
  if (internalTotal + tenderTotal !== toNumberRial(invoice.grandTotal)) throw invalid()
  return { events, replayed: false }
}

/** Revise a create-time payment snapshot after a payment mutation. A funded
 * share may not be rewritten once carried to an exchange descendant; in that
 * case a dedicated witnessed correction flow is required instead.
 */
export async function reviseSaleFundingSnapshot(tx: LedgerClient, invoiceId: number, revision: number) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || !Number.isSafeInteger(revision) || revision <= 1)
    throw invalid()
  const targetPrefix = `sale:${invoiceId}:r${revision}:`
  const targetEvents = await tx.exchangeFundingEvent.findMany({ where: { eventKey: { startsWith: targetPrefix } } })
  if (targetEvents.length) {
    const replay = await recordSaleFundingSnapshot(tx, invoiceId, revision)
    return { ...replay, replayed: true }
  }
  if (await tx.saleReturn.count({ where: { invoiceId, voidedAt: null } }))
    throw new BusinessError('فاکتور دارای برگشت ثبت‌شده است؛ تغییر snapshot پرداخت بدون تطبیق حق برگشت مجاز نیست.')
  const historical = await tx.exchangeFundingEvent.findMany({
    where: { sourceInvoiceId: invoiceId }, orderBy: { id: 'asc' }
  })
  const snapshotPattern = new RegExp(`^sale:${invoiceId}:r(\\d+):`)
  const snapshotEvents = historical.filter((event: any) =>
    snapshotPattern.test(String(event.eventKey)) && !String(event.kind).startsWith('VOID_'))
  if (!snapshotEvents.length) throw new BusinessError('دفتر منشأ قبلی برای اصلاح وجود ندارد؛ هیچ بازنویسی یا حدس انجام نشد.')
  const maxRevision = historical.reduce((max: number, event: any) => {
    const match = snapshotPattern.exec(String(event.eventKey))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  if (maxRevision >= revision) throw mismatch()
  const transfer = await tx.exchangeFundingEvent.findFirst({
    where: { sourceInvoiceId: invoiceId, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } }, select: { id: true }
  })
  if (transfer)
    throw new BusinessError('منشأ این فاکتور قبلاً به سند تعویض منتقل شده است؛ اصلاح پرداختِ مبدأ به مسیر جبرانیِ شاهددار نیاز دارد.')

  for (const source of snapshotEvents) {
    const reversal = await tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(source.id) } })
    if (reversal) continue
    const amount = toNumberRial(source.amount)
    await appendExchangeFundingEvent(tx, {
      eventKey: `${source.eventKey}:void:r${revision}`, kind: `VOID_${source.kind}`, amount: -amount,
      shareId: source.shareId, rootShareId: source.rootShareId,
      sourceInvoiceId: source.sourceInvoiceId, childInvoiceId: source.childInvoiceId,
      returnId: source.returnId, sourcePaymentId: source.sourcePaymentId,
      sourceRedemptionId: source.sourceRedemptionId, sourceCreditId: source.sourceCreditId,
      parentEventId: source.parentEventId, debtId: source.debtId,
      sourceMethodKind: source.sourceMethodKind, sourceDestination: source.sourceDestination,
      evidenceKind: 'PAYMENT_SNAPSHOT_REVISION', evidenceRef: `snapshot:${invoiceId}:r${revision}`,
      actorUserId: source.actorUserId ?? null, reversesEventId: Number(source.id)
    })
  }
  const next = await recordSaleFundingSnapshot(tx, invoiceId, revision)
  const snapshotState = await latestFundingSnapshotState(tx, invoiceId)
  if (snapshotState?.kind === 'SNAPSHOT_STALE')
    await appendFundingSnapshotState(tx, invoiceId, revision, 'RECONCILED')
  return { ...next, replayed: false }
}

/** Advance an existing invoice snapshot revision after a persisted payment
 * mutation. Legacy invoices with no snapshot are left untouched, not backfilled
 * from incomplete history.
 */
export async function reviseLatestSaleFundingSnapshot(tx: LedgerClient, invoiceId: number) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const rows = await tx.exchangeFundingEvent.findMany({ where: { sourceInvoiceId: invoiceId } })
  const pattern = new RegExp(`^sale:${invoiceId}:r(\\d+):`)
  const revision = rows.reduce((max: number, row: any) => {
    const match = pattern.exec(String(row.eventKey))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  if (revision === 0) return null

  // Payment maintenance is an established workflow even after a return. Do not
  // let a bookkeeping hook roll back that payment; equally, do not rewrite
  // source shares whose return rights have not yet been reconciled. The stale
  // snapshot is explicitly reported to the caller and remains ineligible for
  // exchange transfer until a witnessed correction is implemented.
  const activeReturns = await tx.saleReturn.count({ where: { invoiceId, voidedAt: null } })
  if (activeReturns > 0) {
    const transfer = rows.find((row: any) => ['TRANSFER_OUT', 'TRANSFER_IN'].includes(String(row.kind)))
    if (transfer) throw new BusinessError('منشأ پرداخت به سند تعویض منتقل شده است؛ تغییر آن به اصلاح جبرانیِ شاهددار نیاز دارد.')
    const state = await appendFundingSnapshotState(tx, invoiceId, revision, 'STALE')
    return { skipped: true, reason: 'ACTIVE_RETURN_REQUIRES_WITNESSED_CORRECTION',
      invoiceId, revision, stateEventId: Number(state.event.id) }
  }
  return reviseSaleFundingSnapshot(tx, invoiceId, revision + 1)
}

type TransferInput = {
  eventKey: string
  sourceEventId: number
  sourceShareId: string
  destinationShareId: string
  rootShareId: string
  amount: number
  sourceInvoiceId: number
  childInvoiceId: number
  returnId: number
  actorUserId?: number | null
  evidenceRef?: string | null
}

/** Move one proven share. The caller must use a transaction; both sides are
 * written together and the destination retains a parent link to its source. */
export async function transferExchangeFundingShare(tx: LedgerClient, input: TransferInput) {
  if (!input || input.sourceShareId === input.destinationShareId || !Number.isSafeInteger(input.sourceEventId) ||
      input.sourceEventId <= 0 || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
      ![input.sourceInvoiceId, input.childInvoiceId, input.returnId].every((id) => Number.isSafeInteger(id) && id > 0) ||
      typeof input.eventKey !== 'string' || input.eventKey.length > 230) throw invalid()
  if (await fundingSnapshotRequiresCorrection(tx, input.sourceInvoiceId))
    throw new BusinessError('snapshot منشأ پرداخت پس از تغییر در فاکتورِ دارای برگشت منسوخ است؛ انتقال تا اصلاح جبرانیِ شاهددار متوقف شد.')
  const exchangeLink = await activeExchangeLink(tx, input.sourceInvoiceId, input.childInvoiceId, input.returnId)
  if (!exchangeLink) throw insufficient()
  const origin = await tx.exchangeFundingEvent.findUnique({ where: { id: input.sourceEventId } })
  const originInvoiceMatches = origin && (PROVEN_SOURCE_KINDS.has(String(origin.kind))
    ? Number(origin.sourceInvoiceId) === input.sourceInvoiceId
    : origin.kind === 'TRANSFER_IN' && Number(origin.childInvoiceId) === input.sourceInvoiceId)
  if (!origin || !originInvoiceMatches || origin.shareId !== input.sourceShareId || origin.rootShareId !== input.rootShareId ||
      toNumberRial(origin.amount) <= 0 || !(await hasProvableTransferLineage(tx, origin))) throw insufficient()
  const common = {
    sourceInvoiceId: input.sourceInvoiceId, childInvoiceId: input.childInvoiceId, returnId: input.returnId,
    parentEventId: input.sourceEventId, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'EXCHANGE_TRANSFER', evidenceRef: input.evidenceRef ?? null
  }
  const [priorOut, priorIn] = await Promise.all([
    tx.exchangeFundingEvent.findUnique({ where: { eventKey: `${input.eventKey}:out` } }),
    tx.exchangeFundingEvent.findUnique({ where: { eventKey: `${input.eventKey}:in` } })
  ])
  if (!!priorOut !== !!priorIn) throw mismatch()
  if (!priorOut) {
    const alreadyTransferred = await activeTransferValueForReturn(
      tx, input.sourceInvoiceId, input.childInvoiceId, input.returnId
    )
    if (alreadyTransferred == null ||
        BigInt(alreadyTransferred) + BigInt(input.amount) > BigInt(toNumberRial(exchangeLink.total)) ||
        await exchangeFundingBalance(tx, input.sourceShareId) < input.amount)
      throw insufficient()
  }
  const out = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `${input.eventKey}:out`, kind: 'TRANSFER_OUT', amount: -input.amount,
    shareId: input.sourceShareId, rootShareId: input.rootShareId
  })
  const into = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `${input.eventKey}:in`, kind: 'TRANSFER_IN', amount: input.amount,
    shareId: input.destinationShareId, rootShareId: input.rootShareId
  })
  return { outEvent: out.event, inEvent: into.event, replayed: out.replayed && into.replayed }
}

/** Release one validated portion of replacement carry back to its exact
 * parent share when a replacement item is returned. The event pair is separate
 * from the original transfer pair and never means cash was received.
 */
export async function returnExchangeFundingShareForChildReturn(tx: LedgerClient, input: {
  returnId: number; returnItemId: number; sourceEventId: number; amount: number; actorUserId?: number | null
}) {
  if (!input || ![input.returnId, input.returnItemId, input.sourceEventId].every((value) =>
      Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw invalid()
  const [ret, returnItem] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: input.returnId } }),
    tx.saleReturnItem.findUnique({ where: { id: input.returnItemId } })
  ])
  if (!ret || !returnItem || ret.kind !== 'RETURN' || ret.voidedAt != null ||
      Number(returnItem.returnId) !== Number(ret.id) || Number(ret.invoiceId) <= 0)
    throw invalid()
  const childInvoiceId = Number(ret.invoiceId)
  const child = await tx.saleInvoice.findUnique({ where: { id: childInvoiceId }, select: {
    id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true
  } })
  if (!child || child.orderType !== 'EXCHANGE' || !Number.isSafeInteger(Number(child.sourceInvoiceId)) ||
      !Number.isSafeInteger(Number(child.exchangeReturnId))) throw invalid()
  const [allocationRows, funding] = await Promise.all([
    tx.exchangeFundingReturnLineAllocation.findMany({ where: {
      returnItemId: input.returnItemId, sourceEventId: input.sourceEventId, eventKind: 'ALLOCATION'
    } }),
    getCurrentExchangeFundingSources(tx, childInvoiceId, {
      allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
    })
  ])
  const allocation = (allocationRows as any[]).length === 1 ? allocationRows[0] : null
  const source = funding.sources.find((row: any) => Number(row.event.id) === input.sourceEventId)
  const returnLineAmount = toNumberRial(allocation?.amountDelta)
  if (!allocation || !source || returnLineAmount !== input.amount ||
      Number(allocation.returnId) !== input.returnId || Number(allocation.childInvoiceId) !== childInvoiceId ||
      Number(allocation.saleItemId) !== Number(returnItem.saleItemId) ||
      String(allocation.sourceKind) !== source.sourceKind ||
      Number(source.event.kind === 'TRANSFER_IN' ? source.event.childInvoiceId : 0) !== childInvoiceId)
    throw invalid()
  const into = source.event
  const out = await matchingTransferOutForIn(tx, into)
  if (!out || await transferPairReversalState(tx, out, into) !== 'ACTIVE') throw invalid()
  const childBalance = await exchangeFundingBalance(tx, String(into.shareId))
  if (!Number.isSafeInteger(childBalance) || childBalance < input.amount) throw insufficient()

  const baseKey = `child-return:${input.returnId}:item:${input.returnItemId}:source:${input.sourceEventId}`
  const common = {
    sourceInvoiceId: Number(ret.invoiceId) === childInvoiceId ? Number(child.sourceInvoiceId) : null,
    childInvoiceId, returnId: Number(child.exchangeReturnId), relatedReturnId: input.returnId,
    parentEventId: Number(into.id), rootShareId: String(into.rootShareId),
    evidenceKind: 'EXCHANGE_CHILD_RETURN',
    evidenceRef: `SaleReturn:${input.returnId}:SaleReturnItem:${input.returnItemId}:Source:${input.sourceEventId}`,
    actorUserId: input.actorUserId ?? null
  }
  const returnedOut = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `${baseKey}:out`, kind: 'RETURN_TRANSFER_OUT', amount: -input.amount,
    shareId: String(into.shareId)
  })
  const returnedIn = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `${baseKey}:in`, kind: 'RETURN_TRANSFER_IN', amount: input.amount,
    shareId: String(out.shareId)
  })
  return { outEvent: returnedOut.event, inEvent: returnedIn.event,
    replayed: returnedOut.replayed && returnedIn.replayed }
}

/** Consume a direct child tender into its return claim/right. Unlike a
 * TRANSFER_IN carry it has no parent funding share to restore; the paired
 * return event debits only this child Payment share, while any N right is
 * restored separately by ExchangeResidualRightsService.
 */
export async function releaseExchangeFundingTenderForChildReturn(tx: LedgerClient, input: {
  returnId: number; returnItemId: number; sourceEventId: number; amount: number; actorUserId?: number | null
}) {
  if (!input || ![input.returnId, input.returnItemId, input.sourceEventId].every((value) =>
      Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw invalid()
  const [ret, returnItem] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: input.returnId } }),
    tx.saleReturnItem.findUnique({ where: { id: input.returnItemId } })
  ])
  if (!ret || ret.kind !== 'RETURN' || ret.voidedAt != null || !returnItem ||
      Number(returnItem.returnId) !== input.returnId) throw invalid()
  const childInvoiceId = Number(ret.invoiceId)
  const child = await tx.saleInvoice.findUnique({ where: { id: childInvoiceId }, select: {
    id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true
  } })
  if (!child || child.orderType !== 'EXCHANGE' || Number(child.sourceInvoiceId) <= 0 ||
      Number(child.exchangeReturnId) <= 0) throw invalid()
  const [allocations, origin] = await Promise.all([
    tx.exchangeFundingReturnLineAllocation.findMany({ where: {
      returnItemId: input.returnItemId, sourceEventId: input.sourceEventId, eventKind: 'ALLOCATION'
    } }),
    tx.exchangeFundingEvent.findUnique({ where: { id: input.sourceEventId } })
  ])
  const allocation = (allocations as any[]).length === 1 ? allocations[0] : null
  const directSourceBalance = origin ? await exchangeFundingBalance(tx, String(origin.shareId)) : 0
  const sourcePaymentProven = !!origin && await hasPersistedSourcePayment(tx, origin, {
    allowExpiredGiftForReturnAttribution: true, allowReturnedResidualRight: true
  })
  if (!allocation || !origin || origin.kind === 'TRANSFER_IN' ||
      !PROVEN_SOURCE_KINDS.has(String(origin.kind)) || !sourcePaymentProven ||
      Number(origin.sourceInvoiceId) !== childInvoiceId ||
      Number(allocation.sourceInvoiceId) !== Number(child.sourceInvoiceId) ||
      Number(allocation.childInvoiceId) !== childInvoiceId || Number(allocation.returnId) !== input.returnId ||
      Number(allocation.saleItemId) !== Number(returnItem.saleItemId) ||
      toNumberRial(allocation.amountDelta) !== input.amount ||
      String(allocation.sourceKind) !== String(origin.kind) || directSourceBalance < input.amount)
    throw insufficient()
  const baseKey = `child-return:${input.returnId}:item:${input.returnItemId}:source:${input.sourceEventId}`
  const common = {
    sourceInvoiceId: Number(child.sourceInvoiceId), childInvoiceId,
    returnId: Number(child.exchangeReturnId), relatedReturnId: input.returnId,
    parentEventId: input.sourceEventId, rootShareId: String(origin.rootShareId),
    evidenceKind: 'EXCHANGE_CHILD_RETURN',
    evidenceRef: `SaleReturn:${input.returnId}:SaleReturnItem:${input.returnItemId}:Source:${input.sourceEventId}`,
    actorUserId: input.actorUserId ?? null
  }
  const out = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `${baseKey}:out`, kind: 'RETURN_TRANSFER_OUT', amount: -input.amount,
    shareId: String(origin.shareId)
  })
  const into = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: `${baseKey}:in`, kind: 'RETURN_TRANSFER_IN', amount: input.amount,
    shareId: `child-return-right:${input.returnId}:item:${input.returnItemId}:source:${input.sourceEventId}`
  })
  return { outEvent: out.event, inEvent: into.event, replayed: out.replayed && into.replayed }
}

async function matchingReturnTransferOutForIn(tx: LedgerClient, into: any) {
  if (!into || into.kind !== 'RETURN_TRANSFER_IN') return null
  const out = await tx.exchangeFundingEvent.findUnique({ where: { eventKey: `${String(into.eventKey).slice(0, -3)}:out` } })
  if (!out || out.kind !== 'RETURN_TRANSFER_OUT' || toNumberRial(out.amount) >= 0 ||
      toNumberRial(into.amount) !== -toNumberRial(out.amount) || out.shareId === into.shareId ||
      out.rootShareId !== into.rootShareId || out.sourceInvoiceId !== into.sourceInvoiceId ||
      out.childInvoiceId !== into.childInvoiceId || out.returnId !== into.returnId ||
      out.relatedReturnId !== into.relatedReturnId || out.parentEventId !== into.parentEventId ||
      out.evidenceKind !== 'EXCHANGE_CHILD_RETURN' || into.evidenceKind !== 'EXCHANGE_CHILD_RETURN' ||
      out.evidenceRef !== into.evidenceRef || out.reversesEventId != null || into.reversesEventId != null)
    return null
  return out
}

/** Reverse the carry-release pairs for a voided child return. A later spend or
 * reservation of returned carry prevents this reversal from reopening stale state.
 */
export async function reverseExchangeFundingReturnTransfersForChildReturn(tx: LedgerClient, input: {
  returnId: number; actorUserId?: number | null
}) {
  if (!Number.isSafeInteger(input?.returnId) || input.returnId <= 0) throw invalid()
  const ret = await tx.saleReturn.findUnique({ where: { id: input.returnId }, select: {
    id: true, invoiceId: true, kind: true, voidedAt: true
  } })
  if (!ret || ret.kind !== 'RETURN' || ret.voidedAt != null) throw invalid()
  const events = await tx.exchangeFundingEvent.findMany({ where: {
    relatedReturnId: input.returnId, kind: { in: ['RETURN_TRANSFER_OUT', 'RETURN_TRANSFER_IN'] }
  }, orderBy: { id: 'asc' } }) as any[]
  const outs = events.filter((event) => event.kind === 'RETURN_TRANSFER_OUT')
  const ins = events.filter((event) => event.kind === 'RETURN_TRANSFER_IN')
  if (outs.length !== ins.length) throw mismatch()
  let reversed = 0
  for (const into of ins) {
    const out = await matchingReturnTransferOutForIn(tx, into)
    if (!out || !outs.some((candidate) => Number(candidate.id) === Number(out.id)) ||
        Number(into.relatedReturnId) !== input.returnId) throw mismatch()
    const [outReversal, inReversal] = await Promise.all([
      tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(out.id) } }),
      tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(into.id) } })
    ])
    if (!!outReversal !== !!inReversal) throw mismatch()
    if (outReversal) {
      if (outReversal.kind !== 'VOID_RETURN_TRANSFER_OUT' || inReversal.kind !== 'VOID_RETURN_TRANSFER_IN') throw mismatch()
      continue
    }
    const amount = toNumberRial(into.amount)
    // The returned child share has already been debited by this exact release;
    // it can legitimately be zero (for a full item return). Only the parent
    // balance proves the released carry is still present and reversible.
    const parentShareBalance = await exchangeFundingBalance(tx, String(into.shareId))
    if (parentShareBalance < amount)
      throw new BusinessError('carry برگشتی پس از برگشت مصرف یا دوباره منتقل شده است؛ ابطال برگشت بدون مغایرت ممکن نیست.')
    const common = {
      sourceInvoiceId: out.sourceInvoiceId, childInvoiceId: out.childInvoiceId,
      returnId: out.returnId, relatedReturnId: input.returnId,
      parentEventId: out.parentEventId, rootShareId: out.rootShareId,
      evidenceKind: 'SALE_RETURN_VOID', evidenceRef: `SaleReturn:${input.returnId}:ReturnTransfer:${Number(out.id)}`,
      actorUserId: input.actorUserId ?? null
    }
    await appendExchangeFundingEvent(tx, {
      ...common, eventKey: `void:${input.returnId}:return-transfer:${Number(out.id)}:out`,
      kind: 'VOID_RETURN_TRANSFER_OUT', amount, shareId: String(out.shareId), reversesEventId: Number(out.id)
    })
    await appendExchangeFundingEvent(tx, {
      ...common, eventKey: `void:${input.returnId}:return-transfer:${Number(into.id)}:in`,
      kind: 'VOID_RETURN_TRANSFER_IN', amount: -amount, shareId: String(into.shareId), reversesEventId: Number(into.id)
    })
    reversed++
  }
  return { returnId: input.returnId, reversed, pairs: ins.length }
}

/** Reverse both sides of a prior transfer atomically; a replay cannot reverse
 * either side a second time. */
export async function reverseExchangeFundingTransferPair(tx: LedgerClient, input: {
  eventKey: string
  outEventId: number
  inEventId: number
  actorUserId?: number | null
  evidenceRef?: string | null
}) {
  if (!input || typeof input.eventKey !== 'string' || input.eventKey.length > 230 ||
      !Number.isSafeInteger(input.outEventId) || input.outEventId <= 0 ||
      !Number.isSafeInteger(input.inEventId) || input.inEventId <= 0) throw invalid()
  const [outSource, inSource] = await Promise.all([
    tx.exchangeFundingEvent.findUnique({ where: { id: input.outEventId } }),
    tx.exchangeFundingEvent.findUnique({ where: { id: input.inEventId } })
  ])
  if (!outSource || !inSource || outSource.kind !== 'TRANSFER_OUT' || inSource.kind !== 'TRANSFER_IN' ||
      toNumberRial(outSource.amount) >= 0 || toNumberRial(inSource.amount) !== -toNumberRial(outSource.amount) ||
      outSource.shareId === inSource.shareId || outSource.rootShareId !== inSource.rootShareId ||
      outSource.returnId !== inSource.returnId || outSource.childInvoiceId !== inSource.childInvoiceId ||
      outSource.sourceInvoiceId !== inSource.sourceInvoiceId || outSource.parentEventId !== inSource.parentEventId ||
      Number((await matchingTransferOutForIn(tx, inSource))?.id) !== Number(outSource.id))
    throw invalid()
  const eventKeyOut = `${input.eventKey}:out:void`
  const eventKeyIn = `${input.eventKey}:in:void`
  const [sourceOutReversal, sourceInReversal] = await Promise.all([
    tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(outSource.id) } }),
    tx.exchangeFundingEvent.findUnique({ where: { reversesEventId: Number(inSource.id) } })
  ])
  if (!!sourceOutReversal !== !!sourceInReversal) throw mismatch()
  if (sourceOutReversal && (sourceOutReversal.eventKey !== eventKeyOut || sourceInReversal.eventKey !== eventKeyIn))
    throw mismatch()
  const [priorOutVoid, priorInVoid] = await Promise.all([
    tx.exchangeFundingEvent.findUnique({ where: { eventKey: eventKeyOut } }),
    tx.exchangeFundingEvent.findUnique({ where: { eventKey: eventKeyIn } })
  ])
  if (!!priorOutVoid !== !!priorInVoid) throw mismatch()
  if (!priorOutVoid && await exchangeFundingBalance(tx, inSource.shareId) !== toNumberRial(inSource.amount))
    throw new BusinessError('سهم منتقل‌شده در سند فرزند دیگر کامل و آزاد نیست؛ ابطال زنجیره نیازمند اصلاح شاهددار است.')
  const common = {
    sourceInvoiceId: outSource.sourceInvoiceId, childInvoiceId: outSource.childInvoiceId,
    returnId: outSource.returnId, rootShareId: outSource.rootShareId,
    parentEventId: outSource.parentEventId, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'SALE_INVOICE_VOID', evidenceRef: input.evidenceRef ?? null
  }
  const reversalOut = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: eventKeyOut, kind: 'VOID_TRANSFER_OUT',
    amount: -toNumberRial(outSource.amount), shareId: outSource.shareId,
    reversesEventId: outSource.id
  })
  const reversalIn = await appendExchangeFundingEvent(tx, {
    ...common, eventKey: eventKeyIn, kind: 'VOID_TRANSFER_IN',
    amount: -toNumberRial(inSource.amount), shareId: inSource.shareId,
    reversesEventId: inSource.id
  })
  return { outEvent: reversalOut.event, inEvent: reversalIn.event,
    replayed: reversalOut.replayed && reversalIn.replayed }
}

/** Reverse every validated transfer pair recorded for one exchange return. A
 * partial/mismatched pair fails the caller's transaction rather than restoring
 * only one side of the provenance ledger.
 */
export async function reverseExchangeFundingTransfersForReturn(tx: LedgerClient, input: {
  returnId: number
  actorUserId?: number | null
}) {
  if (!input || !Number.isSafeInteger(input.returnId) || input.returnId <= 0 ||
      (input.actorUserId != null && (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0)))
    throw invalid()
  const ret = await tx.saleReturn.findUnique({ where: { id: input.returnId }, select: {
    id: true, invoiceId: true, exchangeInvoiceId: true
  } })
  if (!ret || !Number.isSafeInteger(Number(ret.invoiceId)) ||
      Number(ret.invoiceId) <= 0 || !Number.isSafeInteger(Number(ret.exchangeInvoiceId)) ||
      Number(ret.exchangeInvoiceId) <= 0)
    throw invalid()
  const child = await tx.saleInvoice.findUnique({ where: { id: Number(ret.exchangeInvoiceId) }, select: {
    id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true
  } })
  if (!child || Number(child.id) !== Number(ret.exchangeInvoiceId) || child.orderType !== 'EXCHANGE' ||
      Number(child.sourceInvoiceId) !== Number(ret.invoiceId) || Number(child.exchangeReturnId) !== input.returnId)
    throw invalid()
  const events = await tx.exchangeFundingEvent.findMany({
    where: { returnId: input.returnId, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
    orderBy: { id: 'asc' }
  })
  const outs = (events as any[]).filter((event) => event.kind === 'TRANSFER_OUT')
  const ins = (events as any[]).filter((event) => event.kind === 'TRANSFER_IN')
  if (outs.length !== ins.length) throw invalid()

  const matchedOutIds = new Set<number>()
  let reversed = 0
  for (const into of ins) {
    const out = await matchingTransferOutForIn(tx, into)
    if (!out || !outs.some((candidate) => Number(candidate.id) === Number(out.id)) ||
        matchedOutIds.has(Number(out.id)) || Number(out.returnId) !== input.returnId ||
        Number(into.returnId) !== input.returnId ||
        Number(out.sourceInvoiceId) !== Number(ret.invoiceId) ||
        Number(into.sourceInvoiceId) !== Number(ret.invoiceId) ||
        Number(out.childInvoiceId) !== Number(ret.exchangeInvoiceId) ||
        Number(into.childInvoiceId) !== Number(ret.exchangeInvoiceId))
      throw invalid()
    matchedOutIds.add(Number(out.id))
    const state = await transferPairReversalState(tx, out, into)
    if (state == null) throw invalid()
    if (state === 'REVERSED') continue
    await reverseExchangeFundingTransferPair(tx, {
      eventKey: `void:exchange:return:${input.returnId}:transfer:${Number(out.id)}`,
      outEventId: Number(out.id),
      inEventId: Number(into.id),
      actorUserId: input.actorUserId ?? null,
      evidenceRef: `SaleReturn:${input.returnId}:SaleInvoice:${Number(into.childInvoiceId)}`
    })
    reversed += 1
  }
  if (matchedOutIds.size !== outs.length) throw invalid()
  return { reversed, pairs: ins.length }
}
