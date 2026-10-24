import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { assertManagerPassword } from './AuthService'
import { issueStoreCredit } from './StoreCreditService'
import { CreditSource } from '@shared/credit'
import { cashClaimBalance } from '@shared/returnEntitlement'
import { toNumberRial } from '@shared/money'
import { getExchangeResidualRightBalance, openS1ExchangeResidualRights, openS11ExchangeDebtResidualRights } from './ExchangeResidualRightsService'
import { getCurrentExchangeFundingSources } from './ExchangeFundingLedgerService'

type Client = Prisma.TransactionClient | typeof prisma
const secureInt = (v: unknown, name: string, min = 1): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
    throw new BusinessError(`${name} باید عدد صحیح معتبر باشد؛ هیچ مبلغی ثبت نشد.`)
  return v
}
const safeId = (v: unknown, name: string): number => secureInt(v, name)
const stale = () => new BusinessError('وضعیت حق مالی در همین لحظه تغییر کرده است؛ هیچ تخصیص دومی ثبت نشد. صفحه را تازه کنید.')
const safeView = (row: any) => ({
  returnId: Number(row.returnId),
  invoiceId: Number(row.invoiceId),
  requestId: row.requestId == null ? null : Number(row.requestId),
  cashRight: toNumberRial(row.cashRight),
  cashPaid: toNumberRial(row.cashPaid),
  cashReserved: toNumberRial(row.cashReserved),
  cashConverted: toNumberRial(row.cashConverted),
  giftOpportunity: toNumberRial(row.giftOpportunity),
  debtReduced: toNumberRial(row.debtReduced),
  ...cashClaimBalance(row),
  state: String(row.state),
  version: Number(row.version)
})

export async function assertOrdinaryReturnLineage(tx: Client, returnId: number, invoiceId?: number) {
  const checkedReturnId = safeId(returnId, 'شناسه برگشت')
  const checkedInvoiceId = invoiceId == null ? null : safeId(invoiceId, 'شناسه فاکتور')
  const ret = await tx.saleReturn.findUnique({ where: { id: checkedReturnId }, select: {
    id: true, invoiceId: true, total: true, voidedAt: true,
    invoice: { select: { orderType: true, sourceInvoiceId: true, exchangeReturnId: true } }
  } })
  const parentExchangeReturn = ret
    ? await tx.saleReturn.findFirst({ where: { exchangeInvoiceId: ret.invoiceId }, select: { id: true } })
    : null
  if (!ret || (checkedInvoiceId != null && ret.invoiceId !== checkedInvoiceId) ||
      ret.invoice?.orderType === 'EXCHANGE' || ret.invoice?.sourceInvoiceId != null ||
      ret.invoice?.exchangeReturnId != null || parentExchangeReturn)
    throw new BusinessError('برگشت فرزند تعویض تا تکمیل lineage و جریان مستقل قابل ثبت یا تغییر نیست.')
  return ret
}

/** New returns only. Existing legacy requests are not guessed into a cash
 * claim; their history remains available for manager-controlled cutover.
 * Caller MUST pass the same tx that creates the SaleReturn and REQUEST.
 */
/** Open a provenance-backed cash claim for a child-exchange return. This is
 * not a payout, bank reservation, or CashMovement; settlement is a later step.
 */
export async function openS8ExchangeChildCashRight(
  tx: Client,
  input: { returnId: number; invoiceId: number; amount: number; actorUserId?: number | null }
) {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const invoiceId = safeId(input.invoiceId, 'شناسه فرزند')
  const amount = secureInt(input.amount, 'حق نقدی')
  const [ret, invoice] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: returnId } }),
    tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true, voidedAt: true
    } })
  ])
  const parentReturn = invoice?.exchangeReturnId
    ? await tx.saleReturn.findUnique({ where: { id: Number(invoice.exchangeReturnId) }, select: {
        id: true, invoiceId: true, exchangeInvoiceId: true, voidedAt: true
      } }) : null
  if (!ret || !invoice || invoice.orderType !== 'EXCHANGE' || invoice.voidedAt != null ||
      Number(ret.invoiceId) !== invoiceId || ret.kind !== 'RETURN' || ret.voidedAt != null ||
      toNumberRial(ret.total) < amount || Number(invoice.sourceInvoiceId) <= 0 ||
      !parentReturn || parentReturn.voidedAt != null || Number(parentReturn.invoiceId) !== Number(invoice.sourceInvoiceId) ||
      Number(parentReturn.exchangeInvoiceId) !== invoiceId)
    throw new BusinessError('منشأ CASH_RIGHT برگشت فرزند تعویض قابل تطبیق نیست؛ حق نقدی باز نشد.')
  const existing = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (existing) {
    if (Number(existing.invoiceId) !== invoiceId || toNumberRial(existing.cashRight) !== amount ||
        existing.requestId != null) throw stale()
    return safeView(existing)
  }
  const claim = await tx.returnEntitlement.create({ data: {
    returnId, invoiceId, requestId: null, cashRight: amount, cashReserved: 0,
    giftOpportunity: 0, debtReduced: 0, state: 'OPEN'
  } })
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `s8-child-cash-right:${returnId}`, kind: 'CASH_RIGHT_OPENED',
    amount, actorUserId: input.actorUserId ?? null, evidenceKind: 'S8_PROVEN_CHILD_CARRY_RETURN',
    reason: 'منشأ وجه به حق نقدی باز تبدیل شد؛ هیچ payout یا movement ثبت نشد.', beforeVersion: 0
  } })
  return safeView(claim)
}

export async function openCardTransferEntitlement(
  tx: Client,
  input: { returnId: number; invoiceId: number; requestId: number; amount: number; debtReduced?: number;
    giftOpportunity?: number; actorUserId?: number | null }
): Promise<any> {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const invoiceId = safeId(input.invoiceId, 'شناسه فاکتور')
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const amount = secureInt(input.amount, 'حق نقدی')
  const debtReduced = secureInt(input.debtReduced ?? 0, 'کاهش بدهی', 0)
  const giftOpportunity = secureInt(input.giftOpportunity ?? 0, 'سهم اعتبار غیرنقدی', 0)
  // Reuse the common lineage check, including the parent return's inverse
  // exchangeInvoiceId link when every child-side marker is stale or corrupted.
  const ret = await assertOrdinaryReturnLineage(tx, returnId, invoiceId)
  if (ret.voidedAt != null || amount + debtReduced + giftOpportunity > toNumberRial(ret.total))
    throw new BusinessError('حق نقدی، سهم اعتبار و کاهش بدهی با سند برگشت منطبق نیستند؛ حق تازه باز نشد.')
  const existing = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (existing) {
    if (Number(existing.requestId) !== requestId || toNumberRial(existing.cashRight) !== amount ||
        toNumberRial(existing.giftOpportunity) !== giftOpportunity)
      throw stale()
    return safeView(existing)
  }
  const claim = await tx.returnEntitlement.create({
    data: { returnId, invoiceId, requestId, cashRight: amount, cashReserved: amount,
      giftOpportunity, debtReduced }
  })
  await tx.returnEntitlementEvent.create({
    data: {
      entitlementId: claim.id, eventKey: `claim:${returnId}`, kind: 'CASH_RIGHT_OPENED', amount,
      requestId, actorUserId: input.actorUserId ?? null, beforeVersion: 0
    }
  })
  await tx.returnEntitlementEvent.create({
    data: {
      entitlementId: claim.id, eventKey: `reserve:${requestId}`, kind: 'BANK_RESERVED', amount,
      requestId, actorUserId: input.actorUserId ?? null, beforeVersion: 0
    }
  })
  return safeView(claim)
}

