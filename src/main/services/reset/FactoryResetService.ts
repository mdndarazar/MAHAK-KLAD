/**
 * طرح ۱۴۰۵ · مورد ۸ — «صفر کردن برنامه» (معماری §۴-۲، طرح §۱۶، §۲۴-۳ مورد ۸، §۲۵-۱۰ بند «ج»، §۲۶-۲ بند ۱۴ و ۱۵).
 *
 * دو حالت: «فقط تراکنش‌ها» و «کامل». هر دو یک راه دارند و هر شکست یعنی «هیچ چیزی پاک نشد»:
 *   ۱) پیش‌نمایش شمارش و توضیح کامل همان حالت (`preview`)، پیش از فعال شدن دکمه در رابط؛
 *   ۲) تأیید تایپی «صفر» و تیک «می‌دانم برگشت فقط با بکاپ ممکن است»، و جای خالی دست‌کم دو برابر پایگاه داده؛
 *   ۳) دروازه: قفل کار `system.factory-reset` (بلیت یک‌بار همان لحظه مصرف می‌شود؛ §۳-۸)؛ همهٔ بلیت‌ها پاک؛
 *   ۴) پیام ⚠️ «صفر کردن آغاز شد» در صف پیام‌رسان (بیرون از پایگاه داده)؛
 *   ۵) ورود به `withDesktopBackupCoordination(…, 'reset')` (هاب: بستن مجوزها، epoch تازه؛ پیام‌رسان: نشانگر)؛
 *   ۶) توقف همگام‌سازی سایت (تا پایان دور جاری) و صف پیامک؛
 *   ۷) بکاپ محافظت‌شده و سنجیده (`createProtectedBackup`)؛
 *   ۸) پایگاه تازه کنار `shop.db` با migrator خود برنامه (هرگز `prisma migrate reset`، هرگز حذف ردیف‌به‌ردیف)؛
 *   ۹) کپی جدول‌ها و کلیدهای «می‌ماند» با ATTACH و همان شناسه‌ها (`resetModelClassification.ts`)؛
 *  ۱۰) یک ردیف `FACTORY_RESET` در AuditLog پایگاه تازه، با حالت، نام بکاپ و شمار پاک‌شده؛
 *  ۱۱) سنجش پایگاه تازه: `quick_check`، `foreign_key_check` (هیچ ارجاع شکستهٔ تازه) و شمارش هر جدول؛
 *  ۱۲) جدا شدن Prisma، تغییر نام `shop.db` به `shop.before-reset-<تاریخ>.db` (با `-journal`، `-wal`، `-shm`) و
 *      نشاندن پایگاه تازه؛ سپس رسید پایانی و باز شدن دوبارهٔ برنامه، مثل بازگردانی.
 * از `salePurge` استفاده نمی‌شود. بیرون از پایگاه داده (بکاپ‌ها، `panel-vault.key`، `remote-hub`، پیام‌رسان، کدها،
 * مدت‌ها و مجوزهای زمان‌بندی‌شده) دست نمی‌خورد.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { AuditAction } from '@shared/enums'
import { DEFAULT_CREDIT_SETTINGS, parseCreditSettings } from '@shared/credit'
import { toClock, toJalaliDate } from '@shared/jalali'
import { databaseFile, prisma } from '../../db/client'
import { applyMigrations, type RawSqlClient } from '../../db/migrator'
import { BusinessError } from '../../errors'
import { auditOrThrow, type AuditInput } from '../AuditService'
import { assertManagerPassword } from '../AuthService'
import { backupService, createProtectedBackup } from '../BackupService'
import { withDesktopBackupCoordination } from '../cloud/desktopBackupCoordination'
import { gateAction } from '../locks/gate'
import { clearGateTickets } from '../locks/tickets'
import { startSmsQueue, stopSmsQueue } from '../sms/SmsQueue'
import { startWooSyncScheduler, stopWooSyncScheduler } from '../WooSyncService'
import {
  CREDIT_PRINT_FIELDS, CREDIT_SETTINGS_KEY, FULL_KEEP_SETTING_KEYS, RECEIPT_SEQ_SETTING_KEY, RESET_HEADLINES,
  RESET_SYSTEM_TABLES, TRANSACTION_STATE_SETTING_KEYS, USER_BOUND_LOCKOUT_PREFIXES, WOO_CONFIG_SETTING_KEY,
  ZERO_STOCK_COLUMNS, resetConfirmMatches, resetFate, type ResetMode
} from './resetModelClassification'

/** کلاینت خام پایگاه تازه (یک اتصال فیزیکی؛ ATTACH و BEGIN/COMMIT خام روی همان اتصال می‌مانند). */
export interface ResetDbClient extends RawSqlClient {
  $disconnect(): Promise<void>
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> }
}

