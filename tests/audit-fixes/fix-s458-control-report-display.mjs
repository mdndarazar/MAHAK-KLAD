/** Rendering-only controls: today Jalali default, signed difference display,
 * visible rial/thousands at opening and no coercion of malformed amounts.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s458-control-report-display.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { formatOpeningRialTyping } = await import('../../src/shared/custodyRialInput.ts')
const { parseRequiredRialAmount, money } = await import('@shared/jalali')
const read = (name) => readFileSync(name, 'utf8')
let checks = 0
const eq = (name, got, wanted) => { assert.deepEqual(got, wanted, name); checks++; console.log(`  ✓ ${name}`) }
const plain = formatOpeningRialTyping('47940000', 8)
eq('opening groups valid ungrouped input', plain, { text: money(47_940_000), cursor: money(47_940_000).length })
eq('opening preserves zero rather than confusing it with blank', [formatOpeningRialTyping('۰', 1).text, formatOpeningRialTyping('', 0).text], ['۰', ''])
eq('typing within the amount retains logical digit caret', formatOpeningRialTyping('۱۹٬۰۰۰', 2).cursor, 2)
for (const bad of ['1,2', '۱۲٫۵', '-100', '100ریال', '9007199254740992']) {
  eq(`bad amount ${bad} stays visible and invalid`, [formatOpeningRialTyping(bad, bad.length).text, parseRequiredRialAmount(bad)], [bad, null])
}
const admin = read('src/renderer/src/components/CustodyAdminChip.tsx')
const chip = read('src/renderer/src/components/CustodyChip.tsx')
const evidence = read('src/renderer/src/components/CustodyBlueEvidence.tsx')
const resolution = read('src/renderer/src/components/BlueResolutionPanel.tsx')
const difference = read('src/renderer/src/components/CustodyDifference.tsx')
const opening = read('src/renderer/src/components/OpeningRialInput.tsx')
eq('control report starts with both local Jalali dates today', (admin.match(/useState\(\(\) => toJalaliDate\(new Date\(\)\)\)/g) ?? []).length, 2)
eq('control report uses existing Jalali input for both dates', (admin.match(/<JalaliDateInput/g) ?? []).length, 2)
eq('control report never silently falls back to a 90-day range on cleared fields', admin.includes('if (!isValidJalaliDate(discrepancyFrom) || !isValidJalaliDate(discrepancyTo))'), true)
eq('opening shows grouped count and the rial unit without modifying Main amount', opening.includes('formatOpeningRialTyping') && opening.includes('ریال') && chip.includes('<OpeningRialInput'), true)
eq('shared difference presentation distinguishes shortage, excess, zero and unknown with an accessible label', ['text-rose-700', 'text-emerald-700', 'text-slate-700', 'text-amber-900', 'aria-label'].every((part) => difference.includes(part)), true)
eq('blue evidence and manager pending views use signed difference presentation', evidence.includes('<CustodyDifference') && resolution.includes('<CustodyDifference'), true)
eq('reference label is only in presentation surfaces', [evidence.includes('عدد مرجع اولیه'), resolution.includes('عدد مرجع پس از تصمیم'), chip.includes('عدد مرجع گزارش')], [true, true, true])
console.log(`\n✓ ${checks} presentation checks passed`)
