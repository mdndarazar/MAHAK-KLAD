import { toLatinDigits } from './jalali'

/**
 * Canonical Iranian mobile number, shared by the SMS queue and credit-consent
 * decision without coupling the financial credit service to the SMS module.
 * Invalid numbers fail closed instead of being passed on to a provider.
 */
export function normalizeSmsPhone(raw: unknown): string {
  let p = toLatinDigits(String(raw ?? '')).replace(/[^0-9+]/g, '').replace(/^\+/, '')
  if (p.startsWith('0098')) p = p.slice(4)
  else if (p.startsWith('98') && p.length > 10) p = p.slice(2)
  p = p.replace(/^0+/, '')
  const out = `0${p}`
  return /^09\d{9}$/.test(out) ? out : ''
}