export interface FactoryResetDeps {
  databaseFile(): string
  /** پوشهٔ `backups` (رسید پایانی `last-factory-reset.json` همان‌جا می‌ماند؛ بیرون از پایگاه داده) */
  backupsDir(): string
  openClient(file: string): ResetDbClient
  migrate(client: ResetDbClient, file: string): Promise<unknown>
  /** کلاینت اصلی برنامه (Prisma مشترک) */
  main: {
    query<T = unknown>(sql: string, ...values: unknown[]): Promise<T>
    disconnect(): Promise<void>
    connect(): Promise<void>
  }
  protectedBackup(label: string): Promise<{ id: string; fileName: string; path: string; size: number }>
  listBackups(): Promise<Array<{ id: string; size: number; missing?: boolean }>>
  freeBytes(dir: string): Promise<number>
  coordinate<T>(operation: () => Promise<T>): Promise<T>
  beforeFactoryReset(): Promise<void>
  stopServices(): Promise<void>
  restartServices(): void
  clearTickets(): void
  authorize(managerPassword: string | null): Promise<void>
  audit(client: ResetDbClient, input: AuditInput): Promise<void>
  relaunch(): void
  rename(from: string, to: string): Promise<void>
  now(): Date
  /** باز شدن خودکار برنامه پس از صفر کردن موفق، اگر مدیر زودتر دکمه را نزد */
  autoRelaunchMs: number
}

export interface FactoryResetHeadline { table: string; label: string; count: number }

export interface FactoryResetModePreview {
  mode: ResetMode
  headlines: FactoryResetHeadline[]
  /** شمار کل ردیف‌هایی که پاک می‌شوند */
  deletedRows: number
  /** «فقط تراکنش‌ها»: شمار کالاهای فروشگاه و انبار مرکزی که موجودی‌شان صفر می‌شود */
  zeroStockItems: number
  nextReceiptNo: number
}

export interface FactoryResetReceipt {
  at: string
  atJalali: string
  mode: ResetMode
  backup: { id: string; fileName: string; size: number }
  /** نام پروندهٔ قبلی که پاک نشد و فقط تغییر نام گرفت */
  previousDatabaseFile: string
  deleted: FactoryResetHeadline[]
  deletedRows: number
  zeroStockItems: number
  nextReceiptNo: number
}

export interface FactoryResetPreview {
  modes: Record<ResetMode, FactoryResetModePreview>
  protectedBackups: { count: number; bytes: number }
  space: { databaseBytes: number; freeBytes: number | null; neededBytes: number; enough: boolean }
  lastReset: FactoryResetReceipt | null
}

const BACKUP_LABEL = 'پیش از صفر کردن'
const RECEIPT_FILE = 'last-factory-reset.json'
const PROTECTED_ID = /^imported-\d+-factory-reset\.db$/
const SRC = 'resetsrc'
const MODES = new Set<ResetMode>(['transactions', 'full'])
const q = (name: string) => `"${String(name).replace(/"/g, '""')}"`
const sqlString = (value: string) => `'${String(value).replace(/'/g, "''")}'`
const num = (value: unknown): number => { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0 }
const mb = (bytes: number) => `${Math.max(0, Math.ceil(bytes / (1024 * 1024))).toLocaleString('fa-IR')} مگابایت`
const seqOf = (raw: unknown): number => { const n = Math.round(Number(raw ?? 0)); return Number.isSafeInteger(n) && n > 0 ? n : 0 }

function fileStamp(d: Date): string {
  return `${toJalaliDate(d).replace(/\//g, '-')}_${toClock(d).replace(/:/g, '-')}`
}

const UNRESTORED = 'FACTORY_RESET_RENAME_UNRESTORED'
const KNOWN_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  'Desktop database operation busy': 'یک بازگردانی یا ادغام بکاپ هم‌زمان در جریان است؛ پس از پایانش دوباره امتحان کنید.',
  'Remote backup coordination unavailable': 'کنترل از راه دور در حال روشن یا خاموش شدن است؛ کمی بعد دوباره امتحان کنید.',
  'Restore coordination unavailable': 'کنترل از راه دور در حال روشن یا خاموش شدن است؛ کمی بعد دوباره امتحان کنید.'
})

