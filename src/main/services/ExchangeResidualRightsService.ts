import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { toNumberRial } from '@shared/money'
import { CreditSource } from '@shared/credit'
import { allocateExchangeFundingProportionalFloor } from '@shared/exchangeFundingAllocation'
import { getCurrentExchangeFundingSources, getCurrentSaleFundingSources } from './ExchangeFundingLedgerService'
import { allocateS1ResidualRightReturn } from '@shared/exchangeResidualRightReturn'
import { issueStoreCredit } from './StoreCreditService'
import { assertManagerPassword } from './AuthService'

type Client = Prisma.TransactionClient | typeof prisma
const stale = () => new BusinessError('وضعیت حق B/N تغییر کرده است؛ عملیات تکراری یا ناسازگار رد شد.')
const invalid = () => new BusinessError('منشأ یا عملیات حق B/N قابل اثبات نیست؛ هیچ رویدادی ثبت نشد.')
const int = (value: unknown, label: string, min = 1): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new BusinessError(`${label} باید ریال صحیح معتبر باشد.`)
  return value
}
const id = (value: unknown, label: string) => int(value, label)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function sameDate(a: any, b: any) {
  const x = a == null ? null : new Date(a).getTime()
  const y = b == null ? null : new Date(b).getTime()
  return x === y
}

function stateOf(events: any[]) {
  if (!Array.isArray(events) || events.length === 0) throw invalid()
  const opens = events.filter((row) => row.eventKind === 'OPENED')
  if (opens.length !== 1) throw invalid()
  const opening = opens[0]
  let available = 0n, reserved = 0n, spent = 0n
  for (const row of events) {
    if (row.rightKey !== opening.rightKey || row.rightKind !== opening.rightKind ||
        Number(row.sourceInvoiceId) !== Number(opening.sourceInvoiceId) ||
        Number(row.childInvoiceId) !== Number(opening.childInvoiceId) ||
        Number(row.returnId) !== Number(opening.returnId) ||
        Number(row.sourceEventId) !== Number(opening.sourceEventId) || row.rootShareId !== opening.rootShareId ||
        !sameDate(row.expiresAt, opening.expiresAt)) throw invalid()
    available += BigInt(toNumberRial(row.availableDelta))
    reserved += BigInt(toNumberRial(row.reservedDelta))
    spent += BigInt(toNumberRial(row.spentDelta))
  }
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  const total = BigInt(toNumberRial(opening.amount))
  const voids = events.filter((row) => row.eventKind === 'VOIDED')
  if ([available, reserved, spent].some((v) => v < 0n || v > max) ||
      voids.length > 1 ||
      (voids.length === 0 && available + reserved + spent !== total) ||
      (voids.length === 1 && (available !== 0n || reserved !== 0n || spent !== 0n ||
        Number(voids[0].reversesEventId) !== Number(opening.id) || events.at(-1)?.id !== voids[0].id))) throw invalid()
  return { opening, available: Number(available), reserved: Number(reserved), spent: Number(spent), voided: voids.length === 1 }
}
async function readState(tx: Client, rightKey: string) {
  const events = await tx.exchangeResidualRightEvent.findMany({ where: { rightKey }, orderBy: { id: 'asc' } }) as any[]
  return stateOf(events)
}
function openingMatches(row: any, expected: any) {
  return row.eventKey === expected.eventKey && row.rightKey === expected.rightKey &&
    row.rightKind === expected.rightKind && row.eventKind === 'OPENED' &&
    toNumberRial(row.amount) === expected.amount && toNumberRial(row.availableDelta) === expected.amount &&
    toNumberRial(row.reservedDelta) === 0 && toNumberRial(row.spentDelta) === 0 &&
    Number(row.sourceInvoiceId) === expected.sourceInvoiceId && Number(row.childInvoiceId) === expected.childInvoiceId &&
    Number(row.returnId) === expected.returnId && Number(row.sourceEventId) === expected.sourceEventId &&
    row.rootShareId === expected.rootShareId && sameDate(row.expiresAt, expected.expiresAt)
}

async function ensureRightCode(tx: Client, opening: any, replayed: boolean) {
  const sourceKind = opening.rightKind === 'B' ? 'S1_EXCHANGE_B' : 'S1_EXCHANGE_N'
  let credit = await tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: opening.rightKey } })
  if (!credit && replayed) throw stale()
  if (!credit) {
    credit = await issueStoreCredit(tx, {
      amount: toNumberRial(opening.amount), source: CreditSource.EXCHANGE,
      returnId: Number(opening.returnId), exchangeInvoiceId: Number(opening.childInvoiceId),
      sourceInvoiceId: Number(opening.sourceInvoiceId), exchangeResidualRightKey: opening.rightKey,
      days: null, expiresAtExact: opening.expiresAt ?? null, multiUse: true, status: 'DRAFT',
      note: `حق ${opening.rightKind} سناریوی S1 · منشأ ${opening.rootShareId}`,
      issuedAt: new Date(), userId: opening.actorUserId ?? null
    })
    await tx.creditDelivery.create({ data: { creditId: credit.id, sourceKind } })
  }
  const delivery = await tx.creditDelivery.findUnique({ where: { creditId: Number(credit.id) } })
  if (Number(credit.amount) !== toNumberRial(opening.amount) || credit.source !== CreditSource.EXCHANGE ||
      Number(credit.returnId) !== Number(opening.returnId) ||
      Number(credit.exchangeInvoiceId) !== Number(opening.childInvoiceId) ||
      Number(credit.sourceInvoiceId) !== Number(opening.sourceInvoiceId) ||
      credit.exchangeResidualRightKey !== opening.rightKey || !sameDate(credit.expiresAt, opening.expiresAt) ||
      !delivery || delivery.sourceKind !== sourceKind) throw stale()
  return { creditId: Number(credit.id), publicReference: `اعتبار #${Number(credit.id)}`,
    amount: toNumberRial(credit.amount), rightKind: opening.rightKind,
    expiresAt: credit.expiresAt ?? null, deliveryStatus: delivery.status, replayed }
}

/** Open only the exact S1 remainders after validating the existing ordinary-sale
 * root reader and the persisted child transfer/matrix. Caller must pass its
 * exchange transaction. Provenance/expiry are never accepted from the renderer.
 */
