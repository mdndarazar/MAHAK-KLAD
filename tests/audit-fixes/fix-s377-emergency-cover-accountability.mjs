/**
 * The next worker, not an absent giver or a manager, uses their own PIN and a
 * real combined count. A failed official reference is PENDING, never a fake
 * zero, auto blame, manager wait or a sale-blocking freeze.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s377-emergency-cover-accountability.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-emergency-blue-s377-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const manager = seed.user('مدیر S377')
const absent = seed.user('مسئول غایب S377')
const cover = seed.user('پوشش‌دهنده S377')
await custodyService.setPin({ userId: manager, newPassword: 'Manager377!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager377!' })
for (const [id, temp, personal] of [[absent, 'Absent377!', 'Absent3774!'], [cover, 'Cover377!', 'Cover3774!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager377!', reason: 'سنجش پوشش غیبت با شمارش واقعی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: personal })
}
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
async function rejects(label, code, work) { try { await work() } catch (error) { eq(label, error?.code, code); return } throw new Error(`${label}: unexpectedly accepted`) }
const old = await custodyService.open({ userId: absent, password: 'Absent3774!', operationalTotal: 1000 })
const reason = 'مسئول قدیمی صندوق حاضر نیست؛ همکار با PIN و مبلغ واقعی صندوق را می‌پذیرد.'
await rejects('cover requires its own PIN', 'PIN_WRONG', () => custodyService.emergencyCover({ userId: cover, password: '1111', operationalTotal: 900, reason }))
await rejects('cover requires meaningful reason', 'EMERGENCY_REASON_REQUIRED', () => custodyService.emergencyCover({ userId: cover, password: 'Cover3774!', operationalTotal: 900, reason: 'کم' }))
eq('failed attempts keep previous real owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, old.shiftId)
const originalReportRows = salesService.reportRows
salesService.reportRows = async () => { throw new Error('financial report temporarily unavailable') }
let emergency
try {
  emergency = await custodyService.emergencyCover({ userId: cover, password: 'Cover3774!', operationalTotal: 900, reason })
} finally { salesService.reportRows = originalReportRows }
eq('unknown reference is explicitly pending', emergency.referenceStatus, 'PENDING_RECONCILIATION')
eq('unknown is not a guessed numeric zero', emergency.referenceAmount, null)
eq('unknown means raw difference is null', emergency.rawDifference, null)
eq('new person owns sales immediately, without manager decision', (await custodyService.actorForFinancialOperation()).expectedShiftId, emergency.shiftId)
eq('old Shift still belongs to actual absent owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', old.shiftId).userId, absent)
const absentEvidence = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', emergency.handoverId, 'OUT')
const realEvidence = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', emergency.handoverId, 'IN')
eq('absent count is SYSTEM absence, not human zero', absentEvidence.countOrigin, 'ABSENT_UNCOUNTED')
eq('no absent PIN was claimed', absentEvidence.authMethod, 'SYSTEM_ABSENCE')
eq('absent has no human count', absentEvidence.humanAmount, null)
eq('worker independently counted 900', Number(realEvidence.humanAmount), 900)
eq('worker PIN recorded as worker personal PIN', realEvidence.authMethod, 'CUSTODY_PIN')
eq('worker reference remains PENDING on failure', realEvidence.referenceStatus, 'PENDING_RECONCILIATION')
eq('worker unknown raw stays null', realEvidence.rawDifference, null)
eq('no new discrepancy case imputes fault', seed.count('CustodyDiscrepancyCase'), 0)
eq('cover count never becomes fake cash float', seed.count('CashMovement', 'shiftId=? AND type=?', emergency.shiftId, 'OPENING_FLOAT'), 0)
const event = seed.one('SELECT type, actorUserId, authMethod FROM "CustodyEvent" WHERE handoverId=? ORDER BY id DESC LIMIT 1', emergency.handoverId)
eq('cover event is distinct', event.type, 'BLUE_EMERGENCY_COVER_COMMITTED')
eq('named cover is authenticated actor, not absent owner', event.actorUserId, cover)
eq('event stores personal PIN method only, not raw PIN', event.authMethod, 'CUSTODY_PIN')
const ui = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
eq('UI offers personal cover PIN', ui.includes('CH.custodyEmergencyCover') && ui.includes('PIN شخصی کارمند پوشش‌دهنده'), true)
eq('IPC strips obsolete freeze API field', ipc.includes('countedCash: _old') && ipc.includes('custodyService.emergencyCover(safe)'), true)
console.log(`\n✓ ${checks} checks passed`)
