/**
 * دفتر آزمون ۴-۳۹ — کادر تاریخ رایانه (`JalaliDateInput.tsx`، در همهٔ ۱۴ پرونده) سه‌بخشی با «/» ثابت؛
 * گزارش حضانت (`CustodyAdminChip.tsx`) از اول تاریخ امروز. منطق خالص با اجرای واقعی، و ساختار
 * کادر با خواندن متن پرونده (Node پروندهٔ tsx را اجرا نمی‌کند).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JALALI_PART_LENGTHS, cleanJalaliPart, joinJalaliParts, padJalaliPart, splitJalaliParts } from '../../src/renderer/src/components/jalaliDateParts.ts'

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')

await test('pure logic: split, clean (digits only, Persian too, no "/"), join and pad', () => {
  assert.deepEqual([...JALALI_PART_LENGTHS], [4, 2, 2])
  assert.deepEqual(splitJalaliParts('1405/06/25'), ['1405', '06', '25'])
  assert.deepEqual(splitJalaliParts(''), ['', '', ''])
  assert.deepEqual(splitJalaliParts(undefined), ['', '', ''])
  assert.deepEqual(splitJalaliParts('۱۴۰۵/۰۹/۰۶'), ['1405', '09', '06'], 'old Persian-digit values still read')
  assert.equal(cleanJalaliPart('۱۴۰۵', 0), '1405')
  assert.equal(cleanJalaliPart('١٤٠٥', 0), '1405', 'Arabic-Indic digits')
  assert.equal(cleanJalaliPart('14055', 0), '1405', 'max 4 digits for the year')
  assert.equal(cleanJalaliPart('a/9', 1), '9', 'letters and "/" are dropped')
  assert.equal(cleanJalaliPart('123', 2), '12', 'max 2 digits for the day')
  assert.equal(joinJalaliParts(['1405', '09', '06']), '1405/09/06')
  assert.equal(joinJalaliParts(['', '', '']), '', 'all empty stays "no date"')
  assert.equal(joinJalaliParts(['1405', '', '']), '1405//', 'partial values stay invalid (red) until complete')
  assert.equal(padJalaliPart('9', 1), '09')
  assert.equal(padJalaliPart('3', 2), '03')
  assert.equal(padJalaliPart('1', 0), '1', 'the year is never padded')
  assert.equal(padJalaliPart('12', 1), '12')
})

await test('JalaliDateInput: three numeric boxes, two fixed "/", auto-advance, same outside value', () => {
  const src = read('src/renderer/src/components/JalaliDateInput.tsx')
  assert.equal((src.match(/<span className="select-none opacity-60">\/<\/span>/g) ?? []).length, 2, 'two fixed slashes')
  assert.match(src, /inputMode="numeric"/)
  assert.match(src, /maxLength=\{JALALI_PART_LENGTHS\[i\]\}/)
  assert.match(src, /if \(next\[i\]\.length === JALALI_PART_LENGTHS\[i\] && i < 2\) focusPart\(i \+ 1\)/, 'moves on by itself')
  assert.match(src, /onChange\(joinJalaliParts\(next\)\)/, 'outside value is the same yyyy/MM/dd string')
  assert.match(src, /border-red-400 bg-red-50/, 'invalid date still turns red')
  assert.match(src, /تاریخ نامعتبر/)
  assert.match(src, /value: string\n  onChange: \(v: string\) => void\n  className\?: string\n  autoFocus\?: boolean/, 'props unchanged for the 14 callers')
})

await test('custody report: both dates start with today and use the same box', () => {
  const src = read('src/renderer/src/components/CustodyAdminChip.tsx')
  assert.match(src, /useState\(\(\) => jalaliToday\(\)\)\n  const \[discrepancyTo, setDiscrepancyTo\] = useState\(\(\) => jalaliToday\(\)\)/)
  assert.equal((src.match(/<JalaliDateInput className="input mt-1" value=\{discrepancy(From|To)\}/g) ?? []).length, 2)
  assert.ok(!src.includes('placeholder="۱۴۰۵/۰۷/۲۰"'))
})