export async function openS1ExchangeResidualRights(tx: Client, input: {
  sourceInvoiceId: number; childInvoiceId: number; returnId: number; actorUserId?: number | null
}) {
  const sourceInvoiceId = id(input.sourceInvoiceId, 'شناسه فاکتور مبدأ')
  const childInvoiceId = id(input.childInvoiceId, 'شناسه فرزند')
  const returnId = id(input.returnId, 'شناسه برگشت')
  const [ret, child, parent, childFunding] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: returnId }, select: {
      id: true, invoiceId: true, kind: true, total: true, exchangeInvoiceId: true, exchangeTotal: true, voidedAt: true
    } }),
    tx.saleInvoice.findUnique({ where: { id: childInvoiceId }, select: {
      id: true, sourceInvoiceId: true, exchangeReturnId: true, orderType: true, grandTotal: true, voidedAt: true
    } }),
    // This is a historical rights reconstruction, not a spend/transfer gate.
    // After root expiry, permit gift provenance solely to verify the already
    // opened B/N pair; the B balance is still expired by the independent
    // residual-right ledger and N remains unexpired.
    getCurrentSaleFundingSources(tx, sourceInvoiceId, { allowExpiredGiftForReturnAttribution: true }),
    getCurrentExchangeFundingSources(tx, childInvoiceId, {
      allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
    })
  ])
  if (!ret || !child || ret.voidedAt != null || child.voidedAt != null || ret.kind !== 'EXCHANGE' ||
      Number(ret.invoiceId) !== sourceInvoiceId || Number(ret.exchangeInvoiceId) !== childInvoiceId ||
      Number(child.sourceInvoiceId) !== sourceInvoiceId || Number(child.exchangeReturnId) !== returnId ||
      child.orderType !== 'EXCHANGE' || toNumberRial(ret.exchangeTotal) !== toNumberRial(child.grandTotal) ||
      toNumberRial(ret.total) <= 0 || parent.stale || !parent.snapshotExists || parent.unresolved.length ||
      parent.debt !== 0 || parent.overpay !== 0 || parent.activeReturnIds.length !== 1 ||
      parent.activeReturnIds[0] !== returnId || childFunding.unresolved.length ||
      childFunding.sourceInvoiceId !== sourceInvoiceId || childFunding.returnId !== returnId ||
      childFunding.activeReturnIds.length !== 0 || childFunding.lineAllocationStatus !== 'PERSISTED_RECONCILED')
    throw invalid()
  const sources = parent.sources.map((row) => ({ sourceEventId: Number(row.event.id),
    sourceKind: String(row.sourceKind), originalAmount: toNumberRial(row.event.amount), remaining: row.available, row }))
  if (!sources.length || sources.some((s) => !Number.isSafeInteger(s.sourceEventId) || s.sourceEventId <= 0 ||
      s.originalAmount <= 0 || !['SOURCE_GIFT', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'].includes(s.sourceKind)) ||
      sources.reduce((sum, s) => sum + BigInt(s.originalAmount), 0n) !== BigInt(toNumberRial(ret.total))) throw invalid()
  let plan: ReturnType<typeof allocateExchangeFundingProportionalFloor>
  try {
    plan = allocateExchangeFundingProportionalFloor({ replacementTotal: toNumberRial(child.grandTotal),
      sources: sources.map((s) => ({ sourceEventId: s.sourceEventId,
        sourceKind: s.sourceKind as 'SOURCE_GIFT' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE',
        available: s.originalAmount })) })
  } catch { throw invalid() }
  const giftTotal = sources.filter((s) => s.sourceKind === 'SOURCE_GIFT').reduce((n, s) => n + BigInt(s.originalAmount), 0n)
  const realSources = sources.filter((s) => s.sourceKind !== 'SOURCE_GIFT')
  const cashTotal = realSources.reduce((n, s) => n + BigInt(s.originalAmount), 0n)
  if (giftTotal + cashTotal <= 0n ||
      !plan.allocations.some((allocation) => allocation.remainder > 0) ||
      plan.allocations.some((allocation) => !sources.some((source) =>
        source.sourceEventId === allocation.sourceEventId && source.originalAmount >= allocation.remainder)))
    throw invalid()
  const expected = new Map(plan.allocations.map((r) => [r.sourceEventId, r]))
  const transferred = new Map<number, number>()
  for (const row of childFunding.sources) {
    const parentId = Number(row.event.parentEventId)
    const parentSource = sources.find((s) => s.sourceEventId === parentId)
    if (!Number.isSafeInteger(parentId) || parentId <= 0 || row.event.kind !== 'TRANSFER_IN' ||
        Number(row.event.returnId) !== returnId || !parentSource || row.sourceKind !== parentSource.sourceKind) throw invalid()
    transferred.set(parentId, (transferred.get(parentId) ?? 0) + toNumberRial(row.event.amount))
  }
  const rights: any[] = []
  for (const source of sources.sort((a, b) => a.sourceEventId - b.sourceEventId)) {
    const allocation = expected.get(source.sourceEventId)
    if (!allocation || (transferred.get(source.sourceEventId) ?? 0) !== allocation.carry || source.remaining !== allocation.remainder)
      throw invalid()
    if (!allocation.remainder) continue
    const rightKind = source.sourceKind === 'SOURCE_GIFT' ? 'B' : 'N'
    let expiresAt: Date | null = null
    if (rightKind === 'B') {
      const redemption = await tx.storeCreditRedemption.findUnique({
        where: { id: Number(source.row.event.sourceRedemptionId) },
        select: { id: true, expiryCaptured: true, expiryAtRedeem: true }
      })
      if (!redemption || redemption.expiryCaptured !== true) throw invalid()
      expiresAt = redemption.expiryAtRedeem == null ? null : new Date(redemption.expiryAtRedeem)
      if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw invalid()
    }
    const rightKey = `s1-exchange:${returnId}:source:${source.sourceEventId}:${rightKind}`
    const opening = { eventKey: `open:${rightKey}`, rightKey, rightKind, eventKind: 'OPENED',
      amount: allocation.remainder, availableDelta: allocation.remainder, reservedDelta: 0, spentDelta: 0,
      sourceInvoiceId, childInvoiceId, returnId, sourceEventId: source.sourceEventId,
      rootShareId: String(source.row.event.rootShareId), expiresAt, operationKey: null,
      actorUserId: input.actorUserId ?? null, evidenceKind: 'PROVEN_EXCHANGE_SURPLUS',
      evidenceRef: `SaleReturn:${returnId}:SaleInvoice:${childInvoiceId}` }
    const prior = await tx.exchangeResidualRightEvent.findUnique({ where: { eventKey: opening.eventKey } })
    if (!prior && expiresAt && expiresAt.getTime() <= Date.now())
      throw new BusinessError('ریشهٔ هدیه منقضی شده است؛ سهم تاریخی به B مصرف‌پذیر تبدیل نشد.')
    if (prior) {
      if (!openingMatches(prior, opening)) throw stale()
      const state = await readState(tx, rightKey)
      const access = await ensureRightCode(tx, prior, true)
      rights.push({ ...access, rightKey, amount: allocation.remainder, available: state.available,
        reserved: state.reserved, spent: state.spent, expiresAt, replayed: true })
    } else {
      const created = await tx.exchangeResidualRightEvent.create({ data: opening })
      const access = await ensureRightCode(tx, created, false)
      rights.push({ ...access, rightKey, amount: allocation.remainder, available: allocation.remainder,
        reserved: 0, spent: 0, expiresAt, replayed: false })
    }
  }
  rights.sort((a, b) => a.rightKind.localeCompare(b.rightKind) || a.rightKey.localeCompare(b.rightKey))
  return { sourceInvoiceId, childInvoiceId, returnId, giftCarry: plan.giftCarry, cashCarry: plan.cashCarry,
    rights, replayed: rights.length > 0 && rights.every((r) => r.replayed) }
}

export async function planS1ResidualRightSaleReturn(tx: Client, input: {
  invoiceId: number; returnValue: number
}) {
  const invoiceId = id(input.invoiceId, 'شناسه فروش')
  const returnValue = int(input.returnValue, 'مبلغ برگشت')
  const invoice = await tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: {
    id: true, grandTotal: true, status: true, voidedAt: true, orderType: true,
    sourceInvoiceId: true, exchangeReturnId: true
  } })
  if (!invoice || invoice.voidedAt != null || invoice.orderType === 'EXCHANGE' ||
      invoice.sourceInvoiceId != null || invoice.exchangeReturnId != null) throw invalid()
  const payments = await tx.payment.findMany({ where: { invoiceId, voidedAt: null }, include: { method: true } })
  const credits = await tx.storeCredit.findMany({ where: { id: { in: payments.flatMap((payment: any) =>
    payment.storeCreditId == null ? [] : [Number(payment.storeCreditId)]) } } })
  const creditById = new Map((credits as any[]).map((credit) => [Number(credit.id), credit]))
  const linked = payments.filter((payment: any) => payment.storeCreditId != null &&
    creditById.get(Number(payment.storeCreditId))?.exchangeResidualRightKey != null)
  if (!linked.length) return null

  const blocked = () => new BusinessError('برگشت این فروشِ S1 تا تطبیق کامل سهم B/N، سابقهٔ برگشت و دفتر همان حق متوقف است؛ وجه نقد یا اعتبار عمومی ساخته نشد.')
  if (linked.length !== payments.length || payments.some((payment: any) =>
      String(payment.method?.kind ?? '').toUpperCase() !== 'STORE_CREDIT' ||
      payment.storeCreditId == null || creditById.get(Number(payment.storeCreditId))?.exchangeResidualRightKey == null))
    throw blocked()
  const redemptions = await tx.storeCreditRedemption.findMany({
    where: { invoiceId, reversedAt: null }, orderBy: { id: 'asc' }
  })
  if (redemptions.length !== payments.length || !Number.isSafeInteger(toNumberRial(invoice.grandTotal)) ||
      toNumberRial(invoice.grandTotal) !== payments.reduce((sum: number, payment: any) =>
        sum + toNumberRial(payment.amount), 0) || returnValue > toNumberRial(invoice.grandTotal)) throw blocked()

  const rights: any[] = []
  const seenKinds = new Set<string>()
  for (const payment of payments as any[]) {
    const credit = creditById.get(Number(payment.storeCreditId))
    const redemption = (redemptions as any[]).find((row) => Number(row.paymentId) === Number(payment.id))
    const rightKey = String(credit?.exchangeResidualRightKey ?? '')
    const state = rightKey ? await readState(tx, rightKey) : null
    const committed = state?.opening ? (await tx.exchangeResidualRightEvent.findMany({ where: {
      rightKey, eventKind: 'COMMITTED', relatedInvoiceId: invoiceId, relatedPaymentId: Number(payment.id)
    } })).reduce((sum: number, row: any) => sum + toNumberRial(row.amount), 0) : 0
    const delivery = credit ? await tx.creditDelivery.findUnique({ where: { creditId: Number(credit.id) } }) : null
    if (!credit || !redemption || !state || state.voided ||
        !['B', 'N'].includes(String(state.opening.rightKind)) || seenKinds.has(String(state.opening.rightKind)) ||
        credit.source !== CreditSource.EXCHANGE || credit.returnId !== state.opening.returnId ||
        Number(payment.storeCreditId) !== Number(credit.id) ||
        String(payment.method?.kind ?? '').toUpperCase() !== 'STORE_CREDIT' ||
        Number(redemption.creditId) !== Number(credit.id) || Number(redemption.invoiceId) !== invoiceId ||
        toNumberRial(redemption.amount) !== toNumberRial(payment.amount) ||
        toNumberRial(credit.amount) !== toNumberRial(state.opening.amount) || committed !== toNumberRial(payment.amount) ||
        !delivery || delivery.status !== 'DELIVERED' || credit.deletedAt != null || credit.voidedAt != null)
      throw blocked()
    seenKinds.add(String(state.opening.rightKind))
    rights.push({ rightKey, creditId: Number(credit.id), paymentId: Number(payment.id),
      redemptionId: Number(redemption.id), rightKind: String(state.opening.rightKind),
      amount: toNumberRial(payment.amount), expiresAt: state.opening.expiresAt ?? null })
  }
  if (!seenKinds.has('N') || rights.length < 1 || rights.length > 2) throw blocked()
  const bRight = rights.find((right) => right.rightKind === 'B') ?? null
  const nRight = rights.find((right) => right.rightKind === 'N')
  const bAmount = bRight?.amount ?? 0
  const nAmount = nRight.amount
  const total = bAmount + nAmount
  if (total !== toNumberRial(invoice.grandTotal)) throw blocked()

  const history = await tx.saleReturn.findMany({ where: { invoiceId, voidedAt: null }, orderBy: { id: 'asc' } })
  let previouslyReturned = 0
  let priorB = 0
  let priorN = 0
  const expectedRestorations: any[] = []
  for (const priorReturn of history as any[]) {
    if (priorReturn.kind !== 'RETURN' || String(priorReturn.refundMethod ?? '').toUpperCase() !== 'NONE' ||
        toNumberRial(priorReturn.refundAmount ?? 0) !== 0 || priorReturn.refundPaymentId != null ||
        priorReturn.storeCreditId != null || priorReturn.exchangeInvoiceId != null ||
        toNumberRial(priorReturn.debtReduction ?? 0) !== 0)
      throw blocked()
    let allocation
    try {
      allocation = allocateS1ResidualRightReturn({ bAmount, nAmount, previouslyReturned,
        returningAmount: toNumberRial(priorReturn.total),
        ...(previouslyReturned > 0 ? { priorAllocations: { b: priorB, n: priorN } } : {}) })
    } catch { throw blocked() }
    for (const [right, share] of [[bRight, allocation.b.amount], [nRight, allocation.n.amount]] as const) {
      if (!right || share === 0) continue
      expectedRestorations.push({ returnId: Number(priorReturn.id), rightKey: right.rightKey,
        paymentId: right.paymentId, amount: share })
    }
    previouslyReturned = allocation.returnedAfter
    priorB = allocation.b.cumulative
    priorN = allocation.n.cumulative
  }
  const allReturns = await tx.saleReturn.findMany({ where: { invoiceId }, select: { id: true, voidedAt: true } }) as any[]
  const returnById = new Map<number, any>(allReturns.map((row) => [Number(row.id), row]))
  const rightKeys = rights.map((right) => right.rightKey)
  const [restorationEvents, reversalEvents] = await Promise.all([
    tx.exchangeResidualRightEvent.findMany({ where: {
      rightKey: { in: rightKeys }, eventKind: 'RESTORED'
    }, orderBy: { id: 'asc' } }),
    tx.exchangeResidualRightEvent.findMany({ where: {
      rightKey: { in: rightKeys }, eventKind: 'RESTORATION_REVERSED'
    }, orderBy: { id: 'asc' } })
  ])
  const restoreById = new Map<number, any>((restorationEvents as any[]).map((row) => [Number(row.id), row]))
  const reversedRestoreIds = new Set<number>()
  for (const reversal of reversalEvents as any[]) {
    const sourceId = Number(reversal.reversesEventId)
    const source = restoreById.get(sourceId)
    if (!source || reversedRestoreIds.has(sourceId) ||
        String(reversal.rightKey) !== String(source.rightKey) ||
        Number(reversal.relatedReturnId) !== Number(source.relatedReturnId) ||
        Number(reversal.relatedInvoiceId) !== invoiceId || Number(source.relatedInvoiceId) !== invoiceId ||
        Number(reversal.relatedPaymentId) !== Number(source.relatedPaymentId) ||
        toNumberRial(reversal.amount) !== toNumberRial(source.amount) ||
        !returnById.has(Number(source.relatedReturnId)))
      throw blocked()
    reversedRestoreIds.add(sourceId)
  }
  const activeRestorations: any[] = []
  for (const restoration of restorationEvents as any[]) {
    const returnId = Number(restoration.relatedReturnId)
    const returnRecord = returnById.get(returnId)
    const isReversed = reversedRestoreIds.has(Number(restoration.id))
    if (!returnRecord || Number(restoration.relatedInvoiceId) !== invoiceId ||
        !rights.some((right) => right.rightKey === restoration.rightKey &&
          right.paymentId === Number(restoration.relatedPaymentId)) ||
        !Number.isSafeInteger(toNumberRial(restoration.amount)) || toNumberRial(restoration.amount) <= 0 ||
        (returnRecord.voidedAt != null) !== isReversed)
      throw blocked()
    if (!isReversed) activeRestorations.push(restoration)
  }
  if (activeRestorations.length !== expectedRestorations.length || expectedRestorations.some((expected) =>
      !activeRestorations.some((actual: any) => Number(actual.relatedReturnId) === expected.returnId &&
        actual.rightKey === expected.rightKey && Number(actual.relatedInvoiceId) === invoiceId &&
        Number(actual.relatedPaymentId) === expected.paymentId && toNumberRial(actual.amount) === expected.amount)))
    throw blocked()
  let current
  try {
    current = allocateS1ResidualRightReturn({ bAmount, nAmount, previouslyReturned,
      returningAmount: returnValue,
      ...(previouslyReturned > 0 ? { priorAllocations: { b: priorB, n: priorN } } : {}) })
  } catch { throw blocked() }
  return { invoiceId, total, previouslyReturned, bAmount, nAmount, bRight, nRight,
    b: current.b, n: current.n, returnValue, cumulativeReturned: current.returnedAfter }
}

