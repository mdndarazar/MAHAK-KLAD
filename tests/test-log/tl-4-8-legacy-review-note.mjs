/**
 * دفتر آزمون ۴-۸ — «ثبت یادداشت» بازبینی بازیابی Shift قدیمی از راه صفحه ذخیره می‌شود:
 *  - راه صفحه همان کانال واقعی `custody:legacy:review` است؛ IPC نشست مدیر را می‌سنجد و سرویس را با نشست مدیر صدا می‌زند.
 *    پیش از رفع، شناسهٔ تهی نشست به `manager` تهی می‌رسید و خطای کلی «… چیزی ذخیره نشد» می‌آمد؛
 *  - یادداشت با `GLOBAL_MANAGER` و `MANAGER_SESSION`، رویداد `LEGACY_RECOVERY_REVIEWED` و ردیف ممیزی ثبت می‌شود و در
 *    گزارش مدیر دیده می‌شود؛ تکرار با همان کلید چیزی نمی‌افزاید؛ بی نشست مدیر رد و هیچ چیز نوشته نمی‌شود؛
 *  - راه رمز مدیر همان می‌ماند؛ هیچ عدد، مسئولیت یا سند مالی عوض نمی‌شود.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-8-legacy-review-note.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-8-'))
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
const sender = { id: 48, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)

const db = harnessClient()
const seed = makeSeeder(db)

// ---------------------------------------------------------------- یک بازیابی واقعی (همان راه fix-s392)
const manager = seed.user('مدیر ۴-۸')
const cashier = seed.user('کارمند ۴-۸')
db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', cashier)
await custodyService.setPin({ userId: manager, newPassword: 'Manager48!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager48!' })
await custodyService.setPin({ userId: cashier, newPassword: 'Temporary48!', managerUserId: manager, managerPassword: 'Manager48!', reason: 'راه‌اندازی آزمون ۴-۸' })
await custodyService.setPin({ userId: cashier, currentPassword: 'Temporary48!', newPassword: 'Cashier48!' })
const legacyShift = seed.insert('Shift', { name: 'شیفت قدیمی ۴-۸', number: 1, dayJalali: '1405/08/24', sessionSeq: 1, userId: cashier, staffConfirmed: true, openedVia: 'MANUAL', openedAt: new Date(Date.now() - 86_400_000) })
const status = await custodyService.status()
const recovery = await custodyService.recoverLegacyOpenShifts({
  userId: cashier, password: 'Cashier48!', countedCash: 0, note: 'دو شیفت قدیمی باز مانده بود و کشو شمرده شد.',
  ackTextVersion: 'LEGACY_RECOVERY_V1', idempotencyKey: 'tl-4-8-recovery-0001', seenEpoch: status.epoch, seenShiftIds: status.legacyBlock.shiftIds
})
const money = () => ({ movements: seed.count('CashMovement'), closedAt: seed.one('SELECT closedAt FROM "Shift" WHERE id=?', legacyShift)?.closedAt })
const before = money()
const reviews = () => seed.rows('SELECT * FROM "LegacyShiftRecoveryReview" ORDER BY id')
const NOTE = 'مدیر سابقهٔ بازیابی را دید؛ شیفت‌های قدیمی پیش از روشن شدن حضانت باز مانده بودند.'
const payload = (key) => ({ recoveryId: recovery.recoveryId, reason: NOTE, idempotencyKey: key, decision: 'NOTE' })

test('without a manager session the page path is refused and nothing is written', async () => {
  const r = await invoke(IPC.custodyLegacyRecoveryReview, payload('legacy-review-tl48-0000'))
  assert.equal(r.ok, false)
  assert.deepEqual(reviews(), [])
})

let saved
test('with the manager session (the page path) the note is saved: review row, custody event and audit row', async () => {
  assert.equal((await invoke(IPC.managerVerify, { password: '1111' }))?.ok, true)
  // نامی که رندرر بفرستد کنار گذاشته می‌شود؛ همان نشست مدیر
  const r = await invoke(IPC.custodyLegacyRecoveryReview, { ...payload('legacy-review-tl48-0001'), managerUserId: manager, managerPassword: 'spoofed', managerSession: false })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.replayed, false)
  saved = r.data.reviewId
  const [row] = reviews()
  assert.equal(row.id, saved)
  assert.equal(row.recoveryId, recovery.recoveryId)
  assert.equal(row.decision, 'NOTE')
  assert.equal(row.reason, NOTE)
  assert.equal(row.actorKind, 'GLOBAL_MANAGER')
  assert.equal(row.authMethod, 'MANAGER_SESSION')
  assert.equal(row.actorUserId, null)
  const ev = seed.one('SELECT * FROM "CustodyEvent" WHERE type=? ORDER BY id DESC LIMIT 1', 'LEGACY_RECOVERY_REVIEWED')
  assert.ok(ev, 'the custody event is written')
  assert.equal(ev.actorKind, 'GLOBAL_MANAGER')
  assert.equal(ev.authMethod, 'MANAGER_SESSION')
  assert.equal(Number(ev.legacyRecoveryId), recovery.recoveryId)
  const audit = seed.one('SELECT * FROM "AuditLog" WHERE entity=? AND entityId=?', 'LegacyShiftRecoveryReview', saved)
  assert.ok(audit, 'the audit row is written')
  assert.equal(audit.userId, null)
  const report = await invoke(IPC.custodyReport, {})
  assert.equal(report.ok, true, report.error)
  const shown = report.data.legacyRecoveryReviews.find((x) => x.id === saved)
  assert.equal(shown?.reason, NOTE, 'the manager report shows the note')
  assert.equal(shown.actorName, null, 'the page writes «نشست مدیر» for it')
})

test('the same key again adds nothing (replay); a new note is one more append-only row', async () => {
  const again = await invoke(IPC.custodyLegacyRecoveryReview, payload('legacy-review-tl48-0001'))
  assert.equal(again.ok, true)
  assert.deepEqual([again.data.reviewId, again.data.replayed], [saved, true])
  assert.equal(reviews().length, 1)
  const other = await invoke(IPC.custodyLegacyRecoveryReview, { ...payload('legacy-review-tl48-0002'), reason: 'یادداشت دوم مدیر.' })
  assert.equal(other.ok, true)
  assert.equal(reviews().length, 2)
  assert.equal(reviews()[0].reason, NOTE, 'the first note is never changed')
})

test('the manager-password path stays as it was', async () => {
  const r = await custodyService.reviewLegacyRecovery({ ...payload('legacy-review-tl48-0003'), managerUserId: manager, managerPassword: 'Manager48!' })
  assert.equal(r.replayed, false)
  const row = reviews().find((x) => x.id === r.reviewId)
  assert.deepEqual([row.actorKind, row.authMethod, row.actorUserId], ['MANAGER', 'MANAGER_CUSTODY_PIN', manager])
  await assert.rejects(() => custodyService.reviewLegacyRecovery({ ...payload('legacy-review-tl48-0004'), managerUserId: manager, managerPassword: 'wrong-password' }))
  assert.equal(reviews().some((x) => x.idempotencyKey === 'legacy-review-tl48-0004'), false)
})

test('no money, responsibility or old document changes', () => {
  assert.deepEqual(money(), before)
})
