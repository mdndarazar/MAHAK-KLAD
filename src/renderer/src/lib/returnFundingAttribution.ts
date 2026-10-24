import type { ReturnFundingAttribution } from '@shared/types'
import { money } from '@shared/jalali'

/** Human-readable provenance only; deliberately never describes payout/tender. */
export function formatReturnFundingAttribution(attribution?: ReturnFundingAttribution | null): string {
  if (!attribution || attribution.status === 'NOT_APPLICABLE') return '—'
  if (attribution.status !== 'ATTRIBUTION_ONLY' || attribution.settlementReady !== false ||
      !Array.isArray(attribution.sources) || attribution.sources.length === 0)
    return 'انتساب منشأ نامکمل؛ تطبیق لازم'
  const labels: Record<string, string> = {
    SOURCE_GIFT: 'منشأ هدیه',
    SOURCE_CASH: 'منشأ وجه',
    SOURCE_CARD: 'منشأ کارت',
    SOURCE_CHEQUE: 'منشأ چک'
  }
  if (attribution.sources.some((source) => !labels[source?.sourceKind] ||
      !Number.isSafeInteger(source?.amount) || source.amount < 0))
    return 'انتساب منشأ نامکمل؛ تطبیق لازم'
  return attribution.sources.map((source) => `${labels[source.sourceKind]}: ${money(source.amount)}`)
    .join(' · ') + ' — فقط انتساب؛ نه پرداخت یا حق وجه'
}