async function correctionProjection(tx: Client, opening: any, base: { available: number; reserved: number; spent: number }) {
  const rows = await tx.exchangeResidualRightCorrectionEvent.findMany({
    where: { rightKey: String(opening.rightKey) }, orderBy: { id: 'asc' }
  }) as any[]
  let adjusted = 0n, disputed = 0n, offset = 0n
  const byId = new Map<number, any>()
  for (const row of rows) {
    if (row.rightKey !== opening.rightKey || row.rightKind !== 'N' ||
        Number(row.sourceInvoiceId) !== Number(opening.sourceInvoiceId) ||
        Number(row.childInvoiceId) !== Number(opening.childInvoiceId) ||
        Number(row.rootReturnId) !== Number(opening.returnId) ||
        Number(row.sourceEventId) !== Number(opening.sourceEventId) || row.rootShareId !== opening.rootShareId ||
        !['RIGHT_ADJUST', 'DISPUTED_RECOVERY_OPEN', 'DISPUTE_OFFSET_BY_RETURN',
          'SOURCE_QUARANTINED', 'SOURCE_REATTRIBUTED'].includes(String(row.eventKind)) ||
        !Number.isSafeInteger(toNumberRial(row.amount)) || toNumberRial(row.amount) < 0 ||
        String(row.evidenceRef ?? '').trim().length < 8 || String(row.reason ?? '').trim().length < 8)
      throw invalid()
    if (row.eventKind === 'RIGHT_ADJUST') {
      if (toNumberRial(row.amount) <= 0 || toNumberRial(row.availableDelta) !== -toNumberRial(row.amount) ||
          toNumberRial(row.disputedDelta) !== 0 || row.relatedInvoiceId != null || row.relatedPaymentId != null)
        throw invalid()
      adjusted += BigInt(toNumberRial(row.amount))
    } else if (row.eventKind === 'DISPUTED_RECOVERY_OPEN') {
      if (toNumberRial(row.amount) <= 0 || toNumberRial(row.availableDelta) !== 0 ||
          toNumberRial(row.disputedDelta) !== toNumberRial(row.amount) ||
          toNumberRial(row.basisAmount) <= 0 || !Number.isSafeInteger(Number(row.relatedInvoiceId)) ||
          Number(row.relatedInvoiceId) <= 0 || !Number.isSafeInteger(Number(row.relatedPaymentId)) ||
          Number(row.relatedPaymentId) <= 0) throw invalid()
      disputed += BigInt(toNumberRial(row.amount))
    } else if (row.eventKind === 'DISPUTE_OFFSET_BY_RETURN') {
      const parent = byId.get(Number(row.parentCorrectionEventId))
      if (toNumberRial(row.amount) <= 0 || toNumberRial(row.availableDelta) !== 0 ||
          toNumberRial(row.disputedDelta) !== -toNumberRial(row.amount) ||
          toNumberRial(row.basisAmount) <= 0 || !parent || parent.eventKind !== 'DISPUTED_RECOVERY_OPEN' ||
          parent.operationKey !== row.operationKey || Number(parent.relatedInvoiceId) !== Number(row.relatedInvoiceId) ||
          Number(parent.relatedPaymentId) !== Number(row.relatedPaymentId) ||
          !Number.isSafeInteger(Number(row.relatedReturnId)) || Number(row.relatedReturnId) <= 0)
        throw invalid()
      offset += BigInt(toNumberRial(row.amount))
    } else if (toNumberRial(row.amount) !== 0 || toNumberRial(row.availableDelta) !== 0 ||
        toNumberRial(row.disputedDelta) !== 0) throw invalid()
    byId.set(Number(row.id), row)
  }
  const outstanding = disputed - offset
  const effectiveAmount = BigInt(toNumberRial(opening.amount)) - adjusted - disputed
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (adjusted < 0n || disputed < 0n || offset < 0n || outstanding < 0n || effectiveAmount < 0n ||
      [adjusted, disputed, offset, outstanding, effectiveAmount].some((n) => n > max) ||
      adjusted + disputed > BigInt(toNumberRial(opening.amount)) ||
      outstanding > BigInt(base.spent) || BigInt(base.reserved) > effectiveAmount)
    throw invalid()
  const validSpent = BigInt(base.spent) - outstanding
  const available = effectiveAmount - validSpent - BigInt(base.reserved)
  if (validSpent < 0n || available < 0n || available > max) throw invalid()
  return { rows, adjusted: Number(adjusted), disputed: Number(disputed), offset: Number(offset),
    outstanding: Number(outstanding), effectiveAmount: Number(effectiveAmount),
    validSpent: Number(validSpent), available: Number(available) }
}

export async function getExchangeResidualRightBalance(tx: Client, rightKey: string, at = new Date()) {
  if (typeof rightKey !== 'string' || rightKey.length < 8 || rightKey.length > 200 ||
      !(at instanceof Date) || !Number.isFinite(at.getTime())) throw invalid()
  const state = await readState(tx, rightKey)
  const expired = state.opening.rightKind === 'B' && state.opening.expiresAt != null &&
    new Date(state.opening.expiresAt).getTime() <= at.getTime()
  const correction = state.opening.rightKind === 'N'
    ? await correctionProjection(tx, state.opening, state) : null
  const quarantineIds = correction?.rows.filter((row) => row.eventKind === 'SOURCE_QUARANTINED')
    .map((row) => Number(row.id)) ?? []
  const latestQuarantineId = quarantineIds.length ? Math.max(...quarantineIds) : -1
  const sourceQuarantined = latestQuarantineId >= 0 &&
    !correction!.rows.some((row) => row.eventKind === 'SOURCE_REATTRIBUTED' && Number(row.id) > latestQuarantineId)
  const base = { rightKey, rightKind: state.opening.rightKind, amount: toNumberRial(state.opening.amount),
    available: expired || state.voided || sourceQuarantined ? 0 : correction?.available ?? state.available,
    reserved: state.reserved, spent: correction?.validSpent ?? state.spent,
    expiresAt: state.opening.expiresAt ?? null, expired, voided: state.voided,
    sourceInvoiceId: Number(state.opening.sourceInvoiceId), childInvoiceId: Number(state.opening.childInvoiceId),
    returnId: Number(state.opening.returnId), sourceEventId: Number(state.opening.sourceEventId),
    rootShareId: String(state.opening.rootShareId) }
  // Keep the pre-S7 read shape byte-for-byte for untouched rights; S7 projection
  // fields appear only after an append-only correction/disposition exists.
  if (!correction?.rows.length) return base
  return { ...base, validAmount: correction.effectiveAmount, grossAvailable: state.available,
    grossSpent: state.spent, rightAdjusted: correction.adjusted,
    disputedRecoveryOpen: correction.outstanding, disputedRecoveryTotal: correction.disputed,
    disputedOffset: correction.offset, sourceQuarantined }
}


