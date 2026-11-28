/**
 * دفتر آزمون ۴-۴۰ — جداکنندهٔ هزارگان در کادرهای مبلغ حضانت صندوق (`CustodyChip.tsx`، هفت کادر)
 * با کادر مشترک `AmountInput.tsx`. منطق خالص با اجرای واقعی؛ ساختار با خواندن متن پرونده.
 * عددی که به برنامه می‌رسد همان رشتهٔ رقم‌های لاتین امروز است.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { amountDigits, caretAfterDigits, formatAmountFa, tomanHint } from '../../src/renderer/src/components/amountFormat.ts'

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')

await test('typing Persian or Latin digits, or pasting a separated number, gives the same integer string', () => {
  assert.equal(amountDigits('10000000'), '10000000')
  assert.equal(amountDigits('۱۰۰۰۰۰۰۰'), '10000000')
  assert.equal(amountDigits('۱۰٬۰۰۰٬۰۰۰'), '10000000', 'pasted with Persian separators')
  assert.equal(amountDigits('10,000,000'), '10000000', 'pasted with Latin commas')
  assert.equal(amountDigits('٧٠٠٠٠٠٠٠ ریال'), '70000000', 'Arabic-Indic digits and text are dropped')
  assert.equal(amountDigits(''), '')
  assert.equal(Number(amountDigits('۷۰٬۰۰۰٬۰۰۰')), 70_000_000, 'the app still receives the same safe integer')
})

await test('display groups digits in threes with Persian digits; helper line in toman', () => {
  assert.equal(formatAmountFa('10000000'), '۱۰٬۰۰۰٬۰۰۰')
  assert.equal(formatAmountFa('70000000'), '۷۰٬۰۰۰٬۰۰۰')
  assert.equal(formatAmountFa('999'), '۹۹۹')
  assert.equal(formatAmountFa('1000'), '۱٬۰۰۰')
  assert.equal(formatAmountFa(''), '')
  assert.equal(tomanHint('10000000'), 'یعنی ۱ میلیون تومان')
  assert.equal(tomanHint('70500000'), 'یعنی ۷٬۰۵۰٬۰۰۰ تومان')
  assert.equal(tomanHint('12345'), 'یعنی ۱٬۲۳۴٫۵ تومان')
  assert.equal(tomanHint('0'), '')
  assert.equal(tomanHint(''), '')
  assert.equal(caretAfterDigits('۱۰٬۰۰۰٬۰۰۰', 3), 4, 'caret stays after the third digit')
  assert.equal(caretAfterDigits('۱۰٬۰۰۰٬۰۰۰', 0), 0)
  assert.equal(caretAfterDigits('۱۰٬۰۰۰٬۰۰۰', 8), 10)
})

await test('CustodyChip: all seven amount boxes use the shared box; nothing else changes', () => {
  const chip = read('src/renderer/src/components/CustodyChip.tsx')
  assert.equal((chip.match(/<AmountInput value=\{amount\} onChange=\{setAmount\}/g) ?? []).length, 7)
  assert.ok(!chip.includes('inputMode="numeric" value={amount}'), 'no raw number box is left')
  assert.match(chip, /const value = Number\(countedCash\)/, 'the same integer reaches the app')
  const box = read('src/renderer/src/components/AmountInput.tsx')
  assert.match(box, /onChange\(amountDigits\(e\.target\.value\)\)/)
  assert.match(box, /value=\{shown\}/)
  assert.match(box, />ریال</)
})
