/**
 * طرح ۱۴۰۵ · مرحلهٔ ۷ — «دیدن با گوشی» (مورد ۶؛ معماری §۴-۷ و §۸-۲ بند ۱۶).
 *
 * روی پایگاه دادهٔ موقت با سرویس‌های واقعی فروش، برگشت، تعویض، اعتبار، خرید، انبار مرکزی و بستن صندوق؛ ناظر و
 * فرزند واقعی هاب (بستهٔ esbuild) و HTTP فقط روی 127.0.0.1:
 *  - برابری عدد با رایانه در هر سه فاز (هر بخش با همان تابع صفحهٔ برنامه، روی همان پایگاه داده)؛
 *  - نبود کد و بارکد اعتبار، کد سند برگشت و تلفن مشتری در بخش‌ها؛
 *  - فهرست ثابت نقطه‌ها بی هیچ تابع نوشتاری (آزمون ایستا)، و فرزند هاب بی `shop.db` و بی سرویس‌های رایانه؛
 *  - سقف بازهٔ ۳۱ روز، سقف صفحه، محدودیت فاصله و تک‌اجرا؛ ACL جدای هر بخش برای «فقط مشاهده»؛
 *  - ردیف `PHONE_REPORT_VIEW` حداکثر یکی برای هر عضو و هر بخش در ۱۰ دقیقه؛
 *  - «خلاصهٔ امروز» از پیش ساخته، با ساعتش، و همان سازندهٔ خلاصهٔ ساعت ۲۴؛
 *  - صفحهٔ گوشی: بی innerHTML و localStorage، قالب مبلغ برابر `money()` رایانه.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-phone-reports.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { request } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-plan1405-phone-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { productService } = await import('../../src/main/services/ProductService.ts')
const { secondaryStockService } = await import('../../src/main/services/SecondaryStockService.ts')
const { purchaseService } = await import('../../src/main/services/PurchaseService.ts')
const { shiftService } = await import('../../src/main/services/ShiftService.ts')
const { trendService } = await import('../../src/main/services/management/TrendService.ts')
const { readLockDurations, writeLockDurations } = await import('../../src/main/services/locks/durations.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { createCloudReader } = await import('../../src/main/services/cloud/cloudReader.ts')
const { startExperimentalHubSupervisor } = await import('../../src/main/services/cloud/experimentalHubSupervisor.ts')
const { registerPhoneReports, sharedTodaySummary, todaySummaryDeps, PHONE_REPORT_READERS } = await import('../../src/main/services/cloud/phoneReports.ts')
const { readPhoneReport, phoneReportsStarted, phoneReportsStopped } = await import('../../src/main/services/cloud/phoneReportSource.ts')
const { PHONE_REPORTS, PHONE_REPORT_SECTIONS, PHONE_REPORT_PANELS, parsePhoneReportRequest, parsePhoneReport, jalaliSpanDays } = await import('../../src/main/services/cloud/phoneReportCatalog.ts')
const { buildDailySummary } = await import('../../src/main/services/cloud/messenger/messengerSummary.ts')
const { createTodaySummary } = await import('../../src/main/services/cloud/todaySummary.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { mobileHtml, mobileJs } = await import('../../src/main/services/cloud/mobilePwaAssets.ts')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { money, toJalaliDate, jalaliStartOfDay, jalaliEndOfDay } = await import('@shared/jalali')

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const amount = (n) => (typeof n === 'bigint' ? n.toString() : String(Math.round(Number(n) || 0) || 0))

// ------------------------------------------------------------------ ۱) آزمون‌های ایستا (بی پایگاه داده)
test('catalog: three phases, ten fixed sections, pages ≤200, a VIEW panel each, never a credit code field', () => {
  assert.deepEqual([...PHONE_REPORT_SECTIONS], ['today', 'returns', 'status', 'stock', 'warehouse', 'management', 'credits', 'purchases', 'cashbox', 'shiftlog'])
  assert.deepEqual(PHONE_REPORT_SECTIONS.filter((s) => PHONE_REPORTS[s].phase === 1), ['today', 'returns', 'status'])
  assert.deepEqual(PHONE_REPORT_SECTIONS.filter((s) => PHONE_REPORTS[s].phase === 2), ['stock', 'warehouse'])
  assert.deepEqual(PHONE_REPORT_SECTIONS.filter((s) => PHONE_REPORTS[s].phase === 3), ['management', 'credits', 'purchases', 'cashbox', 'shiftlog'])
  assert.deepEqual([...PHONE_REPORT_PANELS], PHONE_REPORT_SECTIONS.map((s) => `view.${s}`))
  for (const s of PHONE_REPORT_SECTIONS) assert.ok(PHONE_REPORTS[s].pageSize <= 200, `${s}: page ≤ 200`)
  const forbidden = /^(code|legacyCode|returnCode|storeCreditReference|storeCredits|note|refundNote|refundReference|holderPhone|holderNationalId|customerPhone|phone)$/
  for (const s of ['returns', 'credits', 'management', 'purchases', 'cashbox', 'shiftlog', 'today']) {
    for (const [key] of [...PHONE_REPORTS[s].row, ...PHONE_REPORTS[s].totals]) assert.ok(!forbidden.test(key), `${s}.${key} is not a private field`)
  }
  // ۳۱ روز: ۱ تا ۳۱ فروردین پذیرفته، تا ۱ اردیبهشت رد
  assert.equal(jalaliSpanDays('1405/01/01', '1405/01/31'), 30)
  assert.doesNotThrow(() => parsePhoneReportRequest({ section: 'returns', page: 0, fromDay: '1405/01/01', toDay: '1405/01/31' }))
  assert.throws(() => parsePhoneReportRequest({ section: 'returns', page: 0, fromDay: '1405/01/01', toDay: '1405/02/01' }), /range/)
  assert.throws(() => parsePhoneReportRequest({ section: 'returns', page: 0, fromDay: '1405/01/02', toDay: '1405/01/01' }))
  assert.throws(() => parsePhoneReportRequest({ section: 'returns', page: 0, fromDay: '1405/01/01', toDay: '1405/01/02', extra: 1 }))
  assert.throws(() => parsePhoneReportRequest({ section: 'warehouse', page: 1, search: '' }), 'one bounded page only')
  assert.throws(() => parsePhoneReportRequest({ section: 'nope', page: 0 }))
  assert.throws(() => parsePhoneReport('status', { at: 1, atText: 'x', hasMore: false, lines: [], totals: null, rows: [{ title: 'a', minutes: 1, secret: 'x' }] }), 'no extra field passes')
  assert.throws(() => parsePhoneReport('credits', { at: 1, atText: 'x', hasMore: false, lines: [], totals: { count: 1 }, rows: Array(51).fill(null) }), 'page cap')
})

test('todaySummary: precomputed, single-flight, same day only; stop() drops it; the bot recomputes only an old copy', async () => {
  let clock = Date.parse('2026-11-23T08:00:00Z'), calls = 0
  const deps = {
    db: { cashSessionsClosed: async () => [], openShiftsAt: async () => [], chequesDue: async () => ({ count: 0, total: 0 }), auditRowsInRange: async () => [], userNames: async () => new Map() },
    salesSummary: async () => { calls++; return { count: calls, grandTotal: 1000 * calls, cashTotal: 0, cardTotal: 0, otherTotal: 0, managerAccountTotal: 0, creditTotal: 0 } },
    staffPerformance: async () => ({ rows: [] }), abnormalDiscounts: async () => ({ rows: [], disabled: true }), lastBackupAt: async () => null
  }
  const t = createTodaySummary({ deps: () => deps, offsetHours: async () => 0, now: () => clock })
  assert.equal(t.current(), null, 'nothing until the first background computation')
  const [a, b] = await Promise.all([t.refresh(), t.refresh()])
  assert.equal(calls, 1, 'single flight'); assert.equal(a, b)
  assert.deepEqual(t.current().summary.numbers, { count: 1, grandTotal: '1000', cashTotal: '0', cardTotal: '0', managerAccountTotal: '0', otherTotal: '0', creditTotal: '0', returnCount: 0, exchangeCount: 0 })
  clock += 60_000
  assert.equal((await t.latest()).summary.numbers.count, 1, 'a fresh copy is reused (label = its own time)')
  clock += 5 * 60_000
  assert.equal((await t.latest()).summary.numbers.count, 2, 'older than five minutes ⇒ one new computation')
  clock += 24 * 3_600_000
  assert.equal(t.current(), null, "yesterday's copy is never shown as today")
  await t.refresh(); assert.ok(t.current())
  t.stop(); assert.equal(t.current(), null, 'stop drops the copy')
})

test('fixed read-only endpoint list: only desktop read functions, no database access, no write function', () => {
  const src = read('src/main/services/cloud/phoneReports.ts')
  const calls = new Set([...src.matchAll(/\b(\w+Service)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`))
  const allowed = new Set(['salesService.returnList', 'salesService.summary', 'staffReportService.performance', 'staffReportService.abnormalDiscounts',
    'productService.list', 'secondaryStockService.list', 'storeCreditService.list', 'purchaseService.list', 'cashboxService.sessions',
    'shiftService.list', 'trendService.snapshot', 'backupService.list'])
  for (const call of calls) assert.ok(allowed.has(call), `${call} is a read function of the fixed list`)
  assert.ok(calls.size >= 11)
  assert.doesNotMatch(src, /\bprisma\b|\$queryRaw|\$executeRaw|db\/client/, 'no direct database access')
  assert.doesNotMatch(src, /\w+Service\.(create|update|upsert|delete|remove|void|close|open|save|write|set|import|restore|merge|transfer|pay|adjust|redeem|issue|finalize|purge|rebuild|mark)\w*\(/i)
  assert.doesNotMatch(src, /writeLockDurations|assert\w*Password|managerPassword/)
  assert.deepEqual(Object.keys(PHONE_REPORT_READERS), [...PHONE_REPORT_SECTIONS], 'one reader for each section, nothing else')
  // the host gets the reader through the leaf only (no desktop service in CloudSyncService's bundle)
  const host = read('src/main/services/CloudSyncService.ts')
  assert.match(host, /enableInvoiceFacts:true,reports:readPhoneReport,/)
  assert.doesNotMatch(host, /cloud\/phoneReports'/)
  assert.match(read('src/main/ipc/index.ts'), /try \{ registerPhoneReports\(\) \} catch/)
})

test('the hub child never opens shop.db: its bundle has no desktop service, Prisma or database client', async () => {
  const childSrc = read('src/main/services/cloud/experimentalHubChild.ts')
  const imports = [...childSrc.matchAll(/^import [^\n]* from '([^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.includes('./phoneReportCatalog'))
  for (const spec of imports) assert.doesNotMatch(spec, /db\/client|@prisma|phoneReports$|todaySummary|Service$|messenger/, `child import ${spec}`)
  assert.doesNotMatch(childSrc, /join\([^)]*'shop\.db'|DATABASE_URL/, 'no path to the shop database')
  const out = await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], bundle: true, write: false, metafile: true,
    platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent', outfile: join(ROOT, 'probe.cjs') })
  const inputs = Object.keys(out.metafile.inputs).map((p) => p.replace(/\\/g, '/'))
  assert.ok(inputs.some((p) => p.endsWith('cloud/phoneReportCatalog.ts')))
  assert.equal(inputs.filter((p) => /src\/main\/db\/|@prisma|\/services\/[A-Z][A-Za-z]*Service\.ts$|phoneReports\.ts$|todaySummary\.ts$|\/messenger\//.test(p)).length, 0, inputs.join('\n'))
})

test('phone page: report UI is capability-gated, text nodes only, amounts formatted exactly like the desktop money()', async () => {
  assert.match(mobileHtml, /<article id="report-tools" hidden>/)
  assert.match(mobileHtml, /<div id="report-acl" hidden>/)
  assert.ok(!mobileJs.includes('innerHTML') && !mobileJs.includes('localStorage'))
  assert.equal(mobileJs.split('setInterval(').length - 1, 1, 'no new timer')
  const elements = new Map(), calls = []
  class Element {
    constructor() { this.hidden = false; this.value = ''; this.checked = false; this.children = []; this.events = {}; this._text = '' }
    addEventListener(e, h) { this.events[e] = h }
    appendChild(c) { this.children.push(c) }
    set textContent(v) { this._text = String(v); this.children = [] }
    get textContent() { return this._text }
  }
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
  for (const id of ['dashboard', 'owner-tools', 'report-tools', 'report-acl']) el(id).hidden = true
  const respond = (body, status = 200) => ({ ok: status < 300, status, json: async () => body })
  let report = respond({ at: 1, atText: '۱۴۰۵/۰۹/۰۲ ساعت ۱۰:۰۰', rows: [{ id: 1, kind: 'برگشت', receiptNo: 7, returnedAtJalali: '1405/09/02', time: '10:00:00', customerName: '<img onerror=x>', total: '-1234567', refundMethodLabel: 'نقد', refundAmount: '9007199254740993', cashRefundAmount: '0', storeCreditTotal: '0', exchangeDiff: '0', exchangeSettlementLabel: null, invoiceUserName: 'علی', returnUserName: 'علی', items: 'کت ×۱' }], totals: { count: 1 }, lines: [], hasMore: true })
  const fetch = async (path, options = {}) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null })
    if (path === '/api/session') return respond({ user: { username: 'owner', role: 'OWNER' } })
    if (path === '/api/capabilities') return respond({ invoices: false, reports: ['today', 'returns', 'not-a-section'] })
    if (path === '/api/custody') return respond({ boundary: null })
    if (path === '/api/shifts') return respond({ shifts: [], hasMore: false })
    if (path === '/api/members') return respond({ members: [] })
    if (path === '/api/requests') return respond({ error: 'x' }, 404)
    if (path === '/api/report' || path === '/api/invite/create') return report
    throw new Error('Unexpected API ' + path)
  }
  const context = { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console }
  vm.runInNewContext(mobileJs, context, { timeout: 1000 })
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r))
  assert.equal(el('report-tools').hidden, false)
  assert.deepEqual(el('report-section').children.map((o) => o.value), ['today', 'returns'], 'unknown sections are ignored')
  assert.deepEqual(el('report-acl-list').children.length, 2, 'the owner ticks a VIEW box per section')
  el('report-section').value = 'returns'; el('report-section').events.change()
  assert.equal(el('report-range').hidden, false); assert.equal(el('report-search-box').hidden, true)
  el('report-from').value = '1405/09/01'; el('report-to').value = '1405/09/02'
  await el('report-form').events.submit({ preventDefault() {} })
  assert.deepEqual(calls.find((c) => c.path === '/api/report').body, { section: 'returns', page: 0, fromDay: '1405/09/01', toDay: '1405/09/02' })
  const text = el('report-results').children.map((c) => c.textContent).join('\n')
  assert.match(text, /<img onerror=x>/, 'names are text, never HTML')
  assert.match(text, /مبلغ برگشت: -۱٬۲۳۴٬۵۶۷ ریال/)
  assert.match(el('report-stamp').textContent, /^زمان دریافت: ۱۴۰۵\/۰۹\/۰۲ ساعت ۱۰:۰۰$/)
  assert.equal(el('report-next').hidden, false)
  for (const v of ['0', '7', '999', '1000', '-1000', '1234567', '9007199254740993', '-90071992547409930']) assert.equal(context.reportMoney(v), money(BigInt(v)), `money(${v})`)
  // the owner's invite form sends exactly the ticked VIEW panels
  el('report-acl-list').children[1].children[0].checked = true
  report = respond({ invite: 'x' })
  el('invite-role').value = 'VIEWER'; el('invite-pin').value = '123456'
  calls.length = 0
  const invite = el('invite-form').events.submit({ preventDefault() {} })
  await invite
  const sent = calls.find((c) => c.path === '/api/invite/create')
  assert.ok(sent, 'invite posted')
  assert.deepEqual(sent.body.acl.filter((a) => a.panel.startsWith('view.')), [{ panel: 'view.returns', view: true, approve: false }])
})

// ------------------------------------------------------------------ ۲) دادهٔ واقعی روی پایگاه دادهٔ موقت
const seller = seed.user('علی فروشنده')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارتخوان', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('پوشاک')
const mk = (name, price, stock = 50) => {
  const id = seed.variant(seed.product(name, cat), name)
  sql.prepare('UPDATE "ProductVariant" SET stock = ?, salePrice = ? WHERE id = ?').run(stock, price, id)
  return id
}
const vA = mk('کت', 1_000_000), vB = mk('شلوار', 700_000), vC = mk('پیراهن', 400_000)
const today = toJalaliDate(new Date())
const PHONE = '09120000001'
const debtor = { firstName: 'مشتری', lastName: 'آزمون', phone: PHONE }
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId: seller, staffConfirmed: 1 })
const L = (v, unitPrice, qty = 1) => ({ variantId: v, qty, unitPrice, discount: 0, tax: 0 })
const sale = (lines, payments, extra = {}) => salesService.create({ debtor, userId: seller, shiftId, lines, payments, ...extra })
const itemOf = (invoiceId, variantId) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? AND variantId = ? ORDER BY id LIMIT 1', invoiceId, variantId).id

const s1 = await sale([L(vA, 1_000_000), L(vB, 700_000)], [{ methodId: cash, amount: 1_700_000, destination: 'CASH' }])
const s2 = await sale([L(vB, 700_000)], [{ methodId: card, amount: 700_000, destination: 'CARD' }])
await sale([L(vC, 400_000, 2)], [{ methodId: cash, amount: 800_000, destination: 'CASH' }])
await salesService.createReturn({ invoiceId: s2.id, full: true, lines: [{ saleItemId: itemOf(s2.id, vB), qty: 1 }], refundMethod: 'STORE_CREDIT', userId: seller })
await salesService.createExchange({ userId: seller, shiftId, invoiceId: s1.id, lines: [{ saleItemId: itemOf(s1.id, vB), qty: 1 }], replacements: [L(vC, 400_000)], refundMode: 'STORE_CREDIT', idempotencyKey: 'plan1405-phone-exchange' })
await storeCreditService.issueManual({ amount: 600_000, multiUse: true, maxUses: 3, days: 30, userId: seller, managerPassword: PW })
await purchaseService.create({ settlementType: 'CASH', lines: [{ variantId: vA, qty: 2, unitPrice: 450_000 }], discountTotal: 50_000, paidTotal: 300_000, panelPassword: PW })
await secondaryStockService.upsert({ name: 'پارچهٔ کت', code: 'W-1', qty: 12, minQty: 20 })
await secondaryStockService.upsert({ name: 'دکمه', code: null, qty: 300, minQty: 0 })
const expected = await cashboxService.expected({ shiftId }).then((r) => Number(r?.expectedCash ?? 0))
await cashboxService.close({ shiftId, explicitShift: true, userId: seller, countedCash: expected - 50_000, closeShift: false, note: `کسری ${PHONE}` })
writeLockDurations({ sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25 })

const secrets = () => {
  const out = [PHONE]
  for (const r of sql.prepare('SELECT code, legacyCode FROM "StoreCredit"').all()) { if (r.code) out.push(r.code); if (r.legacyCode) out.push(r.legacyCode) }
  for (const r of sql.prepare('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').all()) out.push(r.returnCode)
  return out.filter((v) => typeof v === 'string' && v.length >= 4)
}
assert.ok(secrets().length >= 3, 'the scenario has credit codes and return codes to hide')

// ------------------------------------------------------------------ ۳) ناظر و فرزند واقعی هاب
const childFile = join(ROOT, 'child.cjs')
await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
const views = []
setAccessEventWriter((after, userId, action) => { views.push({ after, userId, action }) })
registerPhoneReports()
const origin = 'https://shop.example'
const stateValue = { version: 1, storeId: 'phone_store', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }
const hub = await startExperimentalHubSupervisor({
  nodeExecutable: process.execPath, childFile, directory: mkdtempSync(join(tmpdir(), 'mahak-plan1405-phone-hub-')), origin,
  owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 9), snapshotMaxAgeMs: 5000,
  reader: createCloudReader(db), enableInvoiceFacts: true, reports: readPhoneReport,
  state: { load: () => ({ ...stateValue }), save: () => {} }, readRestoreMarker: async () => null, timeoutMs: 5000
})
phoneReportsStarted()
function send(path, { method = 'GET', body, cookie } = {}) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method, headers: { host: 'shop.example', ...(method === 'POST' ? { origin, 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let json = null; try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, text, json, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] })
      })
    }); req.on('error', reject); req.end(data ?? undefined)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastRead = 0
/** one report read (the hub allows one every 3 seconds for all sessions) */
async function report(cookie, body) {
  const wait = lastRead + 3_100 - Date.now()
  if (wait > 0) await sleep(wait)
  const r = await send('/api/report', { method: 'POST', body, cookie })
  lastRead = Date.now()
  return r
}
const noSecrets = (r, label) => { for (const s of secrets()) assert.ok(!r.text.includes(s), `${label}: no ${s.slice(0, 3)}… in the response`) }
const changes = () => sql.prepare('SELECT total_changes() AS n').get().n

