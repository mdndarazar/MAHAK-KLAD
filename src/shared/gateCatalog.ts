/**
 * طرح ۱۴۰۵ — کاتالوگ دروازهٔ مرکزی قفل‌ها (معماری §۳-۳).
 *
 * هر «شناسهٔ کار» ← کلید قفل، دسته، منشأ امروز، کلید ماژول مادر (برای کارهای strict)،
 * نوع کلید روشن/خاموش و عنوان فارسی. متن رابط، فهرست گوشی و رفتار دروازه همه از
 * همین‌جا و `panels.ts` ساخته می‌شوند تا هرگز از هم جدا نشوند.
 *
 * مرحلهٔ ۰: خالی. ردیف‌ها در مرحلهٔ ۵ افزوده می‌شوند؛ آزمون اسکن جاهای فراخوانی
 * (`tests/audit-fixes/plan1405-gate-callsite-scan.mjs`) هر شناسهٔ پوشانده را با همین می‌سنجد.
 */

/** منشأ امروزِ گیت: «فقط رمز مدیر»، «strict با رمز دوم/سوم ماژول مادر» یا «فقط نشست مدیر». */
export type GateOrigin = 'MANAGER_PASSWORD' | 'STRICT' | 'SESSION'

/** کلید روشن/خاموش: قفل پنل در `panel.locks`، یا کلید «سیاست حسابداری» که صداکننده خودش می‌سنجد. */
export type GateLockKind = 'panel' | 'policy'

export interface GateCatalogEntry {
  /** شناسهٔ کار، مثل `shift.force-staff-change` */
  id: string
  /** کلید قفل در `panels.ts` (کلید `act-*` یا یکی از پنج کلید استثنا) */
  lockKey: string
  /** ۱ = کلیدسازی (فقط خود مدیر)، ۲ = قفل قسمت، ۳ = قفل کار */
  category: 1 | 2 | 3
  origin: GateOrigin
  /** برای کارهای strict: کلید ماژول مادر که رمز دوم/سوم امروزش کار را باز می‌کند */
  parentPanel?: string
  lockKind: GateLockKind
  titleFa: string
}

export const GATE_CATALOG: Readonly<Record<string, GateCatalogEntry>> = Object.freeze({})

/**
 * برچسب ثابت «روش تأیید» (معماری §۳-۹). مرحلهٔ ۵ این خط را به `note` ردیف خود کار می‌افزاید،
 * فقط برای روش‌های تازه؛ پیام‌رسان (مرحلهٔ ۳) فقط همین برچسب‌های ثابت را از `note` می‌خواند و
 * هرگز متن آزاد `note` را در پیام نمی‌گذارد. شکل خط:
 *   `روش تأیید: <برچسب>[ شمارهٔ <n>][ · پنجرهٔ <n>]`
 */
export const GATE_METHOD_NOTE_PREFIX = 'روش تأیید: '
export const GATE_METHOD_LABELS = Object.freeze({
  MANAGER_SESSION: 'نشست مدیر',
  SENSITIVE_CODE: 'کد یک‌بارمصرف حساس',
  OTHER_CODE: 'کد یک‌بارمصرف',
  REMOTE_GRANT: 'مجوز راه دور',
  SCHEDULED_GRANT: 'مجوز زمان‌بندی‌شده',
  LOCK_OFF: 'قفل این کار خاموش بود'
} as const)
export type GateMethodKey = keyof typeof GATE_METHOD_LABELS

/** ساخت همان خط ثابت؛ نویسنده (مرحلهٔ ۵) و خواننده (پیام‌رسان) هر دو از همین شکل استفاده می‌کنند. */
export function gateMethodNoteLine(method: GateMethodKey, extra: { number?: number; windowNo?: number } = {}): string {
  const n = Number.isSafeInteger(extra.number) && (extra.number as number) > 0 ? ` شمارهٔ ${extra.number}` : ''
  const w = Number.isSafeInteger(extra.windowNo) && (extra.windowNo as number) > 0 ? ` · پنجرهٔ ${extra.windowNo}` : ''
  return `${GATE_METHOD_NOTE_PREFIX}${GATE_METHOD_LABELS[method]}${n}${w}`
}

/**
 * نوع ردیف‌های `ACCESS_EVENT` (معماری §۳-۹) در فیلد `kind` ستون `after`. نویسنده‌ها در مرحله‌های ۵ و ۶
 * می‌آیند؛ خلاصهٔ ساعت ۲۴ پیام‌رسان «امروز N مجوز و M کد مصرف شد» را از همین‌ها می‌شمارد.
 * «دیدن گزارش از گوشی» و ورود و خروج مدیر فقط ثبت می‌شوند و پیام نمی‌شوند.
 */
export const ACCESS_EVENT_KINDS = Object.freeze({
  CODE_USED: 'CODE_USED',
  CODE_WRONG: 'CODE_WRONG',
  CODES_CREATED: 'CODES_CREATED',
  CODES_REVOKED: 'CODES_REVOKED',
  REMOTE_GRANT_OPENED: 'REMOTE_GRANT_OPENED',
  REMOTE_GRANT_CLOSED: 'REMOTE_GRANT_CLOSED',
  SCHEDULED_GRANT_CREATED: 'SCHEDULED_GRANT_CREATED',
  SCHEDULED_GRANT_CANCELED: 'SCHEDULED_GRANT_CANCELED',
  SCHEDULED_GRANT_OPENED: 'SCHEDULED_GRANT_OPENED',
  SCHEDULED_GRANT_CLOSED: 'SCHEDULED_GRANT_CLOSED',
  DURATIONS_CHANGED: 'DURATIONS_CHANGED',
  BOT_DECISION: 'BOT_DECISION',
  PHONE_REPORT_VIEW: 'PHONE_REPORT_VIEW',
  MANAGER_LOGIN: 'MANAGER_LOGIN',
  MANAGER_LOGOUT: 'MANAGER_LOGOUT'
} as const)
export type AccessEventKind = keyof typeof ACCESS_EVENT_KINDS
