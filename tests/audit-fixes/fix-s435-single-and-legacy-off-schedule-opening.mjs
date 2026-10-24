/**
 * Configured SINGLE_SHIFT is a staffing preference, not a sale lock. A named
 * manager or a cashier outside the daily roster may assume a NEW segment with
 * their personal PIN, explicit count and reason; legacy Shift recovery remains
 * two distinct physical counts and never reattributes the old owner.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s435-single-and-legacy-off-schedule-opening.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-single-exception-s435-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { parseShiftConfig } = await import('../../src/shared/receipt.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
let checks = 0
function eq(label, got, want) { assert.equal(got, want, label); checks++; console.log(`  ✓ ${label}`) }
async function rejects(label, work, code) {
  await assert.rejects(work, (error) => error.code === code, label)
  checks++; console.log(`  ✓ ${label}`)
}
const manager = seed.user('مدیر جانشین S435')
const daily = seed.user('مسئول روزانهٔ غایب S435')
const alternate = seed.user('صندوق‌دار خارج از برنامه S435')
sql.prepare('UPDATE "User" SET role=? WHERE id IN (?,?)').run('CASHIER', daily, alternate)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager435!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager435!' })
for (const [id, temporary, personal] of [[daily, 'DailyTemp435!', 'DailyFinal435!'], [alternate, 'AltTemp435!', 'AltFinal435!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager,
    managerPassword: 'Manager435!', reason: 'تنظیم PIN شخصی برای جانشینی مستقل' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
const before = parseShiftConfig(await settingsService.shiftConfig())
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...before, custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: daily },
  managerUserId: manager, managerPassword: 'Manager435!', reason: 'ثبت مسئول روزانه برای آزمایش غیبت او' })
eq('configured daily owner remains primary in policy', (await custodyService.status()).schedulingPolicy.singleShiftCustodianUserId, daily)
await rejects('without a real count the manager cannot replace the absent primary', () => custodyService.open({ userId: manager, password: 'Manager435!', note: 'مسئول اصلی در محل حضور ندارد.' }), 'CUSTODY_UNSCHEDULED_COUNT_REQUIRED')
await rejects('shared/incorrect password cannot impersonate the named manager', () => custodyService.open({ userId: manager, password: '1111', operationalTotal: 0, note: 'مسئول اصلی در محل حضور ندارد.' }), 'PIN_WRONG')
const reason = 'مسئول روزانه حاضر نشد؛ من شخصاً مجموع صندوق و کارت‌خوان را شمردم.'
const managerShift = await custodyService.open({ userId: manager, password: 'Manager435!', operationalTotal: 0, note: reason })
eq('manager can open while scheduled cashier is absent', (await custodyService.status()).custodian?.id, manager)
eq('manager did not inherit the daily roster slot', seed.one('SELECT templateId FROM "CustodyShiftMeta" WHERE shiftId=?', managerShift.shiftId)?.templateId, null)
eq('off-schedule reason is durable', JSON.parse(seed.one('SELECT payloadJson FROM "CustodyEvent" WHERE type=? AND shiftId=?', 'OPEN_UNSCHEDULED', managerShift.shiftId)?.payloadJson ?? '{}').reason, reason)
eq('named manager can now sell on their own actual Shift', (await custodyService.actorForFinancialOperation()).expectedActorUserId, manager)
await custodyService.finalClose({ password: 'Manager435!', operationalTotal: 0 })
eq('final close frees drawer without changing primary', (await custodyService.status()).state, 'NO_SESSION')
eq('primary policy remains unchanged after manager cover', (await custodyService.status()).schedulingPolicy.singleShiftCustodianUserId, daily)

// Legacy/orphan previous Shift is a separate problem: no old custodian PIN or
// manager password should be necessary for the replacement's RECOVERY count.
const old = seed.insert('Shift', { name: 'نشست قدیمی مسئول غایب S435', number: 99, dayJalali: '1405/07/20', sessionSeq: 1,
  userId: daily, staffConfirmed: true, openedVia: 'MANUAL', openedAt: new Date(Date.now() - 3 * 86400000) })
const oldInvoice = seed.invoice({ receiptNo: 435001, grandTotal: 10, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=? WHERE id=?').run(daily, old, oldInvoice.id)
const status = await custodyService.status()
eq('legacy Shift is not silently converted to an owned custody session', status.legacyBlock?.shiftIds?.includes(old), true)
const recoveryInput = { userId: alternate, password: 'AltFinal435!', countedCash: 250,
  note: 'مسئول قبلی غایب است و کشوی نقدیِ نشست قدیمی را خودم شمردم.',
  ackTextVersion: 'LEGACY_RECOVERY_V1', idempotencyKey: 's435-legacy-recovery-with-absent-primary',
  seenEpoch: status.epoch, seenShiftIds: status.legacyBlock.shiftIds }
await rejects('old cashier with no reason cannot recover out-of-roster history', () => custodyService.recoverLegacyOpenShifts({ ...recoveryInput, note: '' }), 'CUSTODY_UNSCHEDULED_REASON_REQUIRED')
eq('rejected recovery never closes old Shift', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old)?.closedAt, null)
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 435, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const recoveryResponse = await invoke(IPC.custodyLegacyRecover, recoveryInput)
eq('out-of-roster recovery works through public IPC', recoveryResponse.ok, true)
const recovered = recoveryResponse.data
eq('out-of-roster cashier can witness old count without prior PIN', recovered.replayed, false)
eq('recovery does not open a new owner implicitly', (await custodyService.status()).state, 'NO_SESSION')
eq('old Shift is ended through the documented recovery', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old)?.closedAt != null, true)
eq('old invoice still belongs to its historical cashier', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.userId, daily)
eq('recovery evidence keeps only the witness and their own count', seed.one('SELECT witnessUserId FROM "LegacyShiftRecovery" WHERE id=?', recovered.recoveryId)?.witnessUserId, alternate)
eq('off-roster recovery reason is an append-only event', JSON.parse(seed.one('SELECT payloadJson FROM "CustodyEvent" WHERE type=? AND legacyRecoveryId=?', 'LEGACY_RECOVERY_UNSCHEDULED', recovered.recoveryId)?.payloadJson ?? '{}').reason, recoveryInput.note)
const openingCount = seed.count('Shift')
const afterRecovery = { userId: alternate, password: 'AltFinal435!', countedCash: 250, note: 'بازیابی ثبت شد؛ صندوق فعلی را مستقلاً برای فروش خودم شمردم.' }
await rejects('independent legacy opening still requires off-roster reason', () => custodyService.open({ ...afterRecovery, note: '' }), 'CUSTODY_UNSCHEDULED_REASON_REQUIRED')
eq('rejected attempt never manufactures a new Shift', seed.count('Shift'), openingCount)
const openingResponse = await invoke(IPC.custodyOpen, afterRecovery)
eq('cash-only legacy opening forwards independent reason through public IPC', openingResponse.ok, true)
const opened = openingResponse.data
eq('actual new opening belongs to cashier, not absent daily primary', (await custodyService.status()).custodian?.id, alternate)
eq('the two cash counts belong to different boundary records', seed.one('SELECT openerUserId FROM "LegacyRecoveryOpeningLink" WHERE openingShiftId=?', opened.shiftId)?.openerUserId, alternate)
eq('no fake aggregate blue snapshot is created by historical cash-only opening', seed.count('CustodyBlueSnapshot', 'shiftId=? AND role=?', opened.shiftId, 'OPENING'), 0)
eq('legacy cash-only exception is explicitly named', JSON.parse(seed.one('SELECT payloadJson FROM "CustodyEvent" WHERE type=? AND shiftId=?', 'OPEN_UNSCHEDULED', opened.shiftId)?.payloadJson ?? '{}').countKind, 'LEGACY_CASH')
eq('sales after legacy recovery belong to the new actual owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
eq('old invoice shift remains the old Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.shiftId, old)
const managerReport = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager435!', take: 150 })
eq('manager report shows the reason for the separate legacy witness', managerReport.events.find((event) => event.type === 'LEGACY_RECOVERY_UNSCHEDULED' && event.legacyRecoveryId === recovered.recoveryId)?.payload?.reason, recoveryInput.note)
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const outputPath = join(dir, 'legacy-witness-audit.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath })
notePanelUnlocked('test', 'MANAGER')
await custodyService.exportReport({ managerSession: true, from: new Date(Date.now() - 60_000).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(), take: 150 })
eq('manager export keeps the exceptional recovery reason', readFileSync(outputPath, 'utf8').includes(recoveryInput.note), true)
console.log(`\n✓ ${checks} single-shift and legacy-recovery continuity checks passed`)
