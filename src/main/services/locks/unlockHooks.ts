/**
 * طرح ۱۴۰۵ §۳-۱۷ — قلاب‌های leaf برای «بستن همه» از مسیر راه دور، و وضعیت «تأیید راه دور متوقف است».
 *
 * `CloudSyncService` (لغو P1 و P2 گوشی) نباید به `lockIpc.ts` (و از آن‌جا به AuthService) وابسته شود، چون
 * آزمون‌های esbuild آن فقط `./AuthService` را جعل می‌کنند. پس `lockIpc` هنگام ثبت، تابع «بستن همه» را این‌جا
 * می‌گذارد و میزبان راه دور فقط همین پروندهٔ بی‌وابستگی را صدا می‌زند. بی ثبت (آزمون‌ها) هیچ کاری نمی‌کند.
 *
 * «تأیید راه دور متوقف است» یعنی هاب در حالت توقف اضطراری کامل (P2) یا مکث است؛ دکمه‌های ربات (§۴-۱-ب) در این
 * حالت تأیید نمی‌کنند، چون تأییدشان از هاب نمی‌گذرد. پس از بازیابی پشت رایانه دوباره باز می‌شود.
 */
export interface CloseAllOptions {
  /** P2: مجوزهای زمان‌بندی‌شدهٔ آینده هم لغو شوند */
  cancelFuture?: boolean
  /** برچسب ثابت صداکننده برای ردیف `ACCESS_EVENT` (مثلاً «گوشی (P1)») */
  source?: string
}
type CloseAll = (options: CloseAllOptions) => unknown

let closeAll: CloseAll | null = null
let approvalsStopped = false

export function setCloseAllUnlocksHook(fn: CloseAll | null): void {
  closeAll = typeof fn === 'function' ? fn : null
}

/** از مسیر لغو راه دور؛ هرگز خطا به صداکننده (رسید لغو) برنمی‌گرداند. */
export function closeAllUnlocksFromRemote(options: CloseAllOptions): void {
  try { closeAll?.(options) } catch {}
}

export function setRemoteApprovalsStopped(stopped: boolean): void {
  approvalsStopped = stopped === true
}

export function remoteApprovalsStopped(): boolean {
  return approvalsStopped
}

/**
 * §۴-۸ — راه سوم بازیابی پشت رایانه: «کد بازیابی» به‌تنهایی، روی همان کانال `remoteAuth:recover` (بار `{code}`).
 * میزبان راه دور هنگام شروع ثبتش می‌کند تا خط موجود `registerRemoteAuthHandlers(...)` همان بماند. `recovered`
 * پس از هر بازیابی موفق (رمز مدیر + PIN یا کد) صدا زده می‌شود.
 */
export interface RemoteRecoveryHooks {
  code?: (code: string) => Promise<boolean>
  recovered?: () => void
}
let recoveryHooks: RemoteRecoveryHooks = {}
export function setRemoteRecoveryHooks(hooks: RemoteRecoveryHooks): void {
  recoveryHooks = {
    ...(typeof hooks?.code === 'function' ? { code: hooks.code } : {}),
    ...(typeof hooks?.recovered === 'function' ? { recovered: hooks.recovered } : {})
  }
}
export function remoteRecoveryHooks(): RemoteRecoveryHooks {
  return recoveryHooks
}
