/**
 * طرح ۱۴۰۵ §۳-۵، §۳-۸ و §۳-۹ — بافت هر فراخوانی IPC و «شناسهٔ کار»ِ پوشانده‌شده.
 *
 * این پرونده عمداً leaf است: جز `node:async_hooks` و کاتالوگ مشترک هیچ import ندارد. `panelSession.ts`،
 * `AuditService.ts` و آزمون‌های esbuild (با جعلِ `./AuthService`) آن را بی جعل بسته‌بندی می‌کنند؛ پس نباید
 * راهی به AuthService، پایگاه داده یا electron داشته باشد.
 *
 * - `runInGateCall(owner, fn)`: `handle()` در `ipc/index.ts` هر فراخوانی IPC را در یک «بافت فراخوانی» اجرا
 *   می‌کند. بیرون از IPC (کارهای داخلی و آزمون‌ها) بافتی نیست و دروازه رفتار امروز را دارد (§۳-۸).
 * - قاب دروازه (`ids`): `gateAction`/`gateSession` شناسهٔ کار را فقط برای همان فراخوانیِ پوشانده می‌گذارند.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { GATE_METHOD_LABELS, GATE_PROOF_MARKER, gateMethodNoteLine, type GateMethodKey } from '@shared/gateCatalog'

export type GateScope = 'MANAGER' | 'PANEL'
export interface GateMethodRecord {
  key: GateMethodKey
  number?: number
  windowNo?: number
}

export interface GateCall {
  readonly owner: number
  /** شناسه‌هایی که در همین فراخوانی گذشتند (یک بلیت = یک فراخوانی؛ بار دوم همان فراخوانی هم می‌گذرد) */
  readonly passed: Map<string, GateScope>
  /** نخستین «روش تازه» که در همین فراخوانی دروازه را باز کرد (برای خط `note`، §۳-۹) */
  method: GateMethodRecord | null
}

export interface GateFrame {
  readonly call: GateCall | null
  readonly ids: readonly string[] | null
  /** دروازه رد کرد و رمز خالی بود ⇒ خطای امروزِ همان تابع کد `GATE_REQUIRED:<شناسه>` می‌گیرد */
  required: string | null
}

const store = new AsyncLocalStorage<GateFrame>()

/** فقط `handle()` در `ipc/index.ts`؛ owner همان `event.sender.id` است و هرگز از payload نمی‌آید. */
export function runInGateCall<T>(owner: number, fn: () => T): T {
  if (!Number.isSafeInteger(owner) || owner <= 0) return fn()
  return store.run({ call: { owner, passed: new Map(), method: null }, ids: null, required: null }, fn)
}

export function currentGateFrame(): GateFrame | null {
  return store.getStore() ?? null
}

export function currentGateCall(): GateCall | null {
  return store.getStore()?.call ?? null
}

/** قاب تازه با همان بافت فراخوانی و شناسه‌های همین کار؛ `fn` هم‌زمان داخل قاب صدا زده می‌شود. */
export function runInGateFrame<T>(ids: readonly string[], fn: (frame: GateFrame) => T): T {
  const frame: GateFrame = { call: store.getStore()?.call ?? null, ids, required: null }
  return store.run(frame, () => fn(frame))
}

/** ثبت «روش تازه» (§۳-۹). روش‌های امروز (رمز تایپی، رمز دوم/سوم در strictها، نشست در نشستی‌ها) ثبت نمی‌شوند. */
export function noteGateMethod(method: GateMethodRecord | null): void {
  const call = store.getStore()?.call
  if (call && method && !call.method && Object.prototype.hasOwnProperty.call(GATE_METHOD_LABELS, method.key)) call.method = method
}

/**
 * `AuditService` هنگام نوشتن ردیف: اگر در همین فراخوانی دروازه با روشی تازه باز شده، یک خط ثابت به
 * `note` افزوده می‌شود (پیام‌رسان فقط همین خط را می‌خواند). ردیف‌های `ACCESS_EVENT` خودشان داده دارند.
 */
export function withGateMethodNote(action: string, note: string | null | undefined): string | null {
  const method = store.getStore()?.call?.method
  const base = note ?? null
  if (!method || action === 'ACCESS_EVENT') return base
  const line = gateMethodNoteLine(method.key, { number: method.number, windowNo: method.windowNo })
  return base ? `${base}\n${line}` : line
}

/**
 * §۳-۶ — نشانگر غیرراز «نشست مدیر باز است / رمز ندارم»: `handle()` هر رشتهٔ ورودی IPC را که دقیقاً برابر
 * نشانگر است پیش از رسیدن به سرویس خالی می‌کند؛ پس همهٔ گیرندگان رمز و PIN آن را مثل کادر خالی می‌بینند و
 * هیچ‌کدام تلاش اشتباه نمی‌شمارد. فقط شیء ساده و آرایه، تا عمق ۶؛ چیز دیگری دست نمی‌خورد.
 */
export function blankGateMarkers<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return (value === GATE_PROOF_MARKER ? '' : value) as T
  if (!value || typeof value !== 'object' || depth > 6) return value
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const current = record[key]
    const next = blankGateMarkers(current, depth + 1)
    if (next !== current) try { record[key] = next } catch {}
  }
  return value
}
