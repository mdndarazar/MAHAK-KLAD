/**
 * After prolonged downtime Main, not the next employee, closes the last real
 * Shift. Public status must not list abandoned Shift IDs/amounts or offer a
 * separate employee recovery/close. Manager cases live behind a session gate.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s413-custody-unattended-privacy.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-missed-private-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const manager = seed.user('مدیر S413')
const oldOwner = seed.user('مسئول شب S413')
const newcomer = seed.user('مسئول تازه S413')
await custodyService.setPin({ userId: manager, newPassword: 'Manager413!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager413!' })
for (const [id, temp, own] of [[oldOwner, 'Old413!', 'Old4134!'], [newcomer, 'New413!', 'New4134!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager413!', reason: 'تست محرمانگی شیفت‌های جامانده' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: own })
}
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checks++; console.log(`  ✓ ${label}`)
}
const old = await custodyService.open({ userId: oldOwner, password: 'Old4134!', operationalTotal: 0 })
const now = Date.now()
sql.prepare('UPDATE "Shift" SET openedAt=? WHERE id=?').run(now - 30 * 60 * 60_000, old.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, rolloverAt=? WHERE shiftId=?')
  .run(toJalaliDate(new Date(now - 24 * 60 * 60_000)), now - 25 * 60 * 60_000, old.shiftId)
const post = await custodyService.status()
eq('system ends old owner before next login', post.state, 'NO_SESSION')
eq('previously real Shift closed by system', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId).closedAt != null, true)
eq('status does not list missed Shift IDs to newcomer', post.unresolved.length, 0)
eq('status does not display number of abandoned cases', post.unresolvedCount, 0)
eq('public status contains no old expected amount', JSON.stringify(post).includes('nightExpectedCash'), false)
eq('manager case is still stored for later review', seed.count('CustodyResolution', 'status=?', 'OPEN'), 1)
const next = await custodyService.open({ userId: newcomer, password: 'New4134!', operationalTotal: 700 })
eq('new employee starts solely own Shift', (await custodyService.status()).custodian?.id, newcomer)
eq('new employee can sell without manager decision', (await custodyService.actorForFinancialOperation()).expectedShiftId, next.shiftId)
eq('manager case remains open after next person starts', seed.count('CustodyResolution', 'status=?', 'OPEN'), 1)

const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 413, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
eq('manager case list blocked for regular employee', (await invoke(IPC.custodyOpenResolutions, {}))?.ok, false)
eq('old employee witness route cannot close missed shift', (await invoke(IPC.custodyUnattendedRecover,
  { resolutionId: 1, userId: newcomer, password: 'New4134!', countedCash: 700 }))?.ok, false)
const login = await invoke(IPC.managerVerify, { password: '1111' })
eq('manager session can open later review', login?.ok, true)
const listed = await invoke(IPC.custodyOpenResolutions, {})
eq('manager session may read cases in Settings', listed?.ok, true)
eq('manager list contains the original Shift', listed?.data?.rows?.[0]?.shiftId, old.shiftId)
eq('manager list does not change new owner', (await custodyService.status()).custodian?.id, newcomer)
const reviewed = await invoke(IPC.custodyUnresolvedResolve, {
  resolutionId: listed.data.rows[0].id, managerUserId: manager, managerPassword: 'Manager413!',
  reason: 'مدیر بدون ادعای شمارش گذشته، فقط پروندهٔ قدیمی را بازبینی کرد.',
  attribution: 'DIFFERENCE_UNKNOWN', countedCash: 700 // malicious/stale renderer count is stripped
})
eq('manager may resolve old case separately without claiming a physical count', reviewed?.ok, true)
eq('old case separately resolved without automatic blame', seed.one('SELECT differenceAttribution FROM "CustodyResolution" WHERE id=?', listed.data.rows[0].id).differenceAttribution, 'DIFFERENCE_UNKNOWN')
eq('forged new employee amount is never used for old Shift', seed.one('SELECT countedTotal FROM "CashSession" WHERE shiftId=?', old.shiftId).countedTotal, null)
eq('manager review does not transfer newer ownership', (await custodyService.status()).custodian?.id, newcomer)
console.log(`\n✓ ${checks} checks passed`)
