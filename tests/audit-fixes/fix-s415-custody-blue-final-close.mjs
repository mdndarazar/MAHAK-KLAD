/**
 * Final real combined count has an immutable daily blue boundary. The reader
 * never freezes sales; a concurrent sale invalidates only that count. Closing
 * does not create an aggregate blame case, cash float or manager withdrawal.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s415-custody-blue-final-close.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-final-close-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const manager = seed.user('مدیر S415')
const owner = seed.user('مسئول S415')
const next = seed.user('مسئول جدید S415')
await custodyService.setPin({ userId: manager, newPassword: 'Manager415!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager415!' })
for (const [id, temp, own] of [[owner, 'Owner415!', 'Owner4154!'], [next, 'Next415!', 'Next4154!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager415!', reason: 'آزمون بستن بدون قفل فروش' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: own })
}
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
async function reject(label, code, work) { try { await work() } catch (error) { eq(label, error?.code, code); return } throw new Error(`${label}: unexpectedly accepted`) }
const opened = await custodyService.open({ userId: owner, password: 'Owner4154!', operationalTotal: 1000 })
let enterRead
const reading = new Promise((resolve) => { enterRead = resolve })
let releaseRead
const resume = new Promise((resolve) => { releaseRead = resolve })
const originalReportRows = salesService.reportRows
salesService.reportRows = async (...args) => { enterRead(); await resume; return originalReportRows(...args) }
try {
  const closing = custodyService.finalClose({ password: 'Owner4154!', operationalTotal: 900 })
  await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error('final close never read the blue reference')), 1500))])
  eq('old real custodian can still sell while final blue count is checked', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
  const invoice = seed.invoice({ grandTotal: 123, status: 'CREDIT' })
  sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=?, paidTotal=? WHERE id=?').run(owner, opened.shiftId, 0, invoice.id)
  releaseRead()
  await reject('financial revision rejects only stale final count', 'CUSTODY_STALE', () => closing)
} finally { releaseRead?.(); salesService.reportRows = originalReportRows }
eq('failed close leaves owner active', (await custodyService.status()).custodian?.id, owner)
eq('failed close leaves previous real Shift open', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt, null)
eq('failed close persisted no counted boundary', seed.count('CustodyBlueSnapshot', 'shiftId=? AND role=?', opened.shiftId, 'FINAL_CLOSE'), 0)
const result = await custodyService.finalClose({ password: 'Owner4154!', operationalTotal: 900 })
eq('final close ends active session', result.state, 'NO_SESSION')
eq('box waits for the next PERSON, not planned Shift', (await custodyService.status()).state, 'NO_SESSION')
const final = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'FINAL_CLOSE')
eq('one FINAL_CLOSE snapshot is durable', !!final, true)
eq('real physical closing count, no forced zero', Number(final.humanAmount), 900)
eq('daily full-scope known zero reference, not cash-drawer forecast', Number(final.referenceAmount), 0)
eq('raw positive versus zero is visible', Number(final.rawDifference), 900)
eq('fresh loss only relative to ACTUAL prior opening count', Number(final.freshDifference), -100)
eq('owner PIN is final count evidence', final.authMethod, 'CUSTODY_PIN')
eq('old Shift stays attributed to original owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', opened.shiftId).userId, owner)
eq('no AUTO fault case created by blue final count', seed.count('CustodyDiscrepancyCase'), 0)
eq('neither the blue opening nor final close creates an obsolete aggregate-v2 boundary', seed.count('CustodyAggregateBoundary'), 0)
eq('count is never a cash opening float', seed.count('CashMovement', 'shiftId=? AND type=?', opened.shiftId, 'OPENING_FLOAT'), 0)
const reopened = await custodyService.open({ userId: next, password: 'Next4154!', operationalTotal: 900 })
eq('next user owns only their new Shift', (await custodyService.status()).custodian?.id, next)
eq('previous counted difference not claimed fresh by next user', seed.one('SELECT freshDifference FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', reopened.shiftId, 'OPENING').freshDifference, null)
eq('next user can immediately sell', (await custodyService.actorForFinancialOperation()).expectedShiftId, reopened.shiftId)
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager415!' })
const closedEvidence = report.blueBoundaries.find((row) => row.snapshotId === final.id)
eq('manager report includes standalone final snapshot', closedEvidence?.role, 'FINAL_CLOSE')
eq('manager report uses frozen raw blue difference', closedEvidence?.rawDifference, 900)
eq('manager report preserves independently computed fresh loss', closedEvidence?.freshDifference, -100)
eq('manager report includes prior real opening as separate evidence', report.blueBoundaries.some((row) => row.role === 'OPENING' && row.shiftId === opened.shiftId), true)
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 415, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
eq('export requires manager session', (await invoke(IPC.custodyReportExport, {})).ok, false)
eq('manager session for final evidence export', (await invoke(IPC.managerVerify, { password: '1111' })).ok, true)
const filePath = join(dir, 'blue-final.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
const exported = await invoke(IPC.custodyReportExport, {})
eq('actual report export writes CSV', exported?.ok && exported.data.format, 'csv')
const csv = readFileSync(filePath, 'utf8')
const finalRow = csv.split('\r\n').find((line) => line.startsWith('بستن نهایی و مرجع آبی اولیه,') && line.includes(`نشست ${opened.shiftId} / سند ${final.id}`))
eq('CSV includes real FINAL_CLOSE row, not only aggregate counts', !!finalRow, true)
eq('CSV final row keeps independent raw +900 and fresh -100', finalRow?.includes(',900,0,900,AVAILABLE,') && finalRow?.includes('اختلاف تازه -100'), true)
console.log(`\n✓ ${checks} checks passed`)
