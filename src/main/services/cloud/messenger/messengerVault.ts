/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — پرونده‌های پیام‌رسان، بیرون از پایگاه داده (معماری §۴-۱).
 *
 *  - `messenger.vault`: کلید ربات‌ها و گیرنده‌ها، رمزشده با `safeStorage` (DPAPI ویندوز)، با `0o600`.
 *    خراب یا ناخوانا ⇒ پیام‌رسان خاموش می‌ماند و پرونده هرگز بی‌صدا بازنویسی یا از نو ساخته نمی‌شود
 *    (همان الگوی fail-closed در `remoteTransportVault.ts`). کنار گذاشتنش فقط با رمز مدیر است.
 *  - `messenger-outbox/<گیرنده>.json`: صف هر گیرنده و آمار او.
 *  - `messenger-cursor.json`: نشانگر AuditLog و اثر انگشت پایگاه داده، روز آخرین خلاصه، و یادآوری‌های پایان شیفتِ
 *    فرستاده‌شده (دفتر آزمون ۴-۲۶).
 *  - `messenger-heartbeat.json`: ساعت، هر دقیقه، و این‌که برنامه عادی بسته شد یا نه.
 *
 * چون همه بیرون از پایگاه داده‌اند، بازگردانی یک بکاپ قدیمی گیرندهٔ حذف‌شده را برنمی‌گرداند و اعلان‌ها را
 * بی‌صدا عوض نمی‌کند. نوشتن‌ها اتمی‌اند (پروندهٔ موقت در همان پوشه، سپس rename).
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyStats, parseMessengerSettings, type MessengerSettings, type OutboxItem, type RecipientStats } from './messengerTypes'

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export const MESSENGER_FILES = Object.freeze({
  vault: 'messenger.vault',
  outbox: 'messenger-outbox',
  cursor: 'messenger-cursor.json',
  heartbeat: 'messenger-heartbeat.json'
})

const MAX_VAULT = 256 * 1024
const MAX_JSON = 8 * 1024 * 1024

/** همان سنجش `remoteTransportVault.ts`: روی Linux، پشتیبان رمزنگاری واقعی لازم است. */
export function secureStorageAvailable(storage: SafeStorageLike | null | undefined): boolean {
  try {
    if (!storage || typeof storage.isEncryptionAvailable !== 'function' || typeof storage.encryptString !== 'function' ||
        typeof storage.decryptString !== 'function' || storage.isEncryptionAvailable() !== true) return false
    if (process.platform === 'linux' && (typeof storage.getSelectedStorageBackend !== 'function' ||
        !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend()))) return false
    return true
  } catch { return false }
}

/** نوشتن اتمی با `0o600`. روی ویندوز rename جای پروندهٔ قبلی را می‌گیرد؛ قفل گذرا (ضدویروس) چند بار تلاش می‌شود. */
export function atomicWrite(path: string, data: string | Buffer): void {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try { renameSync(temporary, path); return } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
        const until = Date.now() + 20 * (attempt + 1)
        while (Date.now() < until) { /* کوتاه؛ فقط برای قفل گذرای ویندوز */ }
      }
    }
    throw lastError
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    try { unlinkSync(temporary) } catch {}
  }
}

function readBounded(path: string, max: number): Buffer | null {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.size > max) throw new Error('Invalid messenger file')
  const fd = openSync(path, 'r')
  try {
    const live = fstatSync(fd)
    if (!live.isFile() || live.size > max) throw new Error('Invalid messenger file')
    const buffer = Buffer.alloc(live.size + 1)
    let length = 0, count = 0
    do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count } while (count > 0 && length < buffer.length)
    if (length > live.size) throw new Error('Invalid messenger file')
    return buffer.subarray(0, length)
  } finally { closeSync(fd) }
}

export type VaultRead =
  | { state: 'absent' }
  | { state: 'ok'; settings: MessengerSettings }
  | { state: 'broken'; reason: string }
  | { state: 'unavailable' }

export interface OutboxFile { version: 1; items: OutboxItem[]; stats: RecipientStats }