/** S7: append one witnessed correction to an existing delivered N right.
 * Reserved rights, B rights and malformed/cross-lineage evidence fail closed.
 */
export async function adjustS7NResidualRight(input: {
  rightKey: string; operationKey: string; verifiedAmount: number; relatedInvoiceId: number;
  relatedPaymentId: number; evidenceKind: string; evidenceRef: string; reason: string;
  managerPassword?: string | null; actorUserId?: number | null
}) {
  const rightKey = String(input?.rightKey ?? '').trim()
  const operationKey = String(input?.operationKey ?? '').trim()
  const verifiedAmount = int(input?.verifiedAmount, 'حق اثبات‌شده')
  const relatedInvoiceId = id(input?.relatedInvoiceId, 'فاکتور مصرف N')
  const relatedPaymentId = id(input?.relatedPaymentId, 'پرداخت مصرف N')
  const evidenceKind = String(input?.evidenceKind ?? '').trim().toUpperCase()
  const evidenceRef = String(input?.evidenceRef ?? '').trim()
  const reason = String(input?.reason ?? '').trim()
  if (rightKey.length < 8 || rightKey.length > 200 || operationKey.length < 8 || operationKey.length > 200 ||
      !['CASH_RECONCILIATION', 'CARD_STATEMENT_REVIEW', 'CHEQUE_BOUNCED'].includes(evidenceKind) ||
      evidenceRef.length < 8 || evidenceRef.length > 300 || reason.length < 8 || reason.length > 500)
    throw new BusinessError('برای اصلاح S7، کلید یکتا، نوع/نشانی شاهد و دلیل روشن لازم است؛ هیچ حق تغییر نکرد.')
  await assertManagerPassword(input.managerPassword, 'اصلاح شاهددار حق N و ثبت DISPUTED_RECOVERY')
  return prisma.$transaction(async (tx) => {
    const state = await readState(tx, rightKey)
    const opening = state.opening
    if (opening.rightKind !== 'N' || verifiedAmount > toNumberRial(opening.amount))
      throw new BusinessError('فقط حق N فعال قابل اصلاح است؛ B دست‌نخورده می‌ماند.')
    const priorRows = await tx.exchangeResidualRightCorrectionEvent.findMany({
      where: { rightKey, operationKey }, orderBy: { id: 'asc' }
    }) as any[]
    if (priorRows.length) {
      const projection = await correctionProjection(tx, opening, state)
      if (projection.effectiveAmount !== verifiedAmount || priorRows.some((row) =>
          row.evidenceKind !== evidenceKind || row.evidenceRef !== evidenceRef || row.reason !== reason) ||
          !priorRows.some((row) => ['RIGHT_ADJUST', 'DISPUTED_RECOVERY_OPEN'].includes(row.eventKind)))
        throw stale()
      return { rightKey, replayed: true, validAmount: projection.effectiveAmount,
        available: projection.available, spent: projection.validSpent,
        disputedRecoveryOpen: projection.outstanding }
    }
    if (state.voided || state.reserved !== 0)
      throw new BusinessError('حق N دارای رزرو فعال یا ابطال‌شده است؛ اصلاح تا commit/cancel رد شد.')
    const priorCorrection = await tx.exchangeResidualRightCorrectionEvent.findFirst({
      where: { rightKey, eventKind: { in: ['RIGHT_ADJUST', 'DISPUTED_RECOVERY_OPEN'] } }
    })
    if (priorCorrection) throw stale()
    const root = await tx.exchangeFundingEvent.findUnique({ where: { id: Number(opening.sourceEventId) } })
    const sourcePaymentId = Number(root?.sourcePaymentId)
    const code = await tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: rightKey } })
    const [delivery, sourcePayment, commits, consumingPayment, redemption] = await Promise.all([
      code ? tx.creditDelivery.findUnique({ where: { creditId: Number(code.id) } }) : null,
      Number.isSafeInteger(sourcePaymentId) && sourcePaymentId > 0
        ? tx.payment.findUnique({ where: { id: sourcePaymentId }, include: { method: true } }) : null,
      tx.exchangeResidualRightEvent.findMany({ where: { rightKey, eventKind: 'COMMITTED' } }),
      tx.payment.findUnique({ where: { id: relatedPaymentId }, include: { method: true } }),
      tx.storeCreditRedemption.findFirst({ where: { paymentId: relatedPaymentId,
        invoiceId: relatedInvoiceId, reversedAt: null } })
    ])
    const cardProof = evidenceKind === 'CARD_STATEMENT_REVIEW' && Number.isSafeInteger(sourcePaymentId)
      ? await tx.exchangeResidualRightPaymentEvidence.findUnique({ where: { paymentId: sourcePaymentId } }) : null
    const spends = new Set((commits as any[]).map((row) => `${row.relatedInvoiceId}:${row.relatedPaymentId}`))
    const restorations = await tx.exchangeResidualRightEvent.findMany({
      where: { rightKey, eventKind: 'RESTORED' }
    }) as any[]
    if (!root || !['SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'].includes(String(root.kind)) ||
        Number(root.sourceInvoiceId) !== Number(opening.sourceInvoiceId) || !code ||
        code.source !== CreditSource.EXCHANGE || code.exchangeResidualRightKey !== rightKey ||
        !delivery || delivery.status !== 'DELIVERED' || !sourcePayment ||
        Number(sourcePayment.invoiceId) !== Number(opening.sourceInvoiceId) || sourcePayment.voidedAt != null ||
        toNumberRial(root.amount) !== toNumberRial(sourcePayment.amount) ||
        !consumingPayment || Number(consumingPayment.invoiceId) !== relatedInvoiceId ||
        Number(consumingPayment.storeCreditId) !== Number(code.id) || consumingPayment.voidedAt != null ||
        String(consumingPayment.method?.kind ?? '').toUpperCase() !== 'STORE_CREDIT' || !redemption ||
        Number(redemption.creditId) !== Number(code.id) || toNumberRial(redemption.amount) !== toNumberRial(consumingPayment.amount) ||
        toNumberRial(root.amount) <= 0 || !spends.has(`${relatedInvoiceId}:${relatedPaymentId}`) ||
        spends.size !== 1 || restorations.length !== 0)
      throw new BusinessError('مبدأ N یا مصرف هدف قابل اثبات نیست؛ هیچ شاخهٔ دیگر یا فروش نامرتبط تغییر نکرد.')
    if (evidenceKind === 'CHEQUE_BOUNCED' &&
        (String(root.kind) !== 'SOURCE_CHEQUE' || String(sourcePayment.kind ?? '').toUpperCase() !== 'CHEQUE' ||
          String(sourcePayment.chequeStatus ?? '').toUpperCase() !== 'BOUNCED' ||
          ![sourcePayment.chequeNo, sourcePayment.reference].some((value) => String(value ?? '').trim() === evidenceRef)))
      throw new BusinessError('شاهد چکِ برگشتی با وضعیت همان Payment منطبق نیست؛ سهم نقد/کارت دست‌نخورده ماند.')
    const methodKind = String(sourcePayment.method?.kind ?? '').toUpperCase()
    if ((evidenceKind === 'CASH_RECONCILIATION' &&
          (methodKind !== 'CASH' || String(sourcePayment.reference ?? '').trim() !== evidenceRef)) ||
        (evidenceKind === 'CARD_STATEMENT_REVIEW' &&
          (methodKind !== 'CARD' || !cardProof ||
            toNumberRial(cardProof.confirmedAmount) !== toNumberRial(sourcePayment.amount) ||
            String(cardProof.sha256) !== evidenceRef)) ||
        (evidenceKind === 'CHEQUE_BOUNCED' && sourcePayment.kind !== 'CHEQUE'))
      throw new BusinessError('نوع شاهد با Payment ریشه‌ای منطبق نیست؛ هیچ اصلاحی ثبت نشد.')
    const disputed = Math.max(0, state.spent - verifiedAmount)
    const rightAdjust = toNumberRial(opening.amount) - verifiedAmount - disputed
    if (!Number.isSafeInteger(rightAdjust) || rightAdjust < 0 || rightAdjust > state.available || disputed > state.spent)
      throw new BusinessError('اصلاحِ محاسبه‌شده از ماندهٔ باز فراتر می‌رود یا مصرف تاریخی ناسازگار است؛ پرونده متوقف شد.')
    if (rightAdjust === 0 && disputed === 0)
      throw new BusinessError('اصلاح مبلغ هیچ تغییری نمی‌دهد؛ برای جلوگیری از رویداد صوری، عملیات ثبت نشد.')
    const common = { rightKey, rightKind: 'N', sourceInvoiceId: Number(opening.sourceInvoiceId),
      childInvoiceId: Number(opening.childInvoiceId), rootReturnId: Number(opening.returnId),
      sourceEventId: Number(opening.sourceEventId), rootShareId: String(opening.rootShareId),
      operationKey, actorUserId: input.actorUserId ?? null, evidenceKind, evidenceRef, reason }
    if (rightAdjust > 0) await tx.exchangeResidualRightCorrectionEvent.create({ data: {
      ...common, eventKey: `s7:${rightKey}:${digest(operationKey)}:right-adjust`,
      eventKind: 'RIGHT_ADJUST', amount: rightAdjust, availableDelta: -rightAdjust, disputedDelta: 0,
      relatedInvoiceId: null, relatedPaymentId: null
    } })
    let disputeEvent: any = null
    if (disputed > 0) disputeEvent = await tx.exchangeResidualRightCorrectionEvent.create({ data: {
      ...common, eventKey: `s7:${rightKey}:${digest(operationKey)}:disputed-open`,
      eventKind: 'DISPUTED_RECOVERY_OPEN', amount: disputed, availableDelta: 0,
      disputedDelta: disputed, basisAmount: state.spent,
      relatedInvoiceId, relatedPaymentId
    } })
    const projection = await correctionProjection(tx, opening, state)
    if (projection.effectiveAmount !== verifiedAmount || projection.available !== 0 ||
        projection.outstanding !== disputed) throw invalid()
    return { rightKey, replayed: false, validAmount: projection.effectiveAmount,
      rightAdjusted: rightAdjust, disputedRecoveryOpen: disputed, available: projection.available,
      spent: projection.validSpent, disputedEventId: disputeEvent?.id ?? null }
  })
}

