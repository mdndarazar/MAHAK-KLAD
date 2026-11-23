/**
 * طرح ۱۴۰۵ — کاتالوگ دروازهٔ مرکزی قفل‌ها (معماری §۳-۳).
 *
 * هر «شناسهٔ کار» ← کلید قفل، دسته، منشأ امروز، کلید ماژول مادر (برای کارهای strict)،
 * نوع کلید روشن/خاموش و عنوان فارسی. متن رابط، فهرست گوشی و رفتار دروازه همه از
 * همین‌جا و `panels.ts` ساخته می‌شوند تا هرگز از هم جدا نشوند.
 *
 * مرحلهٔ ۵: ۴۸ شناسهٔ کار، ۷ قسمت تازه و چهار نشانهٔ «کلیدسازی» برای فهرست‌های چندبخشی. آزمون اسکن جاهای
 * فراخوانی (`tests/audit-fixes/plan1405-gate-callsite-scan.mjs`) هر شناسهٔ پوشانده را با همین می‌سنجد.
 */

/** منشأ امروزِ گیت: «فقط رمز مدیر»، «strict با رمز دوم/سوم ماژول مادر» یا «فقط نشست مدیر». */
export type GateOrigin = 'MANAGER_PASSWORD' | 'STRICT' | 'SESSION'

/** کلید روشن/خاموش: قفل پنل در `panel.locks`، یا کلید «سیاست حسابداری» که صداکننده خودش می‌سنجد. */
export type GateLockKind = 'panel' | 'policy'

export interface GateCatalogEntry {
  /** شناسهٔ کار (مثل `shift.force-staff-change`) یا کلید قسمت تازه (مثل `staff`) */
  id: string
  /** کلید قفل در `panels.ts` (کلید `act-*`، یکی از پنج کلید استثنا، یا کلید قسمت تازه)؛ دستهٔ ۱ کلید ندارد */
  lockKey: string
  /** ۱ = کلیدسازی (فقط خود مدیر)، ۲ = قفل قسمت، ۳ = قفل کار */
  category: 1 | 2 | 3
  origin: GateOrigin
  /** برای کارهای strict: کلید ماژول مادر که رمز دوم/سوم امروزش کار را باز می‌کند */
  parentPanel?: string
  lockKind: GateLockKind
  /** نام ماژولی که در «قفل ماژول‌ها» و گوشی زیرش می‌آید */
  group: string
  titleFa: string
}

const G = Object.freeze({
  settings: 'تنظیمات', credit: 'مدیریت اعتبار', salesCredit: 'نسیه', returns: 'برگشت و تعویض',
  charges: 'عوارض و حق سرویس', sales: 'پنل فروش و فاکتور', cashClose: 'بستن صندوق', reports: 'گزارشات فروش',
  management: 'گزارش مدیریت', staff: 'کارمندان و حضانت', sms: 'پیامک', woo: 'همگام‌سازی سایت', keys: 'کلیدسازی'
} as const)
export const GATE_GROUPS = G

type Row = [id: string, lockKey: string, origin: GateOrigin, parentPanel: string | null, lockKind: GateLockKind, group: string, titleFa: string]

