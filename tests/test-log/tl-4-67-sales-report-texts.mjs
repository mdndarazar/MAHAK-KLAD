/**
 * دفتر آزمون ۴-۶۷ — متن‌های دیدنی «گزارشات فروش» به فارسی ساده: در صفحه و همهٔ پنل‌هایی که صفحه باز
 * می‌کند (پرونده‌ها خودکار از importها پیدا می‌شوند) و یادداشت‌های سرور همین ماژول، هیچ واژهٔ انگلیسی
 * برنامه‌نویسی و هیچ «جلسه/بند/بخش + عدد» در متن دیدنی نیست. توضیح‌های کد (comment) شمرده نمی‌شوند.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** رشته‌های دارای حرف فارسی + متن JSX (حرف فارسی بیرون از رشته و توضیح)؛ توضیح‌ها و regexها کنار می‌روند. */
export function visibleTexts(src) {
  const out = []
  let i = 0
  let line = 1
  let code = ''
  let codeLine = 1
  let prevSig = ''
  const n = src.length
  const push = (text, l) => {
    if (/[\u0600-\u06FF]/.test(text)) out.push({ text, line: l })
  }
  const flushCode = () => {
    code.split('\n').forEach((seg, k) => {
      for (const m of seg.matchAll(/[^<>{}]*[\u0600-\u06FF][^<>{}]*/g)) push(m[0].trim(), codeLine + k)
    })
    code = ''
    codeLine = line
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '\n') {
      line++
      code += c
      i++
      continue
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++
          code += '\n'
        }
        i++
      }
      i += 2
      continue
    }
    if (c === '/' && /^[(,=:[!&|?{};]?$/.test(prevSig)) {
      let j = i + 1
      let cls = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        else if (src[j] === '/' && !cls) break
        j++
      }
      code += ' '
      i = j + 1
      prevSig = 'r'
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      flushCode()
      const l0 = line
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          s += src[j + 1] === 'n' ? '\n' : src[j + 1]
          j += 2
          continue
        }
        if (src[j] === '\n') {
          if (c !== '`') break
          line++
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1
          j += 2
          while (j < n && depth) {
            const ch = src[j]
            if (ch === '{') depth++
            else if (ch === '}') depth--
            else if (ch === '\n') line++
            else if (ch === "'" || ch === '"' || ch === '`') {
              const q = ch
              j++
              while (j < n && src[j] !== q) {
                if (src[j] === '\\') j++
                j++
              }
            }
            j++
          }
          s += ' … '
          continue
        }
        s += src[j]
        j++
      }
      push(s, l0)
      codeLine = line
      i = src[j] === '\n' ? j : j + 1
      prevSig = 's'
      continue
    }
    code += c
    if (!/\s/.test(c)) prevSig = c
    i++
  }
  flushCode()
  return out
}

/** صفحه و همهٔ پرونده‌های renderer که از آن import می‌شوند (بازگشتی). */
function moduleFiles() {
  const seen = new Set()
  const todo = ['src/renderer/src/pages/SalesReports.tsx']
  while (todo.length) {
    const f = todo.pop()
    if (seen.has(f)) continue
    seen.add(f)
    for (const m of read(f).matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]
      let base = null
      if (spec.startsWith('.')) base = normalize(join(dirname(f), spec))
      else if (spec.startsWith('@renderer/')) base = join('src/renderer/src', spec.slice('@renderer/'.length))
      if (!base) continue
      const hit = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((e) => base + e).find((p) => existsSync(join(ROOT, p)))
      if (hit) todo.push(hit.split('\\').join('/'))
    }
  }
  return [...seen].sort()
}

const SERVER_NOTES = [
  'src/main/services/StaffReportService.ts',
  'src/main/services/FraudService.ts',
  'src/main/services/accountingReport.ts',
  'src/shared/reportExtraOutput.ts'
]
const ENGLISH = /\b(override|overridden|legacy|snapshot|endpoint|AuditLog|kind\s*=|gross profit|purchasePrice|canonical|segment|freeze|Renderer|payload|IPC)\b/i
const NUMBERED = /(جلسه|جلسهٔ|بند|بخش)[\s\u200c]*[0-9۰-۹]/

await test('scanner sees strings and JSX text, not comments', () => {
  const sample = "// override\n/* snapshot */\nconst a = 'متن override'\nconst r = /'x'/\nconst b = <div>نوشتهٔ بند ۲ {x}</div>\n"
  const t = visibleTexts(sample).map((x) => x.text)
  assert.deepEqual(t, ['متن override', 'نوشتهٔ بند ۲'])
})

await test('sales reports page and its panels: no English code word, no «جلسه/بند/بخش + عدد»', () => {
  const files = moduleFiles()
  assert.ok(files.length >= 30, `module files found: ${files.length}`)
  for (const must of ['OverrideSessionsPanel', 'OutOfShiftPanel', 'AccountingBlocks', 'BridgeDiagnosticsModal', 'InvoicePaymentsModal', 'CardTransferPanel', 'FinancialInspector'])
    assert.ok(files.some((f) => f.includes(must)), must)
  const hits = []
  for (const f of [...files, ...SERVER_NOTES])
    for (const t of visibleTexts(read(f))) if (ENGLISH.test(t.text) || NUMBERED.test(t.text)) hits.push(`${f}:${t.line}: ${t.text.slice(0, 120)}`)
  assert.deepEqual(hits, [])
})

await test('the proposed texts are in place', () => {
  const page = read('src/renderer/src/pages/SalesReports.tsx')
  assert.match(page, /\n\s+نشست‌هایی که نامشان دستی عوض شد\n/)
  assert.match(page, /\(جدا از تب «اعتبار خرید»\)/)
  assert.match(read('src/renderer/src/components/OverrideSessionsPanel.tsx'), /<h2 className="font-bold">نشست‌هایی که نامشان دستی عوض شد<\/h2>/)
  assert.match(read('src/renderer/src/components/OutOfShiftPanel.tsx'), /نام این نشست دستی عوض شده بود/)
  assert.match(read('src/main/services/StaffReportService.ts'), /توجه: عوض کردن دستی نام یک نشست،/)
  const acc = read('src/renderer/src/components/AccountingBlocks.tsx')
  assert.match(acc, /برگشت ساده \(بدون تعویض\)/)
  assert.match(acc, /ماندهٔ منقضی تا پایان بازه \(بر اساس وضعیت فعلی\)/)
  assert.match(read('src/renderer/src/components/BridgeDiagnosticsModal.tsx'), /در سابقهٔ برنامه می‌مانند\./)
  assert.match(read('src/renderer/src/components/InvoicePaymentsModal.tsx'), /<div className="kbd">مبلغ اضافه‌ی دریافتی<\/div>/)
  const end = 'جمع کل بازه را از جمع‌های خود صفحهٔ گزارش بخوانید.'
  assert.ok(page.includes(end) && read('src/shared/reportExtraOutput.ts').includes(end))
  const fraud = read('src/main/services/FraudService.ts')
  assert.match(fraud, /با نسخه‌های تازهٔ برنامه حساب می‌شود/)
  assert.match(fraud, /یعنی داده‌ی نسخه‌های قدیمی یا ویرایش دستی دیتابیس/)
  assert.ok(fraud.includes('سود ناخالص عمداً در این هشدارها نیست، چون قیمت خرید لحظهٔ فروش قطعی ثبت نمی‌شود و عدد سود قابل اتکا نیست.'))
  assert.match(read('src/main/services/accountingReport.ts'), /که مقصد پولش ثبت نشده: بدهی/)
})
