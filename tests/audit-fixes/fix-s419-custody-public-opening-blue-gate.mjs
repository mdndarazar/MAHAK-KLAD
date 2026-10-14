/**
 * The public opening channel must not let an old renderer turn a combined
 * count into a cash-only float, nor skip the first official morning snapshot.
 * Existing LEGACY_RECOVERY_V1 remains a separately gated historical exception.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s419-custody-public-opening-blue-gate.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-public-opening-s419-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const seed = makeSeeder(harnessClient())
let checked = 0
const eq = (label, got, want) => {
  if (got !== want) throw new Error(`${label}: expected ${String(want)}, got ${String(got)}`)
  checked++; console.log(`  ✓ ${label}`)
}
const manager = seed.user('مدیر S419')
const worker = seed.user('مسئول S419')
await custodyService.setPin({ userId: manager, newPassword: 'Manager419!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager419!' })
await custodyService.setPin({ userId: worker, newPassword: 'Temp419!', managerUserId: manager, managerPassword: 'Manager419!', reason: 'بررسی مرز افتتاح عمومی' })
await custodyService.setPin({ userId: worker, currentPassword: 'Temp419!', newPassword: 'Worker419!' })
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 419, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, input) => handlers.get(channel)({ sender }, input)
const base = { userId: worker, password: 'Worker419!' }
const old = await invoke(IPC.custodyOpen, { ...base, countedCash: 900 })
eq('cash-only bypass of new public opening is rejected', old?.ok, false)
eq('bypass cannot create an actual Shift', seed.count('Shift'), 0)
eq('bypass cannot create cash float', seed.count('CashMovement'), 0)
eq('bypass cannot mark the first real count as complete', seed.count('CustodyCount'), 0)
const current = await invoke(IPC.custodyOpen, { ...base, countedCash: 900, operationalTotal: 1_000 })
eq('new public opening with full amount is allowed', current?.ok, true)
const firstShiftId = current?.data?.shiftId
eq('only the official blue snapshot records combined count', Number(seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', firstShiftId, 'OPENING')?.humanAmount), 1_000)
eq('forged cash-only field never becomes OPENING_FLOAT', seed.count('CashMovement', 'shiftId=? AND type=?', firstShiftId, 'OPENING_FLOAT'), 0)
await custodyService.finalClose({ password: 'Worker419!', operationalTotal: 1_000 })
// Legacy recovery remains a distinct, explicit migration workflow. Only a
// real old Shift without custody metadata may use that historical count field.
const legacyId = seed.insert('Shift', { name: 'نشست باقی‌مانده قدیمی S419', number: 1, dayJalali: '1405/07/20',
  sessionSeq: 1, userId: worker, staffConfirmed: true, openedVia: 'MANUAL', openedAt: new Date(Date.now() - 86_400_000) })
const beforeRecovery = await custodyService.status()
eq('legacy Shift is identified by Main, not an arbitrary client flag', beforeRecovery.legacyBlock?.shiftIds?.includes(legacyId), true)
await custodyService.recoverLegacyOpenShifts({ userId: worker, password: 'Worker419!', countedCash: 0,
  note: 'نشست واقعی قدیمی با سند بازیابی مستقل خاتمه یافت.', ackTextVersion: 'LEGACY_RECOVERY_V1',
  idempotencyKey: 'legacy-recovery-s419-test-0001', seenEpoch: beforeRecovery.epoch,
  seenShiftIds: beforeRecovery.legacyBlock.shiftIds })
eq('only a completed legacy recovery enables historical opening', (await custodyService.status()).legacyOpeningRequired, true)
const historic = await invoke(IPC.custodyOpen, { ...base, countedCash: 0 })
eq('legacy recovery opening still accepts its separate cash-only field', historic?.ok, true)
eq('historic exception opens a new actual Shift', seed.count('Shift'), 3)
eq('historic exception does not pretend the old count is a blue aggregate', seed.count('CustodyBlueSnapshot', 'shiftId=? AND role=?', historic.data.shiftId, 'OPENING'), 0)
console.log(`\n✓ ${checked} checks passed`)