/** Verify a full nested-exchange C2C settlement against the remaining,
 * source-proven cash/card shares. It never treats a barcode share as money.
 */
async function assertChainedExchangeCashSettlementLineage(tx: Client, input: {
  returnId: number; invoiceId: number; amount: number; refundMethod: string; requestId?: number
}) {
  const [ret, source, child] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: safeId(input.returnId, 'شناسه برگشت') } }),
    tx.saleInvoice.findUnique({ where: { id: safeId(input.invoiceId, 'شناسه فاکتور') }, select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true, voidedAt: true
    } }),
    tx.saleReturn.findUnique({ where: { id: input.returnId }, select: {
      exchangeInvoiceId: true
    } }).then((row: any) => row?.exchangeInvoiceId
      ? tx.saleInvoice.findUnique({ where: { id: Number(row.exchangeInvoiceId) }, select: {
          id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true, grandTotal: true, voidedAt: true
        } }) : null)
  ])
  if (!ret || !source || !child || ret.kind !== 'EXCHANGE' || ret.voidedAt != null ||
      source.orderType !== 'EXCHANGE' || source.voidedAt != null || child.orderType !== 'EXCHANGE' ||
      child.voidedAt != null || Number(ret.invoiceId) !== Number(source.id) ||
      Number(ret.exchangeInvoiceId) !== Number(child.id) || Number(child.sourceInvoiceId) !== Number(source.id) ||
      Number(child.exchangeReturnId) !== Number(ret.id) || toNumberRial(child.grandTotal) !== toNumberRial(ret.exchangeTotal) ||
      Number(ret.exchangeDiff) >= 0 || !['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT'].includes(input.refundMethod) ||
      ret.refundMethod !== input.refundMethod || toNumberRial(ret.refundAmount) !== input.amount ||
      toNumberRial(ret.realMoneyRefundAmount) !== input.amount || !Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new BusinessError('تسویهٔ وجه واقعی این برگشت زنجیره‌ای با فاکتور/روش/مبلغ ثبت‌شده منطبق نیست.')
  const [parentFunding, childFunding] = await Promise.all([
    getCurrentExchangeFundingSources(tx, Number(source.id), {
      allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
    }),
    getCurrentExchangeFundingSources(tx, Number(child.id), {
      allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
    })
  ])
  const realRemainder = parentFunding.sources.filter((row: any) =>
    ['SOURCE_CASH', 'SOURCE_CARD'].includes(String(row.sourceKind)))
    .reduce((sum: number, row: any) => sum + Number(row.available), 0)
  const otherRemainder = parentFunding.sources.filter((row: any) =>
    !['SOURCE_CASH', 'SOURCE_CARD'].includes(String(row.sourceKind)))
    .reduce((sum: number, row: any) => sum + Number(row.available), 0)
  if (!parentFunding.snapshotExists || parentFunding.stale || parentFunding.unresolved.length ||
      parentFunding.debt !== 0 || parentFunding.overpay !== 0 ||
      parentFunding.activeReturnIds.length !== 1 || parentFunding.activeReturnIds[0] !== Number(ret.id) ||
      !childFunding.snapshotExists || childFunding.stale || childFunding.unresolved.length ||
      childFunding.sourceInvoiceId !== Number(source.id) || childFunding.returnId !== Number(ret.id) ||
      childFunding.activeReturnIds.length !== 0 || childFunding.lineAllocationStatus !== 'PERSISTED_RECONCILED' ||
      !Number.isSafeInteger(realRemainder) || realRemainder !== input.amount || otherRemainder !== 0)
    throw new BusinessError('دفتر وجه واقعیِ زنجیره با مبلغ کارت‌به‌کارت/بازپرداخت منطبق نیست؛ تسویه متوقف شد.')
  if (input.requestId != null) {
    const request = await tx.cardTransferRequest.findUnique({ where: { id: safeId(input.requestId, 'شناسه درخواست') } })
    if (!request || Number(request.returnId) !== Number(ret.id) || Number(request.sourceInvoiceId) !== Number(source.id) ||
        Number(request.exchangeInvoiceId) !== Number(child.id) || request.operationKind !== 'EXCHANGE' ||
        toNumberRial(request.amount) !== input.amount || request.kind !== 'REQUEST')
      throw new BusinessError('درخواست کارت‌به‌کارت به برگشت و مابه‌التفاوت زنجیره‌ای متصل نیست.')
  }
  return { ret, source, child, parentFunding, childFunding }
}

/** Open a C2C reservation for a full, proven nested exchange. */
export async function openChainedExchangeCardTransferEntitlement(tx: Client, input: {
  returnId: number; invoiceId: number; requestId: number; amount: number; actorUserId?: number | null
}) {
  const checked = await assertChainedExchangeCashSettlementLineage(tx, {
    returnId: input.returnId, invoiceId: input.invoiceId, amount: input.amount,
    refundMethod: 'CARD_TO_CARD', requestId: input.requestId
  })
  const existing = await tx.returnEntitlement.findUnique({ where: { returnId: input.returnId } })
  if (existing) {
    if (Number(existing.invoiceId) !== input.invoiceId || Number(existing.requestId) !== input.requestId ||
        toNumberRial(existing.cashRight) !== input.amount || toNumberRial(existing.cashReserved) !== input.amount ||
        toNumberRial(existing.giftOpportunity) !== 0) throw stale()
    return safeView(existing)
  }
  const claim = await tx.returnEntitlement.create({ data: {
    returnId: input.returnId, invoiceId: input.invoiceId, requestId: input.requestId,
    cashRight: input.amount, cashReserved: input.amount, giftOpportunity: 0,
    debtReduced: toNumberRial(checked.ret.debtReduction)
  } })
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `claim:${input.returnId}`, kind: 'CASH_RIGHT_OPENED',
    amount: input.amount, requestId: input.requestId, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'PROVEN_CHAINED_EXCHANGE_REAL_SOURCE',
    reason: 'ماندهٔ وجه واقعیِ زنجیره برای کارت‌به‌کارت مدیر رزرو شد؛ تا پرداخت وجهی جابه‌جا نشده است.', beforeVersion: 0
  } })
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `reserve:${input.requestId}`, kind: 'BANK_RESERVED',
    amount: input.amount, requestId: input.requestId, actorUserId: input.actorUserId ?? null, beforeVersion: 0
  } })
  return safeView(claim)
}

/** Validate a physical return from an exchange child against the persisted
 * per-item provenance matrix and the fully revalidated funding lineage. */