/** Called inside SalesService.setChequeStatus's transaction so an externally
 * bounced/cleared cheque and the matching residual-right quarantine/release
 * commit atomically rather than rewriting a transferred funding snapshot.
 */
export async function recordS7ChequeResidualRightDisposition(tx: Client, input: {
  paymentId: number; status: 'BOUNCED' | 'CLEARED'; actorUserId?: number | null; statusHistoryId: number
}) {
  const paymentId = id(input.paymentId, 'شناسه پرداخت چک')
  if (!['BOUNCED', 'CLEARED'].includes(input.status) || !Number.isSafeInteger(input.statusHistoryId) ||
      input.statusHistoryId <= 0) throw invalid()
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { method: true } })
  if (!payment || payment.kind !== 'CHEQUE' ||
      String(payment.chequeStatus ?? '').toUpperCase() !== input.status) throw invalid()
  const roots = await tx.exchangeFundingEvent.findMany({
    where: { sourcePaymentId: paymentId, kind: 'SOURCE_CHEQUE' }, orderBy: { id: 'asc' }
  }) as any[]
  if (!roots.length) return { affectedRights: 0, handled: false }
  const rootIds = roots.map((row) => Number(row.id))
  const openings = await tx.exchangeResidualRightEvent.findMany({
    where: { sourceEventId: { in: rootIds }, rightKind: 'N', eventKind: 'OPENED' }, orderBy: { id: 'asc' }
  }) as any[]
  if (!openings.length) return { affectedRights: 0, handled: false }
  let affectedRights = 0
  for (const opening of openings) {
    const state = await readState(tx, String(opening.rightKey))
    if (state.reserved !== 0 || state.voided) throw new BusinessError(
      'چک به یک حق N رزروشده متصل است؛ ابتدا رزرو را commit یا cancel کنید؛ وضعیت مالیِ حق تغییر نکرد.')
    const events = await tx.exchangeResidualRightCorrectionEvent.findMany({
      where: { rightKey: String(opening.rightKey) }, orderBy: { id: 'asc' }
    }) as any[]
    const lastDisposition = [...events].reverse().find((row) =>
      ['SOURCE_QUARANTINED', 'SOURCE_REATTRIBUTED'].includes(String(row.eventKind)))
    const quarantine = input.status === 'BOUNCED'
    if (quarantine && lastDisposition?.eventKind === 'SOURCE_QUARANTINED') continue
    if (!quarantine && lastDisposition?.eventKind !== 'SOURCE_QUARANTINED') continue
    const eventKind = quarantine ? 'SOURCE_QUARANTINED' : 'SOURCE_REATTRIBUTED'
    const operationKey = `s7-cheque-status:${paymentId}:${input.statusHistoryId}`
    const eventKey = `s7:${opening.rightKey}:${digest(operationKey)}:${eventKind.toLowerCase()}`
    const old = await tx.exchangeResidualRightCorrectionEvent.findUnique({ where: { eventKey } })
    if (old) {
      if (old.eventKind !== eventKind || Number(old.sourceEventId) !== Number(opening.sourceEventId)) throw stale()
      continue
    }
    await tx.exchangeResidualRightCorrectionEvent.create({ data: {
      eventKey, operationKey, rightKey: String(opening.rightKey), rightKind: 'N', eventKind,
      amount: 0, availableDelta: 0, disputedDelta: 0, basisAmount: 0,
      sourceInvoiceId: Number(opening.sourceInvoiceId), childInvoiceId: Number(opening.childInvoiceId),
      rootReturnId: Number(opening.returnId), sourceEventId: Number(opening.sourceEventId),
      rootShareId: String(opening.rootShareId), relatedInvoiceId: null, relatedPaymentId: null,
      relatedReturnId: null, parentCorrectionEventId: null, actorUserId: input.actorUserId ?? null,
      evidenceKind: quarantine ? 'CHEQUE_BOUNCED' : 'CHEQUE_CLEARED',
      evidenceRef: String(payment.chequeNo ?? payment.reference ?? `Payment:${paymentId}`),
      reason: quarantine ? `Payment cheque status changed to BOUNCED; history #${input.statusHistoryId}`
        : `Payment cheque status changed to CLEARED; history #${input.statusHistoryId}`
    } })
    affectedRights++
  }
  return { affectedRights, handled: true }
}

/** Archive a manager-reviewed actual statement against the source Payment.
 * Renderer-supplied hashes or references alone are never accepted as bank proof.
 */
export async function reviewS7CardSourceBankStatement(input: {
  paymentId: number; confirmedAmount: number; document: { name: string; bytes: Uint8Array };
  reviewNote: string; attestedBankAccountReview: boolean;
  managerPassword?: string | null; actorUserId?: number | null
}) {
  const paymentId = id(input?.paymentId, 'شناسه پرداخت کارت')
  const amount = int(input?.confirmedAmount, 'مبلغ صورت‌حساب')
  const note = String(input?.reviewNote ?? '').trim()
  const bytes = input?.document?.bytes
  const name = String(input?.document?.name ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120)
  const lowerName = name.toLowerCase()
  const mimeType = lowerName.endsWith('.pdf') && Buffer.from(bytes ?? []).subarray(0, 5).toString() === '%PDF-'
    ? 'application/pdf'
    : lowerName.endsWith('.csv') && bytes instanceof Uint8Array && !Buffer.from(bytes).includes(0) && bytes.length > 10
      ? 'text/csv' : null
  if (!mimeType || !(bytes instanceof Uint8Array) || bytes.length < 15 || bytes.length > 5_000_000 ||
      note.length < 10 || input?.attestedBankAccountReview !== true)
    throw new BusinessError('برای رفع قرنطینهٔ کارت، فایل واقعی PDF/CSV و تأیید صریح تطبیق حساب/تاریخ/مبلغ مدیر لازم است.')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await assertManagerPassword(input.managerPassword, 'بازبینی صورت‌حساب بانک برای سهم کارتِ حق N')
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { method: true } })
    const root = await tx.exchangeFundingEvent.findFirst({ where: {
      sourcePaymentId: paymentId, kind: 'SOURCE_CARD'
    }, orderBy: { id: 'asc' } })
    if (!payment || payment.voidedAt != null || String(payment.method?.kind ?? '').toUpperCase() !== 'CARD' ||
        payment.kind === 'CHEQUE' || !root || amount !== toNumberRial(payment.amount) ||
        amount !== toNumberRial(root.amount))
      throw new BusinessError('صورت‌حساب دقیقاً به پرداخت کارتیِ ریشه‌دار متصل نیست؛ مدرک ثبت نشد.')
    const old = await tx.exchangeResidualRightPaymentEvidence.findUnique({ where: { paymentId } })
    if (old) {
      if (old.sha256 !== sha256 || toNumberRial(old.confirmedAmount) !== amount || old.reviewNote !== note)
        throw stale()
      return { paymentId, evidenceId: Number(old.id), sha256, confirmedAmount: amount, replayed: true }
    }
    const evidence = await tx.exchangeResidualRightPaymentEvidence.create({ data: {
      paymentId, confirmedAmount: amount, sha256, fileName: name,
      documentBase64: Buffer.from(bytes).toString('base64'), mimeType,
      reviewedByUserId: input.actorUserId ?? null, reviewNote: note
    } })
    return { paymentId, evidenceId: Number(evidence.id), sha256, confirmedAmount: amount, replayed: false }
  })
}

/** S7 source-local quarantine/release. A bounced cheque or unproven card is
 * isolated to this N lineage; release requires a later source-matching witness.
 */
