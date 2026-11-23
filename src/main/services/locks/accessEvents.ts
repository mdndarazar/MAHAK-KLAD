/**
 * طرح ۱۴۰۵ §۳-۹ — ردیف‌های جدای `ACCESS_EVENT` (باز شدن و بسته شدن مجوز راه دور، تغییر مدت‌ها، و در مرحلهٔ ۶
 * کدها و مجوز زمان‌بندی‌شده). leaf است: نویسنده (همان `audit` روی پایگاه داده) را `ipc/index.ts` هنگام
 * راه‌اندازی می‌دهد؛ پس `CloudSyncService` و آزمون‌های esbuild آن بی پایگاه داده بسته‌بندی می‌شوند.
 * بی نویسنده (آزمون‌ها) هیچ کاری نمی‌کند. شکست نوشتن هرگز جریان کار را نمی‌شکند.
 */
import { ACCESS_EVENT_KINDS, type AccessEventKind } from '@shared/gateCatalog'

export interface AccessEventFields {
  titleFa?: string
  number?: number
  windowNo?: number
  count?: number
  minutes?: number
  recipientName?: string
  decision?: string
}
type Writer = (after: Record<string, unknown>, userId: number | null) => unknown

let writer: Writer | null = null

export function setAccessEventWriter(fn: Writer | null): void {
  writer = typeof fn === 'function' ? fn : null
}

/** فقط فیلدهای ثابتِ پیام‌رسان (`EVENT_FIELDS.ACCESS_EVENT`)؛ هیچ رمز، کد یا شمارهٔ تماس. */
export function noteAccessEvent(kind: AccessEventKind, fields: AccessEventFields = {}, userId: number | null = null): void {
  if (!writer || !Object.prototype.hasOwnProperty.call(ACCESS_EVENT_KINDS, kind)) return
  const after: Record<string, unknown> = { kind }
  if (typeof fields.titleFa === 'string' && fields.titleFa) after.titleFa = fields.titleFa.slice(0, 120)
  for (const key of ['number', 'windowNo', 'count', 'minutes'] as const) {
    const value = fields[key]
    if (Number.isSafeInteger(value) && (value as number) >= 0) after[key] = value
  }
  if (typeof fields.recipientName === 'string' && fields.recipientName) after.recipientName = fields.recipientName.slice(0, 60)
  if (typeof fields.decision === 'string' && fields.decision) after.decision = fields.decision.slice(0, 40)
  try {
    void Promise.resolve(writer(after, Number.isSafeInteger(userId) ? userId : null)).catch(() => undefined)
  } catch {}
}
