// The off-roster recovery must actually be reachable from the desktop dialog,
// not only from a direct Main service call.
// node --import ./test/harness/register.mjs tests/audit-fixes/fix-s436-off-schedule-opening-renderer-contract.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const chip = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
const admin = readFileSync(new URL('../../src/renderer/src/components/CustodyAdminChip.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../../src/renderer/src/pages/Settings.tsx', import.meta.url), 'utf8')
assert.match(chip, /const openingEligible = eligible\b/, 'single-shift exception cannot be hidden by filtering out the replacement')
assert.match(chip, /staff=\{openingEligible\}/, 'all PIN-eligible staff are offered in the opening dialog')
assert.match(chip, /showNote legacyOpening=\{status\.legacyOpeningRequired === true\}/, 'reason field remains visible for every opening')
assert.match(chip, /operationalTotal: count, note: reason/, 'ordinary opening sends a real drawer+POS count and stated reason to Main')
assert.match(chip, /countedCash: count, note: reason, boundaryReason: reason/, 'legacy opening sends the reason to both roster and historical count boundaries')
assert.match(chip, /view === 'legacyRecovery' && legacyBlock \? <LegacyRecoveryForm legacy=\{legacyBlock\} staff=\{openingEligible\}/, 'unplanned employee can access authenticated old-Shift recovery')
assert.match(chip, /CH\.custodyLegacyRecover, \{ userId: selectedUserId, password, countedCash: amount\(\), note: note\.trim\(\) \|\| undefined/, 'recovery sends the count, PIN and stated reason')
assert.match(chip, /خارج از برنامه هستید، دلیل حداقل ۱۰ حرفی لازم است/, 'a person outside the plan is told why a reason is necessary')
assert.match(ipc, /return custodyService\.open\(\{ userId, password, operationalTotal, note, boundaryReason \}\)/, 'public IPC does not strip exception evidence')
assert.match(ipc, /return custodyService\.open\(\{ userId, password, countedCash, note, boundaryReason \}\)/, 'legacy IPC retains the reason without creating a blue amount')
assert.match(admin, /ورود و بازیابی خارج از برنامه در همین صفحه/, 'the manager can review exceptions without changing earlier ownership')
assert.match(admin, /event\.payload\?\.reason/, 'the manager sees the actual reason, not just an unscheduled label')
assert.match(settings, /جانشین خارج از برنامه با دلیل ثبت‌شده/, 'shift settings explain the exception rather than promising a hard roster gate')
assert.doesNotMatch(settings, /فقط فرد ثبت‌شده در بازهٔ فعال می‌تواند صندوق را تحویل بگیرد/, 'settings do not contradict independent replacement openings')
console.log('✓ desktop, public IPC and manager report keep out-of-roster evidence reachable')
