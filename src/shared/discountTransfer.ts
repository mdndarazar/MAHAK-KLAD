/** Historical discount transfer is enabled by default; managers may opt out of
 * the extra-refund guard, but provenance, capacity and anti-double-counting
 * checks remain mandatory in either setting. */
export interface DiscountTransferSettings {
  preventExtraRefund: boolean
}

export const DEFAULT_DISCOUNT_TRANSFER_SETTINGS: DiscountTransferSettings = {
  preventExtraRefund: true
}

export function parseDiscountTransferSettings(raw: unknown): DiscountTransferSettings {
  let value: any = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { value = null }
  }
  if (typeof value === 'boolean') value = { preventExtraRefund: value }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ...DEFAULT_DISCOUNT_TRANSFER_SETTINGS }
  return { preventExtraRefund: value.preventExtraRefund !== false }
}

export type DiscountTransferOption = 'NO' | 'YES' | 'YES_ZERO'

export interface DiscountTransferChoiceProjection {
  option: DiscountTransferOption
  transferAmount: number
  enabled: boolean
  disabledReason: string | null
  refundValue?: number
  recommended?: boolean
}

/** The policy compares merchandise-only net values on both sides: taxes and
 * service charges are accounted for by settlement, not by discount transfer. */
export function discountTransferPolicyDelta(replacementMerchandiseNet: number, returnedMerchandiseNet: number): number {
  return Math.round(replacementMerchandiseNet) - Math.round(returnedMerchandiseNet)
}

export function discountTransferExplanation(
  option: DiscountTransferOption,
  historicalDiscount: number,
  transferAmount: number,
  formatAmount: (amount: number) => string = (amount) => String(amount)
): string {
  const historical = Math.max(0, Math.round(historicalDiscount))
  const transferred = Math.min(historical, Math.max(0, Math.round(transferAmount)))
  const remainder = historical - transferred
  if (option === 'NO')
    return `از تخفیف کالای قبلی ${formatAmount(historical)} ریال، هیچ مبلغی به کالای جدید منتقل نمی‌شود و ${formatAmount(historical)} ریال باقی‌ماندهٔ تخفیف به مشتری بازپرداخت نمی‌شود.`
  if (option === 'YES') {
    if (remainder <= 0)
      return `تخفیف کالای قبلی ${formatAmount(historical)} ریال بود؛ ${formatAmount(transferred)} ریال تخفیف به کالای جدید منتقل می‌شود.`
    return `تخفیف کالای قبلی ${formatAmount(historical)} ریال بود؛ ${formatAmount(transferred)} ریال به کالای جدید منتقل می‌شود و ${formatAmount(remainder)} ریال باقی‌مانده به‌دلیل سقف ظرفیت منتقل نمی‌شود و بابت تخفیف به مشتری بازپرداخت نمی‌شود.`
  }
  if (remainder <= 0)
    return `تخفیف کالای قبلی ${formatAmount(historical)} ریال بود؛ ${formatAmount(transferred)} ریال تخفیف به کالای جدید منتقل می‌شود.`
  return `تخفیف کالای قبلی ${formatAmount(historical)} ریال بود؛ با انتخاب این گزینه، ${formatAmount(transferred)} ریال تخفیف به کالای جدید منتقل می‌شود و ${formatAmount(remainder)} ریال باقی‌مانده که برای تخفیف است به مشتری بازپرداخت نمی‌شود.`
}

/** Recommend the enabled choices that safely transfer the greatest amount.
 * Refunds are compared with NO as a baseline, so an ordinary refund caused by
 * a cheaper replacement does not disqualify an option; only the incremental
 * refund caused by the historical transfer does. */
export function recommendDiscountTransferChoices<T extends DiscountTransferChoiceProjection>(
  choices: readonly T[]
): Array<T & { recommended: boolean }> {
  const noRefund = choices.find((choice) => choice.option === 'NO')?.refundValue
  const safe = choices.filter((choice) => choice.enabled && choice.refundValue != null &&
    (choice.option === 'NO' || choice.refundValue <= Number(noRefund ?? 0)))
  const bestAmount = safe.reduce((best, choice) => Math.max(best, choice.transferAmount), -1)
  return choices.map((choice) => ({
    ...choice,
    recommended: bestAmount >= 0 && choice.enabled && choice.transferAmount === bestAmount &&
      choice.refundValue != null && (choice.option === 'NO' || choice.refundValue <= Number(noRefund ?? 0))
  })) as Array<T & { recommended: boolean }>
}

export function discountTransferAmounts(input: {
  historicalDiscount: number
  capacity: number
  policyDelta: number
  protectExtraRefund: boolean
  refundValueWithoutTransfer: number
  refundValueWithFullTransfer: number
}): DiscountTransferChoiceProjection[] {
  const d = Math.max(0, Math.round(input.historicalDiscount))
  const c = Math.max(0, Math.round(input.capacity))
  // Policy sign is fixed: Δ = R − N, positive only when the replacement's
  // merchandise net exceeds the returned merchandise net.
  const delta = Math.round(input.policyDelta)
  const full = Math.min(d, c)
  const zero = delta > 0 ? Math.min(d, c, delta) : 0
  const refundIncreased = input.refundValueWithFullTransfer > input.refundValueWithoutTransfer
  return [
    { option: 'NO', transferAmount: 0, enabled: true, disabledReason: null },
    {
      option: 'YES',
      transferAmount: full,
      enabled: !(input.protectExtraRefund && refundIncreased),
      disabledReason: input.protectExtraRefund && refundIncreased
        ? 'با انتقال کامل، ارزش نهایی برگشتی از گزینهٔ «خیر» بیشتر می‌شود.'
        : null
    },
    { option: 'YES_ZERO', transferAmount: zero, enabled: true, disabledReason: null }
  ]
}

/** Deterministic largest-remainder allocation. The returned shares always sum
 * to `total`, and zero/negative weights receive no value. */
export function allocateRialShares(total: number, weights: readonly number[]): number[] {
  const amount = Math.max(0, Math.round(total))
  const clean = weights.map((weight) => Math.max(0, Math.round(weight)))
  const weightSum = clean.reduce((sum, weight) => sum + weight, 0)
  if (!amount || !weightSum || !clean.length) return clean.map(() => 0)
  const parts = clean.map((weight, index) => {
    const exact = amount * weight / weightSum
    const floor = Math.floor(exact)
    return { index, floor, remainder: exact - floor }
  })
  let left = amount - parts.reduce((sum, part) => sum + part.floor, 0)
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break
    part.floor++
    left--
  }
  const out = Array(clean.length).fill(0)
  for (const part of parts) out[part.index] = part.floor
  return out
}