export async function setS7NResidualRightSourceDisposition(input: {
  rightKey: string; operationKey: string; action: 'QUARANTINE' | 'RELEASE';
  evidenceKind: string; evidenceRef: string; reason: string;
  managerPassword?: string | null; actorUserId?: number | null
}) {
  const rightKey = String(input?.rightKey ?? '').trim()
  const operationKey = String(input?.operationKey ?? '').trim()
  const action = input?.action
  const evidenceKind = String(input?.evidenceKind ?? '').trim().toUpperCase()
  const evidenceRef = String(input?.evidenceRef ?? '').trim()
  const reason = String(input?.reason ?? '').trim()
  if (rightKey.length < 8 || rightKey.length > 200 || operationKey.length < 8 || operationKey.length > 200 ||
      !['QUARANTINE', 'RELEASE'].includes(String(action)) || evidenceRef.length < 8 || evidenceRef.length > 300 ||
      reason.length < 8 || reason.length > 500)
    throw new BusinessError('برای قرنطینه/آزادسازی S7، کلید یکتا، شاهد و دلیل لازم است.')
  await assertManagerPassword(input.managerPassword, 'قرنطینه/رفع قرنطینهٔ lineage حق N')
  return prisma.$transaction(async (tx) => {
    const state = await readState(tx, rightKey)
    if (state.opening.rightKind !== 'N')
      throw new BusinessError('فقط lineage حق N قابل قرنطینه/آزادسازی است.')
    const eventKind = action === 'QUARANTINE' ? 'SOURCE_QUARANTINED' : 'SOURCE_REATTRIBUTED'
    const eventKey = `s7:${rightKey}:${digest(operationKey)}:${eventKind.toLowerCase()}`
    const prior = await tx.exchangeResidualRightCorrectionEvent.findUnique({ where: { eventKey } })
    if (prior) {
      if (prior.eventKind !== eventKind || prior.evidenceKind !== evidenceKind ||
          prior.evidenceRef !== evidenceRef || prior.reason !== reason || prior.rightKey !== rightKey)
        throw stale()
      const projection = await correctionProjection(tx, state.opening, state)
      const latestDisposition = [...projection.rows].reverse().find((row) =>
        ['SOURCE_QUARANTINED', 'SOURCE_REATTRIBUTED'].includes(String(row.eventKind)))
      return { rightKey, eventKind, replayed: true, available: latestDisposition?.eventKind === 'SOURCE_QUARANTINED'
        ? 0 : projection.available, quarantined: eventKind === 'SOURCE_QUARANTINED' }
    }
    if (state.voided || state.reserved !== 0)
      throw new BusinessError('فقط lineage حق N بدون رزرو فعال قابل قرنطینه/آزادسازی است.')
    const root = await tx.exchangeFundingEvent.findUnique({ where: { id: Number(state.opening.sourceEventId) } })
    const sourcePaymentId = Number(root?.sourcePaymentId)
    const [credit, payment, existingEvents] = await Promise.all([
      tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: rightKey } }),
      Number.isSafeInteger(sourcePaymentId) && sourcePaymentId > 0
        ? tx.payment.findUnique({ where: { id: sourcePaymentId }, include: { method: true } }) : null,
      tx.exchangeResidualRightCorrectionEvent.findMany({ where: { rightKey }, orderBy: { id: 'asc' } })
    ])
    const delivery = credit ? await tx.creditDelivery.findUnique({ where: { creditId: Number(credit.id) } }) : null
    const methodKind = String(payment?.method?.kind ?? '').toUpperCase()
    const bankProof = action === 'RELEASE' && methodKind === 'CARD' && Number.isSafeInteger(sourcePaymentId)
      ? await tx.exchangeResidualRightPaymentEvidence.findUnique({ where: { paymentId: sourcePaymentId } }) : null
    if (!root || !payment || !credit || credit.source !== CreditSource.EXCHANGE ||
        credit.exchangeResidualRightKey !== rightKey || !delivery || delivery.status !== 'DELIVERED' ||
        Number(payment.invoiceId) !== Number(state.opening.sourceInvoiceId) || payment.voidedAt != null)
      throw invalid()
    const rootKind = String(root.kind)
    if (action === 'QUARANTINE') {
      const valid = evidenceKind === 'CHEQUE_BOUNCED' && rootKind === 'SOURCE_CHEQUE' &&
        payment.kind === 'CHEQUE' && String(payment.chequeStatus ?? '').toUpperCase() === 'BOUNCED' &&
        [payment.chequeNo, payment.reference].some((value) => String(value ?? '').trim() === evidenceRef)
        || evidenceKind === 'CARD_UNKNOWN' && rootKind === 'SOURCE_CARD' && methodKind === 'CARD'
      if (!valid) throw new BusinessError('شاهدِ قرنطینه با Payment ریشه‌ای همان N تطبیق ندارد.')
    } else {
      const quarantined = [...(existingEvents as any[])].reverse().find((row) =>
        ['SOURCE_QUARANTINED', 'SOURCE_REATTRIBUTED'].includes(String(row.eventKind)))
      if (!quarantined || quarantined.eventKind !== 'SOURCE_QUARANTINED')
        throw new BusinessError('این lineage قرنطینهٔ فعال ندارد یا قبلاً آزاد شده است.')
      const valid = evidenceKind === 'CHEQUE_CLEARED' && rootKind === 'SOURCE_CHEQUE' &&
        payment.kind === 'CHEQUE' && String(payment.chequeStatus ?? '').toUpperCase() === 'CLEARED' &&
        [payment.chequeNo, payment.reference].some((value) => String(value ?? '').trim() === evidenceRef)
        || evidenceKind === 'CARD_STATEMENT_REVIEW' && rootKind === 'SOURCE_CARD' && methodKind === 'CARD' &&
          !!bankProof && toNumberRial(bankProof.confirmedAmount) === toNumberRial(payment.amount) &&
          String(bankProof.sha256) === evidenceRef
      if (!valid) throw new BusinessError('مدرک رفع قرنطینه با پرداخت بانکی ریشه‌ای تطبیق ندارد.')
    }
    await tx.exchangeResidualRightCorrectionEvent.create({ data: {
      eventKey, operationKey, rightKey, rightKind: 'N', eventKind, amount: 0,
      availableDelta: 0, disputedDelta: 0, basisAmount: 0,
      sourceInvoiceId: Number(state.opening.sourceInvoiceId), childInvoiceId: Number(state.opening.childInvoiceId),
      rootReturnId: Number(state.opening.returnId), sourceEventId: Number(state.opening.sourceEventId),
      rootShareId: String(state.opening.rootShareId), relatedInvoiceId: null, relatedPaymentId: null,
      relatedReturnId: null, parentCorrectionEventId: null, actorUserId: input.actorUserId ?? null,
      evidenceKind, evidenceRef, reason
    } })
    const projection = await correctionProjection(tx, state.opening, state)
    return { rightKey, eventKind, replayed: false, available: projection.available,
      quarantined: action === 'QUARANTINE' }
  })
}

function operation(input: any) {
  const rightKey = String(input?.rightKey ?? '').trim()
  const operationKey = String(input?.operationKey ?? '').trim()
  const amount = int(input?.amount, 'مبلغ عملیات')
  const relatedInvoiceId = id(input?.relatedInvoiceId, 'شناسه فاکتور مصرف')
  if (rightKey.length < 8 || rightKey.length > 200 || operationKey.length < 8 || operationKey.length > 200)
    throw new BusinessError('شناسهٔ حق یا کلید idempotency معتبر نیست.')
  return { rightKey, operationKey, amount, relatedInvoiceId, hash: digest(operationKey) }
}
async function appendBalance(tx: Client, opening: any, input: any) {
  const prior = await tx.exchangeResidualRightEvent.findUnique({ where: { eventKey: input.eventKey } })
  if (prior) {
    if (prior.rightKey !== opening.rightKey || prior.eventKind !== input.eventKind ||
        toNumberRial(prior.amount) !== input.amount || toNumberRial(prior.availableDelta) !== input.availableDelta ||
        toNumberRial(prior.reservedDelta) !== input.reservedDelta || toNumberRial(prior.spentDelta) !== input.spentDelta ||
        Number(prior.relatedInvoiceId) !== input.relatedInvoiceId ||
        Number(prior.relatedPaymentId ?? 0) !== Number(input.relatedPaymentId ?? 0) ||
        Number(prior.relatedReturnId ?? 0) !== Number(input.relatedReturnId ?? 0) ||
        Number(prior.reversesEventId ?? 0) !== Number(input.reversesEventId ?? 0)) throw stale()
    return { event: prior, replayed: true }
  }
  return { event: await tx.exchangeResidualRightEvent.create({ data: {
    eventKey: input.eventKey, rightKey: opening.rightKey, rightKind: opening.rightKind,
    eventKind: input.eventKind, amount: input.amount, availableDelta: input.availableDelta,
    reservedDelta: input.reservedDelta, spentDelta: input.spentDelta,
    sourceInvoiceId: Number(opening.sourceInvoiceId), childInvoiceId: Number(opening.childInvoiceId),
    returnId: Number(opening.returnId), sourceEventId: Number(opening.sourceEventId),
    rootShareId: String(opening.rootShareId), expiresAt: opening.expiresAt ?? null,
    operationKey: input.operationKey, relatedInvoiceId: input.relatedInvoiceId,
    relatedPaymentId: input.relatedPaymentId ?? null, relatedReturnId: input.relatedReturnId ?? null,
    reversesEventId: input.reversesEventId ?? null, actorUserId: input.actorUserId ?? null,
    evidenceKind: input.evidenceKind ?? 'S1_EXCHANGE_RIGHT_OPERATION',
    evidenceRef: input.evidenceRef ?? `SaleInvoice:${input.relatedInvoiceId}`
  } }), replayed: false }
}

export async function reserveS1ExchangeResidualRight(tx: Client, input: {
  rightKey: string; operationKey: string; amount: number; relatedInvoiceId: number; at?: Date; actorUserId?: number | null
}) {
  const op = operation(input), at = input.at ?? new Date()
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw invalid()
  const state = await readState(tx, op.rightKey)
  const eventKey = `s1-right:reserve:${op.rightKey}:${op.hash}`
  const reserve = await tx.exchangeResidualRightEvent.findFirst({ where: {
    rightKey: op.rightKey, eventKind: 'RESERVED', operationKey: input.operationKey
  } })
  if (reserve) {
    const terminal = await tx.exchangeResidualRightEvent.findFirst({ where: {
      rightKey: op.rightKey, operationKey: input.operationKey, eventKind: { in: ['COMMITTED', 'CANCELLED'] }
    } })
    if (terminal || toNumberRial(reserve.amount) !== op.amount || Number(reserve.relatedInvoiceId) !== op.relatedInvoiceId)
      throw stale()
    return { rightKey: op.rightKey, amount: op.amount, available: state.available, reserved: state.reserved, replayed: true }
  }
  const balance = await getExchangeResidualRightBalance(tx, op.rightKey, at)
  if (state.voided || balance.expired || state.available < op.amount)
    throw new BusinessError('ماندهٔ معتبر حق B/N برای رزرو کافی نیست.')
  const invoice = await tx.saleInvoice.findUnique({ where: { id: op.relatedInvoiceId }, select: { id: true, status: true, voidedAt: true } })
  if (!invoice || invoice.voidedAt != null || ['DRAFT', 'CANCELED'].includes(String(invoice.status))) throw invalid()
  await appendBalance(tx, state.opening, { eventKey, eventKind: 'RESERVED', amount: op.amount,
    availableDelta: -op.amount, reservedDelta: op.amount, spentDelta: 0, operationKey: input.operationKey,
    relatedInvoiceId: op.relatedInvoiceId, actorUserId: input.actorUserId })
  return { rightKey: op.rightKey, amount: op.amount, available: state.available - op.amount,
    reserved: state.reserved + op.amount, replayed: false }
}

