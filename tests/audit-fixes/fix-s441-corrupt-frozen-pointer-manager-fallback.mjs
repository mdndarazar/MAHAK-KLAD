/**
 * A corrupt frozen pointer must not be silently converted into a valid old
 * handover, nor leave the reviewed manager-reset route inaccessible. No fake
 * count, owner, acceptance, or attribution may be constructed from it.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s441-corrupt-frozen-pointer-manager-fallback.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-corrupt-frozen-s441-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر بررسی S441')
const old = seed.user('صندوقدار قدیمی S441')
const replacement = seed.user('صندوقدار تازه S441')
for (const id of [old, replacement]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager441!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager441!' })
for (const [id, temp, final] of [
  [old, 'OldTemp441!', 'OldFinal441!'], [replacement, 'NewTemp441!', 'NewFinal441!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager441!', reason: 'PIN واقعی برای آزمون pointer خراب' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: final })
}
const oldShift = await custodyService.open({ userId: old, password: 'OldFinal441!', countedCash: 10 })
const original = await custodyService.handoverStart({ password: 'OldFinal441!', operationalTotal: 10,
  toUserId: replacement, idempotencyKey: 's441-original' })
// This pointer is irreconcilable: its document claims to have completed, but
// CustodyState still points to it as a frozen acceptance on the original Shift.
sql.prepare('UPDATE "CustodyHandover" SET status=? WHERE id=?').run('COMPLETED', original.id)
sql.prepare('UPDATE "CustodyState" SET state=?, epoch=epoch+1 WHERE key=?').run('HANDOVER_RECOUNT', 'MAIN')
const past = new Date(Date.now() - 180 * 86400_000)
const cutover = new Date(past.getTime() + 3600_000)
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(past.toISOString(), oldShift.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?')
  .run(toJalaliDate(past), cutover.toISOString(), oldShift.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=?').run(toJalaliDate(past), oldShift.shiftId)
eq('corrupt frozen state is not automatically rewritten', (await custodyService.status()).state, 'HANDOVER_RECOUNT')
eq('corrupt record is not treated as an unresolved actual handover', seed.count('CustodyResolution'), 0)
eq('old Shift stays open until explicit review', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', oldShift.shiftId)?.closedAt, null)
await assert.rejects(() => custodyService.emergencyCover({ userId: replacement,
  password: 'NewFinal441!', operationalTotal: 10, reason: 'شمارش شخصی هست ولی سند قبلی خراب است.' }),
(error) => error?.code === 'CUSTODY_INVARIANT_BROKEN', 'cashier cannot take over a corrupt linked witness')
checks++; console.log('  ✓ corrupted witness refuses automatic emergency attribution')
eq('failed cover has no fabricated Shift', seed.count('Shift'), 1)
eq('failed cover does not rewrite completed document', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', original.id)?.status, 'COMPLETED')
const reset = await custodyService.resetShift({ managerUserId: manager, password: 'Manager441!', confirmed: true,
  reason: 'شناسهٔ تحویل ناتمام با سند تکمیل‌شده ناسازگار است؛ رسیدگی مستقل لازم است.' })
eq('manager still has an authenticated recovery route', reset.outcome, 'RECOVERED_REAL_OWNER')
eq('manager reset restores only actual previous owner', reset.activeShiftId, oldShift.shiftId)
eq('bad document is preserved for investigation', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', original.id)?.status, 'COMPLETED')
const next = await custodyService.open({ userId: replacement, password: 'NewFinal441!', operationalTotal: 0,
  note: 'پس از بررسی مدیر، صندوق امروز را مستقلاً شمردم.' })
eq('next cashier can open separately after reviewed reset and expiry', seed.one('SELECT userId FROM "Shift" WHERE id=?', next.shiftId)?.userId, replacement)
eq('old Shift ends at actual cutover', Number(seed.one('SELECT closedAt FROM "Shift" WHERE id=?', oldShift.shiftId)?.closedAt), cutover.getTime())
eq('new cashier owns exactly one new Shift', seed.count('Shift'), 2)
eq('audit retains old corrupt pointer from manager reset', JSON.parse(seed.one('SELECT "before" FROM "AuditLog" WHERE action=? ORDER BY id DESC LIMIT 1', 'CUSTODY_SHIFT_RESET')?.before ?? '{}').unfinishedHandoverId, original.id)
console.log(`\n✓ ${checks} corrupt-pointer fallback checks passed`)
