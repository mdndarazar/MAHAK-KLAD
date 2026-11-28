/**
 * دفتر آزمون ۴-۵۵ — متن‌های دیدنی بی شمارهٔ داخلی و بی واژهٔ انگلیسی برنامه‌نویسی، در ۹ پرونده
 * (`Settings`، `Pos`، `SecondaryStock`، `SalesReturn`، `CustodyChip`، `CustodyAdminChip`، `Stocktake`،
 * `CreditForms` و با اجازهٔ مالک `CashClose`). فقط متن؛ نام‌های داخل کد، کانال‌ها و کدهای خطا همان‌اند.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL('../../src/renderer/src/' + p, import.meta.url), 'utf8')
const files = {
  chip: read('components/CustodyChip.tsx'),
  admin: read('components/CustodyAdminChip.tsx'),
  settings: read('pages/Settings.tsx'),
  cashClose: read('pages/CashClose.tsx'),
  stocktake: read('pages/Stocktake.tsx'),
  credit: read('components/CreditForms.tsx'),
  pos: read('pages/Pos.tsx'),
  secondary: read('pages/SecondaryStock.tsx'),
  salesReturn: read('pages/SalesReturn.tsx')
}

/** همهٔ رشته‌ها و متن‌های JSX بی توضیح‌های کد (برای سنجش «دیدنی»). */
function visible(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

await test('no internal item numbers in visible texts', () => {
  for (const [name, src] of Object.entries(files)) {
    const v = visible(src)
    assert.ok(!/\((?:بند|مورد) [۰-۹0-9][^)]*\)/.test(v), `${name}: «(بند …)» left`)
    assert.ok(!/\(§[^)]*\)/.test(v), `${name}: «(§…)» left`)
  }
  assert.match(files.settings, /<b>قفل خودکار بی‌کاری:<\/b>/)
  assert.match(files.credit, /title="تولید گروهی"/)
})

await test('English programmer words replaced by plain Persian', () => {
  for (const name of ['chip', 'admin', 'settings', 'stocktake', 'credit']) {
    const v = visible(files[name])
    for (const word of ['Master Override', 'snapshot', 'canonical', 'Shift قدیمی', 'Shift قبلی', 'Shiftهای', 'freeze', 'فریز']) {
      assert.ok(!v.includes(word), `${name}: «${word}» left`)
    }
    assert.ok(!/[\u0600-\u06FF«] ?(?:override|legacy)\b/.test(v) && !/\b(?:override|legacy)‌?(?:شده|ها)?[ »]+[\u0600-\u06FF]/.test(v), `${name}: override/legacy left`)
  }
  assert.match(files.chip, />تحویل اضطراری به مدیر<\/button>/)
  assert.match(files.chip, /'ثبت تحویل اضطراری به مدیر'/)
  assert.match(files.admin, /label="بازیابی شیفت قدیمی"/)
  assert.match(files.settings, /«نشست‌هایی که نامشان\s+دستی عوض شد» \(گزارشات فروش\)/)
  assert.match(files.cashClose, /MASTER_OVERRIDE_COUNT: 'شمارش تحویل اضطراری به مدیر'/)
  assert.ok(!visible(files.chip).includes(' Main '), 'chip: «Main» left')
  assert.ok(!files.admin.includes('»ی Settings') && !files.admin.includes('» Settings'), 'admin: «Settings» left')
  assert.ok(!visible(files.settings).includes('رمز دوم Settings') && !visible(files.settings).includes('epoch'), 'settings: «Settings»/«epoch» left')
  assert.ok(!files.cashClose.includes('evidence قدیمی'), 'CashClose: «evidence» left')
  assert.ok(!files.pos.includes('اعتبار pooled') && !files.salesReturn.includes('در Audit ثبت'), 'Pos/SalesReturn word left')
  for (const word of ['snapshot:', 'snapshot زمان', 'یک snapshot', "' · canonical'", "' · Legacy'", 'override شد']) {
    assert.ok(!files.cashClose.includes(word), `CashClose: «${word}» left`)
  }
})

await test('code names, channels and test-measured texts stay', () => {
  assert.match(files.chip, /reset\('masterOverride'\)/)
  assert.match(files.chip, /CH\.custodyMasterOverride/)
  assert.match(files.chip, /MasterOverrideForm/)
  // fix-s386 همین جمله‌ها را در CashClose می‌سنجد؛ بی اجازهٔ جدا عوض نمی‌شوند (batch-1.md)
  assert.ok(files.cashClose.includes('مبلغ موردانتظار هرگز در Renderer محاسبه نمی‌شود'))
  assert.ok(files.cashClose.includes('همهٔ segmentها'))
})