async function assertS8ExchangeChildReturnLineage(tx: Client, claim: any, requestId?: number) {
  const returnId = safeId(Number(claim?.returnId), 'شناسه برگشت')
  const invoiceId = safeId(Number(claim?.invoiceId), 'شناسه فاکتور')
  const [ret, child] = await Promise.all([
    tx.saleReturn.findUnique({ where: { id: returnId } }),
    tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true, voidedAt: true
    } })
  ])
  const parentReturn = child?.exchangeReturnId
    ? await tx.saleReturn.findUnique({ where: { id: Number(child.exchangeReturnId) } }) : null
  if (!ret || ret.kind !== 'RETURN' || ret.voidedAt != null || ret.exchangeInvoiceId != null ||
      !child || child.orderType !== 'EXCHANGE' || child.voidedAt != null ||
      Number(ret.invoiceId) !== invoiceId || !Number.isSafeInteger(Number(child.sourceInvoiceId)) ||
      Number(child.sourceInvoiceId) <= 0 || !parentReturn || parentReturn.kind !== 'EXCHANGE' ||
      parentReturn.voidedAt != null || Number(parentReturn.invoiceId) !== Number(child.sourceInvoiceId) ||
      Number(parentReturn.exchangeInvoiceId) !== invoiceId ||
      Number(parentReturn.id) !== Number(child.exchangeReturnId))
    throw new BusinessError('برگشت عادیِ فرزند با زنجیرهٔ والد و فاکتور فرزند منطبق نیست؛ تسویه متوقف شد.')

  const funding = await getCurrentExchangeFundingSources(tx, invoiceId, {
    allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
  })
  if (!funding.snapshotExists || funding.stale || funding.unresolved.length || funding.debt !== 0 ||
      funding.overpay !== 0 || funding.sourceInvoiceId !== Number(child.sourceInvoiceId) ||
      funding.returnId !== Number(child.exchangeReturnId) || funding.lineAllocationStatus !== 'PERSISTED_RECONCILED')
    throw new BusinessError('دفتر منشأ فرزند تعویض stale/نامعلوم یا ناقص است؛ هیچ وجهی پرداخت یا تبدیل نمی‌شود.')

  const [items, rows] = await Promise.all([
    tx.saleReturnItem.findMany({ where: { returnId }, orderBy: { id: 'asc' } }),
    tx.exchangeFundingReturnLineAllocation.findMany({ where: { returnId, eventKind: 'ALLOCATION' }, orderBy: [{ returnItemId: 'asc' }, { sourceEventId: 'asc' }] })
  ])
  const sourceKinds = new Set(['SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'])
  const sources = new Map<number, any>((funding.sources as any[]).map((row: any) => [Number(row.event?.id), row]))
  const lineCells = new Map<string, number>()
  for (const row of funding.lineAllocations as any[]) {
    const key = `${Number(row.saleItemId)}:${Number(row.sourceEventId)}`
    if (!sourceKinds.has(String(row.sourceKind)) || lineCells.has(key))
      throw new BusinessError('ماتریس منشأ قلم فرزند تکراری/نامعتبر است؛ entitlement مسدود شد.')
    lineCells.set(key, Number(row.amount))
  }
  const itemById = new Map<number, any>(items.map((item: any) => [Number(item.id), item]))
  const perCell = new Map<string, number>()
  const perItem = new Map<number, bigint>()
  let giftRight = 0n
  let cashRight = 0n
  for (const row of rows as any[]) {
    const rowItemId = Number(row.returnItemId)
    const item = itemById.get(rowItemId)
    const sourceEventId = Number(row.sourceEventId)
    const source = sources.get(sourceEventId)
    const amount = toNumberRial(row.amountDelta)
    const kind = String(row.sourceKind)
    const cell = `${Number(row.saleItemId)}:${sourceEventId}`
    const nextCell = (perCell.get(cell) ?? 0) + amount
    if (!item || Number(row.returnItemId) <= 0 || Number(row.returnId) !== returnId ||
        Number(item.returnId) !== returnId || Number(row.childInvoiceId) !== invoiceId ||
        Number(row.sourceInvoiceId) !== Number(child.sourceInvoiceId) ||
        Number(row.saleItemId) !== Number(item.saleItemId) || !source ||
        String(source.sourceKind) !== kind || !sourceKinds.has(kind) ||
        row.reversesAllocationId != null || !Number.isSafeInteger(amount) || amount <= 0 ||
        !Number.isSafeInteger(nextCell) || nextCell > (lineCells.get(cell) ?? -1))
      throw new BusinessError('انتساب برگشت از قلم/سهم ریشهٔ معتبر جدا شده است؛ هیچ حق مالی صادر نشد.')
    perCell.set(cell, nextCell)
    perItem.set(rowItemId, (perItem.get(rowItemId) ?? 0n) + BigInt(amount))
    if (['SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B'].includes(kind)) giftRight += BigInt(amount)
    else cashRight += BigInt(amount)
  }
  if (!items.length || itemById.size !== items.length || rows.length === 0 ||
      items.some((item: any) => perItem.get(Number(item.id)) !== BigInt(toNumberRial(item.lineTotal))) ||
      [...perCell].some(([cell, amount]) => amount > (lineCells.get(cell) ?? -1)) ||
      giftRight + cashRight !== BigInt(toNumberRial(ret.total)) ||
      giftRight > BigInt(Number.MAX_SAFE_INTEGER) || cashRight > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BusinessError('جمع سهم‌های منشأ با اقلام برگشتی تطبیق ندارد؛ تسویه متوقف شد.')

  const real = Number(cashRight)
  const gift = Number(giftRight)
  const method = String(ret.refundMethod ?? '').toUpperCase()
  const amount = toNumberRial(ret.refundAmount)
  const splitCredit = toNumberRial(ret.refundStoreCreditAmount)
  if (toNumberRial(claim.cashRight) !== real || toNumberRial(claim.giftOpportunity) !== gift ||
      toNumberRial(claim.debtReduced) !== 0 || toNumberRial(ret.realMoneyRefundAmount) !== real ||
      !['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE'].includes(method) ||
      (real === 0 && (method !== 'NONE' || amount !== 0 || splitCredit !== 0)) ||
      (real > 0 && method === 'CASH' && amount + splitCredit !== real) ||
      (real > 0 && method !== 'CASH' && method !== 'NONE' && (amount !== real || splitCredit !== 0)) ||
      (real > 0 && method === 'NONE' && (amount !== 0 || splitCredit !== 0)))
    throw new BusinessError('روش/مبلغ تسویه از حق پول واقعیِ منشأدار فراتر رفته یا با آن منطبق نیست.')
  if (method === 'CARD_TO_CARD') {
    if (requestId == null || claim.requestId == null || Number(claim.requestId) !== requestId)
      throw new BusinessError('حق کارت‌به‌کارت فرزند به درخواست مدیر متصل نیست.')
    const request = await tx.cardTransferRequest.findUnique({ where: { id: safeId(requestId, 'شناسه درخواست') } })
    if (!request || Number(request.returnId) !== returnId || Number(request.sourceInvoiceId) !== invoiceId ||
        request.operationKind !== 'RETURN' || request.kind !== 'REQUEST' || toNumberRial(request.amount) !== real)
      throw new BusinessError('درخواست کارت‌به‌کارت با حق واقعی و برگشت فرزند منطبق نیست.')
  } else if (requestId != null || claim.requestId != null) {
    throw new BusinessError('درخواست بانکی به روش تسویهٔ غیرکارت‌به‌کارت متصل شده است.')
  }
  return { ret, child, giftOpportunity: gift, cashRight: real, funding }
}

/** Create the single-return cash entitlement only after its proven child
 * allocations and selected settlement have been persisted in this transaction. */
