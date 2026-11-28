/**
 * دفتر آزمون ۴-۳۵ — قالب یکدست همهٔ پیام‌های تلگرام و بله، همه در `messengerFormat.ts`:
 *  - هر نوع پیام قالب درست دارد: سرتیتر (نشانهٔ نوع، نام کار، تاریخ و ساعت در یک خط)، خط «━━━━━━━━━━━━» زیر سرتیتر
 *    پیام چندبخشی، یک نشانهٔ ثابت برای هر برچسب، «🛍 قلم‌ها:» و فهرست شماره‌دار، پایینِ جدا («▫️ کد رویداد»، «🕒»، «🔁»)
 *    و ⚠️ پیام مهم فقط یک بار؛ نمونهٔ هدف فاکتور فروش دفتر، خط به خط؛ رقم فارسی؛ راست‌چین (خط لاتین‌آغاز با RLM)؛
 *    متن ساده، بی HTML یا Markdown؛
 *  - مرز پیام‌های پشت سر هم با «✦ — — — ✦» و خط خالی دو طرفش روشن است، و «— — —» قدیمی را در خودش دارد؛
 *  - پیام بلند درست چند بخش می‌شود: هر بخش زیر سقف، هیچ خطی جا نمی‌افتد یا تکرار نمی‌شود، شمارهٔ قلم‌ها ادامه می‌یابد؛
 *  - روی موتور واقعی، پایگاه موقت و سرویس‌های واقعی فروش، با سرور ساختگی Bot API برای تلگرام و بله: فروش، برگشت،
 *    شمارش صندوق و فروش ۱۵۰ قلمی پشت سر هم، مرتب و خوانا.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-35-uniform-format.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TZ = 'Asia/Tehran'
const ROOT = mkdtempSync(join(tmpdir(), 'mahak-tl-4-35-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const F = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')
const { auditPageToEvents, custodyCountToEvents, emptyLookups, shiftEndReminder } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { faDigits, money, toJalaliDate } = await import('@shared/jalali')

const DIV = '━━━━━━━━━━━━'
const RLM = '\u200F'
/** ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰ به وقت تهران، همان لحظهٔ نمونهٔ دفتر */
const AT = Date.UTC(2026, 10, 24, 10, 50)
const ctxOf = (data, extra = {}) => ({ offsetHours: 0, threshold: 0, includeCustomerName: false, data, ...extra })
const eventsOf = (rows, data) => auditPageToEvents(rows, ctxOf(data), { closeShiftIds: [] })
const asItem = (ev, extra = {}) => ({ code: ev.code, at: ev.at, title: ev.title, lines: ev.lines, important: ev.important, maybeDup: false, sale: !!ev.sale, day: null, ...extra })
const auditRow = (id, action, after, entity = 'SaleInvoice') => ({ id, at: AT, userId: 5, action, entity, entityId: id, after: JSON.stringify(after), note: null })
const L = (name, qty, unitPrice, discount = 0) => ({ name, qty, unitPrice, discount, lineTotal: qty * unitPrice - discount })
const lookups = () => { const data = emptyLookups(); data.users.set(5, 'علی'); return data }
/** پایین پیام: «▫️ کد رویداد» و پس از آن فقط برچسب‌های لحظهٔ ارسال */
function footerOf(lines) {
  const at = lines.findIndex((l) => /^▫️ کد رویداد: [A-Z]-[0-9a-z-]+$/.test(l))
  assert.ok(at > 0, lines.join('\n'))
  for (const l of lines.slice(at + 1)) assert.match(l, /^(🕒 ارسال با تأخیر|🔁 ممکن است تکراری باشد)/)
  return at
}
/** شکل یک پیام: سرتیتر با نشانه و ساعت، خط زیرش برای چندبخشی، بدنهٔ نشانه‌دار، فهرست شماره‌دار پیوسته و پایینِ جدا */
function assertShape(text) {
  const lines = text.split('\n')
  const head = lines[0].replace(RLM, '')
  assert.match(head, /^(⚠️ )?\p{Extended_Pictographic}/u, `header starts with a sign: ${head}`)
  assert.equal(/⚠️/.test(head.slice(2)), false, `⚠️ once: ${head}`)
  assert.match(head, / [۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}(?: ساعت [۰-۹]{2}:[۰-۹]{2})?(?: \(بخش [۰-۹]+ از [۰-۹]+\))?$/, `date (and time) on the header line: ${head}`)
  const end = footerOf(lines)
  const body = lines.slice(1, end)
  if (body.filter((l) => l !== '' && l !== DIV).length >= 3) assert.equal(lines[1], DIV, 'a rule under the header of a multi-part message')
  // فهرست شماره‌دار پیوسته است و از ۱ آغاز می‌شود؛ فقط بخش دوم به بعدِ پیام بلند می‌تواند با ادامهٔ شماره‌ها آغاز شود
  const continued = /\(بخش [۰-۹]+ از [۰-۹]+\)$/.test(head) && !/\(بخش ۱ از /.test(head)
  let prev = 0, atStart = true
  for (const raw of body) {
    const l = raw.replace(RLM, '')
    assert.equal(/^\s*• /.test(l), false, `bullets become a numbered list: ${l}`)
    const item = /^ {2}([۰-۹]+)\) /.exec(l)
    if (item) {
      const k = Number(item[1].replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))))
      assert.equal(k, prev ? prev + 1 : (continued && atStart ? k : 1), `numbered in order: ${l}`)
      prev = k
    } else {
      prev = 0
      if (l !== DIV) atStart = false
    }
    const label = /^([\p{L}][^:]{0,46}):/u.exec(l)
    if (label) assert.equal(F.LABEL_SIGNS.has(label[1].replace(/\s*\([^()]*\)\s*$/, '').trim()), false, `a known label without its sign: ${l}`)
    if (/^[A-Za-z]/.test(l.trimStart().replace(/^[۰-۹]+\) /, ''))) assert.ok(raw.startsWith(RLM), `a Latin-first line starts with RLM: ${l}`)
  }
  assert.equal(/<\/?[a-z][^>]*>|\*\*|__|`/i.test(text), false, 'plain text: no HTML or Markdown')
}

// ---------------------------------------------------------------- واحد: هر نوع پیام
test('the target sale sample of the test log, line by line', () => {
  const data = lookups()
  data.saleDocs.set(412, {
    goodsTotal: 7_200_000, discountTotal: 0, taxTotal: 0, serviceCharge: 0, deliveryFee: 0, grandTotal: 7_200_000,
    lines: [L('پیراهن مردانه · آبی · L', 2, 1_800_000), L('شلوار جین · ۳۲', 1, 3_600_000)],
    payments: [{ label: 'نقد', amount: 3_600_000 }, { label: 'کارت', amount: 3_600_000 }]
  })
  const [ev] = eventsOf([auditRow(412, 'SALE_CREATE', { receiptNo: 123, grandTotal: 7_200_000, lines: 2 })], data)
  const text = F.renderItem(asItem(ev), AT)
  assert.equal(text, [
    '🧾 فروش · فاکتور ۱۲۳ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰',
    DIV,
    '💰 جمع فاکتور: ۷٬۲۰۰٬۰۰۰ ریال · ۲ قلم',
    '🛍 قلم‌ها:',
    '  ۱) پیراهن مردانه · آبی · L — ۲ × ۱٬۸۰۰٬۰۰۰ = ۳٬۶۰۰٬۰۰۰ ریال',
    '  ۲) شلوار جین · ۳۲ — ۱ × ۳٬۶۰۰٬۰۰۰ = ۳٬۶۰۰٬۰۰۰ ریال',
    '💰 جمع کالاها: ۷٬۲۰۰٬۰۰۰ ریال',
    '💰 مبلغ فاکتور: ۷٬۲۰۰٬۰۰۰ ریال',
    '💳 پرداخت: نقد ۳٬۶۰۰٬۰۰۰ ریال · کارت ۳٬۶۰۰٬۰۰۰ ریال',
    '👤 فروشنده: علی',
    '▫️ کد رویداد: A-412'
  ].join('\n'))
  assertShape(text)
  assert.equal(/[0-9]/.test(text.replace(/A-412$/, '')), false, 'Persian digits everywhere except the event code')
  // خط‌های سازنده همان «برچسب: مقدار» ساده می‌مانند (گزارش گوشی و آزمون‌های قدیمی همان را می‌خوانند)؛ قالب هنگام فرستادن می‌نشیند
  assert.deepEqual(ev.lines.slice(0, 3), ['جمع فاکتور: ۷٬۲۰۰٬۰۰۰ ریال · ۲ قلم', 'قلم‌ها:', '• پیراهن مردانه · آبی · L — ۲ × ۱٬۸۰۰٬۰۰۰ = ۳٬۶۰۰٬۰۰۰ ریال'])
})

test('return and exchange: the total under the rule, «🛍 قلم‌ها:» or both lists numbered from ۱, the chain line, ⚠️ once, RLM for a Latin name', () => {
  const data = lookups()
  data.returnDocs.set(51, { lines: [L('کت سایز ۵۰', 1, 4_000_000), L('Nike Air · ۴۲', 2, 1_000_000, 200_000)], replacement: null, chain: [] })
  data.returnDocs.set(52, { lines: [L('کت سایز ۵۰', 1, 4_000_000)], replacement: [L('پیراهن سایز L - آبی', 3, 1_800_000)], chain: [10, 11, 12] })
  const [ret] = eventsOf([auditRow(51, 'SALE_RETURN', { receiptNo: 10, total: 5_800_000 }, 'SaleReturn')], data)
  const r = F.renderItem(asItem(ret), AT)
  assert.deepEqual(r.split('\n'), [
    '⚠️ ↩️ برگشت از فروش · فاکتور ۱۰ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰',
    DIV,
    '💰 جمع برگشت: ۵٬۸۰۰٬۰۰۰ ریال',
    '🛍 قلم‌ها:',
    '  ۱) کت سایز ۵۰ — ۱ × ۴٬۰۰۰٬۰۰۰ = ۴٬۰۰۰٬۰۰۰ ریال',
    `${RLM}  ۲) Nike Air · ۴۲ — ۲ × ۱٬۰۰۰٬۰۰۰ · تخفیف ۲۰۰٬۰۰۰ ریال (۱۰.۰٪) = ۱٬۸۰۰٬۰۰۰ ریال`,
    '👤 فروشنده: علی',
    '▫️ کد رویداد: A-51'
  ])
  assertShape(r)
  const [ex] = eventsOf([auditRow(52, 'SALE_EXCHANGE', { sourceReceiptNo: 11, exchangeReceiptNo: 12, returnTotal: 4_000_000, exchangeTotal: 5_400_000, diff: 1_400_000 }, 'SaleReturn')], data)
  const x = F.renderItem(asItem(ex), AT)
  const lines = x.split('\n')
  assert.equal(lines[0], '⚠️ 🔄 تعویض کالا · فاکتور ۱۱ ← سند ۱۲ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰')
  assert.deepEqual(lines.slice(1, 3), [DIV, '💰 جمع کالای برگشتی: ۴٬۰۰۰٬۰۰۰ ریال · جمع کالای جایگزین: ۵٬۴۰۰٬۰۰۰ ریال'])
  assert.match(lines[3], /^⚖️ مابه‌التفاوت: ۱٬۴۰۰٬۰۰۰ ریال · /)
  assert.ok(lines.includes('🔗 زنجیره: فاکتور ۱۰ ← سند ۱۱ ← سند ۱۲'))
  const at = lines.indexOf('↩️ کالای برگشتی:')
  assert.deepEqual(lines.slice(at, at + 4), [
    '↩️ کالای برگشتی:', '  ۱) کت سایز ۵۰ — ۱ × ۴٬۰۰۰٬۰۰۰ = ۴٬۰۰۰٬۰۰۰ ریال',
    '🛍 کالای جایگزین:', '  ۱) پیراهن سایز L - آبی — ۳ × ۱٬۸۰۰٬۰۰۰ = ۵٬۴۰۰٬۰۰۰ ریال'
  ])
  assertShape(x)
})

test('count, alert and news: the same header, signs and footer; ⚠️ once; the late and duplicate labels after the code', () => {
  const data = lookups()
  const [count] = custodyCountToEvents({ id: 9, kind: 'SPOT', shiftId: 1, handoverId: null, countedByUserId: 5, countedCash: 10_000_000, expectedCash: 15_000_000, differenceCash: -5_000_000, at: new Date(AT) }, ctxOf(data, { threshold: 1_000_000 }))
  const c = F.renderItem(asItem(count), AT)
  assert.deepEqual(c.split('\n'), [
    '⚠️ 🚨 مغایرت بزرگ در شمارش صندوق (حضانت) · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰',
    DIV,
    '👤 شمارنده: علی',
    '🧮 شمرده: ۱۰٬۰۰۰٬۰۰۰ ریال · مرجع: ۱۵٬۰۰۰٬۰۰۰ ریال · مغایرت: ۵٬۰۰۰٬۰۰۰ ریال کسری',
    '⚖️ سقف مجاز مغایرت: ۱٬۰۰۰٬۰۰۰ ریال',
    '▫️ کد رویداد: K-9'
  ])
  assertShape(c)
  // ۴-۲۶: دو خط ⇐ بی خط زیر سرتیتر؛ نشانهٔ «👤» همان نشانهٔ فروشنده و کاربر در پیام‌های دیگر
  const end = new Date(AT); end.setHours(14, 0, 0, 0)
  const plans = [{ startMinute: 480, durationMinutes: 360, daysMask: 127 }, { startMinute: 840, durationMinutes: 480, daysMask: 127 }]
  const reminder = shiftEndReminder({ shiftId: 7, shiftName: 'صبح', custodianName: 'علی', scheduledEndAt: end.getTime(), dayCutoverMinutes: 300, mode: 'MULTI_SHIFT', handoverPending: false, plans }, end.getTime() + 15 * 60_000, new Set(), 0)
  const h = F.renderItem(asItem(reminder.event), end.getTime() + 15 * 60_000)
  assert.deepEqual(h.split('\n'), [
    '⏰ تحویل شیفت انجام نشده · «صبح» · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۱۵',
    '۱۵ دقیقه از پایان شیفت گذشته (پایان برنامه: ساعت ۱۴:۰۰)',
    '👤 مسئول صندوق: علی',
    `▫️ کد رویداد: ${reminder.event.code}`
  ])
  assertShape(h)
  // خبر بی خط، پیام مهم دیررسیده با برچسب تکرار، و عنوانی که خودش ⚠️ دارد
  const news = { code: 'S-1', at: AT, title: '🟢 برنامه روشن شد · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', lines: [], important: false, maybeDup: false, sale: false, day: null }
  assert.equal(F.renderItem(news, AT), '🟢 برنامه روشن شد · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰\n▫️ کد رویداد: S-1')
  const late = F.renderItem({ ...news, code: 'A-7', title: '🧾 فروش · فاکتور ۷ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', lines: ['جمع فاکتور: ۱۰۰ ریال'], important: true, maybeDup: true }, AT + 10 * 60_000)
  assert.deepEqual(late.split('\n'), ['⚠️ 🧾 فروش · فاکتور ۷ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', '💰 جمع فاکتور: ۱۰۰ ریال', '▫️ کد رویداد: A-7', '🕒 ارسال با تأخیر', '🔁 ممکن است تکراری باشد (ارسال قبلی نامعلوم ماند)'])
  assertShape(late)
  assert.equal(F.renderItem({ ...news, title: '⚠️ صندوق بسته نشد · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', important: true }, AT).startsWith('⚠️ ⚠️'), false, 'no double warning')
  // «— — —» کهنه در متن خود برنامه دیگر نیست؛ جداکنندهٔ تازه آن را در خود دارد
  assert.equal(F.SEPARATOR, '\n\n✦ — — — ✦\n\n')
  assert.ok(F.SEPARATOR.includes('— — —'))
})

test('24:00 summary and bot reports: grouped seller section, numbered rows under their sub-header, the same signs', () => {
  const summaryLines = [
    'بازه: ۱۴۰۵/۰۹/۰۳، ساعت ۰۰:۰۰ تا ۲۴:۰۰ (روز تقویمی گزارش‌های برنامه)',
    'فروش: ۳ فاکتور · جمع ۹٬۰۰۰٬۰۰۰ ریال',
    'برگشت: ۱ · تعویض: ۰',
    'بستن‌های صندوق: ۲',
    '  • علی: تطبیق کامل',
    '  • رضا: ۵۰٬۰۰۰ ریال کسری',
    'آخرین بکاپ موفق: پیدا نشد',
    '⚠️ دو روز است بکاپ موفقی گرفته نشده است.',
    ...F.groupedSection('به تفکیک فروشنده', [['👤 علی', 'فاکتور ۲ · برگشت ۱', 'تخفیف غیرعادی ۰'], ['👤 رضا', 'فاکتور ۱ · برگشت ۰', 'تخفیف غیرعادی ۰']])
  ]
  const d = F.renderItem({ code: 'D-14050903', at: AT, title: '📊 خلاصهٔ روز ۱۴۰۵/۰۹/۰۳', lines: summaryLines, important: false, maybeDup: false, sale: false, day: null }, AT)
  assert.deepEqual(d.split('\n'), [
    '📊 خلاصهٔ روز ۱۴۰۵/۰۹/۰۳',
    DIV,
    '📅 بازه: ۱۴۰۵/۰۹/۰۳، ساعت ۰۰:۰۰ تا ۲۴:۰۰ (روز تقویمی گزارش‌های برنامه)',
    '🛒 فروش: ۳ فاکتور · جمع ۹٬۰۰۰٬۰۰۰ ریال',
    '↩️ برگشت: ۱ · تعویض: ۰',
    '🧮 بستن‌های صندوق: ۲',
    '  ۱) علی: تطبیق کامل',
    '  ۲) رضا: ۵۰٬۰۰۰ ریال کسری',
    '💾 آخرین بکاپ موفق: پیدا نشد',
    '⚠️ دو روز است بکاپ موفقی گرفته نشده است.',
    '👥 به تفکیک فروشنده:',
    '👤 علی',
    '  فاکتور ۲ · برگشت ۱',
    '  تخفیف غیرعادی ۰',
    '',
    '👤 رضا',
    '  فاکتور ۱ · برگشت ۰',
    '  تخفیف غیرعادی ۰',
    '▫️ کد رویداد: D-14050903'
  ])
  assertShape(d)
  // گزارش ربات (۴-۳۳) و درخواست مجوز (۴-۳۰) همان `formatMessage` را دارند، بی پایین کد رویداد
  const report = F.formatMessage('🧾 فروش · ۱۴۰۵/۰۹/۰۳', ['زمان گزارش: ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', 'شمار فاکتور: ۱ · جمع فروش: ۳٬۶۰۰٬۰۰۰ ریال', '', '🧾 فاکتور ۱۲ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۱۰ · ۳٬۶۰۰٬۰۰۰ ریال · فروشنده: علی', F.itemLine('شلوار جین · ۳۲', 1, 3_600_000, { total: 3_600_000 }), F.itemLine('Socks', 2, 0)])
  assert.deepEqual(report.split('\n'), [
    '🧾 فروش · ۱۴۰۵/۰۹/۰۳', DIV, '🕘 زمان گزارش: ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', '🔢 شمار فاکتور: ۱ · جمع فروش: ۳٬۶۰۰٬۰۰۰ ریال', '',
    '🧾 فاکتور ۱۲ · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۱۰ · ۳٬۶۰۰٬۰۰۰ ریال · فروشنده: علی',
    '  ۱) شلوار جین · ۳۲ — ۱ × ۳٬۶۰۰٬۰۰۰ = ۳٬۶۰۰٬۰۰۰ ریال', `${RLM}  ۲) Socks — ۲ عدد`
  ])
  const request = F.formatMessage('🔐 درخواست مجوز از رایانهٔ فروشگاه · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', ['قفل: کالاها', 'کد مقایسه: 4821', 'پنجرهٔ ۳', 'کد را با کدی که فروشنده می‌بیند مقایسه کنید.'])
  assert.deepEqual(request.split('\n').slice(0, 4), ['🔐 درخواست مجوز از رایانهٔ فروشگاه · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', DIV, '🔒 قفل: کالاها', '🔎 کد مقایسه: 4821'])
})

test('signs: one fixed sign per label, with or without a trailing parenthesis; unknown labels, signed lines and bullets keep their shape; idempotent', () => {
  for (const [label, sign] of F.LABEL_SIGNS) {
    assert.equal(F.signLine(`${label}: ۱`), `${sign} ${label}: ۱`, label)
    assert.equal(F.signLine(`${label} (توضیح): ۱`), `${sign} ${label} (توضیح): ۱`, `${label} (…)`)
  }
  for (const [label, sign] of [['فروشنده', '👤'], ['کاربر', '👤'], ['مسئول صندوق', '👤'], ['پرداخت', '💳'], ['جمع فاکتور', '💰'], ['قلم‌ها', '🛍']]) assert.equal(F.LABEL_SIGNS.get(label), sign, label)
  for (const same of ['برچسب ناشناخته: ۱', '💰 جمع: ۱', '⚠️ هشدار: ۱', '  فاکتور ۲ · برگشت ۱', 'ساعت ۱۴:۲۰ گذشت', '', DIV]) assert.equal(F.signLine(same), same)
  const body = ['جمع فاکتور: ۱', 'قلم‌ها:', '• الف — ۱ عدد', '• ب — ۲ عدد', 'کالای جایگزین:', '• ج — ۳ عدد', '', '  • د: ۱']
  const once = F.formatBody(body)
  assert.deepEqual(once, ['💰 جمع فاکتور: ۱', '🛍 قلم‌ها:', '  ۱) الف — ۱ عدد', '  ۲) ب — ۲ عدد', '🛍 کالای جایگزین:', '  ۱) ج — ۳ عدد', '', '  ۱) د: ۱'])
  assert.deepEqual(F.formatBody(once), once, 'formatting a formatted body changes nothing')
  assert.equal(F.rtlLine('Nike'), `${RLM}Nike`)
  assert.equal(F.rtlLine('  ۲) Nike — ۱ عدد'), `${RLM}  ۲) Nike — ۱ عدد`)
  for (const fa of ['کت', '  ۱) کت — ۱ عدد', '🧾 فروش', '۱۲ قلم', DIV, '✦ — — — ✦']) assert.equal(F.rtlLine(fa), fa)
})

// ---------------------------------------------------------------- واحد: مرز پیام‌ها و پیام بلند
const saleOf = (n, latin = false) => {
  const data = lookups()
  const lines = Array.from({ length: n }, (_, i) => L(`${latin ? 'Item' : 'کالای آزمون'} ${i + 1} سایز ${30 + (i % 10)}`, 1 + (i % 3), 100_000 * (i + 1)))
  const grand = lines.reduce((s, l) => s + l.lineTotal, 0)
  data.saleDocs.set(700 + n, { goodsTotal: grand, discountTotal: 0, taxTotal: 0, serviceCharge: 0, deliveryFee: 0, grandTotal: grand, lines, payments: [{ label: 'نقد', amount: grand }] })
  const ev = eventsOf([auditRow(700 + n, 'SALE_CREATE', { receiptNo: n, grandTotal: grand, lines: n })], data)[0]
  ev.grand = grand
  return ev
}

test('packed messages: «✦ — — — ✦» with a blank line on each side; every piece whole, in order, with its own header and footer', () => {
  const items = [asItem(saleOf(2)), { code: 'S-2', at: AT + 1000, title: '🟢 برنامه روشن شد · ۱۴۰۵/۰۹/۰۳ ساعت ۱۴:۲۰', lines: [], important: false, maybeDup: false, sale: false, day: null }, asItem(saleOf(3, true), { at: AT + 2000 })]
  const packed = F.packItems(items, AT + 3000, 4096)
  assert.equal(packed.count, 3)
  assert.equal(packed.texts.length, 1)
  const pieces = packed.texts[0].split(F.SEPARATOR)
  assert.deepEqual(pieces, items.map((i) => F.renderItem(i, AT + 3000)), 'the separator splits it back into the very messages')
  assert.equal(packed.texts[0].split('\n').filter((l) => l === '✦ — — — ✦').length, 2)
  assert.equal(packed.texts[0].split('— — —').length, 3, 'the old «— — —» is inside the new separator')
  for (const p of pieces) assertShape(p)
  // سقف کوچک: فقط پیام‌های کامل در یک پیام می‌آیند، هیچ پیامی نیمه نمی‌شود
  const many = Array.from({ length: 30 }, (_, i) => asItem(saleOf(2), { code: `A-${i + 1}`, at: AT + i }))
  const small = F.packItems(many, AT + 100, 1000)
  assert.ok(small.count > 1 && small.count < 30 && small.texts[0].length <= 1000)
  assert.deepEqual(small.texts[0].split(F.SEPARATOR), many.slice(0, small.count).map((i) => F.renderItem(i, AT + 100)))
})

test('a long message splits correctly: every part within the limit with the worst footer, nothing lost or repeated, numbering goes on', () => {
  for (const latin of [false, true]) {
    const ev = saleOf(150, latin)
    const item = asItem(ev)
    const limit = 4096 - 120
    assert.ok(F.renderItem(item, AT).length > limit, 'really longer than one message')
    const parts = F.splitLines(item, limit)
    assert.ok(parts.length >= 2, `parts: ${parts.length}`)
    parts.forEach((lines, i) => {
      const part = { ...item, title: `${item.title} (بخش ${faDigits(i + 1)} از ${faDigits(parts.length)})`, lines, important: true, maybeDup: true }
      const text = F.renderItem(part, AT + 10 * 60_000)
      assert.ok(text.length <= limit, `part ${i + 1}: ${text.length}`)
      assertShape(text)
    })
    assert.deepEqual(parts.flat(), F.formatBody(ev.lines), 'nothing lost, nothing repeated, the same order')
    const numbers = parts.flat().map((l) => /^ {2}([۰-۹]+)\) /.exec(l)?.[1]).filter(Boolean)
    assert.deepEqual(numbers, Array.from({ length: 150 }, (_, i) => faDigits(i + 1)), 'items ۱ to ۱۵۰, once each, across the parts')
    assert.deepEqual(parts[0].slice(0, 2), [`💰 جمع فاکتور: ${money(ev.grand)} ریال · ۱۵۰ قلم`, '🛍 قلم‌ها:'], 'the total in part one, right under the title')
  }
})

// ---------------------------------------------------------------- موتور واقعی، تلگرام و بله
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const seller = seed.user('فروشندهٔ ۴-۳۵')
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const cat = seed.category('پوشاک')
const mk = (name, size, price) => {
  const id = seed.variant(seed.product(name, cat), size)
  sql.prepare('UPDATE "ProductVariant" SET stock = 1000, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
const vShirt = mk('پیراهن مردانه', 'L', 1_800_000), vJeans = mk('Levis 501', '32', 3_600_000)
const many = Array.from({ length: 150 }, (_, i) => mk(`کالای ${i + 1}`, String(30 + (i % 10)), 10_000 * (i + 1)))
const today = toJalaliDate(new Date())
const shiftId = seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: today, openedAt: Date.now() - 3_600_000, userId: seller, staffConfirmed: 1 })
const line = (variantId, unitPrice, qty = 1) => ({ variantId, qty, unitPrice, discount: 0, tax: 0 })

const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}
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
  server.unref() // اگر آماده‌سازی خطا دهد، فرایند بسته می‌شود و نمی‌ماند
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
const CHAT = { telegram: 4351, bale: 4352 }
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

// همان ترتیب آزمون مالک: فروش، برگشت، شمارش صندوق؛ و یک فروش ۱۵۰ قلمی
await pump(1)
const sale = await salesService.create({ userId: seller, shiftId, lines: [line(vShirt, 1_800_000, 2), line(vJeans, 3_600_000)], payments: [{ methodId: cash, amount: 7_200_000, destination: 'CASH' }] })
const saleItems = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', sale.id).map((r) => r.id)
await salesService.createReturn({ invoiceId: sale.id, full: false, lines: [{ saleItemId: saleItems[1], qty: 1 }], refundMethod: 'CASH', userId: seller })
seed.insert('CustodyCount', { shiftId, kind: 'SPOT', countedCash: 10_000_000, expectedCash: 15_000_000, differenceCash: -5_000_000, countedByUserId: seller, authMethod: 'CUSTODY_PIN', epochAtCount: 0, idempotencyKey: 'tl-4-35', at: Date.now(), operationalDay: today })
await pump(12)
const big = await salesService.create({ userId: seller, shiftId, lines: many.map((v, i) => line(v, 10_000 * (i + 1))), payments: [{ methodId: cash, amount: many.reduce((s, _, i) => s + 10_000 * (i + 1), 0), destination: 'CASH' }] })
await pump(40)
const receipt = (id) => faDigits(seed.one('SELECT receiptNo FROM "SaleInvoice" WHERE id = ?', id).receiptNo)

for (const provider of ['telegram', 'bale']) {
  await test(`${provider}: a sale, a return and a cash count in a row: one tidy message with clear borders, every piece in the uniform format`, () => {
    const sent = mock.log.slice(mark).filter((e) => e.prefix === PREFIX[provider] && e.chat === CHAT[provider]).map((e) => e.text)
    assert.ok(sent.length > 0)
    for (const t of sent) assert.ok(t.length <= 4096, `length ${t.length}`)
    const packed = sent.find((t) => t.includes(`🧾 فروش · فاکتور ${receipt(sale.id)} · `))
    assert.ok(packed && packed.includes('\n\n✦ — — — ✦\n\n'), 'the sale, the return and the count go together, with the separator between them')
    assert.ok(packed.includes(`↩️ برگشت از فروش · فاکتور ${receipt(sale.id)} · `) && packed.includes('🚨 مغایرت بزرگ در شمارش صندوق'), packed.slice(0, 300))
    const pieces = sent.flatMap((t) => t.split(F.SEPARATOR))
    for (const p of pieces) assertShape(p)
    const s = pieces.find((p) => p.startsWith(`🧾 فروش · فاکتور ${receipt(sale.id)} · `)).split('\n')
    assert.deepEqual(s.slice(1, 6), [DIV, `💰 جمع فاکتور: ${money(7_200_000)} ریال · ۲ قلم`, '🛍 قلم‌ها:', `  ۱) پیراهن مردانه سایز L — ۲ × ${money(1_800_000)} = ${money(3_600_000)} ریال`, `${RLM}  ۲) Levis ۵۰۱ سایز ۳۲ — ۱ × ${money(3_600_000)} = ${money(3_600_000)} ریال`])
    assert.ok(s.includes(`💳 پرداخت: نقدی ${money(7_200_000)} ریال`) && s.includes('👤 فروشنده: فروشندهٔ ۴-۳۵ · شیفت صبح'))
    const r = pieces.find((p) => p.startsWith(`⚠️ ↩️ برگشت از فروش · فاکتور ${receipt(sale.id)} · `)).split('\n')
    assert.deepEqual(r.slice(1, 5), [DIV, `💰 جمع برگشت: ${money(3_600_000)} ریال`, '🛍 قلم‌ها:', `${RLM}  ۱) Levis ۵۰۱ سایز ۳۲ — ۱ × ${money(3_600_000)} = ${money(3_600_000)} ریال`])
    const k = pieces.find((p) => p.startsWith('⚠️ 🚨 مغایرت بزرگ در شمارش صندوق (حضانت) · ')).split('\n')
    assert.deepEqual(k.slice(1, 4), [DIV, '👤 شمارنده: فروشندهٔ ۴-۳۵', `🧮 شمرده: ${money(10_000_000)} ریال · مرجع: ${money(15_000_000)} ریال · مغایرت: ${money(5_000_000)} ریال کسری`])
  })

  await test(`${provider}: a 150-line sale in parts: each within 4096 with its header and «(بخش i از n)», all 150 lines numbered once, in order`, () => {
    const sent = mock.log.slice(mark).filter((e) => e.prefix === PREFIX[provider] && e.chat === CHAT[provider]).map((e) => e.text)
    const parts = sent.flatMap((t) => t.split(F.SEPARATOR)).filter((p) => p.startsWith(`🧾 فروش · فاکتور ${receipt(big.id)} · `))
    assert.ok(parts.length >= 2, `parts: ${parts.length}`)
    parts.forEach((p, i) => assert.match(p.split('\n')[0], new RegExp(`\\(بخش ${faDigits(i + 1)} از ${faDigits(parts.length)}\\)$`)))
    assert.equal(parts[0].split('\n')[2], `💰 جمع فاکتور: ${money(many.reduce((s, _, i) => s + 10_000 * (i + 1), 0))} ریال · ۱۵۰ قلم`)
    const numbers = parts.flatMap((p) => p.split('\n')).map((l) => /^ {2}([۰-۹]+)\) کالای ([۰-۹]+) /.exec(l)).filter(Boolean)
    assert.deepEqual(numbers.map((m) => m[1]), Array.from({ length: 150 }, (_, i) => faDigits(i + 1)), 'numbering goes on across the parts')
    assert.deepEqual(numbers.map((m) => m[2]), Array.from({ length: 150 }, (_, i) => faDigits(i + 1)), 'every line once, in order')
  })
}

await new Promise((resolve) => { mock.server.close(() => resolve()); mock.server.closeAllConnections() })
await db.$disconnect?.()
