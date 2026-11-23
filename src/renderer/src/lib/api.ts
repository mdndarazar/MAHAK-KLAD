import type { Api } from '../../../preload/index'

declare global {
  interface Window { api: Api }
}

/** نام رویداد سراسری «این کار قفل است» (طرح ۱۴۰۵ §۳-۷)؛ `detail` = { id، message } */
export const GATE_REQUIRED_EVENT = 'mahak-gate-required'
const GATE_REQUIRED_PREFIX = 'GATE_REQUIRED:'

/** فراخوانی IPC با throw کردن خطای فارسی؛ تا صفحات فقط try/catch بزنند. */
type ApiChannel = Parameters<Api['invoke']>[0]

export async function call<T = any>(channel: ApiChannel, payload?: unknown): Promise<T> {
  const res = await window.api.invoke<T>(channel, payload)
  if (!res.ok) {
    const err = new Error(res.error) as Error & { code?: string; printCancelled?: boolean; printOutcomeUnknown?: boolean }
    err.code = res.code
    if (res.code === 'PRINT_CANCELLED') err.printCancelled = true
    if (res.code === 'PRINT_OUTCOME_UNKNOWN') err.printOutcomeUnknown = true
    // طرح ۱۴۰۵ §۳-۷: رد دروازه ⇒ رویداد سراسری؛ پنجرهٔ «باز کردن قفل این کار» (یک بار در Shell) باز می‌شود
    if (typeof res.code === 'string' && res.code.startsWith(GATE_REQUIRED_PREFIX))
      window.dispatchEvent(new CustomEvent(GATE_REQUIRED_EVENT, { detail: { id: res.code.slice(GATE_REQUIRED_PREFIX.length), message: res.error } }))
    throw err
  }
  return res.data
}

export const CH = window.api?.channels