/** دستهٔ ۳: ۴۸ قفل کار (جدول ۳-۱۰). ترتیب همان شمارهٔ ردیف‌های جدول است. */
const ACTIONS: readonly Row[] = [
  ['backup.export-file', 'act-backup-export', 'STRICT', 'settings', 'panel', G.settings, 'فایل بکاپ کامل در مسیر دلخواه'],
  ['backup.auto-settings', 'act-backup-settings', 'STRICT', 'settings', 'panel', G.settings, 'تنظیمات بکاپ خودکار'],
  ['backup.run-now', 'act-backup-now', 'STRICT', 'settings', 'panel', G.settings, 'بکاپ فوری با چرخش'],
  ['backup.forget', 'act-backup-forget', 'STRICT', 'settings', 'panel', G.settings, 'حذف بکاپ از فهرست'],
  ['backup.restore', 'act-backup-restore', 'STRICT', 'settings', 'panel', G.settings, 'بازگردانی کامل بکاپ'],
  ['backup.merge', 'act-backup-merge', 'STRICT', 'settings', 'panel', G.settings, 'ادغام بکاپ'],
  ['system.factory-reset', 'act-factory-reset', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'صفر کردن برنامه'],
  ['credit.reprint-manager', 'act-credit-reprint', 'STRICT', 'credit-management', 'panel', G.credit, 'چاپ دوبارهٔ گواهی اعتبار به دست مدیر'],
  ['credit.issue-manual', 'act-credit-issue-manual', 'STRICT', 'credit-management', 'panel', G.credit, 'صدور دستی اعتبار'],
  ['credit.void', 'credit-void', 'STRICT', 'credit-void', 'panel', G.credit, 'ابطال اعتبار'],
  ['credit.delete', 'credit-void', 'STRICT', 'credit-void', 'panel', G.credit, 'حذف اعتبار'],
  ['credit.bulk-issue', 'credit-bulk-issue', 'STRICT', 'credit-bulk-issue', 'panel', G.credit, 'تولید گروهی اعتبار'],
  ['credit.settings-save', 'credit-settings', 'STRICT', 'credit-settings', 'panel', G.credit, 'ذخیرهٔ تنظیمات اعتبار'],
  ['credit.code-reveal', 'act-credit-code-reveal', 'SESSION', null, 'panel', G.credit, 'نمایش کد اعتبار برای مدیر'],
  ['credit.invoice-lookup', 'act-credit-invoice-lookup', 'SESSION', null, 'panel', G.credit, 'یافتن اعتبارهای مرتبط با فاکتور'],
  ['sales.payments-edit-open-shift', 'act-payments-edit-open-shift', 'STRICT', 'sales-credit', 'panel', G.salesCredit, 'تغییر پرداخت‌ها در شیفت باز'],
  ['cheque.edit-cleared', 'act-cheque-edit-cleared', 'STRICT', 'sales-credit', 'panel', G.salesCredit, 'ویرایش چک پاس‌شده'],
  ['cheque.void-cleared', 'act-cheque-void-cleared', 'STRICT', 'sales-credit', 'panel', G.salesCredit, 'ابطال چک پاس‌شده'],
  ['cheque.status-change', 'act-cheque-status', 'STRICT', 'sales-credit', 'panel', G.salesCredit, 'تغییر وضعیت چک'],
  ['cheque.replace', 'act-cheque-replace', 'STRICT', 'sales-credit', 'panel', G.salesCredit, 'جایگزینی چک'],
  ['return.full-refund-no-discount-deduction', 'act-refund-full', 'STRICT', 'sales-return', 'panel', G.returns, 'بازپرداخت کامل بی کسر تخفیف'],
  ['return.refund-card', 'act-refund-card-return', 'MANAGER_PASSWORD', null, 'panel', G.returns, 'بازپرداخت کارتی در برگشت'],
  ['exchange.refund-card', 'act-refund-card-exchange', 'MANAGER_PASSWORD', null, 'panel', G.returns, 'بازپرداخت کارتی در تعویض'],
  ['sales.charges-below-auto', 'act-charges-below-auto', 'MANAGER_PASSWORD', null, 'panel', G.charges, 'عوارض یا حق سرویس کمتر از مبلغ خودکار'],
  ['sales.price-below-reference', 'act-price-below-reference', 'MANAGER_PASSWORD', null, 'policy', G.sales, 'قیمت کمتر از قیمت مرجع'],
  ['sales.overpay-credit-above-cap', 'act-overpay-credit-above-cap', 'MANAGER_PASSWORD', null, 'policy', G.sales, 'اعتبار اضافه‌دریافت بالاتر از سقف'],
  ['period.closed-entry', 'act-closed-period-entry', 'MANAGER_PASSWORD', null, 'policy', G.settings, 'کار در دورهٔ بسته‌شده'],
  ['shift.close-stale-session', 'act-close-stale-session', 'STRICT', 'cash-close', 'panel', G.cashClose, 'بستن نشست جامانده و باز کردن نشست تازه'],
  ['shift.force-staff-change', 'act-force-staff-change', 'STRICT', 'cash-close', 'panel', G.cashClose, 'تعویض اجباری کارمند نشست'],
  ['custody.master-override', 'act-master-override', 'MANAGER_PASSWORD', null, 'panel', G.cashClose, 'Master Override صندوق'],
  ['settings.accounting-policy', 'act-accounting-policy', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'سیاست حسابداری'],
  ['settings.exchange-overpay-guard', 'act-exchange-overpay-guard', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'جلوگیری از بازپرداخت اضافه در تعویض'],
  ['settings.clock-offset', 'act-clock-offset', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'افست ساعت رسمی'],
  ['settings.shift-by-clock', 'act-shift-by-clock', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'شیفت بر اساس ساعت'],
  ['settings.overtime-cap', 'act-overtime-cap', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'سقف اضافه‌کاری شیفت'],
  ['settings.manager-sections', 'act-settings-manager-sections', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'بخش‌های مدیریتی تنظیمات'],
  ['settings.raw-sensitive', 'act-raw-sensitive-setting', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'تنظیم خام حساس'],
  ['reports.sales-purge', 'act-sales-reports-purge', 'MANAGER_PASSWORD', null, 'panel', G.reports, 'پاک‌سازی گزارشات فروش'],
  ['maintenance.archive-purge', 'act-data-archive-purge', 'MANAGER_PASSWORD', null, 'panel', G.settings, 'آرشیو و پاک‌سازی داده‌های قدیمی'],
  ['management.cost-ledger-rebuild', 'act-cost-ledger-rebuild', 'MANAGER_PASSWORD', null, 'panel', G.management, 'بازسازی دفتر هزینهٔ گزارش مدیریت'],
  ['sms.api-key-set', 'sms-provider', 'MANAGER_PASSWORD', null, 'panel', G.sms, 'ثبت کلید API پیامک'],
  ['sms.api-key-target', 'sms-provider', 'MANAGER_PASSWORD', null, 'panel', G.sms, 'تغییر مقصد یا نوع اتصال کلید API پیامک'],
  ['woo.connect-initial', 'woo-sync', 'MANAGER_PASSWORD', null, 'panel', G.woo, 'اتصال اولیهٔ موجودی سایت'],
  ['woo.reconnect', 'woo-sync', 'MANAGER_PASSWORD', null, 'panel', G.woo, 'وصل دوبارهٔ موجودی سایت'],
  ['woo.disconnect', 'woo-sync', 'MANAGER_PASSWORD', null, 'panel', G.woo, 'قطع دائم اتصال موجودی سایت'],
  ['woo.parked-process', 'woo-sync', 'MANAGER_PASSWORD', null, 'panel', G.woo, 'پردازش دستی رویدادهای پارک‌شدهٔ سایت'],
  ['woo.decision', 'woo-sync', 'MANAGER_PASSWORD', null, 'panel', G.woo, 'تأیید یا رد تصمیم موجودی سایت'],
  ['woo.bulk-link', 'woo-sync', 'MANAGER_PASSWORD', null, 'panel', G.woo, 'وصل گروهی رنگ و سایز موجودی سایت']
]

