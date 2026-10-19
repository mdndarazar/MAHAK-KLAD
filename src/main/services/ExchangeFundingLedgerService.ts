import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { allocateExchangeFundingByLine } from '@shared/exchangeFundingAllocation'
import { allocateLineNet } from '@shared/returnValue'
import { toNumberRial } from '@shared/money'

type LedgerClient = Prisma.TransactionClient | {
  exchangeFundingEvent: any
  exchangeFundingLineAllocation: any
  saleInvoice: any
  payment: any
  storeCreditRedemption: any
  storeCredit: any
  saleReturn: any
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

const nullableNumber = (value: unknown) => value == null ? null : Number(value)
const normalized = (row: any) => ({
  eventKey: String(row.eventKey), kind: String(row.kind), amount: toNumberRial(row.amount),
  shareId: String(row.shareId), rootShareId: String(row.rootShareId),
  sourceInvoiceId: nullableNumber(row.sourceInvoiceId), childInvoiceId: nullableNumber(row.childInvoiceId),
  returnId: nullableNumber(row.returnId), sourcePaymentId: nullableNumber(row.sourcePaymentId),
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
  const ids = [input.sourceInvoiceId, input.childInvoiceId, input.returnId, input.sourcePaymentId,
    input.sourceRedemptionId, input.sourceCreditId, input.parentEventId, input.debtId,
    input.actorUserId, input.reversesEventId]
  if (!ids.every((value) => value == null || (Number.isSafeInteger(value) && value > 0))) throw invalid()
  if (isSnapshotState && (input.sourceInvoiceId == null || input.childInvoiceId != null || input.returnId != null ||
      input.sourcePaymentId != null || input.sourceRedemptionId != null || input.sourceCreditId != null ||
      input.parentEventId != null || input.debtId != null || input.reversesEventId != null ||
      input.shareId !== `snapshot:${input.sourceInvoiceId}` || input.rootShareId !== `snapshot:${input.sourceInvoiceId}`))
    throw invalid()
  if (input.evidenceKind != null && (typeof input.evidenceKind !== 'string' || input.evidenceKind.length > 80)) throw invalid()
  if (input.evidenceRef != null && (typeof input.evidenceRef !== 'string' || input.evidenceRef.length > 500)) throw invalid()
  return {
    eventKey: input.eventKey.trim(), kind: input.kind, amount: BigInt(input.amount),
    shareId: input.shareId.trim(), rootShareId: input.rootShareId.trim(),
    sourceInvoiceId: input.sourceInvoiceId ?? null, childInvoiceId: input.childInvoiceId ?? null,
    returnId: input.returnId ?? null, sourcePaymentId: input.sourcePaymentId ?? null,
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
    actual.returnId === data.returnId && actual.sourcePaymentId === data.sourcePaymentId &&
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

// Only kinds emitted by the persisted-sale snapshot have a defined proof path.
// Legacy/custom labels (including SOURCE_B/SOURCE_N) stay quarantined until a
// dedicated source contract exists; a positive amount is never proof by itself.
const PROVEN_SOURCE_KINDS = new Set(['SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE', 'SOURCE_GIFT'])

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

async function hasPersistedSourcePayment(tx: LedgerClient, event: any): Promise<boolean> {
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
      select: { id: true, creditId: true, amount: true, compensatedAt: true, expiryCaptured: true, expiryAtRedeem: true }
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
    if (!credit || credit.voidedAt != null || credit.deletedAt != null ||
        !['USED', 'PARTIALLY_USED'].includes(String(credit.status)) ||
        toNumberRial(credit.usedAmount) < paymentAmount || toNumberRial(credit.amount) < toNumberRial(credit.usedAmount) ||
        capturedExpiry !== currentExpiry || (capturedExpiry != null && capturedExpiry <= Date.now()))
      return false
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
  if (!parent || !out || out.kind !== 'TRANSFER_OUT' || out.shareId !== parent.shareId ||
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
    !!ret && ret.voidedAt == null && ret.kind === 'EXCHANGE' && Number(ret.invoiceId) === sourceInvoiceId &&
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

async function provenSourceRootEvent(tx: LedgerClient, event: any): Promise<any | null> {
  let current = event
  const seen = new Set<number>()
  for (let depth = 0; depth < 50; depth++) {
    const id = Number(current?.id)
    const shareId = typeof current?.shareId === 'string' ? current.shareId : ''
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !shareId.trim()) return null
    seen.add(id)
    if (PROVEN_SOURCE_KINDS.has(String(current.kind))) {
      const rootAmount = toNumberRial(current.amount)
      if (!Number.isSafeInteger(rootAmount) || rootAmount <= 0) return null
      if (await eventHasReversal(tx, id)) return null
      if (!await hasPersistedSourcePayment(tx, current)) return null
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
    current = await tx.exchangeFundingEvent.findUnique({ where: { id: Number(current.parentEventId) } })
    if (!current) return null
  }
  return null
}

async function hasProvableTransferLineage(tx: LedgerClient, event: any): Promise<boolean> {
  return (await provenSourceRootEvent(tx, event)) != null
}

/** Read only the latest persisted-sale snapshot and verify every transferable
 * source against its live Payment/redemption row. This deliberately does not
 * reconstruct provenance for legacy invoices or treat an EXCHANGE_CREDIT
 * payment as a source. Callers must separately decide how debt/unknown shares
 * affect the specific return.
 */
export async function getCurrentSaleFundingSources(tx: LedgerClient, invoiceId: number) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const invoice = await tx.saleInvoice.findUnique({
    where: { id: invoiceId }, select: { id: true, orderType: true, voidedAt: true, status: true, grandTotal: true }
  })
  if (!invoice) throw new BusinessError('فاکتور برای خواندن منشأ مالی پیدا نشد؛ هیچ سهمی حدس زده نشد.')
  if (invoice.orderType === 'EXCHANGE')
    throw new BusinessError('فاکتور تعویض برای خواندن منشأ، به دفتر تخصیص مستقل کالای برگشتی نیاز دارد.')
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
        if (!await hasProvableTransferLineage(tx, event)) {
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
export async function getCurrentExchangeFundingSources(tx: LedgerClient, invoiceId: number) {
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
      sourceKind: 'SOURCE_GIFT' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE'
      amount: number
    }>,
    lineAllocationStatus: 'UNAVAILABLE' as 'UNAVAILABLE' | 'READ_ONLY_RECONCILED' | 'PERSISTED_RECONCILED',
    unresolved: [] as Array<{ eventId: number; kind: string; amount: number }>,
    debt: 0,
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
    const root = await provenSourceRootEvent(tx, into)
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
      // No typed NEW_PAID event exists for additional child tenders yet.
      base.unresolved.push({ eventId: Number(payment.id) || 0, kind: 'UNJOURNALED_CHILD_PAYMENT', amount })
    }
  }
  if (redemptionCount > 0)
    base.unresolved.push({ eventId: 0, kind: 'ACTIVE_CHILD_CREDIT_REDEMPTION', amount: redemptionCount })

  const invoiceTotal = toNumberRial(invoice.grandTotal)
  const paidTotal = toNumberRial(invoice.paidTotal)
  const transferred = Number(incomingTotal)
  if (!Number.isSafeInteger(invoiceTotal) || invoiceTotal < 0 || !Number.isSafeInteger(paidTotal) || paidTotal < 0 ||
      !Number.isSafeInteger(exchangeCreditTotal) || !Number.isSafeInteger(transferred)) {
    base.unresolved.push({ eventId: 0, kind: 'INVALID_EXCHANGE_INVOICE_SETTLEMENT', amount: 0 })
  } else {
    base.debt = Math.max(0, invoiceTotal - paidTotal)
    base.overpay = Math.max(0, paidTotal - invoiceTotal)
    if (base.debt > 0)
      base.unresolved.push({ eventId: 0, kind: 'UNRESOLVED_EXCHANGE_CHILD_DEBT', amount: base.debt })
    if (base.overpay > 0)
      base.unresolved.push({ eventId: 0, kind: 'UNRESOLVED_EXCHANGE_CHILD_OVERPAY', amount: base.overpay })
    if (paidTotal !== exchangeCreditTotal)
      base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_TRANSFER_PAID_TOTAL_MISMATCH',
        amount: paidTotal - exchangeCreditTotal })
  }
  if (Number.isSafeInteger(exchangeCreditTotal) && Number.isSafeInteger(transferred) && transferred !== exchangeCreditTotal)
    base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_TRANSFER_PAYMENT_MISMATCH',
      amount: transferred - exchangeCreditTotal })
  if (Number.isSafeInteger(invoiceTotal) && Number.isSafeInteger(transferred) && transferred !== invoiceTotal)
    base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_TRANSFER_INVOICE_MISMATCH',
      amount: transferred - invoiceTotal })
  if (!base.snapshotExists && Number.isSafeInteger(invoiceTotal) && invoiceTotal > 0)
    base.unresolved.push({ eventId: 0, kind: 'MISSING_EXCHANGE_TRANSFER_SNAPSHOT', amount: invoiceTotal })

  // This projection never acts as a return permit. Only expose it for an
  // untouched, fully funded child; if an immutable persisted matrix exists,
  // reconcile it below before returning the current source-to-item view.
  if (base.unresolved.length === 0 && base.activeReturnIds.length === 0 &&
      Number.isSafeInteger(invoiceTotal) && invoiceTotal > 0 && base.sources.length > 0) {
    const sourceBalancesMatchEvents = base.sources.every((source) =>
      Number.isSafeInteger(source.available) && source.available === toNumberRial(source.event.amount))
    if (!sourceBalancesMatchEvents) {
      base.unresolved.push({ eventId: 0, kind: 'EXCHANGE_LINE_SOURCE_BALANCE_MISMATCH', amount: 0 })
    } else {
      const availableTotal = base.sources.reduce((sum, source) => sum + BigInt(source.available), 0n)
      if (availableTotal > BigInt(Number.MAX_SAFE_INTEGER) || availableTotal !== BigInt(invoiceTotal)) {
        base.unresolved.push({ eventId: 0,
          kind: availableTotal > BigInt(Number.MAX_SAFE_INTEGER)
            ? 'INVALID_EXCHANGE_LINE_SCOPE_BALANCE' : 'EXCHANGE_LINE_SCOPE_BALANCE_MISMATCH',
          amount: availableTotal > BigInt(Number.MAX_SAFE_INTEGER)
            ? 0 : Number(availableTotal - BigInt(invoiceTotal)) })
      } else {
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
            sourceKind: source.sourceKind as 'SOURCE_GIFT' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE',
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
 * It is immutable descriptive provenance only: it does not create refund rights,
 * authorize chained exchanges, or replace the existing fail-closed gate.
 */
export async function recordExchangeFundingLineAllocations(tx: LedgerClient, invoiceId: number) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw invalid()
  const view = await getCurrentExchangeFundingSources(tx, invoiceId)
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
    if (!source || source.event.kind !== 'TRANSFER_IN' ||
        Number(source.event.sourceInvoiceId) !== Number(view.sourceInvoiceId) ||
        Number(source.event.childInvoiceId) !== invoiceId || Number(source.event.returnId) !== Number(view.returnId) ||
        source.sourceKind !== allocation.sourceKind || !Number.isSafeInteger(allocation.amount) || allocation.amount <= 0 ||
        !line || !Number.isSafeInteger(line.qty) || line.qty <= 0 ||
        !Number.isSafeInteger(line.netValue) || line.netValue <= 0)
      throw new BusinessError('پیوند تخصیص قلمی با رویداد انتقال اثبات‌شده سازگار نیست؛ هیچ ردیفی ثبت نشد.')

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

/** Capture persisted tender/redemption rows for an ordinary sale. This does not
 * read renderer provenance and deliberately quarantines malformed credit joins
 * and unsupported tenders as SOURCE_UNKNOWN. EXCHANGE invoices need their own
 * returned-goods allocation path and are rejected here.
 */
export async function recordSaleFundingSnapshot(tx: LedgerClient, invoiceId: number, revision = 1) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || !Number.isSafeInteger(revision) || revision <= 0) throw invalid()
  const invoice = await tx.saleInvoice.findUnique({
    where: { id: invoiceId }, select: { id: true, grandTotal: true, orderType: true }
  })
  if (!invoice) throw new BusinessError('فاکتور برای ثبت منشأ مالی پیدا نشد؛ عملیات متوقف شد.')
  if (invoice.orderType === 'EXCHANGE')
    throw new BusinessError('سند تعویض به تخصیص مستقل ارزش برگشتی نیاز دارد؛ snapshot فروش عادی روی آن اعمال نشد.')
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
      }
    } else if (!orphanedRedemption && redemptionRows.length === 0 && !creditShape) {
      if (entryKind === 'CHEQUE') sourceKind = payment.chequeStatus === 'CLEARED' ? 'SOURCE_CHEQUE' : 'SOURCE_UNKNOWN'
      else if (methodKind === 'CASH' || methodKind === 'CARD') sourceKind = `SOURCE_${methodKind}`
    }
    const allocated = Math.min(remainingInvoiceValue, paymentAmount)
    const excess = paymentAmount - allocated
    const shareId = sourceKind === 'SOURCE_GIFT' ? `redemption:${sourceRedemptionId}` : `payment:${payment.id}`
    const rootShareId = sourceKind === 'SOURCE_GIFT' ? `credit:${sourceCreditId}` : `payment:${payment.id}`
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
      else if (['SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'].includes(sourceKind)) real += allocated
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
        Number(into.returnId) !== input.returnId)
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