export async function commitS1ExchangeResidualRight(tx: Client, input: {
  rightKey: string; operationKey: string; amount: number; relatedInvoiceId: number;
  relatedPaymentId: number; actorUserId?: number | null
}) {
  const op = operation(input), paymentId = id(input.relatedPaymentId, 'شناسه پرداخت')
  const state = await readState(tx, op.rightKey)
  const reserve = await tx.exchangeResidualRightEvent.findFirst({ where: {
    rightKey: op.rightKey, eventKind: 'RESERVED', operationKey: input.operationKey
  } })
  if (!reserve || toNumberRial(reserve.amount) !== op.amount || Number(reserve.relatedInvoiceId) !== op.relatedInvoiceId) throw stale()
  const eventKey = `s1-right:commit:${op.rightKey}:${op.hash}`
  const prior = await tx.exchangeResidualRightEvent.findUnique({ where: { eventKey } })
  if (prior) {
    if (toNumberRial(prior.amount) !== op.amount || Number(prior.relatedInvoiceId) !== op.relatedInvoiceId ||
        Number(prior.relatedPaymentId) !== paymentId) throw stale()
    return { rightKey: op.rightKey, amount: op.amount, replayed: true }
  }
  if (state.voided || await tx.exchangeResidualRightEvent.findFirst({ where: {
    rightKey: op.rightKey, operationKey: input.operationKey, eventKind: 'CANCELLED'
  } }) || state.reserved < op.amount) throw stale()
  const [payment, code] = await Promise.all([
    tx.payment.findUnique({ where: { id: paymentId }, include: { method: true } }),
    tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: op.rightKey } })
  ])
  const redemption = payment && code ? await tx.storeCreditRedemption.findFirst({ where: {
    paymentId, creditId: Number(code.id), invoiceId: op.relatedInvoiceId, reversedAt: null
  } }) : null
  if (!payment || !code || !redemption || Number(payment.invoiceId) !== op.relatedInvoiceId ||
      Number(payment.storeCreditId) !== Number(code.id) || toNumberRial(payment.amount) !== op.amount ||
      toNumberRial(redemption.amount) !== op.amount || code.source !== CreditSource.EXCHANGE ||
      code.exchangeResidualRightKey !== op.rightKey || payment.voidedAt != null ||
      String(payment.method?.kind ?? '').toUpperCase() !== 'STORE_CREDIT') throw invalid()
  await appendBalance(tx, state.opening, { eventKey, eventKind: 'COMMITTED', amount: op.amount,
    availableDelta: 0, reservedDelta: -op.amount, spentDelta: op.amount, operationKey: input.operationKey,
    relatedInvoiceId: op.relatedInvoiceId, relatedPaymentId: paymentId, actorUserId: input.actorUserId })
  return { rightKey: op.rightKey, amount: op.amount, replayed: false }
}

/** Restore a returned B/N-funded amount to the same residual right. This is
 * deliberately distinct from issuing a generic successor credit. Caller owns
 * the SaleReturn transaction and its immutable cumulative allocation evidence.
 */
export async function restoreS1ExchangeResidualRight(tx: Client, input: {
  rightKey: string; operationKey: string; amount: number; relatedInvoiceId: number;
  relatedPaymentId: number; relatedReturnId: number; actorUserId?: number | null
}) {
  const op = operation(input)
  const paymentId = id(input.relatedPaymentId, 'شناسه پرداخت ریشه‌دار')
  const returnId = id(input.relatedReturnId, 'شناسه برگشت')
  if (String(input.operationKey).trim().length < 8) throw invalid()
  const state = await readState(tx, op.rightKey)
  const eventKey = `s1-right:restore:${op.rightKey}:${op.hash}`
  const prior = await tx.exchangeResidualRightEvent.findUnique({ where: { eventKey } })
  if (prior) {
    if (prior.eventKind !== 'RESTORED' || toNumberRial(prior.amount) !== op.amount ||
        Number(prior.relatedInvoiceId) !== op.relatedInvoiceId ||
        Number(prior.relatedPaymentId) !== paymentId || Number(prior.relatedReturnId) !== returnId ||
        prior.operationKey !== input.operationKey) throw stale()
    return { rightKey: op.rightKey, amount: op.amount, replayed: true }
  }
  const [payment, code, redemption, events] = await Promise.all([
    tx.payment.findUnique({ where: { id: paymentId }, include: { method: true } }),
    tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: op.rightKey } }),
    tx.storeCreditRedemption.findFirst({ where: { paymentId, invoiceId: op.relatedInvoiceId, reversedAt: null } }),
    tx.exchangeResidualRightEvent.findMany({ where: { rightKey: op.rightKey }, orderBy: { id: 'asc' } })
  ])
  const actualDelivery = code ? await tx.creditDelivery.findUnique({ where: { creditId: Number(code.id) } }) : null
  const commits = (events as any[]).filter((event) => event.eventKind === 'COMMITTED' &&
    Number(event.relatedPaymentId) === paymentId).reduce((sum, event) => sum + toNumberRial(event.amount), 0)
  const alreadyRestored = (events as any[]).filter((event) => event.eventKind === 'RESTORED' &&
    Number(event.relatedPaymentId) === paymentId).reduce((sum, event) => sum + toNumberRial(event.amount), 0)
  const usedBefore = code ? toNumberRial(code.usedAmount) : 0
  if (!payment || !code || !actualDelivery || actualDelivery.status !== 'DELIVERED' || !redemption ||
      Number(redemption.creditId) !== Number(code.id) || Number(payment.invoiceId) !== op.relatedInvoiceId ||
      Number(payment.storeCreditId) !== Number(code.id) || payment.voidedAt != null ||
      String(payment.method?.kind ?? '').toUpperCase() !== 'STORE_CREDIT' ||
      code.source !== CreditSource.EXCHANGE || code.exchangeResidualRightKey !== op.rightKey ||
      Number(code.returnId) !== Number(state.opening.returnId) ||
      toNumberRial(redemption.amount) !== toNumberRial(payment.amount) ||
      commits <= 0 || alreadyRestored + op.amount > commits || op.amount > state.spent ||
      op.amount > usedBefore || !['USED', 'PARTIALLY_USED', 'EXPIRED'].includes(String(code.status)) ||
      code.voidedAt != null || code.deletedAt != null || state.voided)
    throw invalid()
  const restored = await appendBalance(tx, state.opening, {
    eventKey, eventKind: 'RESTORED', amount: op.amount, availableDelta: op.amount,
    reservedDelta: 0, spentDelta: -op.amount, operationKey: input.operationKey,
    relatedInvoiceId: op.relatedInvoiceId, relatedPaymentId: paymentId, relatedReturnId: returnId,
    actorUserId: input.actorUserId, evidenceKind: 'S1_RETURN_RESTORATION',
    evidenceRef: `SaleReturn:${returnId}:Payment:${paymentId}`
  })
  if (!restored.replayed) {
    const usedAfter = usedBefore - op.amount
    const expiresAt = code.expiresAt == null ? null : new Date(code.expiresAt)
    const expired = state.opening.rightKind === 'B' && expiresAt != null && expiresAt.getTime() <= Date.now()
    const nextStatus = expired ? 'EXPIRED' : usedAfter === 0 ? 'ACTIVE' : 'PARTIALLY_USED'
    const updated = await tx.storeCredit.updateMany({
      where: { id: Number(code.id), usedAmount: code.usedAmount, status: code.status },
      data: { usedAmount: usedAfter, status: nextStatus }
    })
    if (updated.count !== 1) throw stale()

    if (state.opening.rightKind === 'N') {
      const corrections = await tx.exchangeResidualRightCorrectionEvent.findMany({
        where: { rightKey: op.rightKey, eventKind: 'DISPUTED_RECOVERY_OPEN',
          relatedInvoiceId: op.relatedInvoiceId, relatedPaymentId: paymentId }, orderBy: { id: 'asc' }
      }) as any[]
      for (const correction of corrections) {
        const offsets = await tx.exchangeResidualRightCorrectionEvent.findMany({
          where: { parentCorrectionEventId: Number(correction.id), eventKind: 'DISPUTE_OFFSET_BY_RETURN' },
          orderBy: { id: 'asc' }
        }) as any[]
        const priorOffset = offsets.reduce((sum, row) => sum + toNumberRial(row.amount), 0)
        const grossReturned = alreadyRestored + op.amount
        const target = Number((BigInt(grossReturned) * BigInt(toNumberRial(correction.amount))) /
          BigInt(toNumberRial(correction.basisAmount)))
        const delta = target - priorOffset
        if (delta < 0 || delta > toNumberRial(correction.amount) - priorOffset) throw invalid()
        if (delta > 0) {
          const eventKey = `s7:${op.rightKey}:${digest(String(correction.operationKey) + ':' + String(returnId))}:dispute-offset`
          const old = await tx.exchangeResidualRightCorrectionEvent.findUnique({ where: { eventKey } })
          if (old) {
            if (toNumberRial(old.amount) !== delta || Number(old.relatedReturnId) !== returnId ||
                Number(old.parentCorrectionEventId) !== Number(correction.id)) throw stale()
          } else {
            await tx.exchangeResidualRightCorrectionEvent.create({ data: {
              eventKey, operationKey: correction.operationKey, rightKey: op.rightKey, rightKind: 'N',
              eventKind: 'DISPUTE_OFFSET_BY_RETURN', amount: delta, availableDelta: 0,
              disputedDelta: -delta, basisAmount: toNumberRial(correction.basisAmount),
              sourceInvoiceId: Number(state.opening.sourceInvoiceId),
              childInvoiceId: Number(state.opening.childInvoiceId), rootReturnId: Number(state.opening.returnId),
              sourceEventId: Number(state.opening.sourceEventId), rootShareId: String(state.opening.rootShareId),
              relatedInvoiceId: Number(correction.relatedInvoiceId), relatedPaymentId: paymentId,
              relatedReturnId: returnId, parentCorrectionEventId: Number(correction.id),
              actorUserId: input.actorUserId ?? null, evidenceKind: 'S7_RETURN_PROVENANCE',
              evidenceRef: `SaleReturn:${returnId}:Payment:${paymentId}`,
              reason: `سهم اختلاف برگشت ${returnId} فقط recovery را offset می‌کند`
            } })
          }
        }
      }
    }
  }
  return { rightKey: op.rightKey, amount: op.amount, replayed: restored.replayed }
}

