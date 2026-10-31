/**
 * A new blue opening must NOT also enter the old cross-day aggregate chain.
 * The old chain can invent a second shortage for the next owner after a real
 * final close, even when the next count is unchanged. Never rewrite old rows:
 * simply stop producing aggregate-v2 evidence for new blue-only openings.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s418-custody-blue-opening-no-legacy-case.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-no-old-case-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const seed = makeSeeder(harnessClient())
let checks = 0
function eq(label, got, expected) {
  if (got !== expected) throw new Error(`${label}: expected ${expected}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
const manager = seed.user('مدیر S418')
const old = seed.user('مسئول اول S418')
const next = seed.user('مسئول دوم S418')
await custodyService.setPin({ userId: manager, newPassword: 'Manager418!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager418!' })
for (const [userId, temp, pin] of [[old, 'Old418!', 'Old4184!'], [next, 'Next418!', 'Next4184!']]) {
  await custodyService.setPin({ userId, newPassword: temp, managerUserId: manager, managerPassword: 'Manager418!', reason: 'آزمون عدم تکرار کسری قدیمی' })
  await custodyService.setPin({ userId, currentPassword: temp, newPassword: pin })
}
const first = await custodyService.open({ userId: old, password: 'Old4184!', operationalTotal: 20_000_000 })
eq('first blue opening belongs to old actual owner', (await custodyService.status()).custodian?.id, old)
await custodyService.finalClose({ password: 'Old4184!', operationalTotal: 18_000_000 })
const closing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', first.shiftId, 'FINAL_CLOSE')
eq('last human count frozen on final close', Number(closing?.humanAmount), 18_000_000)
eq('real drop recorded on old owner’s blue period', Number(closing?.freshDifference), -2_000_000)
const second = await custodyService.open({ userId: next, password: 'Next4184!', operationalTotal: 18_000_000 })
const opening = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', second.shiftId, 'OPENING')
eq('next count is a distinct new owner’s document', Number(opening?.humanAmount), 18_000_000)
eq('new opening cannot claim a comparable period from a prior shift', opening?.freshDifference, null)
eq('no NEW legacy aggregate-v2 boundary for a blue-only opening', seed.count('CustodyAggregateBoundary'), 0)
eq('no duplicate legacy fault case charged to the next owner', seed.count('CustodyDiscrepancyCase'), 0)
eq('old and new blue evidence remain separately accessible', seed.count('CustodyBlueSnapshot'), 3)
console.log(`\n✓ ${checks} checks passed`)
