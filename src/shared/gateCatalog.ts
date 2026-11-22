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
