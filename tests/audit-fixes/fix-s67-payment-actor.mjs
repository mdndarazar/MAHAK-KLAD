/**
 * نشست ۶۷ — خوشه A / actor واقعی روی mutationهای Payment.
 *
 * این تست عمداً بدون Electron اجرا می‌شود: قرارداد امنیتی در مرز IPC است و
 * باید قبل از رسیدن payload به سرویس قابل بررسی باشد.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../src/main/ipc/index.ts', import.meta.url))
const source = readFileSync(root, 'utf8')
let ok = 0
let bad = 0
const truthy = (label, value) => value ? (ok++, console.log(`  ✓ ${label}`)) : (bad++, console.log(`  ✗ ${label}`))
const count = (needle) => (source.match(new RegExp(needle, 'g')) ?? []).length
const sensitiveHandlers = source
  .split('\n')
  .filter((line) => /handle\(IPC\.(salePaymentAdd|salePaymentUpdate|salePaymentDelete|saleOverpayCredit|saleChequeStatus)/.test(line))
  .join('\n')

truthy('helper اختصاصی actor نشست وجود دارد', /async function withSessionActor/.test(source))
truthy('actor از payload renderer کپی نمی‌شود', /return \{ \.\.\.\(payload \?\? \{\}\), userId: actorId \}/.test(source))
truthy('نبود نشست عملیات را متوقف می‌کند', /برای ثبت یا تغییر پرداخت، ابتدا یک نشست بازِ کارمند لازم است/.test(source))
// These two handlers now wrap the committed credit in a first-print grant.
// Check the full handler, not the old single-line text shape.
const addHandler = source.slice(source.indexOf('handle(IPC.salePaymentAdd,'), source.indexOf('handle(IPC.saleOverpayCredit,'))
const issueHandler = source.slice(source.indexOf('handle(IPC.saleOverpayCredit,'), source.indexOf('handle(IPC.salePaymentUpdate,'))
truthy('افزودن پرداخت actor نشست را پیش از سرویس می‌گیرد',
  /withSessionActor\(p \?\? \{\}, 'ثبت یا تغییر پرداخت'\)/.test(addHandler) &&
  addHandler.indexOf('withSessionActor(') < addHandler.indexOf('salesService.addPayment('))
truthy('صدور اعتبار اضافه‌دریافت actor نشست را پیش از سرویس می‌گیرد',
  /withSessionActor\(p \?\? \{\}, 'صدور اعتبار اضافه‌دریافت'\)/.test(issueHandler) &&
  issueHandler.indexOf('withSessionActor(') < issueHandler.indexOf('salesService.overpayCreditIssue('))
truthy('ویرایش پرداخت از actor نشست استفاده می‌کند', /salePaymentUpdate[\s\S]{0,180}withSessionActor\(p\)/.test(source))
truthy('ابطال پرداخت از actor نشست استفاده می‌کند', /salePaymentDelete[\s\S]{0,180}withSessionActor\(p \?\? \{\}\)/.test(source))
truthy('تغییر وضعیت چک از actor نشست استفاده می‌کند', /saleChequeStatus[\s\S]{0,180}withSessionActor\(p \?\? \{\}\)/.test(source))
truthy(
  'این پنج مسیر دیگر مستقیماً payload را به سرویس نمی‌دهند',
  count('handle\\(IPC\\.salePayment(?:Add|Update|Delete)|handle\\(IPC\\.saleOverpayCredit|handle\\(IPC\\.saleChequeStatus') === 5
)
truthy(
  'مسیرهای حساس با withUser قدیمی قاطی نشده‌اند',
  !/withUser/.test(sensitiveHandlers)
)

console.log(`\n✓ ${ok} بررسی موفق · ${bad} ناموفق`)
if (bad) process.exitCode = 1
