import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { toNumberRial } from '@shared/money'
import { CreditSource } from '@shared/credit'
import { allocateExchangeFundingProportionalFloor } from '@shared/exchangeFundingAllocation'
import { getCurrentExchangeFundingSources, getCurrentSaleFundingSources } from './ExchangeFundingLedgerService'
import { issueStoreCredit } from './StoreCreditService'

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
    getCurrentSaleFundingSources(tx, sourceInvoiceId),
    getCurrentExchangeFundingSources(tx, childInvoiceId)
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
      s.originalAmount <= 0 || !['SOURCE_GIFT', 'SOURCE_CASH'].includes(s.sourceKind)) ||
      sources.reduce((sum, s) => sum + BigInt(s.originalAmount), 0n) !== BigInt(toNumberRial(ret.total))) throw invalid()
  let plan: ReturnType<typeof allocateExchangeFundingProportionalFloor>
  try {
    plan = allocateExchangeFundingProportionalFloor({ replacementTotal: toNumberRial(child.grandTotal),
      sources: sources.map((s) => ({ sourceEventId: s.sourceEventId,
        sourceKind: s.sourceKind as 'SOURCE_GIFT' | 'SOURCE_CASH', available: s.originalAmount })) })
  } catch { throw invalid() }
  const giftTotal = sources.filter((s) => s.sourceKind === 'SOURCE_GIFT').reduce((n, s) => n + BigInt(s.originalAmount), 0n)
  const cashTotal = sources.filter((s) => s.sourceKind === 'SOURCE_CASH').reduce((n, s) => n + BigInt(s.originalAmount), 0n)
  if (giftTotal <= 0n || cashTotal <= 0n || plan.giftCarry <= 0 || plan.cashCarry <= 0 ||
      plan.allocations.every((r) => r.sourceKind !== 'SOURCE_GIFT' || r.remainder === 0) ||
      plan.allocations.every((r) => r.sourceKind !== 'SOURCE_CASH' || r.remainder === 0)) throw invalid()
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

export async function getExchangeResidualRightBalance(tx: Client, rightKey: string, at = new Date()) {
  if (typeof rightKey !== 'string' || rightKey.length < 8 || rightKey.length > 200 ||
      !(at instanceof Date) || !Number.isFinite(at.getTime())) throw invalid()
  const state = await readState(tx, rightKey)
  const expired = state.opening.rightKind === 'B' && state.opening.expiresAt != null &&
    new Date(state.opening.expiresAt).getTime() <= at.getTime()
  return { rightKey, rightKind: state.opening.rightKind, amount: toNumberRial(state.opening.amount),
    available: expired || state.voided ? 0 : state.available, reserved: state.reserved, spent: state.spent,
    expiresAt: state.opening.expiresAt ?? null, expired, voided: state.voided,
    sourceInvoiceId: Number(state.opening.sourceInvoiceId), childInvoiceId: Number(state.opening.childInvoiceId),
    returnId: Number(state.opening.returnId), sourceEventId: Number(state.opening.sourceEventId),
    rootShareId: String(state.opening.rootShareId) }
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
        Number(prior.relatedPaymentId ?? 0) !== Number(input.relatedPaymentId ?? 0)) throw stale()
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
    relatedPaymentId: input.relatedPaymentId ?? null, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'S1_EXCHANGE_RIGHT_OPERATION', evidenceRef: `SaleInvoice:${input.relatedInvoiceId}`
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