/** خطای قابل‌فهم برای مدیر؛ متن فنی فقط در کنسول می‌ماند. */
function failure(error: unknown): BusinessError {
  if (error instanceof BusinessError && error.code === UNRESTORED) return error
  console.error('[factory-reset] failed; nothing was deleted', error)
  const message = String((error as { message?: unknown })?.message ?? '')
  const detail = error instanceof BusinessError ? `\n${message}` : KNOWN_FAILURES[message] ? `\n${KNOWN_FAILURES[message]}` : ''
  return new BusinessError(`صفر کردن انجام نشد و هیچ چیزی پاک نشد؛ داده‌ها همان است که بود.${detail}`)
}

async function tableNames(client: RawSqlClient, schema: string): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' ORDER BY name`)
  return (rows ?? []).map((r) => String(r.name)).filter((name) => !RESET_SYSTEM_TABLES.includes(name) && !name.startsWith('sqlite_'))
}

async function countOf(client: RawSqlClient, schema: string, table: string, where = ''): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ n: unknown }[]>(`SELECT COUNT(*) AS n FROM ${schema}.${q(table)}${where}`)
  return num(rows?.[0]?.n)
}

async function columnsOf(client: RawSqlClient, schema: string, table: string): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<{ name: string }[]>(`PRAGMA ${schema}.table_info(${q(table)})`)
  return (rows ?? []).map((r) => String(r.name))
}

async function firstRow<T>(client: RawSqlClient, sql: string, ...values: unknown[]): Promise<T | null> {
  const rows = await client.$queryRawUnsafe<T[]>(sql, ...values)
  return rows?.[0] ?? null
}

/** «فقط تراکنش‌ها»: شمارهٔ فیش بعدی = بیشینهٔ «آخرین فیش» و «شمارنده» + ۱ (`receiptNo.ts`)؛ «کامل»: ۱. */
async function nextReceiptFrom(client: RawSqlClient, schema: string, hasInvoices: boolean): Promise<number> {
  const max = hasInvoices ? num((await firstRow<{ m: unknown }>(client, `SELECT MAX("receiptNo") AS m FROM ${schema}."SaleInvoice"`))?.m) : 0
  const seq = seqOf((await firstRow<{ v: unknown }>(client, `SELECT "value" AS v FROM ${schema}."Setting" WHERE "key" = ?`, RECEIPT_SEQ_SETTING_KEY))?.v)
  return Math.max(max, seq) + 1
}

function headlinesFor(mode: ResetMode, counts: Record<string, number>): FactoryResetHeadline[] {
  return RESET_HEADLINES.filter((h) => resetFate(h.table, mode) === 'clear' && num(counts[h.table]) > 0)
    .map((h) => ({ table: h.table, label: h.label, count: num(counts[h.table]) }))
}

function keepSomeWhere(table: string, mode: ResetMode): string {
  if (table === 'Setting') {
    const keys = mode === 'full' ? FULL_KEEP_SETTING_KEYS : TRANSACTION_STATE_SETTING_KEYS
    return ` WHERE "key" ${mode === 'full' ? 'IN' : 'NOT IN'} (${keys.map(sqlString).join(', ')})`
  }
  if (table === 'AuthLockout' && mode === 'full') return ` WHERE ${USER_BOUND_LOCKOUT_PREFIXES.map((p) => `substr("gate", 1, ${p.length}) <> ${sqlString(p)}`).join(' AND ')}`
  throw new Error(`No keepSome rule for ${table}/${mode}`)
}