/** Reverse the exact S1 right restorations when a simple return is voided. The
 * reversal is allowed only while the restored amount is still available; once
 * a customer has spent/reserved it, the return cannot be silently erased.
 */
export async function reverseS1ResidualRightRestorationsForReturn(tx: Client, input: {
  returnId: number; actorUserId?: number | null
}) {
  const returnId = id(input.returnId, 'شناسه برگشت')
  const ret = await tx.saleReturn.findUnique({ where: { id: returnId }, select: {
    id: true, invoiceId: true, kind: true, voidedAt: true
  } })
  if (!ret || ret.kind !== 'RETURN' || ret.voidedAt != null) throw invalid()
  const restores = await tx.exchangeResidualRightEvent.findMany({ where: {
    relatedReturnId: returnId, eventKind: 'RESTORED'
  }, orderBy: { id: 'asc' } })
  let reversed = 0
  for (const restoration of restores as any[]) {
    const openingState = await readState(tx, String(restoration.rightKey))
    const existing = await tx.exchangeResidualRightEvent.findUnique({
      where: { reversesEventId: Number(restoration.id) }
    })
    if (existing) {
      if (existing.eventKind !== 'RESTORATION_REVERSED' ||
          toNumberRial(existing.amount) !== toNumberRial(restoration.amount) ||
          Number(existing.relatedReturnId) !== returnId) throw stale()
      continue
    }
    if (openingState.voided || openingState.reserved > 0 ||
        openingState.available < toNumberRial(restoration.amount))
      throw new BusinessError('حق برگشتی پس از این برگشت مصرف یا رزرو شده است؛ ابطال برگشت بدون اثر مالی ممکن نیست.')
    const code = await tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: String(restoration.rightKey) } })
    if (!code || code.source !== CreditSource.EXCHANGE || code.voidedAt != null || code.deletedAt != null ||
        Number(code.amount) !== toNumberRial(openingState.opening.amount)) throw stale()
    const usedBefore = toNumberRial(code.usedAmount)
    const amount = toNumberRial(restoration.amount)
    const usedAfter = usedBefore + amount
    if (!Number.isSafeInteger(usedAfter) || usedAfter > toNumberRial(code.amount)) throw stale()
    const eventKey = `s1-right:restoration-reversal:${Number(restoration.id)}`
    const result = await appendBalance(tx, openingState.opening, {
      eventKey, eventKind: 'RESTORATION_REVERSED', amount,
      availableDelta: -amount, reservedDelta: 0, spentDelta: amount,
      operationKey: `void-s1-return:${returnId}:event:${Number(restoration.id)}`,
      relatedInvoiceId: Number(ret.invoiceId), relatedPaymentId: Number(restoration.relatedPaymentId),
      relatedReturnId: returnId, reversesEventId: Number(restoration.id),
      actorUserId: input.actorUserId, evidenceKind: 'S1_RETURN_VOID',
      evidenceRef: `SaleReturn:${returnId}:RestorationEvent:${Number(restoration.id)}`
    })
    if (!result.replayed) {
      const expiresAt = code.expiresAt == null ? null : new Date(code.expiresAt)
      const expired = openingState.opening.rightKind === 'B' && expiresAt != null && expiresAt.getTime() <= Date.now()
      const nextStatus = expired ? 'EXPIRED' : usedAfter === toNumberRial(code.amount) ? 'USED'
        : usedAfter > 0 ? 'PARTIALLY_USED' : 'ACTIVE'
      const update = await tx.storeCredit.updateMany({
        where: { id: Number(code.id), usedAmount: code.usedAmount, status: code.status },
        data: { usedAmount: usedAfter, status: nextStatus }
      })
      if (update.count !== 1) throw stale()
    }
    reversed++
  }
  return { returnId, reversed }
}

export async function cancelS1ExchangeResidualRightReservation(tx: Client, input: {
  rightKey: string; operationKey: string; amount: number; relatedInvoiceId: number; actorUserId?: number | null
}) {
  const op = operation(input), state = await readState(tx, String(input.rightKey))
  const reserve = await tx.exchangeResidualRightEvent.findFirst({ where: {
    rightKey: op.rightKey, eventKind: 'RESERVED', operationKey: input.operationKey
  } })
  if (!reserve || toNumberRial(reserve.amount) !== op.amount || Number(reserve.relatedInvoiceId) !== op.relatedInvoiceId) throw stale()
  const eventKey = `s1-right:cancel:${op.rightKey}:${op.hash}`
  const prior = await tx.exchangeResidualRightEvent.findUnique({ where: { eventKey } })
  if (prior) {
    if (toNumberRial(prior.amount) !== op.amount) throw stale()
    return { rightKey: op.rightKey, amount: op.amount, replayed: true }
  }
  if (state.voided || await tx.exchangeResidualRightEvent.findFirst({ where: {
    rightKey: op.rightKey, operationKey: input.operationKey, eventKind: 'COMMITTED'
  } }) || state.reserved < op.amount) throw stale()
  await appendBalance(tx, state.opening, { eventKey, eventKind: 'CANCELLED', amount: op.amount,
    availableDelta: op.amount, reservedDelta: -op.amount, spentDelta: 0, operationKey: input.operationKey,
    relatedInvoiceId: op.relatedInvoiceId, actorUserId: input.actorUserId })
  return { rightKey: op.rightKey, amount: op.amount, replayed: false }
}

export async function voidS1ExchangeResidualRightsForReturn(tx: Client, input: {
  returnId: number; actorUserId?: number | null
}) {
  const returnId = id(input?.returnId, 'شناسه برگشت')
  const openings = await tx.exchangeResidualRightEvent.findMany({ where: { returnId, eventKind: 'OPENED' }, orderBy: { id: 'asc' } }) as any[]
  let reversed = 0, replayed = openings.length > 0
  for (const opening of openings) {
    const state = await readState(tx, String(opening.rightKey))
    if (state.voided) continue
    replayed = false
    const events = await tx.exchangeResidualRightEvent.findMany({ where: { rightKey: opening.rightKey }, orderBy: { id: 'asc' } }) as any[]
    if (state.available !== toNumberRial(opening.amount) || state.reserved !== 0 || state.spent !== 0 ||
        events.some((row) => ['COMMITTED', 'RESTORED'].includes(String(row.eventKind))))
      throw new BusinessError('حق B/N مصرف یا رزرو شده است؛ ابطال تعویض بدون reversal معتبر مجاز نیست.')
    const credit = await tx.storeCredit.findUnique({ where: { exchangeResidualRightKey: opening.rightKey } })
    const delivery = credit ? await tx.creditDelivery.findUnique({ where: { creditId: Number(credit.id) } }) : null
    if (!credit || !delivery || delivery.status !== 'PENDING_DELIVERY' ||
        toNumberRial(credit.usedAmount) !== 0 || Number(credit.usedCount) !== 0 ||
        credit.status !== 'CANCELED' || credit.voidedAt == null)
      throw new BusinessError('کد B/N تحویل یا مصرف شده یا به‌درستی لغو نشده است؛ ابطال زنجیره متوقف شد.')
    const eventKey = `s1-right:void:${opening.rightKey}:${returnId}`
    const prior = await tx.exchangeResidualRightEvent.findUnique({ where: { eventKey } })
    if (prior) {
      if (prior.eventKind !== 'VOIDED' || Number(prior.reversesEventId) !== Number(opening.id) ||
          toNumberRial(prior.amount) !== toNumberRial(opening.amount)) throw stale()
      continue
    }
    await tx.exchangeResidualRightEvent.create({ data: {
      eventKey, rightKey: opening.rightKey, rightKind: opening.rightKind, eventKind: 'VOIDED',
      amount: toNumberRial(opening.amount), availableDelta: -toNumberRial(opening.amount),
      reservedDelta: 0, spentDelta: 0, sourceInvoiceId: Number(opening.sourceInvoiceId),
      childInvoiceId: Number(opening.childInvoiceId), returnId, sourceEventId: Number(opening.sourceEventId),
      rootShareId: opening.rootShareId, expiresAt: opening.expiresAt ?? null,
      operationKey: `void:${returnId}`, relatedInvoiceId: Number(opening.childInvoiceId),
      actorUserId: input.actorUserId ?? null, evidenceKind: 'EXCHANGE_VOID',
      evidenceRef: `SaleReturn:${returnId}:SaleInvoice:${opening.childInvoiceId}`, reversesEventId: Number(opening.id)
    } })
    const marked = await tx.creditDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING_DELIVERY', version: delivery.version },
      data: { status: 'VOID', version: { increment: 1 } }
    })
    if (marked.count !== 1) throw stale()
    reversed++
  }
  return { returnId, reversed, replayed }
}
