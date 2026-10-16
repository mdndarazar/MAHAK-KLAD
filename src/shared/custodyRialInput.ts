import { money, parseRequiredRialAmount, toLatinDigits } from './jalali'

/** Formatting for the *opening* input only. The financial parser remains the
 * authority: malformed grouping, decimals, signs, letters and unsafe values
 * are NEVER sanitized into a different valid amount. Blank is not zero. */
export function formatOpeningRialTyping(raw: string, cursor: number): { text: string; cursor: number } {
  const amount = parseRequiredRialAmount(raw)
  if (amount === null) return { text: raw, cursor }
  const text = money(amount)
  const digitsBeforeCursor = (toLatinDigits(raw.slice(0, cursor)).match(/\d/g) ?? []).length
  let formattedCursor = 0, digits = 0
  while (formattedCursor < text.length && digits < digitsBeforeCursor) {
    if (/\d/.test(toLatinDigits(text[formattedCursor]))) digits++
    formattedCursor++
  }
  return { text, cursor: formattedCursor }
}