export function defaultFactoryResetDeps(): FactoryResetDeps {
  return {
    databaseFile,
    backupsDir: () => join(app.getPath('userData'), 'backups'),
    openClient: (file) => new PrismaClient({ datasources: { db: { url: `file:${file}?connection_limit=1` } }, log: ['error'] }) as unknown as ResetDbClient,
    migrate: (client, file) => applyMigrations(client, file),
    main: {
      query: (sql, ...values) => prisma.$queryRawUnsafe(sql, ...values),
      disconnect: async () => { await prisma.$disconnect() },
      connect: async () => { await prisma.$connect() }
    },
    protectedBackup: (label) => createProtectedBackup(label),
    listBackups: () => backupService.list(),
    freeBytes: async (dir) => { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize) },
    coordinate: (operation) => withDesktopBackupCoordination(operation, 'reset'),
    beforeFactoryReset: async () => undefined,
    stopServices: async () => { stopSmsQueue(); await stopWooSyncScheduler() },
    restartServices: () => { startWooSyncScheduler(); startSmsQueue() },
    clearTickets: () => clearGateTickets(),
    authorize: async (managerPassword) => {
      await gateAction('system.factory-reset', async () => await assertManagerPassword(managerPassword, 'صفر کردن برنامه'))
    },
    audit: (client, input) => auditOrThrow(client as never, input),
    relaunch: () => { app.relaunch(); app.exit(0) },
    rename: (from, to) => rename(from, to),
    now: () => new Date(),
    autoRelaunchMs: 60_000
  }
}

