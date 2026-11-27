/**
 * دفتر آزمون ۴-۱۳۴ — تاریخ در ۱۲ نمایش کم‌دیده با تقویم و قالب خود برنامه («۱۴۰۵/۰۹/۰۶ ساعت ۱۴:۳۰»)، نه
 * `toLocaleString('fa-IR')` سیستم. فقط نمایش؛ `CashClose.tsx` فقط همان دو خط (اجازهٔ مالک، پاسخ ۱۷).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const { jalaliDateTimeText, toJalaliDate, toClock, faDigits } = await import('../../src/shared/jalali.ts')
const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

await test('one small date-and-time function with the app calendar and format', () => {
  assert.equal(jalaliDateTimeText(new Date(2026, 10, 27, 14, 30, 59)), '۱۴۰۵/۰۹/۰۶ ساعت ۱۴:۳۰')
  assert.equal(jalaliDateTimeText(new Date(2026, 10, 27, 9, 5).toISOString()), '۱۴۰۵/۰۹/۰۶ ساعت ۰۹:۰۵')
  for (const empty of [null, undefined, '', 'not a date']) assert.equal(jalaliDateTimeText(empty), '—')
  // ۲۱۲۵/۰۳/۲۰ ⇐ تقویم سیستم یک روز با تقویم برنامه فرق دارد؛ این تابع همیشه تقویم برنامه است
  const d = new Date(2125, 2, 20, 12, 0)
  assert.equal(jalaliDateTimeText(d), faDigits(`${toJalaliDate(d)} ساعت ${toClock(d, false)}`))
})

await test('no date in src/renderer is shown with the system calendar any more', () => {
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(tsx?|mjs)$/.test(name)) {
        const text = read(rel)
        for (const m of text.matchAll(/new Date\([^)]*\)\.toLocale(?:Date|Time)?String\('fa-IR[^']*'\)/g)) hits.push(`${rel}: ${m[0]}`)
      }
    }
  }
  walk('src/renderer/src')
  assert.deepEqual(hits, [])
  // عددها با جداکنندهٔ هزارگان همان می‌مانند (نمونه: گزارش مدیریت)
  assert.match(read('src/renderer/src/pages/ManagementReports.tsx'), /\.toLocaleString\('fa-IR'\)/)
})

await test('the five pages use the shared function; cash close reads server text in its two lines only', () => {
  for (const [file, n] of [
    ['src/renderer/src/components/BridgeDiagnosticsModal.tsx', 2],
    ['src/renderer/src/components/CustodyAdminChip.tsx', 5],
    ['src/renderer/src/pages/CreditManagement.tsx', 1],
    ['src/renderer/src/pages/Settings.tsx', 1]
  ])
    assert.equal((read(file).match(/jalaliDateTimeText\(/g) ?? []).length, n, file)
  const cash = read('src/renderer/src/pages/CashClose.tsx')
  assert.match(cash, /شروع \{\(segment as any\)\.startedAtText \?\? '—'\}\{segment\.endedAt \? ` · پایان \$\{\(segment as any\)\.endedAtText \?\? '—'\}` : ' · باز'\}/)
  assert.match(cash, /پایان برنامهٔ ثبت‌شده: \{\(segment as any\)\.scheduledEndAtText \?\? '—'\}/)
  const svc = read('src/main/services/CustodyService.ts')
  assert.match(svc, /startedAtText: jalaliDateTimeText\(shift\.openedAt\),/)
  assert.match(svc, /endedAtText: \(meta\.endedAt \?\? shift\.closedAt\) \? jalaliDateTimeText\(meta\.endedAt \?\? shift\.closedAt\) : null,/)
  assert.match(svc, /scheduledEndAtText: meta\.scheduledEndAt \? jalaliDateTimeText\(meta\.scheduledEndAt\) : null,/)
})
