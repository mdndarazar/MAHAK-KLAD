/**
 * دفتر آزمون ۴-۹ — قالب کامل فاکتور در پیام فروش، برگشت و تعویض (تعویض زنجیره‌ای هم)، روی سرور ساختگی Bot API
 * (loopback، مثل `plan1405-messenger-loopback.mjs`) با موتور واقعی پیام‌رسان، پایگاه موقت و سرویس‌های واقعی فروش،
 * برای تلگرام و بله:
 *  - فروش ۱۰ قلمی ⇐ یک پیام با هر ۱۰ قلم، جمع فاکتور درست زیر سرخط، بدنهٔ فاکتور و پرداخت به تفکیک روش؛
 *  - فروش ۱۰۰ قلمی ⇐ چند بخش، هر پیام زیر ۴۰۹۶ نویسه، همهٔ ۱۰۰ قلم (هیچ قلمی جا نمی‌افتد) و جمع در بخش اول؛
 *  - برگشت ⇐ قلم‌های برگشتی و جمع برگشت؛
 *  - تعویض و تعویض زنجیره‌ای ⇐ هر دو فهرست، جمع‌ها، مابه‌التفاوت و خط زنجیره؛
 *  - نبودن کد برگشت، کد و بارکد اعتبار، بارکد کالا و تلفن.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-9-invoice-message.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-tl-4-9-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { SEPARATOR } = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')
const { faDigits, money, toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

// ---------------------------------------------------------------- داده‌های پایه
const seller = seed.user('فروشندهٔ ۴-۹')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'CARD', label: 'کارت', kind: 'CARD', isActive: 1, sortOrder: 2 })
const sepah = seed.insert('PaymentMethod', { key: 'SEPAH', label: 'سپه', kind: 'CARD', isActive: 1, sortOrder: 3 })
const cat = seed.category('پوشاک')
const COLORS = ['ذغالی', 'سرمه‌ای', 'مشکی', 'کرم', 'زیتونی']
const variants = []
const mk = (name, size, color, price) => {
  const id = seed.variant(seed.product(name, cat), size)
  sql.prepare('UPDATE "ProductVariant" SET stock = 1000, salePrice = ?, color = ? WHERE id = ?').run(price, color, id)
  return id
}
for (let i = 1; i <= 100; i++) variants.push({ id: mk(`کالای آزمون ${i}`, String(30 + (i % 10)), COLORS[i % COLORS.length], 100_000 * i), price: 100_000 * i })
const vPants = mk('شلوار بگ', '31', 'ذغالی', 36_000_000), vCoat = mk('کت', '50', null, 40_000_000), vShirt = mk('پیراهن', 'L', 'آبی', 1_800_000)
const PHONE = '09120000049'
const debtor = { firstName: 'مشتری', lastName: 'آزمون', phone: PHONE }
const today = toJalaliDate(new Date())
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId: seller, staffConfirmed: 1 })
const L = (v, unitPrice, qty = 1, discount = 0) => ({ variantId: v, qty, unitPrice, discount, tax: 0 })
const itemsOf = (invoiceId) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', invoiceId).map((r) => r.id)
const invoice = (id) => seed.one('SELECT receiptNo, grandTotal FROM "SaleInvoice" WHERE id = ?', id)

// ---------------------------------------------------------------- ذخیره‌ساز امن ساختگی (AES-GCM)
const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}

// ---------------------------------------------------------------- سرور ساختگی Bot API روی loopback (سقف ۴۰۹۶ نویسه مثل تلگرام و بله)
const TOKENS = { telegram: '123456789:AAHtelegramTOKENsecretVALUE0123456789', bale: '987654321:BBHbaleTOKENsecretVALUE01234567890123' }
const PREFIX = { telegram: 'tg', bale: 'bale' }
const mock = { log: [], updates: { tg: [], bale: [] }, nextId: 1, port: 0, server: null }
await new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      const m = /^\/(tg|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
      if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' })
      const [, prefix, token, method] = m
      let params = {}
      try { params = JSON.parse(body || '{}') } catch {}
      if (token !== (prefix === 'tg' ? TOKENS.telegram : TOKENS.bale)) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' })
      if (method === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, first_name: 'Shop', username: `${prefix}_shop_bot` } })
      if (method === 'getUpdates') {
        const offset = Number(params.offset) || 0
        mock.updates[prefix] = mock.updates[prefix].filter((u) => u.update_id >= offset)
        return send(200, { ok: true, result: mock.updates[prefix] })
      }
      if (method === 'sendMessage') {
        if (String(params.text ?? '').length > 4096) return send(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' })
        mock.log.push({ prefix, chat: params.chat_id, text: String(params.text) })
        return send(200, { ok: true, result: { message_id: mock.nextId++ } })
      }
      return send(404, { ok: false, error_code: 404, description: 'Not Found' })
    })
  })
  server.listen(0, '127.0.0.1', () => { mock.server = server; mock.port = server.address().port; resolve() })
})
let clock = Date.now()
const engine = createMessengerEngine({
  dir: (() => { const d = join(ROOT, 'userdata'); mkdirSync(d, { recursive: true }); return d })(), storage, db: createMessengerDb(),
  summary: {
    salesSummary: (f) => salesService.summary(f),
    staffPerformance: (f) => staffReportService.performance(f),
    abnormalDiscounts: (f) => staffReportService.abnormalDiscounts(f),
    lastBackupAt: async () => Date.now()
  },
  fetchFor: () => (url, init) => fetch(url, init),
  baseUrls: { telegram: `http://127.0.0.1:${mock.port}/tg`, bale: `http://127.0.0.1:${mock.port}/bale` },
  now: () => clock, schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0
})
const CHAT = { telegram: 4901, bale: 4902 }
for (const provider of ['telegram', 'bale']) {
  await engine.saveBot(provider, TOKENS[provider], '')
  const p = await engine.pairStart(provider)
  mock.updates[PREFIX[provider]].push({ update_id: mock.nextId++, message: { message_id: 1, chat: { id: CHAT[provider], type: 'private', first_name: 'مدیر' }, text: provider === 'telegram' ? `/start ${p.code}` : p.code } })
  await engine.pairPollOnce(0)
  await engine.pairConfirm('all')
}
await engine.setEnabled(true)
async function pump(rounds) {
  for (let i = 0; i < rounds; i++) { clock += 1100; await engine.runOnce({ read: true }) }
}
await pump(2)
const mark = mock.log.length

// ---------------------------------------------------------------- رویدادهای واقعی
const ten = await salesService.create({
  debtor, userId: seller, shiftId,
  lines: variants.slice(0, 10).map((v, i) => L(v.id, v.price, i === 0 ? 2 : 1, i === 1 ? 20_000 : 0)),
  invoiceDiscount: 30_000,
  payments: [{ methodId: cash, amount: 2_000_000, destination: 'CASH' }, { methodId: sepah, amount: 1_500_000 }, { methodId: card, amount: 500_000, destination: 'MANAGER' }]
})
const hundred = await salesService.create({ debtor, userId: seller, shiftId, lines: variants.map((v) => L(v.id, v.price)), payments: [] })
const tenItems = itemsOf(ten.id)
await salesService.createReturn({ invoiceId: ten.id, full: false, lines: [{ saleItemId: tenItems[2], qty: 1 }, { saleItemId: tenItems[3], qty: 1 }], refundMethod: 'NONE', userId: seller })
const pantsSale = await salesService.create({ debtor, userId: seller, shiftId, lines: [L(vPants, 36_000_000, 2)], payments: [{ methodId: cash, amount: 72_000_000, destination: 'CASH' }] })
await salesService.createExchange({ invoiceId: pantsSale.id, lines: [{ saleItemId: itemsOf(pantsSale.id)[0], qty: 1 }], replacements: [{ variantId: vCoat, qty: 1 }], refundMode: 'STORE_CREDIT', methodId: cash, userId: seller, shiftId })
const firstExchange = seed.one('SELECT id, receiptNo FROM "SaleInvoice" WHERE orderType = ? ORDER BY id DESC LIMIT 1', 'EXCHANGE')
await salesService.createExchange({ invoiceId: firstExchange.id, lines: [{ saleItemId: itemsOf(firstExchange.id)[0], qty: 1 }], replacements: [{ variantId: vShirt, qty: 3 }], refundMode: 'STORE_CREDIT', methodId: cash, userId: seller, shiftId })
const secondExchange = seed.one('SELECT id, receiptNo FROM "SaleInvoice" WHERE orderType = ? ORDER BY id DESC LIMIT 1', 'EXCHANGE')
await pump(40)

/** همهٔ رویدادهای فرستاده‌شده به یک گفت‌وگو؛ هر پیام چند رویداد را با جداکنندهٔ ثابت دارد. */
const sent = (provider) => mock.log.slice(mark).filter((e) => e.prefix === PREFIX[provider] && e.chat === CHAT[provider])
const segments = (provider) => sent(provider).flatMap((e) => e.text.split(SEPARATOR))
const segmentsOf = (provider, head) => segments(provider).filter((s) => s.replace(/^⚠️ /, '').startsWith(head))
const R = (n) => `${money(n)} ریال`
/** دفتر آزمون ۴-۳۵: خط زیر سرتیتر و قلم شماره‌دار «  ۱) نام — ۲ × ۱۰۰٬۰۰۰ = ۲۰۰٬۰۰۰ ریال» */
const DIV = '━━━━━━━━━━━━'
const itemOf = (n, name, qty, price, total, discount = '') => `  ${faDigits(n)}) ${faDigits(name)} — ${faDigits(qty)} × ${money(price)}${discount} = ${R(total)}`
const isItem = (l) => /^ {2}[۰-۹]+\) /.test(l)
const variantName = (i) => `کالای آزمون ${i} سایز ${30 + (i % 10)} - ${COLORS[i % COLORS.length]}`