export function createFactoryResetService(overrides: Partial<FactoryResetDeps> = {}) {
  const deps: FactoryResetDeps = { ...defaultFactoryResetDeps(), ...overrides }
  let running = false
  let done = false
  let relaunchTimer: ReturnType<typeof setTimeout> | null = null

  const receiptPath = () => join(deps.backupsDir(), RECEIPT_FILE)

  async function readLastReceipt(): Promise<FactoryResetReceipt | null> {
    try {
      const parsed = JSON.parse(await readFile(receiptPath(), 'utf8'))
      return parsed && typeof parsed === 'object' && MODES.has(parsed.mode) ? parsed as FactoryResetReceipt : null
    } catch { return null }
  }

  async function removeDbFile(file: string): Promise<void> {
    for (const path of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) await rm(path, { force: true }).catch(() => undefined)
  }

  async function renameRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { await deps.rename(from, to); return } catch (error) {
        const code = String((error as { code?: unknown })?.code ?? '')
        if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  /** جای خالی دست‌کم دو برابر اندازهٔ پایگاه داده (بکاپ محافظت‌شده + پایگاه تازه). */
  async function space(db: string): Promise<FactoryResetPreview['space']> {
    const databaseBytes = (await stat(db)).size
    let freeBytes: number | null = null
    try { freeBytes = await deps.freeBytes(dirname(db)) } catch { freeBytes = null }
    const neededBytes = databaseBytes * 2
    return { databaseBytes, freeBytes, neededBytes, enough: freeBytes !== null && freeBytes >= neededBytes }
  }

  async function liveCounts(): Promise<Record<string, number>> {
    const rows = await deps.main.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    const counts: Record<string, number> = {}
    for (const { name } of rows ?? []) {
      const table = String(name)
      if (RESET_SYSTEM_TABLES.includes(table) || table.startsWith('sqlite_')) continue
      const r = await deps.main.query<{ n: unknown }[]>(`SELECT COUNT(*) AS n FROM ${q(table)}`)
      counts[table] = num(r?.[0]?.n)
    }
    return counts
  }

  async function zeroStockCount(client: { $queryRawUnsafe: RawSqlClient['$queryRawUnsafe'] } | null, schema: string, present: (t: string) => boolean): Promise<number> {
    let total = 0
    for (const [table, column] of Object.entries(ZERO_STOCK_COLUMNS)) {
      if (!present(table)) continue
      const sql = `SELECT COUNT(*) AS n FROM ${schema ? `${schema}.` : ''}${q(table)} WHERE ${q(column)} <> 0`
      const rows = client ? await client.$queryRawUnsafe<{ n: unknown }[]>(sql) : await deps.main.query<{ n: unknown }[]>(sql)
      total += num(rows?.[0]?.n)
    }
    return total
  }

  /** ۷ تا ۱۰: پایگاه تازه، کپی «می‌ماند»ها، ردیف AuditLog و سنجش. شکست ⇒ پروندهٔ تازه پاک، قدیمی دست‌نخورده. */
  async function buildFreshDatabase(ctx: {
    mode: ResetMode; oldFile: string; newFile: string; userId: number | null
    backup: { id: string; fileName: string; size: number }; at: Date
  }) {
    const { mode, oldFile, newFile } = ctx
    await removeDbFile(newFile)
    // migrator روی اتصال جدای خودش (همان الگوی بکاپ‌های قدیمی در MergeService)؛ سپس اتصال کار روی ساختار کامل
    const migrateClient = deps.openClient(newFile)
    try { await deps.migrate(migrateClient, newFile) } finally { await migrateClient.$disconnect().catch(() => undefined) }
    const client = deps.openClient(newFile)
    let attached = false
    try {
      const tables = await tableNames(client, 'main')
      const unclassified = tables.filter((t) => !resetFate(t, mode))
      if (unclassified.length) throw new Error(`Unclassified tables: ${unclassified.join(', ')}`)
      const seed: Record<string, number> = {}
      for (const t of tables) seed[t] = await countOf(client, 'main', t)

      await client.$executeRawUnsafe(`ATTACH DATABASE ${sqlString(oldFile)} AS ${SRC}`)
      attached = true
      const oldTables = new Set(await tableNames(client, SRC))
      const old: Record<string, number> = {}
      for (const t of tables) if (oldTables.has(t)) old[t] = await countOf(client, SRC, t)
      const zeroStockItems = mode === 'transactions' ? await zeroStockCount(client, SRC, (t) => oldTables.has(t)) : 0
      const nextReceiptNo = mode === 'transactions' ? await nextReceiptFrom(client, SRC, oldTables.has('SaleInvoice')) : 1

      const expected: Record<string, number> = {}
      const deleted: Record<string, number> = {}
      await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
      await client.$executeRawUnsafe('BEGIN IMMEDIATE')
      let committed = false
      try {
        for (const t of tables) {
          const fate = resetFate(t, mode)
          if (fate === 'clear' || !oldTables.has(t)) {
            expected[t] = seed[t]
            deleted[t] = old[t] ?? 0
            continue
          }
          const where = fate === 'keepSome' ? keepSomeWhere(t, mode) : ''
          const mainCols = await columnsOf(client, 'main', t)
          const srcCols = new Set(await columnsOf(client, SRC, t))
          const cols = mainCols.filter((c) => srcCols.has(c)).map(q).join(', ')
          await client.$executeRawUnsafe(`DELETE FROM main.${q(t)}`)
          await client.$executeRawUnsafe(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM ${SRC}.${q(t)}${where}`)
          expected[t] = where ? await countOf(client, SRC, t, where) : old[t]
          deleted[t] = (old[t] ?? 0) - expected[t]
        }
        if (mode === 'transactions') {
          for (const [t, column] of Object.entries(ZERO_STOCK_COLUMNS)) if (tables.includes(t)) await client.$executeRawUnsafe(`UPDATE main.${q(t)} SET ${q(column)} = 0`)
          // همگام‌سازی سایت خاموش می‌ماند تا مالک خودش روشن کند (معماری §۴-۲)
          const woo = await firstRow<{ v: string }>(client, `SELECT "value" AS v FROM main."Setting" WHERE "key" = ?`, WOO_CONFIG_SETTING_KEY)
          if (woo) {
            let cfg: unknown = null
            try { cfg = JSON.parse(String(woo.v)) } catch { cfg = null }
            if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg as { enabled?: unknown }).enabled === true)
              await client.$executeRawUnsafe(`UPDATE main."Setting" SET "value" = ? WHERE "key" = ?`, JSON.stringify({ ...(cfg as object), enabled: false }), WOO_CONFIG_SETTING_KEY)
          }
          // شمارهٔ فیش ادامه می‌یابد: شمارنده تا بیشینهٔ فیش‌های پیشین جلو می‌رود
          const seqRow = await firstRow<{ v: unknown }>(client, `SELECT "value" AS v FROM main."Setting" WHERE "key" = ?`, RECEIPT_SEQ_SETTING_KEY)
          const used = nextReceiptNo - 1
          if (used > seqOf(seqRow?.v)) {
            if (seqRow) await client.$executeRawUnsafe(`UPDATE main."Setting" SET "value" = ? WHERE "key" = ?`, String(used), RECEIPT_SEQ_SETTING_KEY)
            else { await client.$executeRawUnsafe(`INSERT INTO main."Setting" ("key", "value") VALUES (?, ?)`, RECEIPT_SEQ_SETTING_KEY, String(used)); expected.Setting += 1 }
          }
        } else {
          // شش فیلد چاپ سند اعتبار روی تنظیمات پیش‌فرض اعتبار؛ بقیهٔ تنظیمات اعتبار پیش‌فرض (طرح §۲۵-۱۰ بند «ج»)
          const credit = await firstRow<{ v: string }>(client, `SELECT "value" AS v FROM ${SRC}."Setting" WHERE "key" = ?`, CREDIT_SETTINGS_KEY)
          if (credit) {
            const before = parseCreditSettings(credit.v) as unknown as Record<string, unknown>
            const next: Record<string, unknown> = { ...DEFAULT_CREDIT_SETTINGS }
            for (const field of CREDIT_PRINT_FIELDS) next[field] = before[field]
            await client.$executeRawUnsafe(`INSERT INTO main."Setting" ("key", "value") VALUES (?, ?)`, CREDIT_SETTINGS_KEY, JSON.stringify(parseCreditSettings(next)))
            expected.Setting += 1
            deleted.Setting -= 1
          }
        }
        // شناسهٔ جدول‌های «می‌ماند» هرگز دوباره داده نمی‌شود (شمارندهٔ AUTOINCREMENT پیشین)
        if (oldTables.size) {
          const srcSeq = await client.$queryRawUnsafe<{ name: string; seq: unknown }[]>(`SELECT name, seq FROM ${SRC}.sqlite_sequence`).catch(() => [] as { name: string; seq: unknown }[])
          for (const row of srcSeq ?? []) {
            const t = String(row.name), seq = num(row.seq)
            if (!tables.includes(t) || resetFate(t, mode) === 'clear' || seq <= 0) continue
            const cur = await firstRow<{ seq: unknown }>(client, `SELECT seq FROM main.sqlite_sequence WHERE name = ?`, t)
            if (!cur) await client.$executeRawUnsafe(`INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)`, t, seq)
            else if (num(cur.seq) < seq) await client.$executeRawUnsafe(`UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?`, seq, t)
          }
        }
        await client.$executeRawUnsafe('COMMIT')
        committed = true
      } finally {
        if (!committed) await client.$executeRawUnsafe('ROLLBACK').catch(() => undefined)
      }

      const deletedRows = Object.values(deleted).reduce((sum, n) => sum + Math.max(0, n), 0)
      const headlines = headlinesFor(mode, old)
      await deps.audit(client, {
        action: AuditAction.FACTORY_RESET,
        entity: 'System',
        // «کامل» کاربران را پاک می‌کند؛ شناسهٔ کاربر قدیمی در پایگاه تازه نیست.
        userId: mode === 'transactions' ? ctx.userId : null,
        after: JSON.stringify({
          mode, at: ctx.at.toISOString(), backup: { id: ctx.backup.id, fileName: ctx.backup.fileName },
          deleted: Object.fromEntries(Object.entries(deleted).filter(([, n]) => n > 0)), deletedRows, zeroStockItems, nextReceiptNo
        }),
        note: mode === 'transactions' ? 'صفر کردن برنامه — فقط تراکنش‌ها' : 'صفر کردن برنامه — کامل'
      })
      expected.AuditLog = (expected.AuditLog ?? 0) + 1

      // ---- سنجش (هر ناهمخوانی ⇒ شکست؛ پایگاه قدیمی دست‌نخورده)
      const check = await client.$queryRawUnsafe<Record<string, unknown>[]>(`PRAGMA main.quick_check`)
      if (!(check?.length === 1 && Object.values(check[0]).some((v) => String(v).toLowerCase() === 'ok'))) throw new Error('quick_check failed')
      const broken = await client.$queryRawUnsafe<{ table: string; parent: string }[]>(`PRAGMA main.foreign_key_check`)
      if (broken?.length) {
        // فقط ارجاع شکستهٔ «تازه» شکست است؛ ناهمخوانی‌ای که در پایگاه قدیمی هم بود، با همان ردیف‌ها آمده است.
        const groups = new Map<string, number>()
        for (const r of broken) { const k = `${r.table}\u0000${r.parent}`; groups.set(k, (groups.get(k) ?? 0) + 1) }
        for (const [k, n] of groups) {
          const [t, parent] = k.split('\u0000')
          const before = (await client.$queryRawUnsafe<{ parent: string }[]>(`PRAGMA ${SRC}.foreign_key_check(${q(t)})`)).filter((r) => r.parent === parent).length
          if (n > before) throw new Error(`foreign_key_check: ${t} → ${parent}`)
        }
      }
      for (const t of tables) {
        const n = await countOf(client, 'main', t)
        if (n !== expected[t]) throw new Error(`count mismatch ${t}: ${n} != ${expected[t]}`)
      }
      if (mode === 'transactions' && (await zeroStockCount(client, 'main', (t) => tables.includes(t)))) throw new Error('stock not zero')
      if (mode === 'full') {
        const keys = (await client.$queryRawUnsafe<{ key: string }[]>(`SELECT "key" FROM main."Setting"`)).map((r) => String(r.key))
        const allowed = new Set([...FULL_KEEP_SETTING_KEYS, CREDIT_SETTINGS_KEY])
        if (keys.some((k) => !allowed.has(k))) throw new Error('unexpected setting key')
      }
      await client.$executeRawUnsafe(`DETACH DATABASE ${SRC}`)
      attached = false
      return { headlines, deletedRows, zeroStockItems, nextReceiptNo }
    } finally {
      if (attached) await client.$executeRawUnsafe(`DETACH DATABASE ${SRC}`).catch(() => undefined)
      await client.$disconnect().catch(() => undefined)
    }
  }

  /** ۱۲: جدا شدن Prisma، تغییر نام پایگاه قدیمی و نشاندن پایگاه تازه؛ هر شکست ⇒ برگرداندن نام‌ها. */
  async function swapDatabase(db: string, newFile: string, stamp: string): Promise<string> {
    const dir = dirname(db)
    let before = join(dir, `shop.before-reset-${stamp}.db`)
    for (let i = 2; existsSync(before); i++) before = join(dir, `shop.before-reset-${stamp}-${i}.db`)
    await deps.main.disconnect()
    const moved: Array<[string, string]> = []
    try {
      await renameRetry(db, before)
      moved.push([db, before])
      for (const ext of ['-journal', '-wal', '-shm']) {
        if (!existsSync(`${db}${ext}`)) continue
        await renameRetry(`${db}${ext}`, `${before}${ext}`)
        moved.push([`${db}${ext}`, `${before}${ext}`])
      }
      await renameRetry(newFile, db)
    } catch (error) {
      let restored = true
      for (const [from, to] of moved.reverse()) {
        try { await renameRetry(to, from) } catch { restored = false }
      }
      await deps.main.connect().catch(() => undefined)
      if (!restored) {
        console.error('[factory-reset] could not restore the database name', error)
        throw new BusinessError(`پروندهٔ داده به نام «${basename(before)}» تغییر کرد ولی برگرداندن نامش ممکن نشد. برنامه را ببندید و همین پیام را به پشتیبانی بدهید؛ هیچ داده‌ای پاک نشده است.`, UNRESTORED)
      }
      throw error
    }
    await deps.main.connect().catch(() => undefined)
    return basename(before)
  }

  return {
    /** پیش‌نمایش هر دو حالت: شمارش‌ها، بکاپ‌های محافظت‌شدهٔ قبلی، جای خالی و آخرین رسید (فقط خواندن). */
    async preview(): Promise<FactoryResetPreview> {
      const db = deps.databaseFile()
      const counts = await liveCounts()
      const present = (t: string) => Object.prototype.hasOwnProperty.call(counts, t)
      const zero = await zeroStockCount(null, '', present)
      const nextTx = present('SaleInvoice') ? await nextReceiptFrom({ $queryRawUnsafe: deps.main.query } as RawSqlClient, 'main', true) : 1
      const modes = {} as Record<ResetMode, FactoryResetModePreview>
      for (const mode of MODES) {
        let deletedRows = 0
        for (const [t, n] of Object.entries(counts)) if (resetFate(t, mode) === 'clear') deletedRows += n
        modes[mode] = { mode, headlines: headlinesFor(mode, counts), deletedRows, zeroStockItems: mode === 'transactions' ? zero : 0, nextReceiptNo: mode === 'transactions' ? nextTx : 1 }
      }
      const backups = (await deps.listBackups().catch(() => [])).filter((b) => PROTECTED_ID.test(String(b.id)) && !b.missing)
      return {
        modes,
        protectedBackups: { count: backups.length, bytes: backups.reduce((sum, b) => sum + num(b.size), 0) },
        space: await space(db),
        lastReset: await readLastReceipt()
      }
    },

    async run(input: { mode?: unknown; confirmText?: unknown; acknowledged?: unknown; managerPassword?: string | null; userId?: number | null } = {}): Promise<FactoryResetReceipt> {
      const mode = String(input?.mode ?? '') as ResetMode
      if (!MODES.has(mode)) throw new BusinessError('حالت صفر کردن را انتخاب کنید: «فقط تراکنش‌ها» یا «کامل».')
      if (!resetConfirmMatches(input?.confirmText)) throw new BusinessError('برای صفر کردن، واژهٔ «صفر» را تایپ کنید.')
      if (input?.acknowledged !== true) throw new BusinessError('تیک «می‌دانم برگشت فقط با بکاپ ممکن است» را بزنید.')
      if (done) throw new BusinessError('برنامه صفر شد و در حال باز شدن دوباره است.')
      if (running) throw new BusinessError('صفر کردن در جریان است؛ صبر کنید.')
      running = true
      try {
        const db = deps.databaseFile()
        const room = await space(db)
        if (room.freeBytes === null) throw new BusinessError('جای خالی دیسک سنجیده نشد؛ صفر کردن انجام نشد و هیچ چیزی پاک نشد.')
        if (!room.enough) throw new BusinessError(`برای صفر کردن دست‌کم ${mb(room.neededBytes)} جای خالی لازم است و اکنون ${mb(room.freeBytes)} هست؛ هیچ چیزی پاک نشد.`)
        // §۳-۸: بلیت یک‌بار همین لحظه مصرف می‌شود؛ شکست بعدی با همان بلیت دوباره اجرا نمی‌شود.
        await deps.authorize(input?.managerPassword ?? null)
        deps.clearTickets()
        try { await deps.beforeFactoryReset() } catch (error) { console.error('[factory-reset] messenger notice failed', error) }
        const at = deps.now()
        const stamp = fileStamp(at)
        const newFile = join(dirname(db), `shop.reset-new-${stamp}.db`)
        const userId = Number.isSafeInteger(input?.userId) ? input.userId as number : null
        let result: { backup: { id: string; fileName: string; size: number }; built: Awaited<ReturnType<typeof buildFreshDatabase>>; previous: string }
        let stopped = false
        try {
          result = (await deps.coordinate(async () => {
            stopped = true
            await deps.stopServices()
            // WAL را داخل پروندهٔ اصلی بنویس تا بکاپ و کپی کامل باشند (WAL در این برنامه خاموش است؛ احتیاط)
            await deps.main.query('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => null)
            const backup = await deps.protectedBackup(BACKUP_LABEL)
            const built = await buildFreshDatabase({ mode, oldFile: db, newFile, userId, backup, at })
            const previous = await swapDatabase(db, newFile, stamp)
            return { willRestart: true, resetMode: mode, backup, built, previous }
          })) as typeof result
        } catch (error) {
          await removeDbFile(newFile)
          if (stopped) try { deps.restartServices() } catch (e) { console.error('[factory-reset] restart services failed', e) }
          throw failure(error)
        }
        done = true
        const receipt: FactoryResetReceipt = {
          at: at.toISOString(),
          atJalali: `${toJalaliDate(at)} ${toClock(at, false)}`,
          mode,
          backup: { id: result.backup.id, fileName: result.backup.fileName, size: result.backup.size },
          previousDatabaseFile: result.previous,
          deleted: result.built.headlines,
          deletedRows: result.built.deletedRows,
          zeroStockItems: result.built.zeroStockItems,
          nextReceiptNo: result.built.nextReceiptNo
        }
        try {
          await mkdir(deps.backupsDir(), { recursive: true })
          await writeFile(receiptPath(), JSON.stringify(receipt, null, 2), 'utf8')
        } catch (error) { console.error('[factory-reset] receipt file not written', error) }
        relaunchTimer = setTimeout(() => deps.relaunch(), Math.max(0, deps.autoRelaunchMs))
        ;(relaunchTimer as { unref?: () => void }).unref?.()
        return receipt
      } finally {
        running = false
      }
    },

    /** دکمهٔ «برنامه همین حالا دوباره باز شود» در رسید؛ فقط پس از صفر کردن موفق. */
    relaunchNow(): { ok: boolean } {
      if (!done) return { ok: false }
      if (relaunchTimer) clearTimeout(relaunchTimer)
      relaunchTimer = null
      deps.relaunch()
      return { ok: true }
    }
  }
}

export type FactoryResetService = ReturnType<typeof createFactoryResetService>
