/**
 * Safe classification of money received on an exchange invoice.
 *
 * `Payment.destination` is authoritative. In particular, MANAGER and legacy
 * rows without a destination must never be folded into the shop cash drawer.
 * Store/exchange-credit rows and pending cheques are value, not received money.
 */
import { toNumberRial, toRial } from './money'

export type ExchangeTenderBucket = 'cash' | 'card' | 'manager' | 'unknown'

export interface ExchangeTenderPaymentLike {
  amount: number | bigint | string | null | undefined
  destination?: unknown
  kind?: unknown
  chequeStatus?: unknown
  voidedAt?: unknown
  method?: { kind?: unknown } | null
}

export interface ExchangeTenderTotals {
  cash: number
  card: number
  manager: number
  unknown: number
}

export function exchangeTenderBucketOf(destination: unknown): ExchangeTenderBucket {
  const value = String(destination ?? '').trim().toUpperCase()
  if (value === 'CASH') return 'cash'
  if (value === 'CARD') return 'card'
  if (value === 'MANAGER') return 'manager'
  return 'unknown'
}

/** Shared classifier for exchange reports and any other exchange-tender view. */
export function exchangeTenderTotalsOf(
  payments: readonly ExchangeTenderPaymentLike[] | null | undefined
): ExchangeTenderTotals {
  const totals: Record<ExchangeTenderBucket, bigint> = {
    cash: 0n,
    card: 0n,
    manager: 0n,
    unknown: 0n
  }
  for (const payment of payments ?? []) {
    if (payment.voidedAt != null) continue
    const methodKind = String(payment.method?.kind ?? '').trim().toUpperCase()
    if (methodKind === 'EXCHANGE_CREDIT' || methodKind === 'STORE_CREDIT') continue
    const entryKind = String(payment.kind ?? 'CASH').trim().toUpperCase()
    const chequeStatus = String(payment.chequeStatus ?? '').trim().toUpperCase()
    if (entryKind === 'CHEQUE' && chequeStatus !== 'CLEARED') continue
    totals[exchangeTenderBucketOf(payment.destination)] += toRial(payment.amount)
  }
  return {
    cash: toNumberRial(totals.cash),
    card: toNumberRial(totals.card),
    manager: toNumberRial(totals.manager),
    unknown: toNumberRial(totals.unknown)
  }
}