export async function openS8ExchangeChildReturnEntitlement(tx: Client, input: {
  returnId: number; invoiceId: number; cashRight: number; giftOpportunity: number;
  method: string; paidAmount?: number; convertedAmount?: number; requestId?: number | null;
  creditId?: number | null; actorUserId?: number | null
}) {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const invoiceId = safeId(input.invoiceId, 'شناسه فرزند')
  const cashRight = secureInt(input.cashRight, 'حق پول واقعی', 0)
  const giftOpportunity = secureInt(input.giftOpportunity, 'سهم اعتبار غیرنقدی', 0)
  if (cashRight === 0) return null
  const method = String(input.method ?? '').toUpperCase()
  const paid = secureInt(input.paidAmount ?? 0, 'وجه پرداخت‌شده', 0)
  const converted = secureInt(input.convertedAmount ?? 0, 'وجه تبدیل‌شده به اعتبار', 0)
  const requestId = input.requestId == null ? null : safeId(input.requestId, 'شناسه درخواست')
  if (!['NONE', 'CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT'].includes(method) ||
      (method === 'NONE' && (paid !== 0 || converted !== 0 || requestId != null)) ||
      (method === 'CASH' && (paid + converted !== cashRight || (converted > 0 && !input.creditId))) ||
      (method === 'CARD' && (paid !== cashRight || converted !== 0)) ||
      (method === 'STORE_CREDIT' && (converted !== cashRight || paid !== 0 || !input.creditId)) ||
      (method === 'CARD_TO_CARD' && (paid !== 0 || converted !== 0 || requestId == null)) ||
      (method !== 'CARD_TO_CARD' && requestId != null))
    throw new BusinessError('مقدار پرداخت/اعتبار/رزرو با سهم واقعیِ برگشت فرزند منطبق نیست.')
  const claimShape = {
    returnId, invoiceId, requestId,
    cashRight, giftOpportunity, debtReduced: 0,
    cashPaid: paid, cashConverted: converted,
    cashReserved: method === 'CARD_TO_CARD' ? cashRight : 0,
    state: 'OPEN'
  }
  await assertS8ExchangeChildReturnLineage(tx, claimShape, requestId ?? undefined)
  const existing = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (existing) {
    if (Number(existing.invoiceId) !== invoiceId || Number(existing.requestId ?? 0) !== Number(requestId ?? 0) ||
        toNumberRial(existing.cashRight) !== cashRight || toNumberRial(existing.cashPaid) !== paid ||
        toNumberRial(existing.cashConverted) !== converted || toNumberRial(existing.cashReserved) !== claimShape.cashReserved ||
        toNumberRial(existing.giftOpportunity) !== giftOpportunity) throw stale()
    return safeView(existing)
  }
  const claim = await tx.returnEntitlement.create({ data: claimShape as any })
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `s8-child-return:${returnId}:opened`, kind: 'CASH_RIGHT_OPENED',
    amount: cashRight, requestId, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'S8_PROVEN_CHILD_CARRY_RETURN',
    reason: method === 'CARD_TO_CARD'
      ? 'حق واقعی منشأدار برای درخواست مدیر رزرو شد؛ تا تطبیق بانک پرداختی اثبات‌شده نیست.'
      : 'حق واقعی منشأدار با روش ثبت‌شدهٔ برگشت تسویه شد.', beforeVersion: 0
  } })
  if (paid > 0) await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `s8-child-return:${returnId}:paid`, kind: 'CASH_PAID',
    amount: paid, actorUserId: input.actorUserId ?? null,
    evidenceKind: method === 'CASH' ? 'CASH_MOVEMENT_RECORDED' : 'MANAGER_AUTHORIZED_CARD_REFUND',
    reason: 'تسویهٔ فوری فقط در حد سهم واقعیِ دفتر منشأ ثبت شد.', beforeVersion: 0
  } })
  if (converted > 0) await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `s8-child-return:${returnId}:converted`, kind: 'CASH_RIGHT_CONVERTED',
    amount: converted, creditId: input.creditId!, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'RETURN_REAL_SOURCE_TO_STORE_CREDIT',
    reason: 'سهم واقعیِ برگشت طبق انتخاب روش به اعتبار خرید تبدیل شد.', beforeVersion: 0
  } })
  if (requestId != null) await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `s8-child-return:${returnId}:reserved`, kind: 'BANK_RESERVED',
    amount: cashRight, requestId, actorUserId: input.actorUserId ?? null,
    evidenceKind: 'MANAGER_C2C_REQUEST', reason: 'تا تطبیق مستقل صورت‌حساب بانک، حق رزرو است.', beforeVersion: 0
  } })
  return safeView(claim)
}

/** Validate an entitlement using ordinary-return rules or one of the two
 * narrowly proven exchange settlement paths. */
export async function assertReturnEntitlementLineage(tx: Client, claim: any) {
  const returnId = safeId(Number(claim?.returnId), 'شناسه برگشت')
  const invoiceId = safeId(Number(claim?.invoiceId), 'شناسه فاکتور')
  const source = await tx.saleInvoice.findUnique({ where: { id: invoiceId }, select: { orderType: true } })
  if (source?.orderType === 'EXCHANGE') {
    const ret = await tx.saleReturn.findUnique({ where: { id: returnId } })
    if (ret?.kind === 'EXCHANGE')
      return assertChainedExchangeCashSettlementLineage(tx, {
        returnId, invoiceId, amount: toNumberRial(claim.cashRight),
        refundMethod: String(ret.refundMethod ?? ''),
        requestId: claim.requestId == null ? undefined : Number(claim.requestId)
      })
    if (ret?.kind === 'RETURN')
      return assertS8ExchangeChildReturnLineage(tx, claim,
        claim.requestId == null ? undefined : Number(claim.requestId))
    throw new BusinessError('برگشت فرزند تعویض با مسیر تسویهٔ زنجیره‌ای منطبق نیست.')
  }
  return assertOrdinaryReturnLineage(tx, returnId, invoiceId)
}

/** The manager's 'paid' click/typed tracking number is a DECLARATION, not
 * independent evidence of bank payout. Keep the ENTIRE reservation frozen,
 * including the shortfall, until a reviewed bank document is archived.
 */
export async function markBankDeclaration(
  tx: Client,
  input: { requestId: number; declaredAmount: number; actorUserId?: number | null }
): Promise<null | ReturnType<typeof safeView>> {
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const claim = await tx.returnEntitlement.findUnique({ where: { requestId } })
  if (!claim) return null // explicitly legacy, no fabricated entitlement
  await assertReturnEntitlementLineage(tx, claim)
  const amount = secureInt(input.declaredAmount, 'مبلغ اعلامی')
  if (claim.state === 'UNKNOWN_BANK') {
    const previous = await tx.returnEntitlementEvent.findUnique({ where: { eventKey: `declared:${requestId}` } })
    if (previous && toNumberRial(previous.amount) === amount) return safeView(claim)
    throw stale()
  }
  if (claim.state !== 'OPEN' || toNumberRial(claim.cashReserved) <= 0 || amount > toNumberRial(claim.cashReserved))
    throw stale()
  const marked = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, state: 'OPEN', version: claim.version, cashReserved: claim.cashReserved },
    data: { state: 'UNKNOWN_BANK', version: { increment: 1 }, updatedAt: new Date() }
  })
  if (marked.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({
    data: {
      entitlementId: claim.id, eventKey: `declared:${requestId}`, kind: 'BANK_DECLARED_UNKNOWN',
      amount, requestId, actorUserId: input.actorUserId ?? null,
      evidenceKind: 'MANAGER_DECLARATION_NOT_BANK_PROOF', beforeVersion: claim.version
    }
  })
  return safeView({ ...claim, state: 'UNKNOWN_BANK', version: claim.version + 1 })
}

/** A cancellation is not evidence that no off-system bank payment happened.
 * Keep the full reservation under UNKNOWN, never convert it automatically.
 */
export async function markBankCancellationUnknown(
  tx: Client,
  input: { requestId: number; actorUserId?: number | null; reason: string }
): Promise<boolean> {
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const claim = await tx.returnEntitlement.findUnique({ where: { requestId } })
  if (!claim) return false
  await assertReturnEntitlementLineage(tx, claim)
  if (claim.state !== 'OPEN') throw stale()
  const changed = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, version: claim.version, state: 'OPEN' },
    data: { state: 'UNKNOWN_BANK', version: { increment: 1 }, updatedAt: new Date() }
  })
  if (changed.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `cancel-unknown:${requestId}`,
    kind: 'BANK_CANCELED_OUTCOME_UNKNOWN', amount: toNumberRial(claim.cashReserved), requestId,
    actorUserId: input.actorUserId ?? null, evidenceKind: 'MANAGER_DECLARATION_NOT_BANK_PROOF',
    reason: input.reason, beforeVersion: claim.version
  } })
  return true
}

