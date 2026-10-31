/**
 * Ambiguous historical receipt can straddle a real FINAL_CLOSE and next
 * OPENING. Neither shifts money or blames anyone; manager decisions must later
 * append to each ORIGINAL snapshot, not mutate payments or another day's count.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s416-custody-blue-boundary-resolution.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-boundary-resolve-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const day = toJalaliDate(new Date())
const manager = seed.user('مدیر S416')
const giver = seed.user('تحویل‌دهنده S416')
const newcomer = seed.user('گیرنده S416')
await custodyService.setPin({ userId: manager, newPassword: 'Manager416!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager416!' })
for (const [id, temp, pin] of [[giver, 'Giver416!', 'Giver4164!'], [newcomer, 'New416!', 'New4164!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager416!', reason: 'تست مرجع نهایی/افتتاح در نبود تصمیم مدیر' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
const old = await custodyService.open({ userId: giver, password: 'Giver4164!', operationalTotal: 501_000_000 })
const knownMethod = seed.insert('PaymentMethod', { key: 'S416_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
const ambiguousMethod = seed.insert('PaymentMethod', { key: 'S416_OLD_CREDIT', label: 'legacy', kind: 'CREDIT', isActive: 0 })
for (const [receipt, amount, method, destination] of [[416001, 500_000_000, knownMethod, 'CASH'], [416002, 1_000_000, ambiguousMethod, null]]) {
  const inv = seed.invoice({ receiptNo: receipt, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, giver, old.shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId: method, amount, seq: 1, kind: 'CASH', destination,
    paidAt: Date.now(), paidAtJalali: day, createdByUserId: giver, createdShiftId: old.shiftId })
}
const closed = await custodyService.finalClose({ password: 'Giver4164!', operationalTotal: 501_000_000 })
eq('real old Shift closes without manager verdict', closed.state, 'NO_SESSION')
const closing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', old.shiftId, 'FINAL_CLOSE')
eq('closing initial reference is unknown', closing.referenceAmount, null)
eq('closing initial raw is unknown', closing.rawDifference, null)
eq('closing stores definite 500M', Number(closing.knownSubtotal), 500_000_000)
eq('closing stores ambiguous 1M', Number(closing.ambiguousLegacyCredit), 1_000_000)
const newShift = await custodyService.open({ userId: newcomer, password: 'New4164!', operationalTotal: 501_000_000 })
eq('new person can sell BEFORE later manager resolution', (await custodyService.actorForFinancialOperation()).expectedShiftId, newShift.shiftId)
const morning = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newShift.shiftId, 'OPENING')
eq('new opening retains its own unknown reference', morning.referenceAmount, null)
eq('new opening is separately immutable evidence', morning.id > closing.id, true)
const list = await custodyBlueResolutionService.pendingList()
eq('manager sees ambiguous closing snapshot', list.rows.some((row) => row.snapshotId === closing.id), true)
eq('manager sees ambiguous opening snapshot', list.rows.some((row) => row.snapshotId === morning.id), true)
const decisionBase = (snapshotId, key, kind, reason) => ({ snapshotId, managerUserId: manager, password: 'Manager416!',
  decisionKind: kind, evidenceDay: day, evidenceReference: 'رسید/دفتر رسیدگی فیش 416002', reason, idempotencyKey: key })
const denied = await custodyBlueResolutionService.resolve(decisionBase(closing.id, 's416:closing:no-receipt', 'NOT_RECEIVED', 'رسید قدیمی پولی را در این بازه ثابت نمی‌کند'))
eq('unreceived amount stays OUT of closing reference', denied.referenceAmount, 500_000_000)
eq('closing raw becomes positive 1M, no blame verdict', denied.rawDifference, 1_000_000)
eq('with a real prior count, closing fresh is calculated separately (not blamed)', denied.freshDifference, -500_000_000)
eq('only closing snapshot gets first decision', seed.one('SELECT snapshotId FROM "CustodyBlueResolution" WHERE id=?', denied.id).snapshotId, closing.id)
eq('opening original remains pending until its OWN decision', seed.count('CustodyBlueResolution', 'snapshotId=?', morning.id), 0)
const proven = await custodyBlueResolutionService.resolve(decisionBase(morning.id, 's416:opening:received', 'RECEIVED_CASH', 'وجه نقد این بازه با رسید رسمی بعداً ثابت شد'))
eq('received amount goes INTO opening reference', proven.referenceAmount, 501_000_000)
eq('opening count matches resolved reference', proven.rawDifference, 0)
eq('both original frozen references remain null', seed.count('CustodyBlueSnapshot', 'id IN (?,?) AND referenceAmount IS NULL', closing.id, morning.id), 2)
eq('decisions do not rewrite historical Payment', seed.count('Payment', 'destination IS NULL'), 1)
eq('decisions never change current owner', (await custodyService.status()).custodian?.id, newcomer)
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager416!' })
const closedReport = report.blueBoundaries.find((row) => row.snapshotId === closing.id)
const openReport = report.blueBoundaries.find((row) => row.snapshotId === morning.id)
eq('report links closing decision to closing snapshot', closedReport?.decision?.id, denied.id)
eq('report shows closing original still null', closedReport?.originalReferenceAmount, null)
eq('report links opening decision only to opening snapshot', openReport?.decision?.id, proven.id)
eq('report keeps opening original reference null', openReport?.originalReferenceAmount, null)
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 416, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
eq('manager session for export', (await invoke(IPC.managerVerify, { password: '1111' })).ok, true)
const filePath = join(dir, 'blue-boundaries.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
eq('manager export writes CSV', (await invoke(IPC.custodyReportExport, {})).data.format, 'csv')
const csv = readFileSync(filePath, 'utf8')
eq('export contains separate closing decision tied to original snapshot', csv.includes(`بستن نهایی و مرجع آبی اولیه`) && csv.includes(`نشست ${old.shiftId} / سند ${closing.id}`) && csv.includes(`تصمیم افزایشی مرز آبی`) && csv.includes('NOT_RECEIVED'), true)
eq('export contains separate opening decision tied to original snapshot', csv.includes(`نشست ${newShift.shiftId} / سند ${morning.id}`) && csv.includes('RECEIVED_CASH'), true)
console.log(`\n✓ ${checks} checks passed`)