/** دستهٔ ۲: هفت قسمت تازه (همه «حساس»)؛ امروز «فقط نشست مدیر». */
const PARTS: readonly Row[] = [
  ['credit-print', 'credit-print', 'SESSION', null, 'panel', G.credit, 'چاپ سند اعتبار از مدیریت اعتبار'],
  ['staff', 'staff', 'SESSION', null, 'panel', G.staff, 'کارمندان'],
  ['staff-sensitive-file', 'staff-sensitive-file', 'SESSION', null, 'panel', G.staff, 'پروندهٔ حساس پرسنلی'],
  ['custody-settings', 'custody-settings', 'SESSION', null, 'panel', G.staff, 'تنظیمات حضانت صندوق'],
  ['custody-control-report', 'custody-control-report', 'SESSION', null, 'panel', G.staff, 'گزارش کنترل حضانت'],
  ['custody-discrepancy-cases', 'custody-discrepancy-cases', 'SESSION', null, 'panel', G.staff, 'پرونده‌های مغایرت کشو و کارت‌خوان'],
  ['custody-work-plans', 'custody-work-plans', 'SESSION', null, 'panel', G.staff, 'برنامه‌های کاری حضانت']
]

/**
 * دستهٔ ۱ («کلیدسازی») فقط به‌عنوان نشانه در فهرست‌های چندبخشی می‌آید: وقتی یک ذخیرهٔ کلی چیزی از این
 * جنس را هم عوض کند، دروازه فقط رفتار امروز را دارد (رمز تایپی یا نشست خود مدیر؛ بی کد و مجوز).
 */
