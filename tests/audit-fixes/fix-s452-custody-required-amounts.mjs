/** Low-risk amount input regression: an empty count is never zero, malformed
 * input never becomes a different rial amount, and legacy no-count close is
 * still allowed/read as an unknown difference.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s452-custody-required-amounts.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-required-rial-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { parseRequiredRialAmount, toJalaliDate } = await import('@shared/jalali')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const day = toJalaliDate(new Date())
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  checks++; console.log(`  ✓ ${label}`)
}

for (const [raw, amount] of [
  ['0', 0], ['۰', 0], ['٠', 0], ['۰۰۰', 0], ['۱۲۳۴', 1234],
  ['۱٬۲۳۴٬۵۶۷', 1_234_567], ['1,234', 1234], ['1 234', 1234],
  ['9007199254740991', Number.MAX_SAFE_INTEGER]
]) eq(`required amount ${JSON.stringify(raw)}`, parseRequiredRialAmount(raw), amount)
for (const raw of [null, undefined, '', ' ', '1.5', '۱٫۵', '-5', '+5', '1e3', '0x10', '1,5', '1٬23', '12abc', '9007199254740992'])
  eq(`reject malformed amount ${JSON.stringify(raw)}`, parseRequiredRialAmount(raw), null)

// The renderer must never turn '-' or '.' into a new, apparently valid count.
// Opening has a display-only formatter that leaves invalid text untouched;
// the four other custody amount fields still pass raw input through.
const chip = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
const opening = readFileSync(new URL('../../src/renderer/src/components/OpeningRialInput.tsx', import.meta.url), 'utf8')
const formatter = readFileSync(new URL('../../src/shared/custodyRialInput.ts', import.meta.url), 'utf8')
eq('non-opening custody fields preserve raw text', chip.match(/setAmount\(e\.target\.value\)/g)?.length, 4)
eq('opening formats only a value accepted by the strict rial parser', opening.includes('formatOpeningRialTyping') && formatter.includes('if (amount === null) return { text: raw, cursor }'), true)
eq('custody submit uses shared parser', chip.includes('parseRequiredRialAmount(countedCash)'), true)
eq('custody does not silently strip invalid characters', /setAmount\(e\.target\.value\.replace/.test(chip), false)
const legacyUi = readFileSync(new URL('../../src/renderer/src/pages/CashClose.tsx', import.meta.url), 'utf8')
eq('legacy count uses shared parser', legacyUi.includes('parseRequiredRialAmount(counted)'), true)
eq('legacy opening float uses shared parser', legacyUi.includes('parseRequiredRialAmount(openingFloat)'), true)
eq('invalid nonblank legacy amount must be rejected before closing', legacyUi.indexOf('if (invalidCounted || invalidOpeningFloat)') < legacyUi.indexOf('const res = await call<any>(CH.cashClose,'), true)

// The legacy read-side contract is already in place; retain it rather than
// changing CashCloseGuard or inventing a new write-side difference state.
const clerk = seed.user('صندوقدار قدیمی S439')
const shiftId = seed.insert('Shift', { name: 'قدیمی S439', number: 1, dayJalali: day, openedAt: Date.now(), userId: clerk })
const closed = await cashboxService.close({ shiftId, explicitShift: true, userId: clerk, closeShift: true,
  note: 'نشست آزمایشی بدون فاکتور و بدون شمارش نقدی بسته می‌شود.' })
const stored = seed.one('SELECT countedTotal, cashDifference FROM "CashSession" WHERE id=?', closed.session.id)
eq('no count stays NULL in stored legacy session', stored.countedTotal, null)
eq('stored legacy no-count placeholder still zero for compatibility', Number(stored.cashDifference), 0)
const prior = (await cashboxService.sessions({ fromJalali: day, toJalali: day })).find((s) => s.id === closed.session.id)
eq('legacy manager history treats no count as unknown difference', prior?.diff, null)

const manager = seed.user('مدیر S439')
await custodyService.setPin({ userId: manager, newPassword: 'Manager439!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager439!' })
for (const bad of ['', '   ', '-5', '1.5', '1e3', '1,5', '9007199254740992']) {
  let rejected = false
  try { await custodyService.open({ userId: manager, password: 'Manager439!', operationalTotal: bad }) }
  catch { rejected = true }
  eq(`Main rejects invalid opening ${JSON.stringify(bad)}`, rejected, true)
  eq('invalid opening leaves drawer available', (await custodyService.status()).state, 'NO_SESSION')
}
const opened = await custodyService.open({ userId: manager, password: 'Manager439!', operationalTotal: '۱٬۲۳۴' })
eq('Persian grouped count opens the drawer', (await custodyService.status()).state, 'ACTIVE')
eq('opening stores the physical count, not a sanitized guess', Number(seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'OPENING', opened.shiftId)?.humanAmount), 1234)
let invalidCloseRejected = false
try { await custodyService.finalClose({ password: 'Manager439!', operationalTotal: '-5' }) }
catch { invalidCloseRejected = true }
eq('invalid close count rejected by Main', invalidCloseRejected, true)
eq('failed close did not freeze or lock the drawer', (await custodyService.status()).state, 'ACTIVE')
await custodyService.finalClose({ password: 'Manager439!', operationalTotal: '۰' })
eq('explicit Persian zero is accepted for final close', Number(seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'FINAL_CLOSE', opened.shiftId)?.humanAmount), 0)
eq('valid final close releases the drawer normally', (await custodyService.status()).state, 'NO_SESSION')
console.log(`\n✓ ${checks} safe amount checks passed`)
