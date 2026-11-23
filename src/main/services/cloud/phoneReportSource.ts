/**
 * طرح ۱۴۰۵ · مرحلهٔ ۷ (مورد ۶) — پل leaf میان میزبان هاب (`CloudSyncService`) و خوانندهٔ گزارش‌های گوشی.
 *
 * خواننده (`phoneReports.ts`، با سرویس‌های رایانه) را `registerIpcHandlers` هنگام راه‌اندازی ثبت می‌کند؛ پس
 * `CloudSyncService` و آزمون‌های esbuild آن بی سرویس‌های فروش و بی پایگاه داده بسته‌بندی می‌شوند (الگوی
 * `locks/accessEvents.ts`). بی خواننده هر درخواست «در دسترس نیست» است و هیچ زمان‌سنجی ساخته نمی‌شود.
 */
export interface PhoneReportSource {
  /** یک بخش از فهرست ثابت، با ورودی سنجیده‌شده؛ `member` نام کاربری عضو گوشی برای ردیف AuditLog */
  read(section: string, request: Record<string, unknown>, member: string): Promise<unknown>
  /** هاب روشن شد: تازه‌سازی دوره‌ای «خلاصهٔ امروز» */
  start(): void
  /** هاب خاموش شد (یا پس از بازگردانی): توقف و پاک کردن نسخهٔ ساخته‌شده */
  stop(): void
}

let source: PhoneReportSource | null = null

export function setPhoneReportSource(next: PhoneReportSource | null): void {
  source = next && typeof next.read === 'function' && typeof next.start === 'function' && typeof next.stop === 'function' ? next : null
}

export function readPhoneReport(section: string, request: Record<string, unknown>, member: string): Promise<unknown> {
  const current = source
  if (!current) return Promise.reject(new Error('Phone reports unavailable'))
  return current.read(section, request, member)
}

export function phoneReportsStarted(): void {
  try { source?.start() } catch {}
}

export function phoneReportsStopped(): void {
  try { source?.stop() } catch {}
}