/** A controlled edit of an UNPAID pending request. There must be no gift/debt
 * split or bank declaration; anything else needs a separate correction case.
 */
export async function correctPendingEntitlement(
  tx: Client,
  input: { returnId: number; requestId: number; newRight: number; reason: string; actorUserId?: number | null }
): Promise<boolean> {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (!claim) return false
  await assertReturnEntitlementLineage(tx, claim)
  const right = secureInt(input.newRight, 'حق اصلاح‌شده')
  if (claim.requestId !== input.requestId || claim.state !== 'OPEN' ||
      toNumberRial(claim.cashPaid) !== 0 || toNumberRial(claim.cashConverted) !== 0 ||
      toNumberRial(claim.debtReduced) !== 0 || toNumberRial(claim.giftOpportunity) !== 0 ||
      toNumberRial(claim.cashRight) !== toNumberRial(claim.cashReserved))
    throw new BusinessError('اصلاح سادهٔ این برگشتِ دارای حق مالی ممکن نیست؛ تسویه/منشأ آن نیاز به پروندهٔ اصلاح شاهددار دارد.')
  if (right === toNumberRial(claim.cashRight)) return true
  const changed = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, version: claim.version, state: 'OPEN', cashRight: claim.cashRight, cashReserved: claim.cashReserved },
    data: { cashRight: right, cashReserved: right, version: { increment: 1 }, updatedAt: new Date() }
  })
  if (changed.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `pending-correction:${claim.id}:${claim.version + 1}`,
    kind: 'PENDING_RIGHT_CORRECTED', amount: right - toNumberRial(claim.cashRight), requestId: input.requestId,
    actorUserId: input.actorUserId ?? null, evidenceKind: 'MANAGER_CORRECTION',
    reason: input.reason, beforeVersion: claim.version
  } })
  return true
}

/** Voiding a source must not delete an obligation or infer that the bank never
 * paid. Quarantine the immutable claim; do not reopen a spendable code.
 */
export async function quarantineEntitlement(
  tx: Client,
  input: { returnId: number; reason: string; actorUserId?: number | null }
): Promise<boolean> {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
  if (!claim) return false
  await assertReturnEntitlementLineage(tx, claim)
  if (claim.state === 'QUARANTINED') return true
  const changed = await tx.returnEntitlement.updateMany({
    where: { id: claim.id, version: claim.version, state: claim.state },
    data: { state: 'QUARANTINED', version: { increment: 1 }, updatedAt: new Date() }
  })
  if (changed.count !== 1) throw stale()
  await tx.returnEntitlementEvent.create({ data: {
    entitlementId: claim.id, eventKey: `quarantine:${claim.id}:${claim.version + 1}`,
    kind: 'SOURCE_QUARANTINED', amount: 0, requestId: claim.requestId,
    actorUserId: input.actorUserId ?? null, evidenceKind: 'MANAGER_CORRECTION',
    reason: input.reason, beforeVersion: claim.version
  } })
  return true
}