export interface CursorFile {
  version: 1
  /** آخرین AuditLog خوانده‌شده؛ و هش همان ردیف برای تشخیص جایگزینی پایگاه داده */
  auditId: number
  auditHash: string
  /** شمارندهٔ تغییر سرآیند SQLite در آخرین خواندن (null یعنی نامعلوم) */
  counter: number | null
  custodyEventId: number
  custodyCountId: number
  /** شیفت‌هایی که اخیراً با بستن صندوق بسته شدند (پیام جدای «پایان نشست» نمی‌گیرند) */
  closeShiftIds: number[]
  /** روز شمسی آخرین خلاصهٔ ساعت ۲۴ */
  summaryDay: string | null
  /** بازگردانی، ادغام یا صفر کردنی که آغاز شد و پایانش هنوز ثبت نشده (معماری §۴-۱) */
  pendingBackupAt: number | null
  pendingKind: 'backup' | 'reset' | null
  /** دفتر آزمون ۴-۲۶ (TL-D8): یادآوری‌های پایان شیفت که فرستاده شدند (`h:<شیفت>` تحویل، `n:<شیفت>` شیفت آخر)؛ ۴۰ تای آخر */
  reminderKeys: string[]
  /** پس از بازگردانی کامل از راه برنامه: شروع بعدی نشانگر را بی پیام دوباره، از «اکنون» می‌گیرد */
  resetOnStart: boolean
}

export interface HeartbeatFile { version: 1; at: number; clean: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

function validItem(v: unknown): v is OutboxItem {
  return isObj(v) && typeof v.code === 'string' && v.code.length <= 40 && isInt(v.at) && typeof v.title === 'string' &&
    Array.isArray(v.lines) && v.lines.every((l) => typeof l === 'string') && typeof v.important === 'boolean' &&
    typeof v.maybeDup === 'boolean' && typeof v.sale === 'boolean' && (v.day === null || typeof v.day === 'string')
}
function validStats(v: unknown): RecipientStats {
  const out = emptyStats()
  if (!isObj(v)) return out
  if (isInt(v.lastSuccessAt)) out.lastSuccessAt = v.lastSuccessAt
  if (typeof v.lastError === 'string') out.lastError = v.lastError.slice(0, 300)
  const e = v.expiredPending
  if (isObj(e) && isInt(e.count) && isInt(e.fromAt) && isInt(e.toAt) && e.count > 0) out.expiredPending = { count: e.count, fromAt: e.fromAt, toAt: e.toAt }
  if (isInt(v.expiredTotal)) out.expiredTotal = v.expiredTotal
  if (isInt(v.failedTotal)) out.failedTotal = v.failedTotal
  const s = v.saleSent
  if (isObj(s) && typeof s.day === 'string' && isInt(s.n)) out.saleSent = { day: s.day, n: s.n }
  return out
}

export function createMessengerStore(dir: string, storage: SafeStorageLike | null) {
  const vaultPath = join(dir, MESSENGER_FILES.vault)
  const outboxDir = join(dir, MESSENGER_FILES.outbox)
  const cursorPath = join(dir, MESSENGER_FILES.cursor)
  const heartbeatPath = join(dir, MESSENGER_FILES.heartbeat)
  const outboxPath = (id: string) => {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid recipient id')
    return join(outboxDir, `${id}.json`)
  }

  function vaultExists(): boolean {
    try { lstatSync(vaultPath); return true } catch { return false }
  }

  function readSettings(): VaultRead {
    if (!vaultExists()) return { state: 'absent' }
    if (!secureStorageAvailable(storage)) return { state: 'unavailable' }
    let data: Buffer | null
    try { data = readBounded(vaultPath, MAX_VAULT) } catch { return { state: 'broken', reason: 'file' } }
    if (!data || data.length < 1) return { state: 'broken', reason: 'empty' }
    let plaintext: string
    try { plaintext = storage!.decryptString(data) } catch { return { state: 'broken', reason: 'decrypt' } }
    let parsed: unknown
    try { parsed = JSON.parse(plaintext) } catch { return { state: 'broken', reason: 'json' } }
    const settings = parseMessengerSettings(parsed)
    return settings ? { state: 'ok', settings } : { state: 'broken', reason: 'shape' }
  }

  /** فقط با ذخیره‌ساز امن واقعی. رمزنگاری پیش از نوشتن یک بار برگردانده و سنجیده می‌شود. */
  function writeSettings(settings: MessengerSettings): void {
    if (!secureStorageAvailable(storage)) throw new Error('Secure storage unavailable')
    const checked = parseMessengerSettings(JSON.parse(JSON.stringify(settings)))
    if (!checked) throw new Error('Invalid messenger settings')
    const plaintext = JSON.stringify(checked)
    let encrypted: Buffer
    try { encrypted = storage!.encryptString(plaintext) } catch { throw new Error('Secure storage failed') }
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > MAX_VAULT || encrypted.includes(Buffer.from(plaintext, 'utf8'))) throw new Error('Secure storage failed')
    let recovered: unknown
    try { recovered = storage!.decryptString(Buffer.from(encrypted)) } catch { throw new Error('Secure storage failed') }
    if (recovered !== plaintext) throw new Error('Secure storage failed')
    mkdirSync(dir, { recursive: true })
    atomicWrite(vaultPath, encrypted)
  }