const KEYMAKING: readonly Row[] = [
  ['keys.panel-locks', '', 'MANAGER_PASSWORD', null, 'panel', G.keys, 'روشن و خاموش کردن قفل‌ها'],
  ['keys.security-config', '', 'MANAGER_PASSWORD', null, 'panel', G.keys, 'تنظیمات امنیتی'],
  ['keys.accounting-lock-switches', '', 'MANAGER_PASSWORD', null, 'panel', G.keys, 'سه کلید قفل «سیاست حسابداری»'],
  ['keys.staff-manager-fields', '', 'SESSION', null, 'panel', G.keys, 'نقش «مدیر» و رمز شخصی تأیید اصلاح کارمند']
]

function entries(rows: readonly Row[], category: 1 | 2 | 3): Array<[string, GateCatalogEntry]> {
  return rows.map(([id, lockKey, origin, parentPanel, lockKind, group, titleFa]) => [
    id,
    Object.freeze({ id, lockKey, category, origin, ...(parentPanel ? { parentPanel } : {}), lockKind, group, titleFa })
  ])
}

export const GATE_CATALOG: Readonly<Record<string, GateCatalogEntry>> = Object.freeze(Object.fromEntries([
  ...entries(ACTIONS, 3), ...entries(PARTS, 2), ...entries(KEYMAKING, 1)
]))

/** فقط شناسه‌های کار (۴۸)؛ برای مجوز یک‌بار راه دور و فهرست گوشی. */
export const GATE_ACTION_IDS: readonly string[] = Object.freeze(ACTIONS.map((r) => r[0]))
/** کلیدهای هفت قسمت تازه. */
export const GATE_PART_KEYS: readonly string[] = Object.freeze(PARTS.map((r) => r[0]))
/** کلیدهای تازهٔ `act-*` (۳۶)؛ پنج کلید استثنا از قبل در `panels.ts` هستند. */
export const GATE_ACTION_LOCK_KEYS: readonly string[] = Object.freeze([...new Set(ACTIONS.map((r) => r[1]).filter((k) => k.startsWith('act-')))])

export function gateEntry(id: unknown): GateCatalogEntry | null {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(GATE_CATALOG, id) ? GATE_CATALOG[id] : null
}

/**
 * فهرست‌های چندبخشی (معماری §۳-۱۰، زیر جدول دستهٔ ۱): یک ذخیره که چند چیز را با هم عوض می‌کند همهٔ
 * شناسه‌هایش را می‌خواهد (اصل «ج»: راه دوم قفل راه اول را دور نمی‌زند). دستهٔ ۱ در فهرست یعنی «فقط رفتار
 * امروز» (رمز تایپی یا نشست خود مدیر). نام این تابع‌ها و متغیرهای خروجی‌شان با `GateIds` تمام می‌شود تا
 * آزمون اسکن پوشش آن‌ها را بشناسد؛ آزمون کاتالوگ هر خروجی را با همین کاتالوگ می‌سنجد.
 */
const objectOf = (raw: unknown): Record<string, unknown> => {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const ACCOUNTING_SWITCHES = ['requireManagerForPriceOverride', 'lockClosedPeriods', 'storeCreditLimit'] as const

/** پیکربندی شیفت: «شیفت بر اساس ساعت» و «سقف اضافه‌کاری» کار جدای خودشان را دارند؛ بقیهٔ تغییرها `rest`. */
export function shiftChangeGateIds(before: unknown, next: unknown, rest: string): string[] {
  const b = objectOf(before), n = objectOf(next)
  const ids: string[] = []
  if (!sameValue(b.byTime, n.byTime)) ids.push('settings.shift-by-clock')
  if (!sameValue(b.overtimeMaxMinutes, n.overtimeMaxMinutes)) ids.push('settings.overtime-cap')
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'byTime' && k !== 'overtimeMaxMinutes'))
  if (!ids.length || !sameValue(strip(b), strip(n))) ids.push(rest)
  return ids
}

/** سیاست حسابداری: سه کلید قفل (گیت قیمت دستی، قفل دورهٔ بسته، سقف اعتبار خرید) دستهٔ ۱‌اند؛ بقیه قفل کار. */
export function accountingPolicyGateIds(before: unknown, next: unknown): string[] {
  const b = objectOf(before), n = objectOf(next)
  const switches = ACCOUNTING_SWITCHES.some((k) => !sameValue(b[k], n[k]))
  const others = Object.keys({ ...b, ...n }).some((k) => !(ACCOUNTING_SWITCHES as readonly string[]).includes(k) && !sameValue(b[k], n[k]))
  const ids: string[] = []
  if (switches) ids.push('keys.accounting-lock-switches')
  if (others || !switches) ids.push('settings.accounting-policy')
  return ids
}

