/**
 * طرح ۱۴۰۵ · مورد ۱۲ — گواهی اعتبار برگشت و تعویض (معماری §۴-۳ و §۸-۲).
 *
 * سرویس‌ها و هندلرهای واقعی IPC اجرا می‌شوند؛ فقط چاپگر سیستم با ماک s129 شبیه‌سازی می‌شود و پایگاه داده موقت
 * است. هیچ پایگاه دادهٔ واقعی یا چاپگر واقعی لمس نمی‌شود. این آزمون جای آزمون دستگاه مالک (§۱۳) را نمی‌گیرد.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-credit-print-seller.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'plan1405-credit-print-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
register('./support/s129-hooks.mjs', import.meta.url)

const mock = await import('./support/s129-electron-mock.mjs')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 140512, isDestroyed: () => false, once: () => {} }

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { exchangeReceiptHtml } = await import('../../src/main/print/templates.ts')
const seller = await import('../../src/main/services/storeCreditSellerReprint.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { notePanelUnlocked, clearPanelSessions } = await import('../../src/main/services/panelSession.ts')
const { IPC } = await import('../../src/shared/ipc.ts')
const { DEFAULT_RECEIPT_TEMPLATE, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { DEFAULT_CREDIT_SETTINGS } = await import('../../src/shared/credit.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const ui = await import('../../src/shared/creditUi.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const userId = seed.user('فروشنده آزمون گواهی')
const shiftId = seed.insert('Shift', { name: 'شیفت صبح آزمون', number: 1, dayJalali: today, openedAt: Date.now() - 60_000, userId })
let shift2Id = null
const cashMethodId = seed.insert('PaymentMethod', { key: 'P1405-CERT-CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const categoryId = seed.category('دسته آزمون گواهی')
const productId = seed.product('کالای آزمون گواهی', categoryId)
seed.setting(SETTING_KEYS.receiptTemplate, { ...DEFAULT_RECEIPT_TEMPLATE, printerName: 'Axiom', printMethod: 'CHROMIUM' })
seed.creditSettings(DEFAULT_CREDIT_SETTINGS)
seed.setting(SETTING_KEYS.panelLocks, { [PANEL_KEYS.salesReturn]: true, [PANEL_KEYS.creditManagement]: true, [PANEL_KEYS.settings]: true })

let variantNo = 0
const variant = (price) => {
  const id = seed.variant(productId, `گواهی-${++variantNo}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100,salePrice=? WHERE id=?').run(price, id)
  return id
}
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
const itemsOf = (invoiceId) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId).map((r) => Number(r.id))
const returnCredit = async (price, shift = shiftId) => {
  const v = variant(price)
  const sale = await salesService.create({ userId, shiftId: shift, lines: [line(v, price)], payments: [{ methodId: cashMethodId, amount: price, destination: 'CASH' }] })
  const returned = await salesService.createReturn({
    invoiceId: sale.id, full: false, lines: [{ saleItemId: itemsOf(sale.id)[0], qty: 1 }],
    refundMethod: 'STORE_CREDIT', refundAmount: price, userId, shiftId: shift
  })
  return Number(returned.storeCredit.id)
}
const credit = (id) => seed.one('SELECT * FROM "StoreCredit" WHERE id=?', id)
const sellerRows = (id) => seed.rows('SELECT id,userId,after FROM "AuditLog" WHERE action=\'CREDIT_REPRINT\' AND entityId=? ORDER BY id', id)
  .map((r) => ({ ...r, a: JSON.parse(r.after) }))
  .filter((r) => String(r.a?.path ?? '').startsWith('SELLER_CERTIFICATE'))
const printers = (list) => {
  mock.reset()
  mock.state.printers = list.map((p) => ({ ...p }))
  mock.state.executeJavaScriptOutcome = 500
}
const REAL = [{ name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: true }, { name: 'Axiom', displayName: 'Axiom', isDefault: false }]

registerIpcHandlers()
const invoke = (channel, payload) => {
  const fn = handlers.get(channel)
  assert.ok(fn, `handler for ${channel}`)
  return fn({ sender }, payload)
}

let checks = 0
const ok = (label, cond) => {
  assert.ok(cond, label)
  checks++
  console.log(`  ✓ ${label}`)
}

try {
  console.log('\n— ۱) نام چاپگر مجازی و سند تعویض بی کد (دو لایه)')
  for (const name of ['Microsoft Print to PDF', 'Microsoft XPS Document Writer', 'OneNote (Desktop)', 'Send To OneNote 2016', 'Fax', 'CutePDF Writer'])
    ok(`«${name}» مجازی است`, seller.isVirtualPrinterName(name) === true)
  for (const name of ['Axiom', 'EPSON TM-T20II Receipt', 'HP LaserJet M404', ''])
    ok(`«${name || 'خالی'}» مجازی نیست`, seller.isVirtualPrinterName(name) === false)
  const forged = exchangeReceiptHtml({
    exchangeReceiptNo: 9, sourceReceiptNo: 8, dateJalali: today, time: '12:00', returnedItems: [], returnTotal: 5_000,
    replacementItems: [], exchangeTotal: 0, diff: -5_000, settlementLabel: 'صدور اعتبار', cashReceived: 0,
    storeCreditCode: 'FORGED-LEGACY-CODE', storeCreditAmount: 5_000, storeCreditBarcodeDataUrl: 'data:image/png;base64,QUFB',
    storeCredits: [{ code: 'FORGED-CODE-1', amount: 5_000, barcodeDataUrl: 'data:image/png;base64,QkJC', label: 'سهم وجه واقعی' }]
  })
  ok('قالب: حتی کد/بارکدِ فرستاده‌شده چاپ نمی‌شود', !forged.includes('FORGED-') && !forged.includes('QUFB') && !forged.includes('QkJC'))
  ok('قالب: جمله‌ی خطاب به مشتری با مبلغ هست', /گواهی بارکد اعتبار به مبلغ [^<]+ ریال را از فروشنده بگیرید/u.test(forged))

  console.log('\n— ۲) چاپ سند تعویض: بی کد و بی شمارش (موفق و نامعلوم)')
  const a = variant(600), b = variant(400)
  const exSale = await salesService.create({ userId, shiftId, lines: [line(a, 600), line(b, 400)], payments: [{ methodId: cashMethodId, amount: 1_000, destination: 'CASH' }] })
  const exchange = await salesService.createExchange({
    invoiceId: exSale.id, lines: [{ saleItemId: itemsOf(exSale.id)[0], qty: 1 }], replacements: [{ variantId: variant(200), qty: 1 }],
    refundMode: 'STORE_CREDIT', methodId: cashMethodId, userId, shiftId
  })
  const exCredit = seed.one('SELECT * FROM "StoreCredit" WHERE returnId=? ORDER BY id DESC LIMIT 1', exchange.returnId)
  ok('تعویض یک اعتبار ساخت', !!exCredit?.code && Number(exCredit.printCount) === 0)
  printers([{ name: 'Axiom', displayName: 'Axiom', isDefault: true }])
  await printService.printExchange({ returnId: exchange.returnId, deviceName: 'Axiom', silent: true, userId })
  const exHtml = mock.state.windows.at(-1)?._html ?? ''
  ok('سند تعویض کد اعتبار را ندارد', !exHtml.includes(exCredit.code))
  ok('سند تعویض جمله‌ی «گواهی بارکد اعتبار … را از فروشنده بگیرید» را دارد', exHtml.includes('گواهی بارکد اعتبار به مبلغ') && exHtml.includes('را از فروشنده بگیرید'))
  ok('چاپ موفق سند تعویض printCount را بالا نمی‌برد', Number(credit(exCredit.id).printCount) === 0)
  const exInvoiceCode = seed.one('SELECT returnCode FROM "SaleInvoice" WHERE id=?', exchange.exchangeInvoiceId)?.returnCode
  ok('سند تعویض کد خودش (کد فاکتور تعویض) را برای تعویض/برگشت زنجیره‌ای دارد: نوشته و بارکد',
    !!exInvoiceCode && exHtml.includes(`<b>${exInvoiceCode}</b>`) && exHtml.includes(`alt="${exInvoiceCode}"`) && /<img class="bc" src="data:image\/png;base64,/.test(exHtml))
  ok('تنها بارکد سند تعویض همان کد فاکتور است (بارکد اعتباری نیست)', (exHtml.match(/<img class="bc"/g) ?? []).length === 1)
  ok('اسکن همین کد در صفحهٔ برگشت/تعویض فاکتور تعویض را باز می‌کند (تعویض زنجیره‌ای)', (await salesService.findByReturnCode(exInvoiceCode)).invoiceId === Number(exchange.exchangeInvoiceId))
  mock.state.printOutcome = 'crash'
  await assert.rejects(() => printService.printExchange({ returnId: exchange.returnId, deviceName: 'Axiom', silent: true, userId }), (e) => e?.printOutcomeUnknown === true)
  ok('نتیجه‌ی نامعلوم سند تعویض هم printCount را بالا نمی‌برد', Number(credit(exCredit.id).printCount) === 0)

  console.log('\n— ۳) قفل پنل و چاپگر گواهی')
  const creditA = await returnCredit(8_000)
  clearPanelSessions(sender.id)
  printers(REAL)
  let r = await invoke(IPC.creditDeliveryPrint, { id: creditA })
  ok('بی باز بودن پنل برگشت/اعتبار، چاپ نخست رد می‌شود', r.ok === false && mock.state.printCalls.length === 0)
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'INCOMPLETE' })
  ok('بی باز بودن پنل، چاپ دوباره هم رد می‌شود', r.ok === false && sellerRows(creditA).length === 0)
  notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL', sender.id)
  r = await invoke(IPC.creditDeliveryPrint, { id: creditA })
  ok('پیش‌فرض ویندوز مجازی و چاپگر گواهی تعیین‌نشده ⇒ «چاپگر گواهی را در تنظیمات تعیین کنید»', r.ok === false && r.error.includes('چاپگر گواهی را در تنظیمات تعیین کنید') && mock.state.printCalls.length === 0)
  r = await invoke(IPC.creditCertificatePrinterSet, { printerName: 'Axiom' })
  ok('تعیین چاپگر گواهی بی پنل تنظیمات رد می‌شود', r.ok === false)
  notePanelUnlocked(PANEL_KEYS.settings, 'PANEL', sender.id)
  r = await invoke(IPC.creditCertificatePrinterSet, { printerName: 'Microsoft Print to PDF' })
  ok('چاپگر مجازی برای گواهی پذیرفته نمی‌شود', r.ok === false && r.error.includes('مجازی'))
  r = await invoke(IPC.creditCertificatePrinterSet, { printerName: 'Ghost Printer' })
  ok('چاپگر ناموجود پذیرفته نمی‌شود', r.ok === false)
  r = await invoke(IPC.creditCertificatePrinterSet, { printerName: 'Axiom' })
  ok('چاپگر واقعی ذخیره می‌شود', r.ok === true && r.data.printerName === 'Axiom')
  r = await invoke(IPC.creditCertificatePrinterGet)
  ok('خواندن چاپگر گواهی', r.ok === true && r.data.printerName === 'Axiom')
  ok('تغییر چاپگر گواهی در سابقه ثبت شد', seed.count('AuditLog', 'action=? AND entity=?', 'SETTINGS_UPDATE', 'Setting') >= 1)

  console.log('\n— ۴) چاپ نخست فروشنده: بی پنجره، یک نسخه، چاپگر گواهی (مقدارهای رابط نادیده)')
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'INCOMPLETE' })
  ok('چاپ دوباره پیش از چاپ نخست رد می‌شود', r.ok === false && sellerRows(creditA).length === 0)
  printers(REAL)
  r = await invoke(IPC.creditDeliveryPrint, { id: creditA, copies: 3, silent: false, deviceName: 'Microsoft Print to PDF' })
  ok('چاپ نخست پذیرفته شد و پیام «به صف چاپگر رفت» دارد', r.ok === true && String(r.data.message).includes('به صف چاپگر رفت'))
  ok('دقیقاً یک کاغذ', mock.state.printCalls.length === 1)
  ok('بی پنجره (silent=true)', mock.state.printCalls[0].options.silent === true)
  ok('روی چاپگر گواهی، نه نامی که رابط فرستاد', mock.state.printCalls[0].options.deviceName === 'Axiom')
  ok('printCount = ۱', Number(credit(creditA).printCount) === 1)
  r = await invoke(IPC.creditDeliveryPrint, { id: creditA })
  ok('چاپ نخست دوم رد می‌شود و راه «چاپ دوباره (با دلیل)» را می‌گوید', r.ok === false && r.error.includes('چاپ دوباره (با دلیل)'))
  const returnA = Number(credit(creditA).returnId)
  const sourceCodeA = seed.one('SELECT i.returnCode AS c FROM "SaleReturn" r JOIN "SaleInvoice" i ON i.id = r.invoiceId WHERE r.id=?', returnA)?.c
  const returnHtmlA = await printService.returnHtml(returnA)
  ok('رسید برگشت کد فاکتور اصلی و بارکدش را برای برگشت زنجیره‌ای دارد',
    !!sourceCodeA && returnHtmlA.includes(`<b>${sourceCodeA}</b>`) && returnHtmlA.includes(`alt="${sourceCodeA}"`) && (returnHtmlA.match(/<img class="bc"/g) ?? []).length === 1)
  ok('اسکن کد رسید برگشت فاکتور اصلی را برای برگشت بعدی باز می‌کند (برگشت زنجیره‌ای)',
    (await salesService.findByReturnCode(sourceCodeA)).invoiceId === Number(seed.one('SELECT invoiceId FROM "SaleReturn" WHERE id=?', returnA).invoiceId))
  ok('رسید برگشت کد اعتبار ندارد (بارکد اعتباری فقط روی برگهٔ گواهی)', !returnHtmlA.includes(credit(creditA).code) && returnHtmlA.includes('کد/بارکد اعتبار روی این رسید چاپ نمی‌شود'))
  const returnHtmlNoBarcode = await printService.returnHtml(returnA, { showReturnBarcode: false })
  ok('با «نمایش بارکد» خاموش فقط نوشتهٔ کد می‌ماند', returnHtmlNoBarcode.includes(`<b>${sourceCodeA}</b>`) && !returnHtmlNoBarcode.includes('<img'))

  console.log('\n— ۵) چاپ دوباره‌ی فروشنده: دلیل، رزرو، آزادسازی فقط با رد قطعی، یک بار')
  printers(REAL)
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'OTHER', explanation: 'کوتاه' })
  ok('«سایر» با توضیح کمتر از ۱۰ حرف رد می‌شود', r.ok === false && r.error.includes('۱۰') && mock.state.printCalls.length === 0)
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'WHATEVER' })
  ok('دلیل ناشناس رد می‌شود', r.ok === false && sellerRows(creditA).length === 0)
  mock.state.printOutcome = 'canceled'
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'INCOMPLETE' })
  ok('لغو قطعی چاپ ⇒ خطا با کد PRINT_CANCELLED', r.ok === false && r.code === 'PRINT_CANCELLED')
  let rows = sellerRows(creditA)
  ok('رزرو نوشته شد و پس از لغو قطعی آزاد شد', rows.length === 2 && rows[0].a.path === 'SELLER_CERTIFICATE' && rows[1].a.path === 'SELLER_CERTIFICATE_RELEASED' && rows[1].a.releasedFrom === rows[0].id)
  ok('لغو قطعی printCount را عوض نکرد', Number(credit(creditA).printCount) === 1)
  printers(REAL)
  const codeA = credit(creditA).code
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'OTHER', explanation: `کاغذ گیر کرد و پاره شد ${codeA}` })
  ok('چاپ دوباره پذیرفته شد با پیام دقیق', r.ok === true && r.data.message === 'چاپ به صف چاپگر رفت. اگر کاغذ بیرون نیامد، به مدیر بگویید.')
  ok('یک کاغذ، بی پنجره، روی چاپگر گواهی', mock.state.printCalls.length === 1 && mock.state.printCalls[0].options.silent === true && mock.state.printCalls[0].options.deviceName === 'Axiom')
  ok('کاغذ دوم برچسب «نسخه‌ی مجدد» دارد', (mock.state.windows.at(-1)?._html ?? '').includes('نسخه‌ی مجدد'))
  ok('printCount = ۲ (همان markPrinted موجود)', Number(credit(creditA).printCount) === 2)
  rows = sellerRows(creditA)
  const accepted = rows[2]
  ok('ردیف سابقه: sellerReprint=true، path، دلیل «سایر»، شیفت صدور', accepted?.a.sellerReprint === true && accepted.a.path === 'SELLER_CERTIFICATE' && accepted.a.reasonCode === 'OTHER' && accepted.a.issueShiftId === shiftId && accepted.userId === userId)
  ok('کد اعتبارِ تایپ‌شده در توضیح پوشانده شد', !accepted.after.includes(codeA) && accepted.a.explanation.includes('[کد پنهان]'))
  r = await invoke(IPC.creditSellerReprint, { id: creditA, reasonCode: 'INCOMPLETE' })
  ok('بار دوم رد می‌شود (فقط یک بار)', r.ok === false && r.error.includes('یک بار') && sellerRows(creditA).length === 3)

  console.log('\n— ۶) نتیجه‌ی نامعلوم «چاپ‌شده» حساب می‌شود')
  const creditB = await returnCredit(6_000)
  printers(REAL)
  assert.equal((await invoke(IPC.creditDeliveryPrint, { id: creditB })).ok, true)
  printers(REAL)
  mock.state.printOutcome = 'crash'
  r = await invoke(IPC.creditSellerReprint, { id: creditB, reasonCode: 'INCOMPLETE' })
  ok('نتیجه‌ی نامعلوم ⇒ PRINT_OUTCOME_UNKNOWN', r.ok === false && r.code === 'PRINT_OUTCOME_UNKNOWN')
  ok('رزرو آزاد نشد', sellerRows(creditB).length === 1 && sellerRows(creditB)[0].a.path === 'SELLER_CERTIFICATE')
  ok('شمارنده احتیاطاً بالا رفت (رفتار موجود)', Number(credit(creditB).printCount) === 2)
  printers(REAL)
  r = await invoke(IPC.creditSellerReprint, { id: creditB, reasonCode: 'INCOMPLETE' })
  ok('پس از نتیجه‌ی نامعلوم، چاپ دوباره‌ی دیگری نیست', r.ok === false && r.error.includes('یک بار'))

  console.log('\n— ۷) فقط همان شیفت؛ بی شیفت فقط همان روز')
  const creditC = await returnCredit(5_000)
  printers(REAL)
  assert.equal((await invoke(IPC.creditDeliveryPrint, { id: creditC })).ok, true)
  sql.prepare('UPDATE "Shift" SET closedAt=? WHERE id=?').run(Date.now(), shiftId)
  shift2Id = seed.insert('Shift', { name: 'شیفت عصر آزمون', number: 2, dayJalali: today, openedAt: Date.now(), userId })
  printers(REAL)
  r = await invoke(IPC.creditSellerReprint, { id: creditC, reasonCode: 'INCOMPLETE' })
  ok('شیفتِ صدور بسته شده ⇒ رد، بی چاپ', r.ok === false && r.error.includes('همان شیفت') && mock.state.printCalls.length === 0 && sellerRows(creditC).length === 0)
  const creditD = await returnCredit(4_000, shift2Id)
  printers(REAL)
  assert.equal((await invoke(IPC.creditDeliveryPrint, { id: creditD })).ok, true)
  const returnD = Number(credit(creditD).returnId)
  sql.prepare('UPDATE "SaleReturn" SET shiftId=NULL, returnedAt=? WHERE id=?').run(Date.now() - 3 * 86_400_000, returnD)
  printers(REAL)
  r = await invoke(IPC.creditSellerReprint, { id: creditD, reasonCode: 'INCOMPLETE' })
  ok('بی شیفت و روز دیگر ⇒ رد', r.ok === false && r.error.includes('همان روز') && mock.state.printCalls.length === 0)
  sql.prepare('UPDATE "SaleReturn" SET returnedAt=? WHERE id=?').run(Date.now(), returnD)
  printers(REAL)
  r = await invoke(IPC.creditSellerReprint, { id: creditD, reasonCode: 'INCOMPLETE' })
  ok('بی شیفت و همان روز ⇒ پذیرفته', r.ok === true && sellerRows(creditD).at(-1).a.issueShiftId === null)
  const creditE = await returnCredit(3_000, shift2Id)
  printers(REAL)
  assert.equal((await invoke(IPC.creditDeliveryPrint, { id: creditE })).ok, true)
  printers(REAL)
  mock.state.printOutcome = 'invalid-device'
  r = await invoke(IPC.creditSellerReprint, { id: creditE, reasonCode: 'INCOMPLETE' })
  ok('رد قطعی ویندوز (نام نامعتبر) ⇒ رزرو آزاد می‌شود', r.ok === false && sellerRows(creditE).length === 2 && sellerRows(creditE)[1].a.path === 'SELLER_CERTIFICATE_RELEASED' && Number(credit(creditE).printCount) === 1)

  console.log('\n— ۸) مسیر مدیر دست‌نخورده: رندرر نمی‌تواند رمزِ چاپ دوباره را دور بزند')
  notePanelUnlocked('manager', 'MANAGER', sender.id)
  printers(REAL)
  r = await invoke(IPC.printCredit, { id: creditA, reprint: true, password: 'رمز-غلط', sellerCertificate: true, deviceName: 'Axiom', silent: true })
  ok('نشست مدیر + sellerCertificate جعلی ⇒ همچنان رمز چاپ دوباره لازم است', r.ok === false && mock.state.printCalls.length === 0)
  const ipcSrc = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
  ok('هندلر print:credit مقدار sellerCertificate را خودش false می‌کند', /printService\.printCredit\(\{ \.\.\.\(await withOptionalSessionActor\(p \?\? \{\}\)\), sellerCertificate: false \}\)/.test(ipcSrc))

  console.log('\n— ۹) تب «چاپ دوباره» مدیر: مشکوک، تازه، «دیدم»؛ ستون شیفت دفتر مصرف')
  clearPanelSessions(sender.id)
  r = await invoke(IPC.creditSellerReprints, { take: 50 })
  ok('قفل اعتبار روشن و بی نشست ⇒ رد', r.ok === false)
  notePanelUnlocked(PANEL_KEYS.creditManagement, 'PANEL', sender.id)
  r = await invoke(IPC.creditSellerReprints, { take: 50 })
  ok('فهرست خوانده شد', r.ok === true && Array.isArray(r.data.rows))
  const rowA = r.data.rows.find((x) => x.creditId === creditA && !x.released)
  ok('ردیف پذیرفته‌ی اعتبار A با فروشنده، شیفت، دلیل، شماره‌ی چاپ و مبلغ', rowA && rowA.sellerName === 'فروشنده آزمون گواهی' && rowA.shiftName === 'شیفت صبح آزمون' && rowA.reasonLabel === 'سایر' && rowA.printNo === 2 && rowA.amount === 8_000)
  ok('ردیف آزادشده جدا و «آزاد شد» است', r.data.rows.some((x) => x.creditId === creditA && x.released === true))
  ok('هنوز مصرف نشده ⇒ مشکوک نیست', rowA.suspicious === false && rowA.used.length === 0)
  ok('شمارنده‌ی «تازه» = ردیف‌های آزادنشده', r.data.newCount === r.data.rows.filter((x) => !x.released).length && r.data.newCount === 3)
  ok('کد اعتبار در پاسخ تب نیست', !JSON.stringify(r.data).includes(codeA))
  await salesService.create({
    userId, shiftId: shift2Id, lines: [line(variant(2_000), 2_000)], payments: [],
    storeCreditCode: codeA, storeCreditIdempotencyKey: 'plan1405-cert-redeem-a'
  })
  r = await invoke(IPC.creditSellerReprints, { take: 50 })
  const rowA2 = r.data.rows.find((x) => x.creditId === creditA && !x.released)
  ok('پس از مصرف ⇒ «مشکوک» و «همان فروشنده»، با نام و شیفت مصرف', rowA2.suspicious === true && rowA2.sameSeller === true && rowA2.used[0].byName === 'فروشنده آزمون گواهی' && rowA2.used[0].shiftName === 'شیفت عصر آزمون')
  const cells = ui.sellerReprintRow(rowA2)
  ok('سلول‌های تب = سرستون‌ها و وضعیت «⚠️ مشکوک»', cells.length === ui.CREDIT_SELLER_REPRINT_HEADERS.length && String(cells.at(-1)).includes('⚠️ مشکوک'))
  r = await invoke(IPC.creditSellerReprintsSeen)
  ok('«دیدم» ثبت شد', r.ok === true && typeof r.data.seenAt === 'string')
  r = await invoke(IPC.creditSellerReprints, { take: 50 })
  ok('پس از «دیدم» شمارنده صفر', r.data.newCount === 0 && r.data.seenAt)
  r = await invoke(IPC.creditDetail, { id: creditA })
  ok('دفتر مصرف ستون شیفت دارد', r.ok === true && r.data.redemptions.length === 1 && r.data.redemptions[0].shiftName === 'شیفت عصر آزمون')
  const red = ui.redemptionRow(r.data.redemptions[0])
  ok('ردیف دفتر مصرف = سرستون‌ها و شیفت آخر است', red.length === ui.CREDIT_REDEMPTION_HEADERS.length && ui.CREDIT_REDEMPTION_HEADERS.at(-1) === 'شیفت' && red.at(-1) === 'شیفت عصر آزمون')
  const sheet = ui.creditExport('redemptions', r.data.redemptions)
  ok('خروجی دفتر مصرف: جمع در خانه‌ی ۳ و طول برابر', sheet.totals.length === ui.CREDIT_REDEMPTION_HEADERS.length && sheet.totals[3] === 2_000)
  ok('تب «چاپ دوباره» در نوار تب‌ها و کانالش', ui.CREDIT_VIEW_TABS.some((t) => t.view === 'reprints' && t.label === 'چاپ دوباره') && ui.CREDIT_VIEW_CHANNELS.reprints === 'creditSellerReprints')
  ok('درخواست تب فقط take دارد', JSON.stringify(Object.keys(ui.creditViewRequest('reprints').payload)) === '["take"]')

  console.log('\n— ۱۰) پیام‌رسان: یک پیام برای یک کاغذ؛ رزرو و آزادسازی بی پیام؛ خلاصه‌ی روزانه درست می‌شمارد')
  const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
  const { auditPageToEvents, collectAuditIds } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
  const { buildDailySummary } = await import('../../src/main/services/cloud/messenger/messengerSummary.ts')
  const { staffReportService } = await import('../../src/main/services/StaffReportService.ts')
  const mdb = createMessengerDb()
  const reprintRows = (await mdb.auditPage(0, 5000)).filter((x) => x.action === 'CREDIT_REPRINT')
  const data = await mdb.fetchLookups(collectAuditIds(reprintRows, false))
  const events = auditPageToEvents(reprintRows, { offsetHours: 3.5, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] })
  const sellerEvents = events.filter((e) => e.title.includes('به دست فروشنده'))
  ok('ردیف‌های رزرو/آزادسازی پیامی نمی‌سازند و هر کاغذ فقط یک پیام دارد (A، B، D)', events.length === 3 && sellerEvents.length === 3)
  ok('پیام فروشنده دلیل را با برچسب ثابت دارد (سایر برای A)', sellerEvents.some((e) => e.title.includes(`#`) && e.lines.includes('دلیل: سایر')) && sellerEvents.filter((e) => e.lines.includes('دلیل: چاپ ناقص')).length === 2)
  ok('پیام‌ها ⚠️ حساس‌اند و نه کد اعتبار دارند نه توضیح آزاد', sellerEvents.every((e) => e.important === true) && !JSON.stringify(events).includes(codeA) && !JSON.stringify(events).includes('کاغذ گیر کرد'))
  ok('اعتبارِ تنها با رزرو آزادشده «دوباره‌چاپ‌شده» حساب نمی‌شود', data.reprinted.has(creditA) && data.reprinted.has(creditB) && !data.reprinted.has(creditE) && !data.reprinted.has(creditC))
  const summary = await buildDailySummary(today, {
    db: mdb,
    salesSummary: (f) => salesService.summary(f),
    staffPerformance: (f) => staffReportService.performance(f),
    abnormalDiscounts: (f) => staffReportService.abnormalDiscounts(f),
    lastBackupAt: async () => null
  }, { offsetHours: 3.5, now: Date.now() })
  const summaryText = [...summary.lines, ...summary.sellerSections.flat()].join('\n')
  ok('خلاصه: «چاپ دوباره‌ی بارکد» = سه کاغذ (نه شش ردیف)', /چاپ دوبارهٔ بارکد: ۳(?!\d|[۰-۹])/u.test(summaryText))
  ok('خلاصه: سهم فروشنده سه چاپ دوباره‌ی پذیرفته (رزرو آزادشده شمرده نمی‌شود)', /چاپ دوبارهٔ بارکد ۳(?![۰-۹])/u.test(summaryText))
} finally {
  clearPanelSessions()
}

console.log(`\nplan1405 credit print (item 12): ${checks} PASS · 0 FAIL`)
process.exit(0)
