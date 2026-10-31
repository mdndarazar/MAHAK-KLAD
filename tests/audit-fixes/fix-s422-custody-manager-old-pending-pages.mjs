/**
 * A manager must be able to reach and resolve an older ambiguous blue snapshot
 * even after many later records. Page boundaries must not hide the 101st one.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s422-custody-manager-old-pending-pages.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-pages-s422-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { CUSTODY_REFERENCE_PREVIOUS_VERSION } = await import('@shared/custodyReference')
const db = harnessClient()
const seed = makeSeeder(db)
const day = toJalaliDate(new Date())
const manager = seed.user('مدیر S422')
await custodyService.setPin({ userId: manager, newPassword: 'Manager422!', currentPassword: '1111' })
const shiftId = seed.insert('Shift', { name: 'S422', userId: manager })
let checks = 0
function eq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
const snapshotIds = []
for (let i = 0; i < 101; i++) {
  snapshotIds.push(seed.insert('CustodyBlueSnapshot', {
    shiftId, role: 'OPENING', actorUserId: manager, authMethod: 'CUSTODY_PIN',
    countOrigin: 'EXPLICIT_AMOUNT', humanAmount: 501_000_000, arithmeticAmount: 501_000_000,
    referenceFromDay: day, referenceToDay: day, scopeKind: 'TODAY',
    referenceStatus: 'PENDING_RECONCILIATION', referenceAmount: null,
    knownSubtotal: 500_000_000, ambiguousLegacyCredit: 1_000_000,
    destinationUnknownReceived: 0, calculationVersion: CUSTODY_REFERENCE_PREVIOUS_VERSION, financialRevision: 0, epochAtCount: 1,
    rawDifference: null, freshDifference: null, freshStatus: 'UNKNOWN_REFERENCE_PENDING',
    idempotencyKey: `s422:snapshot:${i}`, operationalDay: day
  }))
}
const oldest = snapshotIds[0]
const first = await custodyBlueResolutionService.pendingList({ skip: 0 })
eq('first manager page bounded', first.rows.length, 100)
eq('manager can go forward', first.hasMore, true)
eq('newest snapshot on first page', first.rows[0].snapshotId, snapshotIds[100])
eq('oldest snapshot not hidden in first page', first.rows.some((r) => r.snapshotId === oldest), false)
const second = await custodyBlueResolutionService.pendingList({ skip: 100 })
eq('older snapshot accessible on second page', second.rows[0]?.snapshotId, oldest)
eq('last page has no more', second.hasMore, false)
const resolved = await custodyBlueResolutionService.resolve({
  snapshotId: oldest, managerUserId: manager, password: 'Manager422!',
  decisionKind: 'RECEIVED_CARD', evidenceDay: day,
  evidenceReference: 'سند کارت‌خوان بازهٔ افتتاح قدیمی',
  reason: 'پرداخت مبهم این افتتاح قدیمی با سند بازه اثبات شد',
  idempotencyKey: 's422:decision:oldest'
})
eq('oldest snapshot resolved on original record', resolved.snapshotId, oldest)
eq('original reference not rewritten', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', oldest).referenceAmount, null)
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 422, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
eq('employee cannot view manager evidence', (await invoke(IPC.custodyBluePendingList, { skip: 100 })).ok, false)
eq('manager authenticates', (await invoke(IPC.managerVerify, { password: '1111' })).ok, true)
const viaIpc = await invoke(IPC.custodyBluePendingList, { skip: 100 })
eq('IPC forwards page number to Main', viaIpc.data.rows[0]?.snapshotId, oldest)
eq('manager sees decision on original snapshot', viaIpc.data.rows[0]?.status, 'RESOLVED')
console.log(`\n✓ ${checks} checks passed`)
