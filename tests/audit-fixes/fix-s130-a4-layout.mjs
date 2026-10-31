/**
 * نشست ۱۳۰ · خوشه J · چیدمان PDF گزارش A4
 *
 * قبل از رفع: عرض body برابر ۲۱۰mm + padding بود و scrollWidth از صفحه‌ی A4
 * بزرگ‌تر می‌شد؛ در گزارش RTL ستون سمت چپ از لبه بیرون می‌زد.
 * بعد از رفع: body با box-sizing:border-box در همان عرض کاغذ می‌ماند.
 *
 * این تست Chromium واقعی را صدا می‌زند؛ Electron/پرینتر واقعی را ادعا نمی‌کند.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// تست PDF واقعی عمداً به «موفق» تبدیل نمی‌شود اگر مرورگر/ابزار PDF نباشد.
// مسیرها برای CI قابل تنظیم‌اند؛ نبود پیش‌نیازها exit=77 است، نه تأیید صوری.
// pdfjs-dist یک خوانندهٔ واقعی PDF و جایگزین *اختیاری* برای poppler است؛
// وابستگی جدید به اپلیکیشن/lockfile اضافه نمی‌شود.
const playwrightEntry = resolve(process.env.MAHAK_S130_PLAYWRIGHT_ENTRY ?? '/opt/sd-artifact/node_modules/playwright/index.mjs')
const chromeExecutable = resolve(process.env.MAHAK_S130_CHROMIUM ?? '/ms-playwright/chromium-1208/chrome-linux64/chrome')
const pdfjsEntry = process.env.MAHAK_S130_PDFJS_ENTRY ? resolve(process.env.MAHAK_S130_PDFJS_ENTRY) : null
const popplerAvailable = ['pdfinfo', 'pdftotext'].every((cmd) => !spawnSync(cmd, ['-v']).error)
if (!existsSync(playwrightEntry) || !existsSync(chromeExecutable) ||
    (pdfjsEntry ? !existsSync(pdfjsEntry) : !popplerAvailable)) {
  console.error(`A4_BROWSER_PDF_NOT_VERIFIED: Playwright=${existsSync(playwrightEntry) ? 'موجود' : 'ناموجود'}؛ Chromium=${existsSync(chromeExecutable) ? 'موجود' : 'ناموجود'}؛ PDF parser=${pdfjsEntry ? existsSync(pdfjsEntry) ? 'pdfjs' : 'pdfjs ناموجود' : popplerAvailable ? 'poppler' : 'ناموجود'}. Chromium و poppler یا MAHAK_S130_PDFJS_ENTRY برای آزمون لازم‌اند.`)
  process.exit(77)
}
const { chromium } = await import(playwrightEntry)
const { reportHtml } = await import(new URL('../../src/main/print/templates.ts', import.meta.url).href)

let ok = 0
let bad = 0
const check = (label, actual, expected = true) => {
  if (actual === expected) {
    ok++
    console.log(`  ✓ ${label}`)
  } else {
    bad++
    console.log(`  ✗ ${label}`)
  }
}

const fa = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])
const money = (n) => fa(Math.round(n).toLocaleString('en-US')).replace(/,/g, '٬')
const headers = ['شماره فیش', 'تاریخ', 'ساعت', 'شیفت', 'کد', 'نام کالا', 'تعداد', 'قیمت واحد', 'تخفیف', 'جمع', 'برگشتی']
const rows = Array.from({ length: 150 }, (_, i) => [
  fa(100000 + i),
  fa('1403/07/01'),
  fa('12:34'),
  'شیفت صبح — نشست ۱',
  fa('JN-' + (1000 + i)),
  'شلوار جین مردانه راسته سایز ۳۲ - آبی تیره',
  fa(1),
  money(2450000),
  money(0),
  money(2450000),
  fa(0)
])
const html = reportHtml(
  'گزارش جزئیات فروش',
  headers,
  rows,
  ['جمع', '', '', '', '', '', fa(150), '', '', money(367500000), ''],
  'بازه: ۱۴۰۳/۰۷/۰۱ تا ۱۴۰۳/۰۷/۳۰'
)

const browser = await chromium.launch({
  headless: true,
  executablePath: chromeExecutable
})
const page = await browser.newPage({ viewport: { width: 794, height: 1123 } })
await page.setContent(html, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
check('فونت فارسی همراه برنامه پیش از صفحه‌بندی واقعاً بارگذاری شد', await page.evaluate(() => {
  const loaded = [...document.fonts].filter((f) => f.family === 'Vazirmatn' && f.status === 'loaded')
  return loaded.some((f) => f.weight === '400') && loaded.some((f) => f.weight === '700')
}))
const metrics = await page.evaluate(() => ({
  bodyWidth: document.body.getBoundingClientRect().width,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth
}))
check('بدنه‌ی گزارش از عرض واقعی A4 بیرون نمی‌زند', metrics.bodyWidth <= metrics.clientWidth + 1)
check('گزارش A4 افقی اسکرول افقی پنهان ندارد', metrics.scrollWidth <= metrics.clientWidth + 1)

const dir = mkdtempSync(join(tmpdir(), 'mahak-s130-'))
const pdfPath = join(dir, 'report.pdf')
try {
  const pdf = await page.pdf({
    width: '210mm',
    height: '297mm',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
  })
  writeFileSync(pdfPath, pdf)
  let pages
  let pageTexts
  if (pdfjsEntry) {
    const { getDocument } = await import(pathToFileURL(pdfjsEntry).href)
    const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true })
    try {
      const document = await loading.promise
      pages = document.numPages
      pageTexts = []
      for (let n = 1; n <= pages; n++) {
        const sheet = await document.getPage(n)
        const size = sheet.getViewport({ scale: 1 })
        check(`صفحهٔ ${n} واقعاً A4 است`, Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1)
        pageTexts.push((await sheet.getTextContent()).items.map((item) => item.str ?? '').join(' '))
      }
    } finally {
      await loading.destroy()
    }
  } else {
    const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' })
    pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0)
    check('اندازهٔ صفحه A4 است', /Page size:\s+595\.\d+ x 841\.\d+ pts/.test(info))
    const textPath = join(dir, 'report.txt')
    execFileSync('pdftotext', ['-layout', pdfPath, textPath])
    pageTexts = readFileSync(textPath, 'utf8').split('\f').filter((part) => part.trim())
  }
  check('گزارش ۱۵۰ ردیفی به PDF چهارصفحه‌ای A4 تبدیل می‌شود', pages === 4)
  // PDF.js در متن RTL ممکن است glyphهای presentation-form را با ترتیبِ بصری
  // برگرداند؛ در poppler متنِ منطقی هم پذیرفته است. هیچ سرستونی جعل نمی‌شود.
  const headerVisible = (part) => {
    const glyphs = part.normalize('NFKC').replace(/[\s\u200c-\u200f]/g, '')
    return part.includes('شماره فیش') || glyphs.includes('رهامششیف') || glyphs.includes('شیفرهامش')
  }
  check('سرستون در هر صفحهٔ واقعی PDF تکرار می‌شود', pageTexts.length === pages && pageTexts.every(headerVisible))
  const text = pageTexts.join(' ')
  check('۱۵۰ شماره‌فیش در PDF هستند', rows.every((_, i) => text.includes(fa(100000 + i))))
  check('آخرین فیش و ردیف جمع در PDF باقی می‌مانند', text.includes('۱۰۰۱۴۹') && text.includes('۳۶۷٬۵۰۰٬۰۰۰'))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${bad ? '✗' : '✓'} ${ok} بررسی موفق · ${bad} ناموفق`)
if (bad) process.exit(1)