// a Persian username longer than 64 UTF-8 bytes (the identity allows 64 Unicode letters)
const VIEWER = 'بینندهگزارشهایفروشگاهارکاپوسشعبهیک'
assert.ok(Buffer.byteLength(VIEWER, 'utf8') > 64 && VIEWER.length <= 64)
try {
  const owner = (await send('/api/login', { method: 'POST', body: { username: 'owner', password: 'owner-test-password' } })).cookie
  assert.ok(owner)

  await test('capabilities: the owner sees all ten sections; a viewer only the sections ticked for it', async () => {
    const caps = (await send('/api/capabilities', { cookie: owner })).json
    assert.equal(caps.invoices, true, 'the raw invoice list is on')
    assert.deepEqual(caps.reports, [...PHONE_REPORT_SECTIONS])
    const invite = await send('/api/invite/create', { method: 'POST', cookie: owner, body: { role: 'VIEWER', pin: '746392', acl: [{ panel: 'view.today', view: true, approve: false }, { panel: 'view.stock', view: true, approve: false }] } })
    assert.equal(invite.status, 200)
    assert.equal((await send('/api/invite/create', { method: 'POST', cookie: owner, body: { role: 'VIEWER', pin: '746392', acl: [{ panel: 'view.today', view: true, approve: true }] } })).status, 403, 'a report panel is view-only')
    assert.equal((await send('/api/invite/accept', { method: 'POST', body: { invite: invite.json.invite, username: VIEWER, password: 'viewer-test-password', pin: '482931' } })).status, 200)
    assert.equal((await send('/api/member/approve', { method: 'POST', cookie: owner, body: { username: VIEWER, pin: '746392' } })).status, 200)
  })
  const viewer = (await send('/api/login', { method: 'POST', body: { username: VIEWER, password: 'viewer-test-password' } })).cookie

  await test('ACL, request bounds and rate: 401, 403 per section, 400 over 31 days, 429 within 3 s', async () => {
    assert.deepEqual((await send('/api/capabilities', { cookie: viewer })).json, { invoices: false, reports: ['today', 'stock'] })
    assert.equal((await send('/api/report', { method: 'POST', body: { section: 'today', page: 0 } })).status, 401)
    assert.equal((await send('/api/report', { method: 'POST', cookie: viewer, body: { section: 'returns', page: 0, fromDay: today, toDay: today } })).status, 403)
    assert.equal((await send('/api/report', { method: 'POST', cookie: owner, body: { section: 'returns', page: 0, fromDay: '1405/01/01', toDay: '1405/02/01' } })).status, 400)
    assert.equal((await send('/api/invoices', { method: 'POST', cookie: owner, body: { fromDay: '1405/01/01', toDay: '1405/02/01', afterId: 0 } })).status, 400, 'the invoice list keeps the same 31-day cap')
    assert.equal((await send('/api/report', { method: 'POST', cookie: owner, body: { section: 'today', page: 0, extra: true } })).status, 400)
    const first = await report(owner, { section: 'status', page: 0 })
    assert.equal(first.status, 200)
    assert.equal((await send('/api/report', { method: 'POST', cookie: owner, body: { section: 'status', page: 0 } })).status, 429, 'one read per 3 seconds for all sessions')
  })

  await test('phase 1: «خلاصهٔ امروز» from the precomputed summary = the desktop sales report and the 24:00 builder', async () => {
    for (let i = 0; i < 100 && !sharedTodaySummary().current(); i++) await sleep(100)
    const snap = sharedTodaySummary().current()
    assert.ok(snap, 'the summary is precomputed after the hub starts')
    const before = changes()
    const r = await report(viewer, { section: 'today', page: 0 })
    assert.equal(r.status, 200)
    const v = r.json, sales = await salesService.summary({ fromJalali: today, toJalali: today })
    const staff = await staffReportService.performance({ fromJalali: today, toJalali: today })
    assert.equal(v.at, snap.at); assert.match(v.atText, /ساعت/)
    assert.deepEqual(v.totals, {
      count: sales.count, grandTotal: amount(sales.grandTotal), cashTotal: amount(sales.cashTotal), cardTotal: amount(sales.cardTotal),
      managerAccountTotal: amount(sales.managerAccountTotal), otherTotal: amount(sales.otherTotal), creditTotal: amount(sales.creditTotal),
      returnCount: staff.rows.reduce((s, x) => s + x.returnCount, 0), exchangeCount: staff.rows.reduce((s, x) => s + x.exchangeCount, 0)
    })
    assert.ok(Number(v.totals.grandTotal) > 0 && v.totals.count >= 3 && v.totals.returnCount + v.totals.exchangeCount >= 1, JSON.stringify(v.totals))
    // the same builder as the 24:00 message and the bot, at the same moment
    const direct = await buildDailySummary(today, { ...todaySummaryDeps(), db: createMessengerDb() }, { offsetHours: 0, now: snap.at })
    assert.deepEqual(v.lines, [...direct.lines, ...(direct.sellerSections.length ? ['— به تفکیک فروشنده —', ...direct.sellerSections.flat()] : [])])
    assert.ok(v.lines.some((l) => l.includes(`جمع ${money(sales.grandTotal)} ریال`)), 'formatted with the desktop money()')
    noSecrets(r, 'today')
    assert.equal(changes(), before, 'a phone request writes nothing and computes nothing')
  })

  await test('phase 1: the raw invoice list (now enabled) = the stored invoices', async () => {
    const r = await send('/api/invoices', { method: 'POST', cookie: owner, body: { fromDay: today, toDay: today, afterId: 0 } })
    assert.equal(r.status, 200)
    const stored = sql.prepare('SELECT id, receiptNo, grandTotal FROM "SaleInvoice" WHERE issuedAtJalali = ? ORDER BY id').all(today)
    assert.deepEqual(r.json.invoices.map((i) => [i.id, i.receiptNo, i.grandTotal]), stored.map((s) => [s.id, s.receiptNo, String(s.grandTotal)]))
  })

  await test('phase 1: returns and exchanges = salesService.returnList, without any code', async () => {
    const r = await report(owner, { section: 'returns', page: 0, fromDay: today, toDay: today })
    assert.equal(r.status, 200)
    const desk = await salesService.returnList({ fromJalali: today, toJalali: today, includeExchanges: true, take: 50, skip: 0 })
    assert.equal(desk.length, 2)
    assert.deepEqual(r.json.rows.map((x) => [x.id, x.kind, x.receiptNo, x.total, x.refundAmount, x.cashRefundAmount, x.storeCreditTotal, x.exchangeDiff]),
      desk.map((d) => [d.id, d.isExchange ? 'تعویض' : 'برگشت', d.receiptNo, amount(d.total), amount(d.refundAmount), amount(d.cashRefundAmount), amount(d.storeCreditTotal), amount(d.exchangeDiff)]))
    assert.deepEqual(r.json.totals, { count: desk.page.totalCount }); assert.equal(r.json.hasMore, false)
    noSecrets(r, 'returns')
  })

  await test('phase 1: «وضعیت سیستم» shows the three durations of lock-durations.json', async () => {
    const r = await report(owner, { section: 'status', page: 0 })
    const d = readLockDurations()
    assert.deepEqual(r.json.rows.map((x) => x.minutes), [d.sensitiveCodeMinutes, d.otherCodeMinutes, d.remoteGrantMinutes])
    assert.deepEqual(r.json.rows.map((x) => x.minutes), [7, 12, 25])
    assert.deepEqual(Object.keys((await send('/api/health', { cookie: owner })).json).sort(), ['dataAgeMs', 'linkAgeMs', 'revocationPending'], '/api/health keeps its three keys')
  })

  await test('phase 2: store stock and the central warehouse = productService.list and secondaryStockService.list', async () => {
    const r = await report(viewer, { section: 'stock', page: 0, search: '' })
    assert.equal(r.status, 200)
    const desk = await productService.list({ take: 101, skip: 0 })
    assert.deepEqual(r.json.rows.map((x) => [x.id, x.stock, x.salePrice, x.code]), desk.slice(0, 100).map((d) => [d.id, d.stock, amount(d.salePrice), d.code]))
    assert.ok(!r.text.includes('purchasePrice'))
    const w = await report(owner, { section: 'warehouse', page: 0, search: '' })
    const wd = await secondaryStockService.list({ take: 201 })
    assert.deepEqual(w.json.rows.map((x) => [x.id, x.name, x.qty, x.minQty, x.low]), wd.map((d) => [d.id, d.name, d.qty, d.minQty, d.low]))
    assert.equal(w.json.rows.find((x) => x.code === 'W-1').low, true)
    const searched = await report(owner, { section: 'stock', page: 0, search: 'پیراهن' })
    assert.deepEqual(searched.json.rows.map((x) => x.id), (await productService.list({ search: 'پیراهن', take: 101, skip: 0 })).map((d) => d.id))
  })

  await test('phase 3: management, store credit, purchases, cashbox and shifts = the desktop functions, never a credit code', async () => {
    const m = await report(owner, { section: 'management', page: 0, fromDay: today, toDay: today })
    const a = (await trendService.snapshot({ fromJalali: today, toJalali: today })).accounting
    assert.deepEqual(m.json.totals, {
      invoiceCount: a.invoice.invoiceCount, grossSales: amount(a.invoice.grossSales), discounts: amount(a.invoice.discounts), taxes: amount(a.invoice.taxes),
      serviceCharges: amount(a.invoice.serviceCharges), deliveryFees: amount(a.invoice.deliveryFees), simpleReturns: amount(a.invoice.simpleReturns),
      exchangeReturned: amount(a.invoice.exchangeReturned), netAccrualSales: amount(a.invoice.netAccrualSales), cashReceived: amount(a.cash.cashReceived),
      cardReceived: amount(a.cash.cardReceived), otherReceived: amount(a.cash.otherReceived), managerAccountReceived: amount(a.cash.managerAccountReceived),
      creditRemaining: amount(a.credit.remaining)
    })
    const c = await report(owner, { section: 'credits', page: 0, fromDay: today, toDay: today })
    const cd = await storeCreditService.list({ fromJalali: today, toJalali: today, take: 50, skip: 0 })
    assert.ok(cd.length >= 3)
    assert.deepEqual(c.json.rows.map((x) => [x.id, x.amount, x.usedAmount, x.remaining, x.publicReference]), cd.map((d) => [d.id, amount(d.amount), amount(d.usedAmount), amount(d.remaining), d.publicReference]))
    assert.deepEqual(c.json.totals, { count: cd.page.totalCount })
    noSecrets(c, 'credits')
    const p = await report(owner, { section: 'purchases', page: 0, fromDay: today, toDay: today })
    const pd = await purchaseService.list({ from: jalaliStartOfDay(today).toISOString(), to: jalaliEndOfDay(today).toISOString(), take: 50, skip: 0 })
    assert.deepEqual(p.json.totals, { count: pd.totals.count, goodsTotal: amount(pd.totals.goodsTotal), discountTotal: amount(pd.totals.discountTotal), grandTotal: amount(pd.totals.grandTotal), paidTotal: amount(pd.totals.paidTotal) })
    assert.deepEqual(p.json.rows.map((x) => [x.invoiceNo, x.grandTotal]), pd.map((d) => [d.invoiceNo, amount(d.grandTotal)]))
    assert.deepEqual(p.json.totals.grandTotal, '850000')
    const k = await report(owner, { section: 'cashbox', page: 0, fromDay: today, toDay: today })
    const kd = await cashboxService.sessions({ fromJalali: today, toJalali: today, take: 50, skip: 0 })
    assert.equal(kd.length, 1)
    assert.deepEqual(k.json.rows.map((x) => [x.id, x.cashTotal, x.cardTotal, x.grandTotal, x.countedTotal, x.diff]), kd.map((d) => [d.id, amount(d.cashTotal), amount(d.cardTotal), amount(d.grandTotal), d.countedTotal == null ? null : amount(d.countedTotal), d.diff == null ? null : amount(d.diff)]))
    assert.ok(!k.text.includes(PHONE), 'free-text notes never reach the phone')
    const s = await report(owner, { section: 'shiftlog', page: 0, fromDay: today, toDay: today })
    const sd = await shiftService.list({ fromJalali: today, toJalali: today, take: 200 })
    assert.deepEqual(s.json.rows.map((x) => [x.id, x.invoiceCount, x.grandTotal, x.cashTotal, x.cardTotal, x.closed]), sd.map((d) => [d.id, d.invoiceCount, amount(d.grandTotal), amount(d.cashTotal), amount(d.cardTotal), d.closed]))
  })

  await test('PHONE_REPORT_VIEW: at most one AuditLog row per member and section in ten minutes; never a message', async () => {
    const r = await report(owner, { section: 'status', page: 0 })
    assert.equal(r.status, 200)
    const rows = views.filter((v) => v.action === 'ACCESS_EVENT' && v.after.kind === 'PHONE_REPORT_VIEW')
    const key = (v) => `${v.after.recipientName}|${v.after.titleFa}`
    assert.equal(new Set(rows.map(key)).size, rows.length, 'one row per member and section')
    assert.equal(rows.filter((v) => v.after.recipientName === 'owner' && v.after.titleFa === 'گزارش گوشی: وضعیت سیستم').length, 1, 'three status reads, one row')
    assert.ok(rows.some((v) => v.after.recipientName === VIEWER && v.after.titleFa === 'گزارش گوشی: خلاصهٔ فروش امروز'), 'a long Persian member name is recorded as is')
  })

  await test('a stopped hub keeps no precomputed summary; the phone gets «not ready», never stale numbers', async () => {
    phoneReportsStopped()
    assert.equal(sharedTodaySummary().current(), null)
    const r = await report(owner, { section: 'today', page: 0 })
    assert.equal(r.status, 200); assert.equal(r.json.totals, null); assert.equal(r.json.at, null)
    phoneReportsStarted()
  })
} finally {
  phoneReportsStopped()
  await hub.stop()
  setAccessEventWriter(null)
}
