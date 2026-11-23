/**
 * طرح ۱۴۰۵ · مرحلهٔ ۸ — «صفر کردن برنامه» (معماری §۴-۲ و §۸-۲ بند ۱۴؛ معیار §۱۲: هر دو حالت و بازگردانی با اثر
 * انگشت روی پایگاه موقت).
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-factory-reset.mjs
 *
 * والد: آزمون‌های ایستا (طبقه‌بندی همهٔ مدل‌ها و جدول‌ها، متن‌ها، سیم‌کشی). سپس هر حالت در یک فرایند فرزند جدا
 * اجرا می‌شود (هارنس یک Prisma مشترک روی یک پایگاه دارد و پس از جابه‌جایی بسته می‌شود). هر فرزند دادهٔ واقع‌نما را
 * با خود سرویس‌ها می‌سازد، شکست هر مرحله را می‌آزماید («پایگاه قدیمی دست‌نخورده»)، سپس صفر می‌کند و پایگاه تازه،
 * پروندهٔ تغییرنام‌یافتهٔ قبلی و بکاپ محافظت‌شده را جدول‌به‌جدول با اثر انگشت می‌سنجد.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CHILD = process.env.PLAN1405_RESET_CHILD

let ok = 0
let bad = 0
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✓ ${label}`) } else { bad++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ---------------------------------------------------------------------------
// اثر انگشت جدول‌به‌جدول (node:sqlite؛ عدد بزرگ به‌صورت bigint، پس بی افت دقت)
// ---------------------------------------------------------------------------
const SYSTEM = new Set(['_prisma_migrations', 'sqlite_sequence'])
function openDb(file) { return new DatabaseSync(file) }
function tablesOf(db) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name).filter((n) => !SYSTEM.has(n) && !n.startsWith('sqlite_'))
}
function rowsOf(db, table) {
  const stmt = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
  stmt.setReadBigInts(true)
  return stmt.all()
}
const ser = (v) => typeof v === 'bigint' ? `n:${v}` : v instanceof Uint8Array ? `b:${Buffer.from(v).toString('hex')}` : v
const hashRows = (rows) => createHash('sha256').update(JSON.stringify(rows.map((r) => Object.entries(r).map(([k, v]) => [k, ser(v)])))).digest('hex')
function fingerprint(file, transform = {}) {
  const db = openDb(file)
  try {
    const out = {}
    for (const t of tablesOf(db)) {
      const rows = rowsOf(db, t).map((r) => (transform[t] ? transform[t](r) : r)).filter(Boolean)
      out[t] = { n: rows.length, h: hashRows(rows) }
    }
    return out
  } finally { db.close() }
}
const dropTimes = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/At$/.test(k)))

// ===========================================================================
// فرزند: یک حالت صفر کردن روی پایگاه موقت
// ===========================================================================
async function runChild(MODE) {
  const DIR = mkdtempSync(join(tmpdir(), `mahak-plan1405-reset-${MODE}-`))
  mkdirSync(join(DIR, 'data'), { recursive: true })
  process.env.HARNESS_DIR = DIR
  process.env.HARNESS_DB = join(DIR, 'data', 'shop.db')
  const DB = process.env.HARNESS_DB
  const DATA = join(DIR, 'data')

  const { harnessClient, PrismaClient } = await import('../../test/harness/stubs/prismaClient.mjs')
  const { makeSeeder } = await import('../../test/harness/seed.mjs')
  const db = harnessClient()
  const seed = makeSeeder(db)
  const sql = db.$harness.db
  const { databaseFile } = await import('../../src/main/db/client.ts')
  const { applyMigrations } = await import('../../src/main/db/migrator.ts')
  const { salesService } = await import('../../src/main/services/SalesService.ts')
  const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
  const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
  const { purchaseService } = await import('../../src/main/services/PurchaseService.ts')
  const { secondaryStockService } = await import('../../src/main/services/SecondaryStockService.ts')
  const { priceAdjustService } = await import('../../src/main/services/PriceAdjustService.ts')
  const { authService } = await import('../../src/main/services/AuthService.ts')
  const { createProtectedBackup, backupService, runBackup } = await import('../../src/main/services/BackupService.ts')
  const { summarizeBackup } = await import('../../src/main/services/MergeService.ts')
  const { setDesktopBackupHooks } = await import('../../src/main/services/cloud/desktopBackupCoordination.ts')
  const { addGateTicket, peekGateTicket } = await import('../../src/main/services/locks/tickets.ts')
  const { nextReceiptNo } = await import('../../src/main/services/receiptNo.ts')
  const { rename: fsRename } = await import('node:fs/promises')
  const { createFactoryResetService } = await import('../../src/main/services/reset/FactoryResetService.ts')
  const C = await import('../../src/main/services/reset/resetModelClassification.ts')
  const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
  const { DEFAULT_CREDIT_SETTINGS, parseCreditSettings } = await import('@shared/credit')
  const { toJalaliDate } = await import('@shared/jalali')

  console.log(`\n[${MODE}] ۱) دادهٔ واقع‌نما با خود سرویس‌ها`)
  check('databaseFile() همان پایگاه هارنس است', databaseFile() === DB)
  const PW = 'Reset-Test-1405'
  await authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
  const today = toJalaliDate(new Date())
  const userId = seed.user('صندوق‌دار آزمون صفر کردن')
  const seller2 = seed.user('فروشنده دوم')
  const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
  const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارتخوان', kind: 'CARD', isActive: 1, sortOrder: 2 })
  seed.insert('Warehouse', { name: 'انبار اصلی', isMain: 1 })
  seed.insert('SecondaryWarehouse', { name: 'انبار دوم آزمون', isDefault: 0, isActive: 1, sortOrder: 2 })
  const catWear = seed.category('پوشاک')
  const catCoat = seed.category('کت', catWear)
  const mk = (name, cat, price, stock) => {
    const id = seed.variant(seed.product(name, cat), name)
    sql.prepare('UPDATE "ProductVariant" SET stock = ?, salePrice = ?, purchasePrice = ? WHERE id = ?').run(stock, price, Math.round(price / 2), id)
    return id
  }
  const vA = mk('کت زمستانی', catCoat, 1_000_000, 50)
  const vB = mk('شلوار', catWear, 700_000, 40)
  const vC = mk('پیراهن', catWear, 400_000, 30)
  // ناهمخوانی ازپیش‌موجود در یک جدول «می‌ماند» (کالای بی دسته‌ی موجود): نباید صفر کردن را ببندد
  seed.insert('Product', { name: 'کالای یتیم آزمون', categoryId: 77777 })
  const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId, staffConfirmed: 1 })
  seed.insert('Supplier', { code: 'S-1405', name: 'تأمین‌کنندهٔ آزمون' })
  const debtor = { firstName: 'مشتری', lastName: 'صفر کردن', phone: '09120000077' }
  const L = (v, unitPrice, qty = 1) => ({ variantId: v, qty, unitPrice, discount: 0, tax: 0 })
  const pay = (methodId, amount, destination) => [{ methodId, amount, destination }]
  const sale = (lines, payments) => salesService.create({ debtor, userId, shiftId, lines, payments })
  const itemsOf = (id) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', id)
  const s1 = await sale([L(vA, 1_000_000)], pay(cash, 1_000_000, 'CASH'))
  await sale([L(vB, 700_000)], pay(card, 700_000, 'CARD'))
  const s3 = await sale([L(vC, 400_000)], [])
  await salesService.addPayment({ invoiceId: s3.id, kind: 'CHEQUE', amount: 400_000, chequeNo: 'R1405', bankName: 'ملت', dueDateJalali: today, userId })
  const s4 = await sale([L(vB, 700_000)], pay(cash, 700_000, 'CASH'))
  await salesService.createReturn({ invoiceId: s4.id, full: true, lines: [{ saleItemId: itemsOf(s4.id)[0].id, qty: 1 }], refundMethod: 'STORE_CREDIT', userId })
  const s5 = await sale([L(vA, 1_000_000)], pay(cash, 1_000_000, 'CASH'))
  await salesService.createExchange({ invoiceId: s5.id, userId, shiftId, lines: [{ saleItemId: itemsOf(s5.id)[0].id, qty: 1 }], replacements: [{ variantId: vB, qty: 1, unitPrice: 700_000 }], refundMode: 'CASH' }).catch(() => null)
  await storeCreditService.issueManual({ amount: 600_000, multiUse: true, maxUses: 3, carryRemainder: true, days: 30, userId, managerPassword: PW })
  await purchaseService.create({ settlementType: 'CASH', lines: [{ variantId: vC, qty: 5, unitPrice: 150_000 }], userId, panelPassword: PW })
  await secondaryStockService.upsert({ name: 'شلوار مرکزی', code: 'W-1405', qty: 12, minQty: 2, userId })
  await priceAdjustService.apply({ kind: 'DISCOUNT', mode: 'PERCENT', value: 10, scope: 'CATEGORY', categoryId: catCoat, target: 'SALE', userId, password: PW, note: 'آزمون صفر کردن' }).catch(() => null)
  const counted = await cashboxService.expected({ shiftId }).then((r) => Number(r?.expectedCash ?? 0)).catch(() => 0)
  await cashboxService.close({ shiftId, explicitShift: true, userId, countedCash: counted, closeShift: false, note: 'آزمون صفر کردن' }).catch(() => null)
  // جدول‌هایی که سرویسشان این‌جا لازم نیست، با ردیف کوچک (پیامک، سایت، کارمند، هدف، قفل رمز اشتباه)
  const link = seed.insert('WooProductLink', { variantId: vA, wooProductId: 501, holderKey: 'h-501', lastWooQty: 7, lastMahakQty: 50 })
  seed.insert('WooSyncOutbox', { linkId: link, variantId: vA, targetQty: 49, idempotencyKey: 'reset-test-1' })
  seed.insert('SmsProviderConfig', { name: 'آزمون', providerKey: 'LOG_ONLY', credentialsEncrypted: 'sealed:abc' })
  seed.insert('SmsTemplate', { code: 'RESET_TEST', title: 'آزمون', body: 'سلام' })
  seed.insert('SmsOptOut', { phone: '09120000099' })
  seed.insert('SmsOutbox', { dedupeKey: 'reset-test-sms', eventType: 'TEST', phoneSnapshot: '09120000088' })
  seed.insert('MgmtTarget', { monthJalali: today.slice(0, 7), userId: 0, amount: 90_000_000 })
  seed.insert('StaffProfile', { userId: seller2, jobTitle: 'فروشنده' })
  seed.insert('CustodyCredential', { userId: seller2, salt: 's', hash: 'h' })
  const plan = seed.insert('ShiftPlan', { title: 'صبح', startMinute: 480, durationMinutes: 360, daysMask: 127 })
  seed.insert('ShiftPlanStaff', { planId: plan, userId: seller2 })
  seed.insert('AuthLockout', { gate: `custody-pin:${seller2}`, failCount: 2 })
  seed.insert('AuthLockout', { gate: 'panel:products', failCount: 1 })
  // تنظیمات: همه‌جور کلید (می‌ماند، پاک می‌شود، ردپای تراکنش)
  seed.setting('receipt.template', { storeName: 'فروشگاه آزمون', copies: 2, printerName: 'XP-80' })
  seed.setting('label.template', { printerName: 'Zebra', widthMm: 40 })
  seed.setting('security.config', { lockoutEnabled: true, idleLockMinutes: 5 })
  seed.setting('panel.locks', { products: true, 'act-factory-reset': true })
  seed.setting('panel.auth', { products: { salt: 'x', hash: 'y', enabled: true } })
  seed.setting('credit.settings', { ...DEFAULT_CREDIT_SETTINGS, codeLength: 10, paper: 'A5', printFontPx: 14, printMarginXMm: 7, printMarginYMm: 3, customWidthMm: 120, customHeightMm: 160, rulesText: 'قانون فروشگاه آزمون' })
  seed.setting('credit.certificatePrinter', 'HP-LaserJet-Reset')
  seed.setting('credit.sellerReprintSeenAt', new Date().toISOString())
  seed.setting('shift.config', { mode: 'MULTI', shifts: [{ number: 1, from: '09:00', to: '17:00' }] })
  seed.setting('accounting.policy', { storeCreditLimit: 1234 })
  seed.setting('woo.sync.config.v1', { siteUrl: 'https://shop.example', enabled: true, autoSync: true, intervalSeconds: 120 })
  seed.setting('woo.sync.secret.v1', 'sealed-secret')
  seed.setting('woo.sync.cursor.v1', '55')
  seed.setting('mgmt.reconcileCursor', '4000')
  seed.setting('mgmt.reconcileBudgetMs', '6000')
  seed.setting('mgmt.lastReprice', { at: new Date().toISOString(), lots: 1 })
  seed.setting('debtReminder.log', [{ shiftId, at: Date.now() }])
  seed.setting('staff.active', String(userId))
  const maxReceipt = Number(seed.one('SELECT MAX(receiptNo) m FROM "SaleInvoice"').m)
  seed.setting('sale.receiptSeq', String(maxReceipt + 5))
  const counts0 = Object.fromEntries(['SaleInvoice', 'SaleReturn', 'Payment', 'StoreCredit', 'PurchaseInvoice', 'StockMovement', 'CashSession', 'AuditLog', 'CreditReturnAllocation', 'SecondaryStockItem', 'PriceChangeBatch'].map((t) => [t, seed.count(t)]))
  check('دادهٔ واقع‌نما ساخته شد (فروش، برگشت به اعتبار، چک، خرید، انبار مرکزی، صندوق، گزارش کار)',
    counts0.SaleInvoice >= 5 && counts0.SaleReturn >= 1 && counts0.StoreCredit >= 2 && counts0.PurchaseInvoice >= 1 && counts0.StockMovement > 0 && counts0.AuditLog > 0 && counts0.SecondaryStockItem >= 1, JSON.stringify(counts0))
  const expectedNextTx = Math.max(maxReceipt, maxReceipt + 5) + 1

  // ---- نصب تازه (همان migrator) برای سنجش جدول‌های «پاک می‌شود»
  const freshFile = join(DIR, 'fresh.db')
  new DatabaseSync(freshFile).close()
  { const c = new PrismaClient({ datasources: { db: { url: `file:${freshFile}?connection_limit=1` } } }); await applyMigrations(c, freshFile, { touchFile: false }); await c.$disconnect() }
  const fresh = fingerprint(freshFile, { CustodyState: dropTimes, SecondaryWarehouse: dropTimes })
  const migrationCount = readdirSync(join(ROOT, 'prisma', 'migrations')).filter((d) => existsSync(join(ROOT, 'prisma', 'migrations', d, 'migration.sql'))).length

  console.log(`\n[${MODE}] ۲) بکاپ محافظت‌شده: سنجیده، در فهرست، و پس از چند بکاپ خودکار هنوز هست`)
  const before = fingerprint(DB)
  const prot = await createProtectedBackup('آزمون محافظت')
  check('شناسهٔ بکاپ از نوع «واردشده» است (در فهرست بازگردانی می‌آید)', /^imported-\d+-factory-reset\.db$/.test(prot.id) && prot.path === join(DIR, 'backups', 'imported', prot.id))
  check('بکاپ محافظت‌شده دقیقاً همان پایگاه است (اثر انگشت همهٔ جدول‌ها)', JSON.stringify(fingerprint(prot.path)) === JSON.stringify(before))
  await backupService.saveConfig({ keep: 1, managerPassword: PW })
  for (let i = 0; i < 3; i++) { await runBackup(); await new Promise((r) => setTimeout(r, 1100)) }
  const autos = readdirSync(join(DIR, 'backups')).filter((f) => /^shop-.*\.db$/.test(f))
  check('چرخش بکاپ خودکار (keep=1) فقط یک بکاپ خودکار نگه داشت', autos.length === 1, autos.join(','))
  const listed = await backupService.list()
  check('پس از سه بکاپ خودکار، بکاپ محافظت‌شده هنوز روی دیسک و در فهرست است', existsSync(prot.path) && listed.some((e) => e.id === prot.id && e.source === 'imported' && !e.missing))
  check('بکاپ محافظت‌شده از راه فهرست پیدا می‌شود (همان راه بازگردانی)', (await backupService.resolve(prot.id)) === prot.path)
  check('بکاپ محافظت‌شده سنجش بکاپ برنامه را می‌گذراند', !!(await summarizeBackup(prot.path)))

  // ---- قلاب‌ها و ثبت فراخوانی‌ها
  const calls = []
  setDesktopBackupHooks({ before: (kind) => calls.push(`before:${kind}`), after: (o) => calls.push(`after:${o.ok}:${o.kind}:${o.result?.willRestart === true}`) })
  const stub = (extra = {}) => ({
    beforeFactoryReset: async () => { calls.push('notice') },
    stopServices: async () => { calls.push('stop') },
    restartServices: () => { calls.push('restart') },
    relaunch: () => { calls.push('relaunch') },
    main: { query: (q, ...v) => db.$queryRawUnsafe(q, ...v), disconnect: async () => { calls.push('disconnect') }, connect: async () => { calls.push('connect') } },
    autoRelaunchMs: 60_000,
    ...extra
  })
  const VALID = { mode: MODE, confirmText: 'صفر', acknowledged: true, managerPassword: PW, userId }
  const dataFiles = () => readdirSync(DATA).sort()
  const ledgerIds = () => JSON.parse(seed.one(`SELECT value FROM "Setting" WHERE key = 'backup.imports'`)?.value ?? '[]').map((r) => r.id)
  let baseline = fingerprint(DB)
  const untouched = (label, { ledgerGrows = false } = {}) => {
    const now = fingerprint(DB)
    const diff = Object.keys(baseline).filter((t) => JSON.stringify(now[t]) !== JSON.stringify(baseline[t]))
    const allowed = ledgerGrows ? ['Setting'] : []
    check(`${label}: پایگاه قدیمی دست‌نخورده`, diff.every((t) => allowed.includes(t)) && JSON.stringify(dataFiles()) === JSON.stringify(['shop.db']), `diff=${diff.join(',')} files=${dataFiles().join(',')}`)
    baseline = now
  }
  const rejects = async (label, promise, pattern) => {
    try { await promise; check(label, false, 'رد نشد') } catch (e) { check(label, pattern.test(String(e?.message ?? e)), String(e?.message ?? e).split('\n').slice(0, 2).join(' | ')) }
  }

  console.log(`\n[${MODE}] ۳) پیش‌نمایش (فقط خواندن)`)
  const pv = await createFactoryResetService(stub()).preview()
  const pm = pv.modes[MODE]
  check('پیش‌نمایش هر دو حالت را دارد', !!pv.modes.transactions && !!pv.modes.full)
  check('شمار فاکتورهای فروش در پیش‌نمایش درست است', pm.headlines.find((h) => h.table === 'SaleInvoice')?.count === seed.count('SaleInvoice'))
  check('شمار و حجم بکاپ‌های محافظت‌شدهٔ قبلی روی صفحه', pv.protectedBackups.count === 1 && pv.protectedBackups.bytes === prot.size)
  check('جای خالی سنجیده شد و کافی است', pv.space.enough === true && pv.space.neededBytes === 2 * pv.space.databaseBytes)
  check(`شمارهٔ فیش بعدی: «فقط تراکنش‌ها» ادامه (${expectedNextTx})، «کامل» از ۱`, pv.modes.transactions.nextReceiptNo === expectedNextTx && pv.modes.full.nextReceiptNo === 1)
  check('«کامل» کالا و مشتری را هم می‌شمارد، «فقط تراکنش‌ها» نه', pv.modes.full.headlines.some((h) => h.table === 'ProductVariant') && !pv.modes.transactions.headlines.some((h) => h.table === 'ProductVariant'))
  check('«فقط تراکنش‌ها» شمار کالاهایی را که موجودی‌شان صفر می‌شود می‌گوید', pv.modes.transactions.zeroStockItems === seed.count('ProductVariant', 'stock <> 0') + seed.count('SecondaryStockItem', 'qty <> 0'))
  check('پیش‌نمایش چیزی را عوض نکرد', JSON.stringify(fingerprint(DB)) === JSON.stringify(baseline))

  console.log(`\n[${MODE}] ۴) هر شکست ⇒ هیچ چیزی پاک نمی‌شود`)
  // شکست‌های عمدی این بخش در کنسول سرویس ثبت می‌شوند؛ این‌جا فقط شمرده می‌شوند تا خروجی آزمون خوانا بماند
  const realError = console.error
  let resetErrorLogs = 0
  console.error = (...args) => { if (String(args[0]).startsWith('[factory-reset]')) resetErrorLogs++; else realError(...args) }
  const noGate = { authorize: async () => { calls.push('authorize') } }
  calls.length = 0
  await rejects('تایپ اشتباه «صفر» رد می‌شود', createFactoryResetService(stub()).run({ ...VALID, confirmText: 'سفر' }), /«صفر»/)
  await rejects('بی تیک «می‌دانم…» رد می‌شود', createFactoryResetService(stub()).run({ ...VALID, acknowledged: false }), /می‌دانم/)
  await rejects('حالت نامعتبر رد می‌شود', createFactoryResetService(stub()).run({ ...VALID, mode: 'all' }), /حالت/)
  await rejects('جای خالی کمتر از دو برابر ⇒ رد پیش از دروازه', createFactoryResetService(stub({ freeBytes: async () => 10 })).run(VALID), /جای خالی/)
  await rejects('جای خالیِ سنجیده‌نشده ⇒ رد', createFactoryResetService(stub({ freeBytes: async () => { throw new Error('statfs') } })).run(VALID), /سنجیده نشد/)
  check('پیش از دروازه: نه پیام پیام‌رسان، نه توقف سرویس‌ها، نه قلاب', calls.length === 0, calls.join(','))
  untouched('ورودی نادرست یا جای کم')
  await rejects('رمز اشتباه ⇒ دروازه رد می‌کند', createFactoryResetService(stub()).run({ ...VALID, managerPassword: 'wrong-pass' }), /رمز/)
  check('رمز اشتباه: پیام «آغاز شد» نرفت و کار شروع نشد', !calls.includes('notice') && !calls.some((c) => c.startsWith('before:')), calls.join(','))
  baseline = fingerprint(DB) // شمارندهٔ رمز اشتباه (AuthLockout) کار خود دروازه است
  check('بلیت یک‌بار پیش از کار پاک می‌شود (پنجره‌های دیگر هم)', addGateTicket(7, 'backup.forget', 60_000, 'PASSWORD') && !!peekGateTicket(7, 'backup.forget'))

  calls.length = 0
  await rejects('شکست بکاپ محافظت‌شده', createFactoryResetService(stub({ ...noGate, protectedBackup: async () => { throw new Error('disk full') } })).run(VALID), /هیچ چیزی پاک نشد/)
  check('بلیت‌ها با شروع کار پاک شدند', !peekGateTicket(7, 'backup.forget'))
  check('ترتیب: پیام ⚠️، قلاب before(reset)، توقف سرویس‌ها، سپس پس از شکست after(ok=false) و روشن شدن دوبارهٔ سرویس‌ها',
    calls.join(',') === 'authorize,notice,before:reset,stop,after:false:reset:false,restart', calls.join(','))
  untouched('شکست بکاپ')
  const ledger0 = ledgerIds().length
  const open = (file) => new PrismaClient({ datasources: { db: { url: `file:${file}?connection_limit=1` } } })
  const failing = [
    ['شکست migrator', { migrate: async () => { throw new Error('migration boom') } }],
    // میانهٔ کپی: کپی Setting (در هر دو حالت) پس از چند جدول دیگر می‌شکند ⇒ ROLLBACK
    ['شکست میانهٔ کپی (ROLLBACK)', { openClient: (file) => { const c = open(file); const exec = c.$executeRawUnsafe; c.$executeRawUnsafe = async (q, ...v) => { if (/^INSERT INTO main\."Setting"/.test(q)) throw new Error('copy boom'); return exec(q, ...v) }; return c } }],
    ['quick_check ناموفق', { openClient: (file) => { const c = open(file); const query = c.$queryRawUnsafe; c.$queryRawUnsafe = async (q, ...v) => (/quick_check/.test(q) ? [{ quick_check: 'page 3 corrupt' }] : query(q, ...v)); return c } }],
    // ارجاع شکستهٔ تازه: پیش از COMMIT یک کالای کپی‌شده به کالای ناموجود اشاره می‌کند (شمار ردیف‌ها همان)
    ['ارجاع شکستهٔ تازه (foreign_key_check)', { openClient: (file) => { const c = open(file); const exec = c.$executeRawUnsafe; c.$executeRawUnsafe = async (q, ...v) => { if (q === 'COMMIT') await exec(`UPDATE main."ProductVariant" SET "productId" = 88888 WHERE "id" = (SELECT MIN("id") FROM main."ProductVariant")`); return exec(q, ...v) }; return c } }],
    ['شکست تغییر نام پایگاه قدیمی', { rename: async () => { const e = new Error('EIO'); e.code = 'EIO'; throw e } }],
    ['شکست نشاندن پایگاه تازه (برگرداندن نام قدیمی)', (() => { let n = 0; return { rename: async (a, b) => { if (++n === 2) { const e = new Error('EIO'); e.code = 'EIO'; throw e } return fsRename(a, b) } } })()]
  ]
  for (const [label, extra] of failing) {
    if (MODE === 'full' && /foreign_key_check/.test(label)) continue // در «کامل» کالاها پاک می‌شوند؛ همین آزمون در «فقط تراکنش‌ها»
    calls.length = 0
    await rejects(label, createFactoryResetService(stub({ ...noGate, ...extra })).run(VALID), /هیچ چیزی پاک نشد/)
    check(`${label}: قلاب after(ok=false) و روشن شدن دوبارهٔ سرویس‌ها`, calls.includes('after:false:reset:false') && calls.includes('restart'), calls.join(','))
    if (/تغییر نام|نشاندن/.test(label)) check(`${label}: Prisma دوباره وصل شد`, calls.includes('disconnect') && calls.includes('connect'))
    untouched(label, { ledgerGrows: true })
  }
  check('هر شکستِ پس از بکاپ، بکاپ محافظت‌شدهٔ خودش را در فهرست گذاشت', ledgerIds().length - ledger0 === failing.filter(([l]) => !(MODE === 'full' && /foreign_key_check/.test(l))).length)
  check('هیچ پروندهٔ تازه یا تغییرنام‌یافته‌ای در پوشهٔ داده نماند', JSON.stringify(dataFiles()) === JSON.stringify(['shop.db']))
  console.error = realError
  check('هر شکست پس از دروازه در کنسول ثبت شد (متن فنی فقط آن‌جا)', resetErrorLogs >= failing.length)

  console.log(`\n[${MODE}] ۵) صفر کردن واقعی`)
  calls.length = 0
  addGateTicket(9, 'credit.void', 60_000, 'PASSWORD')
  // «فقط تراکنش‌ها»: نخستین تغییر نام یک بار EBUSY می‌دهد (مثل ویندوز وقتی پرسشی هم‌زمان Prisma را دوباره وصل کرده)
  let renames = 0
  const busyOnce = MODE === 'transactions' ? { rename: async (a, b) => { if (++renames === 1) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e } return fsRename(a, b) } } : {}
  const svc = createFactoryResetService({ ...stub(busyOnce), main: { query: (q, ...v) => db.$queryRawUnsafe(q, ...v), disconnect: async () => { calls.push('disconnect'); await db.$disconnect() }, connect: async () => { calls.push('connect') } } })
  let receipt = null
  try { receipt = await svc.run(VALID) } catch (e) { check('صفر کردن انجام شد', false, String(e?.message ?? e)) }
  if (!receipt) { console.log(`RESULT ${JSON.stringify({ ok, bad })}`); process.exit(1) }
  check('صفر کردن انجام شد', true)
  const wantCalls = `notice,before:reset,stop,disconnect,${MODE === 'transactions' ? 'disconnect,' : ''}disconnect,connect,after:true:reset:true`
  check(MODE === 'transactions'
    ? 'ترتیب: پیام ⚠️، before(reset)، توقف، جدا شدن Prisma، EBUSY ⇒ جدا شدن دوباره و تلاش دوباره، جدا شدن پایانی و اتصال، after(ok, willRestart)'
    : 'ترتیب: پیام ⚠️، before(reset)، توقف، جدا شدن Prisma، جدا شدن پایانی و اتصال، after(ok, willRestart)', calls.join(',') === wantCalls, calls.join(','))
  check('همهٔ بلیت‌های یک‌بار پاک شدند', !peekGateTicket(9, 'credit.void'))
  check('هنوز باز شدن دوباره نیامده (منتظر دکمه یا ۶۰ ثانیه)', !calls.includes('relaunch'))
  check('دکمهٔ «همین حالا دوباره باز شود» کار می‌کند', svc.relaunchNow().ok === true && calls.filter((c) => c === 'relaunch').length === 1)
  await rejects('صفر کردن دوم پیش از باز شدن دوباره رد می‌شود', svc.run(VALID), /دوباره است/)
  const files = dataFiles()
  const prevName = files.find((f) => /^shop\.before-reset-.*\.db$/.test(f))
  check('پایگاه قدیمی پاک نشد؛ فقط تغییر نام گرفت (shop.before-reset-…)', !!prevName && receipt.previousDatabaseFile === prevName && files.length === 2 && files.includes('shop.db'), files.join(','))
  const PREV = join(DATA, prevName)
  const BACKUP = join(DIR, 'backups', 'imported', receipt.backup.id)
  const prev = fingerprint(PREV)
  const bk = fingerprint(BACKUP)
  const nw = fingerprint(DB, { CustodyState: dropTimes, ...(MODE === 'full' ? { SecondaryWarehouse: dropTimes } : {}) })
  const nwRaw = openDb(DB)
  const prevDb = openDb(PREV)
  const settingRows = (d) => Object.fromEntries(d.prepare('SELECT key, value FROM "Setting" ORDER BY key').all().map((r) => [r.key, r.value]))
  const prevSet = settingRows(prevDb)
  const newSet = settingRows(nwRaw)
  check('بکاپ پیش از صفر کردن همان پایگاه قدیمی است (جز ردیف فهرست خودش)', Object.keys(prev).every((t) => t === 'Setting' || JSON.stringify(prev[t]) === JSON.stringify(bk[t])),
    Object.keys(prev).filter((t) => t !== 'Setting' && JSON.stringify(prev[t]) !== JSON.stringify(bk[t])).join(','))
  check('فهرست بکاپ پایگاه قدیمی و تازه، بکاپ «پیش از صفر کردن» را دارد', JSON.parse(prevSet['backup.imports']).some((r) => r.id === receipt.backup.id && /^پیش از صفر کردن – /.test(r.fileName)) && JSON.parse(newSet['backup.imports']).some((r) => r.id === receipt.backup.id))
  check('رسید: حالت، نام بکاپ، شمار پاک‌شده و شمارهٔ فیش بعدی', receipt.mode === MODE && receipt.backup.fileName.startsWith('پیش از صفر کردن – ') && receipt.deleted.find((d) => d.table === 'SaleInvoice')?.count === prev.SaleInvoice.n && receipt.nextReceiptNo === (MODE === 'transactions' ? expectedNextTx : 1))
  const savedReceipt = JSON.parse(readFileSync(join(DIR, 'backups', 'last-factory-reset.json'), 'utf8'))
  check('رسید پایانی بیرون از پایگاه داده هم ماند (last-factory-reset.json)', savedReceipt.backup.id === receipt.backup.id && savedReceipt.mode === MODE)

  console.log(`\n[${MODE}] ۶) پایگاه تازه، جدول‌به‌جدول`)
  const zero = (col) => (r) => ({ ...r, [col]: 0n })
  const wrong = []
  for (const t of Object.keys(nw)) {
    const fate = C.resetFate(t, MODE)
    let want
    if (!fate) { wrong.push(`${t}:unclassified`); continue }
    if (t === 'AuditLog' || t === 'Setting' || (t === 'AuthLockout' && fate === 'keepSome')) continue
    if (fate === 'clear') want = fresh[t]
    else if (fate === 'keep') want = prev[t]
    else if (fate === 'keepZeroStock') want = fingerprint(PREV, { [t]: zero(C.ZERO_STOCK_COLUMNS[t]) })[t]
    if (JSON.stringify(nw[t]) !== JSON.stringify(want)) wrong.push(`${t}:${fate}(${nw[t]?.n}/${want?.n})`)
  }
  check(`هر جدول «می‌ماند» همان قبلی و هر جدول «پاک می‌شود» همان نصب تازه است (${Object.keys(nw).length} جدول)`, wrong.length === 0, wrong.join(' '))
  check('پایگاه تازه همهٔ جدول‌های نصب تازه را دارد', JSON.stringify(Object.keys(nw).sort()) === JSON.stringify(Object.keys(fresh).sort()))
  const audits = nwRaw.prepare('SELECT action, entity, userId, after, note FROM "AuditLog"').all()
  const after = audits[0] ? JSON.parse(audits[0].after) : {}
  check('AuditLog تازه فقط یک ردیف FACTORY_RESET دارد، با حالت، نام بکاپ و شمار پاک‌شده', audits.length === 1 && audits[0].action === 'FACTORY_RESET' && after.mode === MODE && after.backup?.id === receipt.backup.id && after.deleted?.SaleInvoice === prev.SaleInvoice.n)
  check(MODE === 'transactions' ? 'ردیف صفر کردن به نام کاربر انجام‌دهنده است' : '«کامل»: ردیف صفر کردن بی کاربر (کاربران پاک شدند)', MODE === 'transactions' ? audits[0]?.userId === userId : audits[0]?.userId === null)
  check('quick_check پایگاه تازه: ok', nwRaw.prepare('PRAGMA quick_check').all()[0]?.quick_check === 'ok')
  const fk = nwRaw.prepare('PRAGMA foreign_key_check').all()
  check(MODE === 'transactions' ? 'foreign_key_check: فقط همان ناهمخوانی ازپیش‌موجود (کالای یتیم)' : 'foreign_key_check: هیچ ارجاع شکسته‌ای', MODE === 'transactions' ? fk.length === 1 && fk[0].table === 'Product' : fk.length === 0, JSON.stringify(fk))
  check('migrationها در پایگاه تازه ثبت شده‌اند (شروع بعدی چیزی اجرا نمی‌کند)', nwRaw.prepare('SELECT COUNT(*) n FROM "_prisma_migrations"').get().n === migrationCount)
  const seqOf = (d) => Object.fromEntries(d.prepare('SELECT name, seq FROM sqlite_sequence').all().map((r) => [r.name, Number(r.seq)]))
  const prevSeq = seqOf(prevDb), newSeq = seqOf(nwRaw)
  const seqBad = Object.keys(prevSeq).filter((t) => C.resetFate(t, MODE) && C.resetFate(t, MODE) !== 'clear' && (newSeq[t] ?? 0) < prevSeq[t])
  check('شناسهٔ جدول‌های «می‌ماند» دوباره داده نمی‌شود (شمارندهٔ AUTOINCREMENT)', seqBad.length === 0, seqBad.join(','))

  if (MODE === 'transactions') {
    const wantKeys = Object.keys(prevSet).filter((k) => !C.TRANSACTION_STATE_SETTING_KEYS.includes(k)).sort()
    check('تنظیمات: همه ماندند جز ردپای کارهای پاک‌شده', JSON.stringify(Object.keys(newSet).sort()) === JSON.stringify(wantKeys), Object.keys(newSet).sort().join(','))
    const changed = wantKeys.filter((k) => newSet[k] !== prevSet[k])
    check('فقط دو تنظیم عوض شد: همگام‌سازی سایت خاموش و شمارندهٔ فیش', JSON.stringify(changed.sort()) === JSON.stringify(['woo.sync.config.v1']) || JSON.stringify(changed.sort()) === JSON.stringify(['sale.receiptSeq', 'woo.sync.config.v1']), changed.join(','))
    const woo = JSON.parse(newSet['woo.sync.config.v1'])
    check('همگام‌سازی سایت خاموش ماند؛ آدرس، بازه و کلید اتصال همان', woo.enabled === false && woo.autoSync === true && woo.siteUrl === 'https://shop.example' && newSet['woo.sync.secret.v1'] === 'sealed-secret' && newSet['woo.sync.cursor.v1'] === '55')
    check('زمان‌بند سایت فقط با enabled و autoSync کار می‌کند ⇒ پس از شروع دوباره هیچ درخواست Woo', /if \(cfg\.enabled && cfg\.autoSync\)/.test(read('src/main/services/WooSyncService.ts')))
    check('شمارندهٔ فیش تا بیشینه ماند', Number(newSet['sale.receiptSeq']) === expectedNextTx - 1)
    check('موجودی فروشگاه و انبار مرکزی صفر شد؛ کالا، قیمت و بارکد همان',
      nwRaw.prepare('SELECT COUNT(*) n FROM "ProductVariant" WHERE stock <> 0').get().n === 0 && nwRaw.prepare('SELECT COUNT(*) n FROM "SecondaryStockItem" WHERE qty <> 0').get().n === 0 &&
      JSON.stringify(nwRaw.prepare('SELECT id, code, barcode, salePrice FROM "ProductVariant" ORDER BY id').all()) === JSON.stringify(prevDb.prepare('SELECT id, code, barcode, salePrice FROM "ProductVariant" ORDER BY id').all()))
    check('اتصال کالا به سایت ماند و صف ارسال به سایت خالی شد', nw.WooProductLink.n === 1 && nw.WooSyncOutbox.n === 0)
    check('قفل‌های رمز اشتباه همه ماندند', JSON.stringify(nw.AuthLockout) === JSON.stringify(prev.AuthLockout))
  } else {
    const kept = C.FULL_KEEP_SETTING_KEYS.filter((k) => prevSet[k] !== undefined)
    check('«کامل»: فقط کلیدهای نام‌بردهٔ Setting به‌علاوهٔ تنظیمات اعتبار', JSON.stringify(Object.keys(newSet).sort()) === JSON.stringify([...kept, 'credit.settings'].sort()), Object.keys(newSet).sort().join(','))
    check('تنظیمات چاپ، قالب فاکتور، چاپگر گواهی، قفل‌ها، رمزهای دوم و security.config همان مقدار پیش', kept.every((k) => newSet[k] === prevSet[k]) && kept.includes('receipt.template') && kept.includes('label.template') && kept.includes('security.config') && kept.includes('credit.certificatePrinter') && kept.includes('manager.auth'))
    check('شمارندهٔ «تازه»ی چاپ دوباره و ساعت شیفت‌ها نماندند', newSet['credit.sellerReprintSeenAt'] === undefined && newSet['shift.config'] === undefined && newSet['sale.receiptSeq'] === undefined)
    const cs = JSON.parse(newSet['credit.settings']), old = parseCreditSettings(prevSet['credit.settings'])
    check('شش فیلد چاپ سند اعتبار همان پیش، بقیهٔ تنظیمات اعتبار پیش‌فرض', C.CREDIT_PRINT_FIELDS.every((f) => cs[f] === old[f]) && cs.codeLength === DEFAULT_CREDIT_SETTINGS.codeLength && cs.rulesText === DEFAULT_CREDIT_SETTINGS.rulesText && old.codeLength === 10)
    const locks = nwRaw.prepare('SELECT gate FROM "AuthLockout" ORDER BY gate').all().map((r) => r.gate)
    check('قفل رمز اشتباهِ کاربرِ پاک‌شده نماند؛ بقیه ماندند', !locks.some((g) => g.startsWith('custody-pin:')) && locks.includes('panel:products'), locks.join(','))
  }
  // شمارهٔ فیش بعدی از همان تابع برنامه، روی پایگاه تازه
  const nc = new PrismaClient({ datasources: { db: { url: `file:${DB}?connection_limit=1` } } })
  check(`شمارهٔ فیش بعدی با تابع خود برنامه: ${MODE === 'transactions' ? expectedNextTx : 1}`, (await nextReceiptNo(nc)) === (MODE === 'transactions' ? expectedNextTx : 1))
  await nc.$disconnect()
  nwRaw.close(); prevDb.close()

  console.log(`\n[${MODE}] ۷) بازگردانی بکاپ «پیش از صفر کردن» (همان کپی جایگزینی کامل)`)
  await runBackup()
  check('بکاپ خودکار پس از صفر کردن، بکاپ محافظت‌شده را پاک نمی‌کند', existsSync(BACKUP) && existsSync(prot.path))
  copyFileSync(BACKUP, DB)
  const restored = fingerprint(DB)
  check('پس از بازگردانی، همهٔ جدول‌ها دقیقاً همان پیش از صفر کردن‌اند (اثر انگشت)', Object.keys(prev).every((t) => t === 'Setting' || JSON.stringify(restored[t]) === JSON.stringify(prev[t])) && JSON.stringify(Object.keys(restored).sort()) === JSON.stringify(Object.keys(prev).sort()))
  check('پس از بازگردانی، فروش‌ها، اعتبارها و موجودی سر جایشان‌اند', restored.SaleInvoice.n === counts0.SaleInvoice && restored.StoreCredit.n === counts0.StoreCredit && JSON.stringify(restored.ProductVariant) === JSON.stringify(prev.ProductVariant))
  check('پایگاه بازگشته سنجش بکاپ برنامه را می‌گذراند', !!(await summarizeBackup(DB)))
  setDesktopBackupHooks(undefined)
  rmSync(DIR, { recursive: true, force: true })
  console.log(`RESULT ${JSON.stringify({ ok, bad })}`)
  process.exit(bad ? 1 : 0)
}

// ===========================================================================
// والد: آزمون‌های ایستا و دو فرزند
// ===========================================================================
async function runParent() {
  const C = await import('../../src/main/services/reset/resetModelClassification.ts')
  const { RECEIPT_SEQ_KEY } = await import('../../src/main/services/receiptNo.ts')
  const { WOO_SYNC_SETTING_KEY } = await import('@shared/wooSync')
  const { DEFAULT_CREDIT_SETTINGS } = await import('@shared/credit')

  console.log('\n۱) طبقه‌بندی همهٔ مدل‌ها و جدول‌ها')
  const models = [...read('prisma/schema.prisma').matchAll(/^model (\w+) \{/gm)].map((m) => m[1])
  const dir = mkdtempSync(join(tmpdir(), 'mahak-plan1405-reset-static-'))
  const file = join(dir, 'fresh.db')
  const fdb = new DatabaseSync(file)
  fdb.exec('PRAGMA foreign_keys = OFF')
  const migDir = join(ROOT, 'prisma', 'migrations')
  for (const d of readdirSync(migDir).sort()) { const f = join(migDir, d, 'migration.sql'); if (existsSync(f)) fdb.exec(readFileSync(f, 'utf8')) }
  const tables = tablesOf(fdb)
  fdb.close(); rmSync(dir, { recursive: true, force: true })
  const rules = C.RESET_TABLE_RULES
  check(`هر ۸۰ مدل schema.prisma طبقه دارد (${models.length})`, models.length === 80 && models.every((m) => rules[m]), models.filter((m) => !rules[m]).join(','))
  check(`هر جدول نصب تازه طبقه دارد (${tables.length})`, tables.every((t) => rules[t]), tables.filter((t) => !rules[t]).join(','))
  check('طبقهٔ جدولِ ناموجود نیست', Object.keys(rules).every((t) => tables.includes(t)), Object.keys(rules).filter((t) => !tables.includes(t)).join(','))
  const FATES = ['keep', 'keepZeroStock', 'keepSome', 'clear']
  check('هر طبقه هر دو حالت و دلیل دارد', Object.values(rules).every((r) => FATES.includes(r.transactions) && FATES.includes(r.full) && r.why.length > 3))
  check('«موجودی صفر» فقط فروشگاه و انبار مرکزی، فقط در «فقط تراکنش‌ها»', Object.entries(rules).filter(([, r]) => r.transactions === 'keepZeroStock' || r.full === 'keepZeroStock').map(([t]) => t).sort().join(',') === Object.keys(C.ZERO_STOCK_COLUMNS).sort().join(',') && Object.values(rules).every((r) => r.full !== 'keepZeroStock'))
  check('«فقط ردیف‌های نام‌برده» فقط Setting و (در «کامل») AuthLockout', Object.entries(rules).filter(([, r]) => r.transactions === 'keepSome' || r.full === 'keepSome').map(([t]) => t).sort().join(',') === 'AuthLockout,Setting' && rules.AuthLockout.transactions === 'keep')
  check('«کامل» هیچ جدولی جز Setting و AuthLockout نگه نمی‌دارد', Object.entries(rules).every(([t, r]) => r.full === 'clear' || ['Setting', 'AuthLockout'].includes(t)))
  check('تراکنش‌ها در هر دو حالت پاک می‌شوند', ['SaleInvoice', 'SaleReturn', 'Payment', 'PurchaseInvoice', 'StoreCredit', 'CreditReturnAllocation', 'CashSession', 'CashMovement', 'Shift', 'Consolidation', 'StockMovement', 'AuditLog', 'SmsOutbox', 'CostEngineState'].every((t) => rules[t].transactions === 'clear' && rules[t].full === 'clear'))
  check('«فقط تراکنش‌ها» کالا، دسته، مشتری، کاربر و تنظیمات را نگه می‌دارد', ['Product', 'Category', 'Customer', 'User', 'PaymentMethod', 'Warehouse', 'StaffProfile'].every((t) => rules[t].transactions === 'keep') && rules.ProductVariant.transactions === 'keepZeroStock' && rules.Setting.transactions === 'keepSome')
  check('کلیدهای «کامل» همان فهرست معماری §۴-۲ (به‌علاوهٔ چاپگر گواهی مورد ۱۲)', JSON.stringify([...C.FULL_KEEP_SETTING_KEYS].sort()) === JSON.stringify(['backup.config', 'backup.imports', 'credit.certificatePrinter', 'label.template', 'manager.auth', 'panel.auth', 'panel.locks', 'receipt.template', 'security.config']))
  check('«کامل»: credit.sellerReprintSeenAt و shift.config نمی‌مانند', !C.FULL_KEEP_SETTING_KEYS.includes('credit.sellerReprintSeenAt') && !C.FULL_KEEP_SETTING_KEYS.includes('shift.config'))
  check('شش فیلد چاپ سند اعتبار، همه در تنظیمات پیش‌فرض اعتبار', C.CREDIT_PRINT_FIELDS.length === 6 && C.CREDIT_PRINT_FIELDS.every((f) => f in DEFAULT_CREDIT_SETTINGS))
  check('کلید شمارندهٔ فیش و تنظیم سایت همان کلیدهای برنامه', C.RECEIPT_SEQ_SETTING_KEY === RECEIPT_SEQ_KEY && C.WOO_CONFIG_SETTING_KEY === WOO_SYNC_SETTING_KEY)
  check('ردپاهای پاک‌شونده هیچ تنظیم واقعی (رمز، فهرست بکاپ، شمارندهٔ فیش، سایت) را نمی‌گیرند', !C.TRANSACTION_STATE_SETTING_KEYS.some((k) => ['manager.auth', 'backup.imports', 'sale.receiptSeq', 'woo.sync.config.v1', 'woo.sync.secret.v1', 'panel.locks', 'receipt.template'].includes(k)))

  console.log('\n۲) تأیید تایپی «صفر»')
  check('«صفر» پذیرفته می‌شود، با فاصله و نیم‌فاصله هم', C.resetConfirmMatches('صفر') && C.resetConfirmMatches(' ص\u200cفر ') && C.resetConfirmMatches('\u200fصفر'))
  check('واژه‌های دیگر رد می‌شوند', !C.resetConfirmMatches('سفر') && !C.resetConfirmMatches('صفر۰') && !C.resetConfirmMatches('') && !C.resetConfirmMatches(null))
  check('«ي/ی»، «ك/ک» و رقم فارسی و عربی یکسان شمرده می‌شوند', C.normalizeResetConfirm('كي ۱۲٣') === 'کی123')

  console.log('\n۳) سیم‌کشی (متن پرونده‌ها)')
  const svc = read('src/main/services/reset/FactoryResetService.ts')
  const code = svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('پایگاه تازه با migrator خود برنامه؛ هرگز prisma migrate reset، هرگز salePurge', /applyMigrations\(/.test(code) && !/migrate reset/.test(code) && !/salePurge/.test(code))
  check('هیچ DELETE یا UPDATE روی پایگاه قدیمی (فقط main.)', !/(DELETE FROM|UPDATE|INSERT INTO) \$\{SRC\}/.test(code) && /DELETE FROM main\./.test(code))
  check('دروازه: قفل کار system.factory-reset دور assertManagerPassword', /gateAction\('system\.factory-reset', async \(\) => await assertManagerPassword\(/.test(code))
  check('هماهنگی هاب و پیام‌رسان با نوع reset', /withDesktopBackupCoordination\(operation, 'reset'\)/.test(code))
  check('بکاپ محافظت‌شده، توقف سایت و صف پیامک، سنجش و تغییر نام با -journal/-wal/-shm', /createProtectedBackup\(/.test(code) && /stopWooSyncScheduler\(\)/.test(code) && /stopSmsQueue\(\)/.test(code) && /quick_check/.test(code) && /foreign_key_check/.test(code) && /shop\.before-reset-/.test(code) && /'-journal', '-wal', '-shm'/.test(code))
  check('جای خالی پیش از دروازه سنجیده می‌شود، و بلیت‌ها پس از دروازه پاک', code.indexOf('room.enough') < code.indexOf('deps.authorize(') && code.indexOf('deps.authorize(') < code.indexOf('deps.clearTickets()'))
  const backup = read('src/main/services/BackupService.ts')
  check('BackupService: فقط تابع تازهٔ createProtectedBackup (importedDir، summarizeBackup، ردیف فهرست)', /export async function createProtectedBackup\(/.test(backup) && /await summarizeBackup\(target\)/.test(backup))
  check('WooSyncService: تابع توقف تا پایان دور جاری صبر می‌کند', /export async function stopWooSyncScheduler\(/.test(read('src/main/services/WooSyncService.ts')))
  const coord = read('src/main/services/cloud/desktopBackupCoordination.ts')
  check('هماهنگی بکاپ: نوع کار به قلاب‌ها می‌رسد و صفر کردن با بکاپ هم‌زمان نمی‌شود', /hooks\?\.before\(kind\)/.test(coord) && /hooks\?\.after\(\{\.\.\.outcome,kind\}\)/.test(coord) && /resetActive/.test(coord))
  check('پیام‌رسان: قلاب‌ها reset را از backup جدا می‌کنند', /kind === 'reset' \? 'reset' : 'backup'/.test(read('src/main/services/cloud/messenger/messengerRuntime.ts')))
  const ipc = read('src/main/ipc/index.ts')
  check('IPC: کانال‌های صفر کردن ثبت شد و پس از بازگردانی و ادغام همهٔ بلیت‌ها پاک می‌شوند', /registerFactoryResetHandlers\(handle,/.test(ipc) && /backupService\.apply\(input\)\)\n\s+\/\/[^\n]*\n\s+clearGateTickets\(\)/.test(ipc))
  check('پیام ⚠️ «صفر کردن آغاز شد» از موتور پیام‌رسان', /beforeFactoryReset: \(\) => messengerEngine\(\)\.beforeFactoryReset\(\)/.test(read('src/main/services/reset/factoryResetIpc.ts')))
  const shared = read('src/shared/ipc.ts')
  check('سه کانال تازه در قرارداد مشترک IPC', /factoryResetPreview: 'system:factory-reset:preview'/.test(shared) && /factoryResetRun: 'system:factory-reset:run'/.test(shared) && /factoryResetRelaunch: 'system:factory-reset:relaunch'/.test(shared))

  console.log('\n۴) رابط: توضیح کامل هر حالت پیش از فعال شدن دکمه')
  const ui = read('src/renderer/src/components/FactoryResetSection.tsx')
  const settings = read('src/renderer/src/pages/Settings.tsx')
  check('تب «صفر کردن برنامه» در تنظیمات', /tab === 'reset' && <FactoryResetSection/.test(settings) && /setTab\('reset'\)/.test(settings))
  check('متن «فقط تراکنش‌ها»: پاک می‌شود، می‌ماند، موجودی صفر، شمارهٔ فیش ادامه، سایت خاموش', /موجودی فروشگاه و انبار مرکزی صفر می‌شود/.test(ui) && /شمارهٔ فیش فروش ادامه پیدا می‌کند/.test(ui) && /همگام‌سازی موجودی سایت خاموش می‌ماند/.test(ui) && /کالاها با قیمت و بارکد/.test(ui))
  check('متن «کامل»: مثل روز نصب، آنچه می‌ماند، ساعت شیفت‌ها، فیش از ۱', /برنامه مثل روز نصب می‌شود/.test(ui) && /رمز مدیر/.test(ui) && /تنظیمات چاپ و قالب فاکتور/.test(ui) && /ساعت شیفت‌ها به پیش‌فرض برمی‌گردد/.test(ui) && /شمارهٔ فیش فروش از ۱ شروع می‌شود/.test(ui))
  check('متن هر دو حالت: بکاپ پیش از هر کار و راه برگرداندن', /پیش از هر کاری، برنامه یک بکاپ کامل می‌گیرد و آن را می‌سنجد/.test(ui) && /بکاپ و بازگردانی/.test(ui))
  check('دکمهٔ ادامه تا انتخاب حالت (و دیدن توضیحش) و پیش‌نمایش و جای کافی خاموش است', /disabled=\{!mode \|\| !preview \|\| !preview\.space\.enough \|\| busy\}/.test(ui))
  check('دکمهٔ پایانی تا تایپ «صفر» و تیک خاموش است', /disabled=\{busy \|\| !resetConfirmMatches\(confirmText\) \|\| !acknowledged\}/.test(ui))
  const iExplain = ui.indexOf('MODE_TEXT[m].body'), iButton = ui.indexOf('setConfirmOpen(true)')
  check('توضیح هر حالت پیش از دکمه نوشته می‌شود', iExplain > 0 && iButton > iExplain)
  check('پنجرهٔ تأیید پایانی: خلاصه، شمارش، نام بکاپ، تایپ «صفر»، تیک', /نام بکاپ:/.test(ui) && /می‌دانم برگشت فقط با بکاپ ممکن است/.test(ui) && /واژهٔ «صفر»/.test(ui))
  check('رسید: نام بکاپ، راه برگرداندن، شمارهٔ فیش بعدی و دکمهٔ باز شدن دوباره', /شمارهٔ فیش بعدی/.test(ui) && /CH\.factoryResetRelaunch/.test(ui) && /previousDatabaseFile/.test(ui))
  check('رابط فقط از @shared و lib/api می‌خواند (بی import از main)', !/from '\.\.\/\.\.\/\.\.\/main|from '@main/.test(ui))
  check('آیکون SVG اختصاصی برای بخش صفر کردن', /<svg[^>]*aria-hidden="true"/.test(ui))

  console.log('\n۵) هر دو حالت روی پایگاه موقت (فرایند جدا)')
  for (const mode of ['transactions', 'full']) {
    const r = spawnSync(process.execPath, ['--import', './test/harness/register.mjs', fileURLToPath(import.meta.url)], {
      cwd: ROOT, env: { ...process.env, PLAN1405_RESET_CHILD: mode }, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024
    })
    const out = `${r.stdout ?? ''}`
    process.stdout.write(out.split('\n').filter((l) => !l.startsWith('RESULT ')).map((l) => (l ? `    ${l}` : l)).join('\n'))
    const line = out.split('\n').find((l) => l.startsWith('RESULT '))
    const res = line ? JSON.parse(line.slice(7)) : null
    if (r.status !== 0 && r.stderr) console.log(r.stderr.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).slice(-25).join('\n'))
    check(`حالت «${mode === 'transactions' ? 'فقط تراکنش‌ها' : 'کامل'}»: ${res ? `${res.ok} سبز، ${res.bad} شکست` : 'بی نتیجه'}`, r.status === 0 && res && res.bad === 0 && res.ok > 40)
  }

  console.log(`\n${ok} سبز، ${bad} شکست`)
  process.exit(bad ? 1 : 0)
}

if (CHILD) await runChild(CHILD)
else await runParent()