const documentMime = (name: string, bytes: Uint8Array): string => {
  const n = name.toLowerCase()
  if (n.endsWith('.pdf') && Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-') return 'application/pdf'
  if (n.endsWith('.csv') && !Buffer.from(bytes).includes(0) && bytes.length > 10) return 'text/csv'
  throw new BusinessError('شاهد بانک باید فایل PDF صورت‌حساب یا CSV خروجی بانک باشد؛ عکس، شماره پیگیری و PIN کافی نیست.')
}

/** Document is selected/read in MAIN (not an arbitrary renderer-provided
 * digest). It is archived inside SQLite and therefore included by BackupService.
 * This records a HUMAN REVIEW of a bank document, not a bank API confirmation.
 * The bank evidence must show the actual payout, not only a claimed amount.
 */
export async function reconcileBankDocument(input: {
  requestId: number
  confirmedAmount: number
  document: { name: string; bytes: Uint8Array }
  reviewNote: string
  attestedBankAccountReview: boolean
  managerPassword?: string | null
  actorUserId?: number | null
}) {
  const requestId = safeId(input.requestId, 'شناسه درخواست')
  const amount = secureInt(input.confirmedAmount, 'مبلغ صورت‌حساب')
  const note = String(input.reviewNote ?? '').trim()
  if (note.length < 10 || input.attestedBankAccountReview !== true)
    throw new BusinessError('مدیر باید تطبیق صورت‌حساب بانک با حساب/تاریخ/مبلغ را صریحاً تأیید و دلیل حداقل ۱۰ نویسه ثبت کند.')
  const bytes = input.document?.bytes
  if (!(bytes instanceof Uint8Array) || bytes.length < 15 || bytes.length > 5_000_000)
    throw new BusinessError('فایل شاهد بانک وجود ندارد یا حجم آن معتبر نیست (حداکثر ۵ مگابایت).')
  const name = String(input.document?.name ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120)
  const mimeType = documentMime(name, bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  await assertManagerPassword(input.managerPassword, 'تطبیق سند پرداخت کارت‌به‌کارت با صورت‌حساب بانک')

  return prisma.$transaction(async (tx) => {
    const claim = await tx.returnEntitlement.findUnique({ where: { requestId } })
    if (!claim) throw new BusinessError('این درخواست فاقد حق مالیِ قابل‌تبدیل است؛ پروندهٔ قدیمی به رسیدگی مدیر نیاز دارد.')
    await assertReturnEntitlementLineage(tx, claim)
    const existing = await tx.bankStatementEvidence.findUnique({ where: { requestId } })
    if (existing) {
      if (existing.sha256 !== digest || toNumberRial(existing.confirmedAmount) !== amount) throw stale()
      return { ...safeView(claim), evidenceId: existing.id, replayed: true }
    }
    const req = await tx.cardTransferRequest.findUnique({ where: { id: requestId } })
    if (!req || req.kind !== 'REQUEST' || !['PAID', 'ADJUSTED'].includes(req.status) || !req.paidAt)
      throw new BusinessError('این درخواست هنوز پرداختِ اعلام‌شده ندارد؛ سند بانک را به درخواست درست وصل کنید.')
    if (amount !== toNumberRial(req.paidAmount) || amount > toNumberRial(req.amount))
      throw new BusinessError('مبلغ صورت‌حساب با اعلام پرداخت همین درخواست یکسان نیست؛ پرونده تا رسیدگی اختلاف مسدود می‌ماند.')
    if (claim.state !== 'UNKNOWN_BANK' || toNumberRial(claim.cashReserved) !== toNumberRial(req.amount))
      throw stale()
    const next = {
      cashPaid: toNumberRial(claim.cashPaid) + amount,
      cashReserved: 0,
      cashConverted: toNumberRial(claim.cashConverted),
      cashRight: toNumberRial(claim.cashRight)
    }
    const state = cashClaimBalance(next).overAllocated ? 'OVER_ALLOCATED' : 'OPEN'
    const updated = await tx.returnEntitlement.updateMany({
      where: { id: claim.id, version: claim.version, state: 'UNKNOWN_BANK', cashReserved: claim.cashReserved },
      data: { cashPaid: next.cashPaid, cashReserved: 0, state, version: { increment: 1 }, updatedAt: new Date() }
    })
    if (updated.count !== 1) throw stale()
    const evidence = await tx.bankStatementEvidence.create({
      data: {
        requestId, confirmedAmount: amount, sha256: digest, fileName: name,
        mimeType, documentBase64: Buffer.from(bytes).toString('base64'),
        reviewedByUserId: input.actorUserId ?? null, reviewNote: note
      }
    })
    await tx.returnEntitlementEvent.create({
      data: {
        entitlementId: claim.id, eventKey: `bank-reviewed:${requestId}`, kind: 'BANK_DOCUMENT_REVIEWED',
        amount, requestId, actorUserId: input.actorUserId ?? null,
        evidenceKind: 'BANK_STATEMENT_REVIEWED_BY_MANAGER', evidenceHash: digest,
        reason: note, beforeVersion: claim.version
      }
    })
    return { ...safeView({ ...claim, ...next, state, version: claim.version + 1 }), evidenceId: evidence.id, replayed: false }
  })
}

/** Only a MANAGER can exchange verified, unallocated cash rights for a
 * no-expiry multi-use StoreCredit. A pending/unknown bank attempt never opens
 * the 400 remainder. A DRAFT code requires a separate witnessed handoff.
 */
export async function convertCashRight(input: {
  returnId: number
  amount: number
  expectedVersion: number
  idempotencyKey: string
  managerPassword?: string | null
  actorUserId?: number | null
}) {
  const returnId = safeId(input.returnId, 'شناسه برگشت')
  const amount = secureInt(input.amount, 'مبلغ تبدیل')
  const version = secureInt(input.expectedVersion, 'نسخهٔ حق مالی', 0)
  const key = String(input.idempotencyKey ?? '').trim()
  if (key.length < 8 || key.length > 200)
    throw new BusinessError('کلید یکتای عملیات تبدیل معتبر نیست؛ برای تلاش تازه کلید تازه بگیرید.')
  const eventKey = `convert:${returnId}:${createHash('sha256').update(key).digest('hex')}`
  await assertManagerPassword(input.managerPassword, 'تبدیل آگاهانهٔ حق نقدی به کد اعتبار بدون انقضا')

  return prisma.$transaction(async (tx) => {
    const previous = await tx.returnEntitlementEvent.findUnique({ where: { eventKey } })
    if (previous) {
      if (toNumberRial(previous.amount) !== amount || !previous.creditId) throw stale()
      const priorClaim = await tx.returnEntitlement.findUnique({ where: { id: previous.entitlementId } })
      if (!priorClaim) throw stale()
      await assertReturnEntitlementLineage(tx, priorClaim)
      const delivery = await tx.creditDelivery.findUnique({ where: { creditId: previous.creditId } })
      return { creditId: previous.creditId, publicReference: `اعتبار #${previous.creditId}`,
        deliveryStatus: delivery?.status ?? 'PENDING_DELIVERY', replayed: true }
    }
    const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
    if (!claim || claim.state !== 'OPEN' || claim.version !== version)
      throw new BusinessError('حق مالی هنوز باز/تطبیق‌شده نیست یا نسخهٔ آن تغییر کرده است؛ تبدیل انجام نشد.')
    const ret = await assertReturnEntitlementLineage(tx, claim)
    const balance = cashClaimBalance(claim)
    if (balance.overAllocated || amount > balance.open)
      throw new BusinessError('مبلغ مورد درخواست از حق نقدی باز بیشتر است؛ کدی صادر نشد. پرداخت و رزرو بانک را بررسی کنید.')
    if (ret.voidedAt != null)
      throw new BusinessError('سند برگشت معتبر برای تبدیل حق مالی وجود ندارد؛ کدی صادر نشد.')
    const invoice = await tx.saleInvoice.findUnique({ where: { id: ret.invoiceId }, select: { customerId: true } })
    const changed = await tx.returnEntitlement.updateMany({
      where: { id: claim.id, version, state: 'OPEN', cashPaid: claim.cashPaid,
        cashReserved: claim.cashReserved, cashConverted: claim.cashConverted, cashRight: claim.cashRight },
      data: { cashConverted: toNumberRial(claim.cashConverted) + amount, version: { increment: 1 }, updatedAt: new Date() }
    })
    if (changed.count !== 1) throw stale()
    const credit = await issueStoreCredit(tx, {
      amount, source: CreditSource.EXCHANGE, days: null, expiresAtExact: null,
      multiUse: true, maxUses: 1000, status: 'DRAFT',
      returnId, sourceInvoiceId: ret.invoiceId, customerId: invoice?.customerId ?? null,
      note: `تبدیل آگاهانهٔ حق واقعیِ بازپرداخت سند برگشت #${returnId} به اعتبار بدون انقضا`,
      userId: input.actorUserId ?? null
    })
    await tx.creditDelivery.create({ data: { creditId: credit.id, sourceKind: 'CASH_RIGHT_CONVERSION' } })
    await tx.returnEntitlementEvent.create({
      data: { entitlementId: claim.id, eventKey, kind: 'CASH_RIGHT_CONVERTED', amount,
        requestId: claim.requestId, creditId: credit.id, actorUserId: input.actorUserId ?? null,
        evidenceKind: 'MANAGER_DECISION', beforeVersion: version }
    })
    return { creditId: credit.id, publicReference: `اعتبار #${credit.id}`, deliveryStatus: 'PENDING_DELIVERY', replayed: false }
  })
}

export async function assertChainedExchangeCreditDeliveryLineage(tx: Client, creditId: number, returnId: number) {
  const [credit, delivery, ret] = await Promise.all([
    tx.storeCredit.findUnique({ where: { id: safeId(creditId, 'شناسه اعتبار') } }),
    tx.creditDelivery.findUnique({ where: { creditId: safeId(creditId, 'شناسه اعتبار') } }),
    tx.saleReturn.findUnique({ where: { id: safeId(returnId, 'شناسه برگشت') } })
  ])
  if (!credit || !delivery || !ret ||
      !['CHAIN_GIFT_RESIDUAL', 'CHAIN_REAL_REFUND'].includes(String(delivery.sourceKind)) ||
      Number(credit.returnId) !== Number(ret.id) || Number(ret.id) !== returnId ||
      Number(credit.sourceInvoiceId) !== Number(ret.invoiceId) ||
      Number(credit.exchangeInvoiceId) !== Number(ret.exchangeInvoiceId) ||
      ret.kind !== 'EXCHANGE' || ret.voidedAt != null || Number(ret.exchangeDiff) >= 0 ||
      !Number.isSafeInteger(toNumberRial(ret.total)) || toNumberRial(ret.total) <= 0)
    throw new BusinessError('منشأ بارکدِ برگشت زنجیره‌ای با برگشت و فاکتور جایگزین منطبق نیست؛ چاپ/تحویل متوقف شد.')
  const [sourceInvoice, childInvoice] = await Promise.all([
    tx.saleInvoice.findUnique({ where: { id: Number(ret.invoiceId) }, select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true, voidedAt: true
    } }),
    tx.saleInvoice.findUnique({ where: { id: Number(ret.exchangeInvoiceId) }, select: {
      id: true, orderType: true, sourceInvoiceId: true, exchangeReturnId: true,
      grandTotal: true, voidedAt: true
    } })
  ])
  if (!sourceInvoice || !childInvoice || sourceInvoice.orderType !== 'EXCHANGE' ||
      childInvoice.orderType !== 'EXCHANGE' || sourceInvoice.voidedAt != null || childInvoice.voidedAt != null ||
      Number(childInvoice.sourceInvoiceId) !== Number(sourceInvoice.id) ||
      Number(childInvoice.exchangeReturnId) !== Number(ret.id) ||
      toNumberRial(childInvoice.grandTotal) !== toNumberRial(ret.exchangeTotal) ||
      !['PENDING_DELIVERY', 'DELIVERED'].includes(String(delivery.status)) ||
      (delivery.status === 'PENDING_DELIVERY' && credit.status !== 'DRAFT') ||
      (delivery.status === 'DELIVERED' && credit.status !== 'ACTIVE'))
    throw new BusinessError('زنجیرهٔ فاکتور برگشتی یا وضعیت اعتبار برای تحویل معتبر نیست؛ کد فعال نشد.')

  const [parentFunding, childFunding] = await Promise.all([
    getCurrentExchangeFundingSources(tx, Number(sourceInvoice.id), {
      allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
    }),
    getCurrentExchangeFundingSources(tx, Number(childInvoice.id), {
      allowReturnBalanceChanges: true, allowExpiredGiftForReturnAttribution: true
    })
  ])
  if (!parentFunding.snapshotExists || parentFunding.stale || parentFunding.unresolved.length ||
      parentFunding.debt !== 0 || parentFunding.overpay !== 0 ||
      parentFunding.activeReturnIds.length !== 1 || parentFunding.activeReturnIds[0] !== Number(ret.id) ||
      !childFunding.snapshotExists || childFunding.stale || childFunding.unresolved.length ||
      childFunding.sourceInvoiceId !== Number(sourceInvoice.id) || childFunding.returnId !== Number(ret.id) ||
      childFunding.activeReturnIds.length !== 0 || childFunding.lineAllocationStatus !== 'PERSISTED_RECONCILED')
    throw new BusinessError('دفتر منشأ فاکتور زنجیره‌ای ناقص یا کهنه است؛ تحویل بارکد متوقف شد.')

  if (delivery.sourceKind === 'CHAIN_GIFT_RESIDUAL') {
    const allocation = await tx.creditReturnAllocation.findUnique({ where: { successorCreditId: Number(credit.id) } })
    const issue = await tx.exchangeFundingEvent.findFirst({ where: {
      returnId: Number(ret.id), kind: 'CREDIT_REISSUE_OUT', evidenceRef: `StoreCredit:${Number(credit.id)}`
    } })
    const sourceEvent = issue?.parentEventId
      ? await tx.exchangeFundingEvent.findUnique({ where: { id: Number(issue.parentEventId) } }) : null
    let rootEvent = sourceEvent
    const seen = new Set<number>()
    while (rootEvent?.kind === 'TRANSFER_IN') {
      const parentId = Number(rootEvent.parentEventId)
      if (!Number.isSafeInteger(parentId) || parentId <= 0 || seen.has(parentId)) break
      seen.add(parentId)
      rootEvent = await tx.exchangeFundingEvent.findUnique({ where: { id: parentId } })
    }
    const redemption = allocation?.redemptionId
      ? await tx.storeCreditRedemption.findUnique({ where: { id: Number(allocation.redemptionId) } }) : null
    const rootSource = sourceEvent
      ? parentFunding.sources.find((row: any) => Number(row.event.id) === Number(sourceEvent.id)) : null
    if (!allocation || !issue || !sourceEvent || !rootEvent || rootEvent.kind !== 'SOURCE_GIFT' ||
        Number(issue.sourceInvoiceId) !== Number(sourceInvoice.id) ||
        Number(issue.childInvoiceId) !== Number(childInvoice.id) || Number(issue.returnId) !== Number(ret.id) ||
        toNumberRial(issue.amount) !== -toNumberRial(credit.amount) ||
        Number(issue.parentEventId) !== Number(sourceEvent.id) || issue.shareId !== sourceEvent.shareId ||
        issue.rootShareId !== sourceEvent.rootShareId || !rootSource || rootSource.sourceKind !== 'SOURCE_GIFT' ||
        rootSource.available !== 0 ||
        Number(allocation.returnId) !== Number(ret.id) || Number(allocation.successorCreditId) !== Number(credit.id) ||
        Number(allocation.redemptionId) !== Number(rootEvent.sourceRedemptionId) ||
        Number(allocation.parentCreditId) !== Number(rootEvent.sourceCreditId) ||
        Number(allocation.invoiceId) !== Number(redemption?.invoiceId) ||
        Number(redemption?.creditId) !== Number(rootEvent.sourceCreditId) ||
        Number(allocation.rootCreditId) <= 0 ||
        toNumberRial(allocation.amount) + toNumberRial(allocation.supplementUnspent) !== toNumberRial(credit.amount) ||
        (allocation.originalExpiresAt?.getTime() ?? null) !== (credit.expiresAt?.getTime() ?? null) ||
        delivery.status !== 'PENDING_DELIVERY' && delivery.status !== 'DELIVERED')
      throw new BusinessError('اعتبار باقی‌مانده به منشأ هدیهٔ استفاده‌شده و سهم برگشتی این فاکتور وصل نیست؛ کد صادر/فعال نشد.')
  } else {
    const realRemainder = parentFunding.sources.filter((row: any) =>
      ['SOURCE_CASH', 'SOURCE_CARD'].includes(String(row.sourceKind)))
      .reduce((sum: number, row: any) => sum + Number(row.available), 0)
    const otherRemainder = parentFunding.sources.filter((row: any) =>
      !['SOURCE_CASH', 'SOURCE_CARD'].includes(String(row.sourceKind)))
      .reduce((sum: number, row: any) => sum + Number(row.available), 0)
    if (ret.refundMethod !== 'STORE_CREDIT' || Number(ret.storeCreditId) !== Number(credit.id) ||
        toNumberRial(ret.refundAmount) !== toNumberRial(credit.amount) ||
        toNumberRial(ret.realMoneyRefundAmount) !== toNumberRial(credit.amount) ||
        realRemainder !== toNumberRial(credit.amount) || otherRemainder !== 0 ||
        !Number.isSafeInteger(realRemainder))
      throw new BusinessError('این بارکد به ماندهٔ وجه واقعیِ برگشتیِ همین زنجیره وصل نیست؛ کد فعال نشد.')
  }
  return { credit, delivery, returnRow: ret }
}

async function assertCreditDeliverySourceLineage(tx: Client, delivery: any, credit: any, actorUserId?: number | null) {
  if (delivery.originCreditId != null) {
    const replaced = await tx.creditReplacement.findUnique({ where: { successorCreditId: credit.id } })
    const old = await tx.storeCredit.findUnique({ where: { id: delivery.originCreditId } })
    if (!replaced || replaced.originalCreditId !== delivery.originCreditId || old?.status !== 'CANCELED')
      throw new BusinessError('زنجیرهٔ جانشینی کد/ابطال مبدأ قابل تأیید نیست؛ تحویل دوباره تأیید نشد.')
  } else if (delivery.sourceKind === 'CASH_RIGHT_CONVERSION') {
    const events = await tx.returnEntitlementEvent.findMany({ where: { creditId: credit.id, kind: 'CASH_RIGHT_CONVERTED' } })
    if (events.length !== 1)
      throw new BusinessError('رویداد منشأ تبدیل این کد مفقود یا چندگانه است؛ تحویل/بازپخش امن نیست.')
    const event = events[0]
    const claim = await tx.returnEntitlement.findUnique({ where: { id: event.entitlementId } })
    const creditAmount = toNumberRial(credit.amount)
    if (!claim || claim.state !== 'OPEN' || toNumberRial(event.amount) !== creditAmount ||
        toNumberRial(claim.cashConverted) < creditAmount ||
        Number(credit.returnId) !== Number(claim.returnId) ||
        Number(credit.sourceInvoiceId) !== Number(claim.invoiceId))
      throw new BusinessError('منشأ/lineage حق نقدی و کد جانشین یکتا/سازگار نیست؛ تحویل تا تطبیق مدیر متوقف است.')
    const ret = await assertReturnEntitlementLineage(tx, claim)
    if (ret.voidedAt != null)
      throw new BusinessError('سند مرجع کد تبدیل‌شده باطل است؛ تحویل یا بازپخش کد مجاز نیست.')
  } else if (delivery.sourceKind === 'CHAIN_GIFT_RESIDUAL' || delivery.sourceKind === 'CHAIN_REAL_REFUND') {
    await assertChainedExchangeCreditDeliveryLineage(tx, Number(credit.id), Number(credit.returnId))
  } else if (delivery.sourceKind === 'CREDIT_RETURN_OPPORTUNITY') {
    const branch = await tx.creditReturnAllocation.findUnique({ where: { successorCreditId: credit.id } })
    const ret = branch
      ? await assertOrdinaryReturnLineage(tx, Number(branch.returnId), Number(branch.invoiceId))
      : null
    if (!branch || !ret || ret.voidedAt != null || ret.invoiceId !== branch.invoiceId ||
        toNumberRial(branch.amount) + toNumberRial(branch.supplementUnspent) !== toNumberRial(credit.amount) ||
        (branch.originalExpiresAt?.getTime() ?? null) !== (credit.expiresAt?.getTime() ?? null))
      throw new BusinessError('منشأ B/E یا مبلغ/انقضای اصلی قابل تطبیق نیست؛ کد فعال نشد.')
  } else if (delivery.sourceKind === 'S1_EXCHANGE_B' || delivery.sourceKind === 'S1_EXCHANGE_N') {
    const rightKey = String(credit.exchangeResidualRightKey ?? '')
    const expectedKind = delivery.sourceKind === 'S1_EXCHANGE_B' ? 'B' : 'N'
    const opening = rightKey ? await tx.exchangeResidualRightEvent.findFirst({
      where: { rightKey, eventKind: 'OPENED' }
    }) : null
    if (!opening || opening.rightKind !== expectedKind ||
        Number(credit.returnId) !== Number(opening.returnId) ||
        Number(credit.exchangeInvoiceId) !== Number(opening.childInvoiceId) ||
        Number(credit.sourceInvoiceId) !== Number(opening.sourceInvoiceId) ||
        toNumberRial(credit.amount) !== toNumberRial(opening.amount) ||
        (credit.expiresAt == null ? null : new Date(credit.expiresAt).getTime()) !==
          (opening.expiresAt == null ? null : new Date(opening.expiresAt).getTime()) ||
        (expectedKind === 'N' && credit.expiresAt != null))
      throw new BusinessError('کد B/N با دفتر append-only یا مبدأ/موعد ریشه منطبق نیست؛ تحویل متوقف شد.')
    const [balance, verified] = await Promise.all([
      getExchangeResidualRightBalance(tx, rightKey),
      (opening.evidenceKind === 'PAID_SOURCE_AFTER_DEBT_OFFSET'
        ? openS11ExchangeDebtResidualRights(tx, { sourceInvoiceId: Number(opening.sourceInvoiceId),
            childInvoiceId: Number(opening.childInvoiceId), returnId: Number(opening.returnId),
            actorUserId: actorUserId ?? null })
        : openS1ExchangeResidualRights(tx, { sourceInvoiceId: Number(opening.sourceInvoiceId),
            childInvoiceId: Number(opening.childInvoiceId), returnId: Number(opening.returnId),
            actorUserId: actorUserId ?? null }))
    ])
    if (balance.rightKind !== expectedKind || balance.amount !== toNumberRial(credit.amount) ||
        balance.expired || balance.voided ||
        !(verified.rights as Array<{ rightKey: string; creditId: number }>).some((right) =>
          right.rightKey === rightKey && right.creditId === Number(credit.id)))
      throw new BusinessError('lineage زندهٔ B/N یا مانده/انقضای ریشه در همین لحظه تأیید نشد؛ تحویل متوقف شد.')
  }
}

/** Print != delivery. A DRAFT replacement/conversion cannot be spent before
 * this witnessed handoff. Replayed confirmations revalidate provenance and do
 * not reactivate twice.
 */
export async function confirmCreditDelivery(input: {
  creditId: number
  witnessKind: 'CUSTOMER_HANDOFF' | 'COURIER_ACK'
  witnessRef: string
  managerPassword?: string | null
  actorUserId?: number | null
}) {
  const creditId = safeId(input.creditId, 'شناسه اعتبار')
  const ref = String(input.witnessRef ?? '').trim()
  if (!['CUSTOMER_HANDOFF', 'COURIER_ACK'].includes(input.witnessKind) || ref.length < 8)
    throw new BusinessError('برای تحویل اعتبار، نوع شاهد و توضیح مشخصِ تحویل (حداقل ۸ نویسه) لازم است.')
  await assertManagerPassword(input.managerPassword, 'تأیید تحویل شاهددار کد اعتبار')
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.creditDelivery.findUnique({ where: { creditId } })
    if (!delivery) throw new BusinessError('برای این اعتبار پروندهٔ تحویل کنترل‌شده وجود ندارد.')
    const credit = await tx.storeCredit.findUnique({ where: { id: creditId } })
    if (!credit) throw new BusinessError('کد اعتبار پیدا نشد؛ سابقهٔ تحویل را برای رسیدگی بررسی کنید.')
    await assertCreditDeliverySourceLineage(tx, delivery, credit, input.actorUserId ?? null)
    if (delivery.status === 'DELIVERED') {
      if (delivery.witnessKind === input.witnessKind && delivery.witnessRef === ref)
        return { creditId, status: 'DELIVERED', replayed: true }
      throw stale()
    }
    if (delivery.status !== 'PENDING_DELIVERY') throw stale()
    if (['CHAIN_GIFT_RESIDUAL', 'CHAIN_REAL_REFUND'].includes(String(delivery.sourceKind)) &&
        Number(credit.printCount) < 1)
      throw new BusinessError('ابتدا بارکد را چاپ کنید؛ اعتبار زنجیره‌ای پیش از چاپ و تحویل واقعی فعال نمی‌شود.')
    if (credit.status !== 'DRAFT' || credit.deletedAt != null || credit.voidedAt != null)
      throw new BusinessError('کد اعتبار دیگر در حالت انتظار تحویل نیست؛ تحویل ثبت نشد.')
    const at = new Date()
    if (credit.expiresAt && credit.expiresAt <= at)
      throw new BusinessError('انقضای اصلی این اعتبار گذشته است؛ تحویل کد، فرصت منقضی را احیا نمی‌کند.')
    const marked = await tx.creditDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING_DELIVERY', version: delivery.version },
      data: { status: 'DELIVERED', deliveredAt: at, deliveredByUserId: input.actorUserId ?? null,
        witnessKind: input.witnessKind, witnessRef: ref, version: { increment: 1 } }
    })
    if (marked.count !== 1) throw stale()
    const activated = await tx.storeCredit.updateMany({
      where: { id: creditId, status: 'DRAFT', usedAmount: 0, deletedAt: null }, data: { status: 'ACTIVE' }
    })
    if (activated.count !== 1) throw stale()
    const issuance = await tx.returnEntitlementEvent.findFirst({ where: { creditId, kind: 'CASH_RIGHT_CONVERTED' } })
    if (issuance) {
      await tx.returnEntitlementEvent.create({ data: {
        entitlementId: issuance.entitlementId, eventKey: `delivered:${creditId}`, kind: 'CREDIT_DELIVERED', amount: 0,
        creditId, actorUserId: input.actorUserId ?? null, evidenceKind: input.witnessKind, reason: ref,
        beforeVersion: delivery.version
      } })
    }
    return { creditId, status: 'DELIVERED', replayed: false }
  })
}

export async function viewReturnEntitlement(returnId: number) {
  const row = await prisma.returnEntitlement.findUnique({ where: { returnId: safeId(returnId, 'شناسه برگشت') } })
  if (!row) return null
  return safeView(row)
}