for (const provider of ['telegram', 'bale']) {
  await test(`${provider}: every sent message is within 4096 characters`, () => {
    assert.ok(sent(provider).length > 0)
    for (const e of sent(provider)) assert.ok(e.text.length <= 4096, `length ${e.text.length}`)
  })

  await test(`${provider}: a 10-line sale is one message with every line, the total under the title, the body and the payments`, () => {
    const inv = invoice(ten.id)
    const segs = segmentsOf(provider, `🧾 فروش · فاکتور ${faDigits(inv.receiptNo)} · `)
    assert.equal(segs.length, 1, 'one message, not split')
    const lines = segs[0].split('\n')
    assert.doesNotMatch(lines[0], /بخش/)
    assert.equal(lines[1], DIV, 'a rule under the title (4-35)')
    assert.equal(lines[2], `💰 جمع فاکتور: ${R(Number(inv.grandTotal))} · ۱۰ قلم`, 'the invoice total right under the title')
    assert.equal(lines[3], '🛍 قلم‌ها:')
    assert.equal(lines[4], itemOf(1, variantName(1), 2, 100_000, 200_000))
    assert.equal(lines[5], itemOf(2, variantName(2), 1, 200_000, 180_000, ` · تخفیف ${R(20_000)} (۱۰.۰٪)`))
    for (let i = 3; i <= 10; i++) assert.ok(lines.includes(itemOf(i, variantName(i), 1, 100_000 * i, 100_000 * i)), `line ${i}`)
    assert.ok(lines.includes(`💰 جمع کالاها: ${R(5_600_000)}`))
    assert.ok(lines.some((l) => l.startsWith(`🏷️ تخفیف: ${R(50_000)} (`)))
    assert.ok(lines.includes(`💰 مبلغ فاکتور: ${R(5_550_000)}`))
    assert.ok(lines.includes(`💳 پرداخت: نقدی ${R(2_000_000)} · سپه ${R(1_500_000)} · حساب مدیر ${R(500_000)}`))
    assert.ok(lines.includes(`📒 مانده (نسیه): ${R(1_550_000)}`))
    assert.ok(lines.includes('👤 فروشنده: فروشندهٔ ۴-۹ · شیفت صبح'))
    assert.equal(lines.filter((l) => /(عوارض|هزینهٔ)/.test(l)).length, 0, 'zero charges are not shown')
    assert.ok(lines.some((l) => /^▫️ کد رویداد: A-\d+$/.test(l)), 'the event code in the footer')
  })

  await test(`${provider}: a 100-line sale is split into parts with all 100 lines and the total in part one`, () => {
    const inv = invoice(hundred.id)
    const parts = segmentsOf(provider, `🧾 فروش · فاکتور ${faDigits(inv.receiptNo)} · `)
    assert.ok(parts.length >= 2, `parts: ${parts.length}`)
    parts.forEach((p, i) => assert.match(p.split('\n')[0], new RegExp(`\\(بخش ${faDigits(i + 1)} از ${faDigits(parts.length)}\\)$`)))
    assert.deepEqual(parts[0].split('\n').slice(1, 3), [DIV, `💰 جمع فاکتور: ${R(Number(inv.grandTotal))} · ۱۰۰ قلم`], 'the total is in part one, right under the title')
    const itemLines = parts.flatMap((p) => p.split('\n')).filter(isItem)
    assert.equal(itemLines.length, 100, 'no line is dropped or repeated')
    // ۴-۳۵: شمارهٔ قلم‌ها در بخش بعد ادامه می‌یابد
    for (let i = 1; i <= 100; i++) assert.ok(itemLines.includes(itemOf(i, variantName(i), 1, 100_000 * i, 100_000 * i)), `line ${i}`)
    assert.ok(parts.at(-1).split('\n').includes(`📒 مانده (نسیه): ${R(Number(inv.grandTotal))}`))
  })

  await test(`${provider}: a return lists the returned lines under its total`, () => {
    const segs = segmentsOf(provider, `↩️ برگشت از فروش · فاکتور ${faDigits(invoice(ten.id).receiptNo)} · `)
    assert.equal(segs.length, 1)
    const lines = segs[0].split('\n')
    const ret = seed.one('SELECT total FROM "SaleReturn" WHERE invoiceId = ? ORDER BY id DESC LIMIT 1', ten.id)
    assert.deepEqual(lines.slice(1, 4), [DIV, `💰 جمع برگشت: ${R(Number(ret.total))}`, '🛍 قلم‌ها:'])
    const items = lines.filter(isItem)
    assert.equal(items.length, 2)
    assert.ok(items[0].startsWith(`  ۱) ${faDigits(variantName(3))} — ۱ × ${money(300_000)} = `))
    assert.ok(items[1].startsWith(`  ۲) ${faDigits(variantName(4))} — ۱ × ${money(400_000)} = `))
  })

  await test(`${provider}: an exchange lists both sides; a chained exchange adds the chain line`, () => {
    const first = segmentsOf(provider, `🔄 تعویض کالا · فاکتور ${faDigits(invoice(pantsSale.id).receiptNo)} ← سند ${faDigits(firstExchange.receiptNo)} · `)
    assert.equal(first.length, 1)
    const a = first[0].split('\n')
    assert.equal(a[1], DIV)
    assert.equal(a[2], `💰 جمع کالای برگشتی: ${R(36_000_000)} · جمع کالای جایگزین: ${R(40_000_000)}`)
    assert.match(a[3], /^⚖️ مابه‌التفاوت: /)
    assert.equal(a.some((l) => l.includes('زنجیره:')), false, 'a first exchange has no chain line')
    assert.deepEqual(a.slice(a.indexOf('↩️ کالای برگشتی:'), a.indexOf('↩️ کالای برگشتی:') + 4), [
      '↩️ کالای برگشتی:', itemOf(1, 'شلوار بگ سایز 31 - ذغالی', 1, 36_000_000, 36_000_000), '🛍 کالای جایگزین:', itemOf(1, 'کت سایز 50', 1, 40_000_000, 40_000_000)
    ])
    const chained = segmentsOf(provider, `🔄 تعویض کالا · فاکتور ${faDigits(firstExchange.receiptNo)} ← سند ${faDigits(secondExchange.receiptNo)} · `)
    assert.equal(chained.length, 1)
    const b = chained[0].split('\n')
    assert.equal(b[2], `💰 جمع کالای برگشتی: ${R(40_000_000)} · جمع کالای جایگزین: ${R(5_400_000)}`)
    assert.ok(b.includes(`🔗 زنجیره: فاکتور ${faDigits(invoice(pantsSale.id).receiptNo)} ← سند ${faDigits(firstExchange.receiptNo)} ← سند ${faDigits(secondExchange.receiptNo)}`))
    assert.ok(b.includes(itemOf(1, 'کت سایز 50', 1, 40_000_000, 40_000_000)))
    assert.ok(b.includes(itemOf(1, 'پیراهن سایز L - آبی', 3, 1_800_000, 5_400_000)))
  })

  await test(`${provider}: no return code, credit code or barcode, product barcode or phone`, () => {
    const all = sent(provider).map((e) => e.text).join('\n')
    const secrets = [PHONE, faDigits(PHONE)]
    for (const r of sql.prepare('SELECT returnCode FROM "SaleInvoice" WHERE returnCode IS NOT NULL').all()) secrets.push(r.returnCode)
    for (const r of sql.prepare('SELECT code, legacyCode FROM "StoreCredit"').all()) secrets.push(r.code, r.legacyCode)
    for (const r of sql.prepare('SELECT code, barcode FROM "ProductVariant"').all()) secrets.push(r.code, r.barcode)
    const list = secrets.filter((v) => typeof v === 'string' && v.length >= 4)
    assert.ok(list.length > 200)
    for (const v of list) assert.equal(all.includes(v), false, `leaked ${v}`)
  })
}

await new Promise((resolve) => { mock.server.close(() => resolve()); mock.server.closeAllConnections() })
await db.$disconnect?.()