  /** فقط برای گاوصندوق خراب، با رمز مدیر: پرونده کنار گذاشته می‌شود، نه پاک. */
  function setAsideVault(now: number): string | null {
    if (!vaultExists()) return null
    const aside = `${vaultPath}.broken-${now}`
    renameSync(vaultPath, aside)
    return aside
  }

  function readJson(path: string): unknown {
    const data = readBounded(path, MAX_JSON)
    if (!data) return null
    try { return JSON.parse(data.toString('utf8')) } catch { return undefined }
  }

  function readOutbox(id: string): OutboxFile {
    let raw: unknown
    try { raw = readJson(outboxPath(id)) } catch { raw = undefined }
    if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.items)) return { version: 1, items: [], stats: emptyStats() }
    return { version: 1, items: raw.items.filter(validItem).map((i) => ({ ...i })), stats: validStats(raw.stats) }
  }
  function writeOutbox(id: string, box: OutboxFile): void {
    mkdirSync(outboxDir, { recursive: true })
    atomicWrite(outboxPath(id), JSON.stringify(box))
  }
  function removeOutbox(id: string): void {
    try { unlinkSync(outboxPath(id)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  function listOutboxIds(): string[] {
    try { return readdirSync(outboxDir).filter((n) => /^[a-f0-9]{12}\.json$/.test(n)).map((n) => n.slice(0, 12)) } catch { return [] }
  }

  function readCursor(): CursorFile | null {
    let raw: unknown
    try { raw = readJson(cursorPath) } catch { return null }
    if (!isObj(raw) || raw.version !== 1 || !isInt(raw.auditId) || typeof raw.auditHash !== 'string' ||
        !(raw.counter === null || isInt(raw.counter)) || !isInt(raw.custodyEventId) || !isInt(raw.custodyCountId)) return null
    return {
      version: 1, auditId: raw.auditId, auditHash: raw.auditHash, counter: raw.counter as number | null,
      custodyEventId: raw.custodyEventId, custodyCountId: raw.custodyCountId,
      closeShiftIds: Array.isArray(raw.closeShiftIds) ? raw.closeShiftIds.filter(isInt).slice(-20) : [],
      summaryDay: typeof raw.summaryDay === 'string' ? raw.summaryDay : null,
      pendingBackupAt: isInt(raw.pendingBackupAt) ? raw.pendingBackupAt : null,
      pendingKind: raw.pendingKind === 'backup' || raw.pendingKind === 'reset' ? raw.pendingKind : null,
      resetOnStart: raw.resetOnStart === true,
      // پروندهٔ قدیمی بی این فهرست ⇒ خالی
      reminderKeys: Array.isArray(raw.reminderKeys) ? raw.reminderKeys.filter((k): k is string => typeof k === 'string' && /^[hn]:\d{1,15}$/.test(k)).slice(-40) : []
    }
  }
  function writeCursor(cursor: CursorFile): void {
    mkdirSync(dir, { recursive: true })
    atomicWrite(cursorPath, JSON.stringify(cursor))
  }

  function readHeartbeat(): HeartbeatFile | null {
    let raw: unknown
    try { raw = readJson(heartbeatPath) } catch { return null }
    if (!isObj(raw) || raw.version !== 1 || !isInt(raw.at) || typeof raw.clean !== 'boolean') return null
    return { version: 1, at: raw.at, clean: raw.clean }
  }
  function writeHeartbeat(value: HeartbeatFile): void {
    mkdirSync(dir, { recursive: true })
    atomicWrite(heartbeatPath, JSON.stringify(value))
  }

  return {
    paths: { vault: vaultPath, outbox: outboxDir, cursor: cursorPath, heartbeat: heartbeatPath },
    vaultExists, readSettings, writeSettings, setAsideVault,
    readOutbox, writeOutbox, removeOutbox, listOutboxIds,
    readCursor, writeCursor, readHeartbeat, writeHeartbeat
  }
}
export type MessengerStore = ReturnType<typeof createMessengerStore>