/** تنظیم خام `settings:set` (کلیدهای «رمز مدیر»): هرگز آسان‌تر از مسیر رسمی همان کلید نیست. */
export function rawSettingGateIds(key: unknown, beforeRaw?: unknown, nextRaw?: unknown): string[] {
  const k = String(key ?? '')
  if (k === 'panel.locks') return ['keys.panel-locks']
  if (k === 'security.config') return ['keys.security-config']
  if (k === 'time.official') return ['settings.clock-offset']
  if (k === 'shift.config') return shiftChangeGateIds(beforeRaw, nextRaw, 'settings.raw-sensitive')
  if (k === 'accounting.policy') return [...new Set([...accountingPolicyGateIds(beforeRaw, nextRaw), 'settings.raw-sensitive'])]
  if (k === 'credit.settings') return ['credit.settings-save', 'settings.raw-sensitive']
  return ['settings.raw-sensitive']
}

/** ذخیرهٔ کلی تنظیمات (`SettingsService.saveBundle`): هر بخشِ واقعاً تغییرکرده شناسهٔ خودش را می‌خواهد. */
export function settingsSaveGateIds(changed: { security?: boolean; clockOffset?: boolean; shift?: readonly string[]; other?: boolean }): string[] {
  const ids = new Set<string>()
  if (changed.security) ids.add('keys.security-config')
  if (changed.clockOffset) ids.add('settings.clock-offset')
  for (const id of changed.shift ?? []) ids.add(id)
  if (changed.other) ids.add('settings.manager-sections')
  return ids.size ? [...ids] : ['settings.manager-sections']
}

/** ثبت یا ویرایش کارمند: نقش «مدیر» و رمز شخصی تأیید اصلاح دستهٔ ۱ است؛ بقیه قسمت «کارمندان». */
export function staffSaveGateIds(managerFieldsTouched: unknown): string[] {
  return managerFieldsTouched === true ? ['keys.staff-manager-fields', 'staff'] : ['staff']
}

/** بازگردانی یا ادغام بکاپ، از روی حالت. */
export function backupApplyGateIds(mode: unknown): string[] {
  return [mode === 'merge' ? 'backup.merge' : 'backup.restore']
}

/** چاپ سند اعتبار از «مدیریت اعتبار»: چاپ نخست قسمت `credit-print`؛ «دوباره» قفل کار یک‌بار (§۳-۱۰ ردیف ۸). */
export function creditPrintGateIds(reprint: unknown): string[] {
  return [reprint === true ? 'credit.reprint-manager' : 'credit-print']
}

/** نشانگر غیرراز «نشست مدیر باز است / رمز ندارم» (معماری §۳-۶): با صفحه‌کلید تایپ نمی‌شود و هرگز رمز نیست. */
export const GATE_PROOF_MARKER = '\u2063\u2063\u2063'
/** پیشوند کد خطای رد دروازه؛ رابط پنجرهٔ «باز کردن قفل این کار» را با آن باز می‌کند (معماری §۳-۷). */
export const GATE_REQUIRED_PREFIX = 'GATE_REQUIRED:'

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
  LOCK_OFF: 'قفل این کار خاموش بود',
  /** رمز دوم/سوم جای تازه: رمز جدای خود «قفل کار»، یا رمز دوم/سوم قسمتی که امروز «فقط نشست مدیر» بود */
  PANEL_PASSWORD: 'رمز دوم/سوم همین قفل'
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
  /** مرحلهٔ ۶: برداشتن قفل کدها به دست مدیر؛ پروندهٔ خراب کدها (همه باطل)؛ کدهای بازیابی توقف اضطراری */
  CODES_UNLOCKED: 'CODES_UNLOCKED',
  CODES_FILE_BROKEN: 'CODES_FILE_BROKEN',
  RECOVERY_CODES_CREATED: 'RECOVERY_CODES_CREATED',
  RECOVERY_CODES_REVOKED: 'RECOVERY_CODES_REVOKED',
  RECOVERY_CODE_USED: 'RECOVERY_CODE_USED',
  PHONE_REPORT_VIEW: 'PHONE_REPORT_VIEW',
  MANAGER_LOGIN: 'MANAGER_LOGIN',
  MANAGER_LOGOUT: 'MANAGER_LOGOUT'
} as const)
export type AccessEventKind = keyof typeof ACCESS_EVENT_KINDS
