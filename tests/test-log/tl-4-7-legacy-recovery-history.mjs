/**
 * دفتر آزمون ۴-۷ — «بازیابی‌های Shift قدیمی»: کادر زرد فقط تا ثبت یادداشت؛ پس از آن در «سوابق» همان تب:
 *  - گزارش مدیر (همان کانال واقعی صفحه) فیلد فقط‌خواندنی `legacyRecoveriesUnreviewed` دارد: بازیابی‌هایی که هیچ یادداشتی
 *    ندارند، بی بازهٔ تاریخ؛ پس بازیابی بی‌یادداشتِ قدیمی‌تر از ۹۰ روز هم از دید نمی‌رود؛ شکل هر ردیف همان `legacyRecoveries`؛
 *  - با ثبت یادداشت (راه صفحه، ۴-۸) آن بازیابی از کادر زرد می‌رود و در سوابق (دو فهرست امروز) با یادداشتش می‌ماند؛ بازیابی
 *    تازه دوباره در کادر زرد می‌آید؛ هیچ داده‌ای پاک یا عوض نمی‌شود؛
 *  - صفحه (`CustodyAdminChip.tsx`): کادر زرد، جدول و فرم از همین فیلد؛ دکمهٔ بستهٔ «سوابق بازیابی‌ها (n)» فقط خواندنی.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-7-legacy-recovery-history.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-7-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 47, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = async (channel, payload) => {
  const r = await handlers.get(channel)({ sender }, payload)
  assert.equal(r.ok, true, `${channel}: ${r.error}`)
  return r.data
}

const db = harnessClient()
const seed = makeSeeder(db)
const DAY = 86_400_000

// ---------------------------------------------------------------- یک بازیابی واقعی امروز و یک بازیابی ۱۲۰ روز پیش
const manager = seed.user('مدیر ۴-۷')
const cashier = seed.user('کارمند ۴-۷')
db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', cashier)
await custodyService.setPin({ userId: manager, newPassword: 'Manager47!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager47!' })
await custodyService.setPin({ userId: cashier, newPassword: 'Temporary47!', managerUserId: manager, managerPassword: 'Manager47!', reason: 'راه‌اندازی آزمون ۴-۷' })
await custodyService.setPin({ userId: cashier, currentPassword: 'Temporary47!', newPassword: 'Cashier47!' })
seed.insert('Shift', { name: 'شیفت قدیمی ۴-۷', number: 1, dayJalali: '1405/08/24', sessionSeq: 1, userId: cashier, staffConfirmed: true, openedVia: 'MANUAL', openedAt: new Date(Date.now() - DAY) })
const status = await custodyService.status()
const { recoveryId: today } = await custodyService.recoverLegacyOpenShifts({
  userId: cashier, password: 'Cashier47!', countedCash: 0, note: 'دو شیفت قدیمی باز مانده بود و کشو شمرده شد.',
  ackTextVersion: 'LEGACY_RECOVERY_V1', idempotencyKey: 'tl-4-7-recovery-0001', seenEpoch: status.epoch, seenShiftIds: status.legacyBlock.shiftIds
})
const recoveryRow = (key, at) => seed.insert('LegacyShiftRecovery', {
  idempotencyKey: key, requestFingerprint: `fp-${key}`, witnessUserId: cashier, actorKind: 'STAFF', authMethod: 'CUSTODY_PIN', countedCash: 0,
  expectedTotalSnapshot: null, provisionalDifference: null, differenceScope: 'EXPECTED_UNAVAILABLE', ackTextVersion: 'LEGACY_RECOVERY_V1', note: null,
  epochBefore: 0, epochAfter: 0, createdAt: new Date(at), operationalDay: '1405/05/01'
})
const old = recoveryRow('tl-4-7-old', Date.now() - 120 * DAY)

assert.equal((await handlers.get(IPC.managerVerify)({ sender }, { password: '1111' }))?.ok, true)
const report = () => invoke(IPC.custodyReport, {})
const ids = (rows) => (rows ?? []).map((r) => r.id)
const note = (recoveryId, reason, key) => invoke(IPC.custodyLegacyRecoveryReview, { recoveryId, reason, idempotencyKey: key, decision: 'NOTE' })

test('before any note: both recoveries are in the yellow list, the one older than 90 days too; the range lists stay as they were', async () => {
  const r = await report()
  assert.deepEqual(ids(r.legacyRecoveriesUnreviewed), [today, old], 'newest first, no date range')
  assert.deepEqual(ids(r.legacyRecoveries), [today], 'the report range (90 days by default) is unchanged')
  assert.deepEqual(r.legacyRecoveriesUnreviewed[0], r.legacyRecoveries[0], 'the same row shape: witness, old shifts, count, opening')
  assert.equal(r.legacyRecoveriesUnreviewed[0].items.length, 1)
  assert.equal(r.legacyRecoveriesUnreviewed[1].witnessName, 'کارمند ۴-۷', 'names are read for an out-of-range row too')
  assert.equal(r.summary.legacyRecoveries, 1, 'the summary counts stay those of the range')
})

test('a note moves the recovery out of the yellow list into the records, with its note; old data is never changed', async () => {
  await note(today, 'مدیر سابقه را دید؛ پیش از روشن شدن حضانت بود.', 'legacy-review-tl47-0001')
  const r = await report()
  assert.deepEqual(ids(r.legacyRecoveriesUnreviewed), [old])
  assert.deepEqual(ids(r.legacyRecoveries), [today], 'still in the records')
  assert.deepEqual(r.legacyRecoveryReviews.map((x) => [x.recoveryId, x.reason, x.actorName]), [[today, 'مدیر سابقه را دید؛ پیش از روشن شدن حضانت بود.', null]])
  await note(old, 'بازیابی قدیمی هم دیده شد.', 'legacy-review-tl47-0002')
  const after = await report()
  assert.deepEqual(ids(after.legacyRecoveriesUnreviewed), [], 'no unreviewed recovery ⇒ the whole yellow box hides')
  assert.equal(seed.count('LegacyShiftRecovery'), 2, 'nothing is deleted')
  assert.equal(seed.count('LegacyShiftRecoveryReview'), 2)
})

test('a later recovery shows again in the yellow list until its note; any decision counts as reviewed', async () => {
  const later = recoveryRow('tl-4-7-later', Date.now())
  assert.deepEqual(ids((await report()).legacyRecoveriesUnreviewed), [later])
  await custodyService.reviewLegacyRecovery({ recoveryId: later, reason: 'بازبینی شد و باز می‌ماند.', idempotencyKey: 'legacy-review-tl47-0003', decision: 'REVIEWED_KEEP_UNRESOLVED', managerUserId: manager, managerPassword: 'Manager47!' })
  assert.deepEqual(ids((await report()).legacyRecoveriesUnreviewed), [])
})

test('the page: yellow box, table and form only from the unreviewed list; a closed, read-only «سوابق بازیابی‌ها (n)» with the notes', () => {
  const src = readFileSync(new URL('../../src/renderer/src/components/CustodyAdminChip.tsx', import.meta.url), 'utf8')
  const yellowAt = src.indexOf('<b>بازیابی‌های شیفت قدیمی</b>')
  const yellowBlock = src.slice(src.lastIndexOf('{(report?.', yellowAt), src.indexOf('سوابق بازیابی‌ها', yellowAt))
  assert.match(yellowBlock, /^\{\(report\?\.legacyRecoveriesUnreviewed\?\.length \?\? 0\) > 0 \?/, 'the yellow box shows only while an unreviewed recovery exists')
  assert.match(yellowBlock, /<LegacyRecoveryTable rows=\{report\?\.legacyRecoveriesUnreviewed \?\? \[\]\} \/>/)
  assert.match(yellowBlock, /report\?\.legacyRecoveriesUnreviewed\?\.map\(\(row\) => <option key=\{row\.id\} value=\{row\.id\}>بازیابی #\{row\.id\}<\/option>\)/, 'the form offers only unreviewed recoveries')
  assert.match(yellowBlock, /setReviewRecoveryId\(next\.legacyRecoveriesUnreviewed\?\.\[0\]\?\.id \?\? ''\)/, 'after a note the next unreviewed one is picked')
  assert.equal(yellowBlock.includes('legacyRecoveries?.map'), false)
  const historyAt = src.indexOf('سوابق بازیابی‌ها (')
  assert.ok(historyAt > 0)
  const history = src.slice(src.lastIndexOf('{(report?.legacyRecoveries?.length ?? 0) > 0 ?', historyAt), src.indexOf('آخرین شمارش‌ها', historyAt))
  assert.match(history, /useState|showRecoveryHistory \?/, 'closed until the manager opens it')
  assert.match(history, /<LegacyRecoveryTable rows=\{report\?\.legacyRecoveries \?\? \[\]\} \/>/)
  assert.match(history, /row\.actorName \?\? 'نشست مدیر'/)
  assert.equal(/<input|<select|<textarea|CH\.custodyLegacyRecoveryReview/.test(history), false, 'read-only: no field and no writer in the records')
  assert.match(src, /const \[showRecoveryHistory, setShowRecoveryHistory\] = useState\(false\)/)
})
