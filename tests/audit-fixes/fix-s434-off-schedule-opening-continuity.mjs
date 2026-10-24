/**
 * Off-roster opening after a multi-day outage: any active CASHIER or MANAGER
 * with their own non-temporary PIN, an explicit physical drawer+POS count and
 * a recorded reason can start a NEW responsibility segment and sell. No
 * schedule, old owner, manager session or prior discrepancy can appoint a
 * fictional custodian or rewrite a prior invoice.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s434-off-schedule-opening-continuity.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-unscheduled-opening-s434-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { parseShiftConfig } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
let checks = 0
function eq(label, got, want) {
  assert.equal(got, want, label)
  checks++
  console.log(`  ✓ ${label}`)
}
async function rejects(label, work, code) {
  await assert.rejects(work, (error) => error.code === code, label)
  checks++
  console.log(`  ✓ ${label}`)
}

const manager = seed.user('مدیر S434')
const prior = seed.user('مسئول برنامهٔ قدیمی S434')
const replacement = seed.user('صندوق‌دار جایگزین S434')
const tempWorker = seed.user('دارندهٔ PIN موقت S434')
const stockkeeper = seed.user('انباردار S434')
const archived = seed.user('کارمند غیرفعال S434')
sql.prepare('UPDATE "User" SET role=? WHERE id IN (?,?,?,?)').run('CASHIER', prior, replacement, tempWorker, archived)
sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('STOCKKEEPER', stockkeeper)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager434!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager434!' })
for (const [id, temporary, personal] of [
  [prior, 'PriorTemp434!', 'PriorFinal434!'],
  [replacement, 'NextTemp434!', 'NextFinal434!'],
  [stockkeeper, 'StockTemp434!', 'StockFinal434!'],
  [archived, 'ArchivedTemp434!', 'ArchivedFinal434!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager,
    managerPassword: 'Manager434!', reason: 'تنظیم PIN شخصی برای تمرین پوشش غیبت' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
await custodyService.setPin({ userId: tempWorker, newPassword: 'TempOnly434!', managerUserId: manager,
  managerPassword: 'Manager434!', reason: 'PIN موقت هنوز PIN شخصی نیست' })
const initial = parseShiftConfig(await settingsService.shiftConfig())
const configured = await settingsService.saveCustodySchedulingWorkflow({
  shift: { ...initial, custodyMode: 'MULTI_SHIFT', singleShiftCustodianUserId: null,
    templates: initial.templates.map((template, index) => index === 0
      ? { ...template, startTime: '00:00', endTime: '00:00', daysMask: 127, staffIds: [prior] }
      : { ...template, isActive: false, staffIds: [] }) },
  managerUserId: manager, managerPassword: 'Manager434!',
  reason: 'فقط مسئول قبلی در برنامه بود؛ جایگزین در صورت غیبت مستند وارد می‌شود.'
})
eq('manager schedule is canonical multi-shift', configured.custodyModeConfigured, true)
// A historical cash-only opening predates the immutable blue snapshots.
const old = await custodyService.open({ userId: prior, password: 'PriorFinal434!', countedCash: 0 })
eq('scheduled owner opens without an emergency reason', seed.one('SELECT custodianUserId FROM "CustodyShiftMeta" WHERE shiftId=?', old.shiftId)?.custodianUserId, prior)
const oldInvoice = seed.invoice({ receiptNo: 434001, grandTotal: 200, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET issuedAtJalali=?, goodsTotal=?, paidTotal=?, shiftId=?, userId=? WHERE id=?')
  .run(toJalaliDate(new Date(Date.now() - 3 * 86400000)), 200, 200, old.shiftId, prior, oldInvoice.id)
const threeDaysAgo = new Date(Date.now() - 3 * 86400000)
const pastDay = toJalaliDate(threeDaysAgo)
// Model the already-stored deadline and day of an actual old Shift, not a
// fictional roster slot. No production history is changed in this test.
sql.prepare('UPDATE "Shift" SET openedAt=?, dayJalali=? WHERE id=?').run(threeDaysAgo.getTime(), pastDay, old.shiftId)
sql.prepare('UPDATE "CustodyShiftMeta" SET operationalDay=?, scheduledEndAt=?, rolloverAt=? WHERE shiftId=?')
  .run(pastDay, threeDaysAgo.getTime(), threeDaysAgo.getTime(), old.shiftId)
sql.prepare('UPDATE "CustodyCount" SET operationalDay=? WHERE shiftId=? AND kind=?').run(pastDay, old.shiftId, 'OPENING')
const rollover = await custodyService.ensureRolledOver()
eq('outage closes previous shift as SYSTEM evidence', rollover?.shiftId, old.shiftId)
eq('drawer is available for a new independent owner', (await custodyService.status()).state, 'NO_SESSION')
eq('old invoice still belongs to old custodian', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.userId, prior)
const oldClose = seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt
const caseCount = seed.count('CustodyResolution', 'shiftId=? AND status=?', old.shiftId, 'OPEN')
eq('old unresolved case remains available for manager review', caseCount, 1)
const countBefore = seed.count('Shift')
const baseline = { userId: replacement, password: 'NextFinal434!', note: 'مسئول برنامه سه روز حاضر نبود؛ صندوق را شخصاً شمارش کردم.' }
await rejects('wrong PIN never opens the drawer', () => custodyService.open({ ...baseline, password: 'NotPersonal!', operationalTotal: 0 }), 'PIN_WRONG')
await rejects('temporary PIN cannot open the drawer', () => custodyService.open({ ...baseline, userId: tempWorker, password: 'TempOnly434!', operationalTotal: 0 }), 'PIN_MUST_CHANGE')
await rejects('non-operational role cannot bypass the roster', () => custodyService.open({ ...baseline, userId: stockkeeper, password: 'StockFinal434!', operationalTotal: 0 }), 'NO_PERMISSION')
sql.prepare('UPDATE "User" SET isActive=0 WHERE id=?').run(archived)
await rejects('inactive worker cannot bypass the roster', () => custodyService.open({ ...baseline, userId: archived, password: 'ArchivedFinal434!', operationalTotal: 0 }), 'INACTIVE')
await rejects('omitted count cannot masquerade as zero', () => custodyService.open(baseline), 'CUSTODY_UNSCHEDULED_COUNT_REQUIRED')
await rejects('missing reason cannot bypass the schedule', () => custodyService.open({ ...baseline, note: '', operationalTotal: 0 }), 'CUSTODY_UNSCHEDULED_REASON_REQUIRED')
await rejects('short reason cannot bypass the schedule', () => custodyService.open({ ...baseline, note: 'غیبت', operationalTotal: 0 }), 'CUSTODY_UNSCHEDULED_REASON_REQUIRED')
await rejects('old cash-only count cannot act as drawer+POS evidence', () => custodyService.open({ ...baseline, countedCash: 0 }), 'CUSTODY_UNSCHEDULED_COUNT_REQUIRED')
eq('rejected attempts create no new Shift', seed.count('Shift'), countBefore)
eq('rejected attempts create no unscheduled audit record', seed.count('CustodyEvent', 'type=?', 'OPEN_UNSCHEDULED'), 0)
const newOwner = await custodyService.open({ ...baseline, operationalTotal: 0 })
eq('explicit zero opens a new Shift for replacement', seed.one('SELECT userId FROM "Shift" WHERE id=?', newOwner.shiftId)?.userId, replacement)
eq('new Shift is not the old Shift', newOwner.shiftId > old.shiftId, true)
eq('new owner is not given the old scheduled template', seed.one('SELECT templateId FROM "CustodyShiftMeta" WHERE shiftId=?', newOwner.shiftId)?.templateId, null)
eq('new owner is recorded with their own PIN', seed.one('SELECT openAuth FROM "CustodyShiftMeta" WHERE shiftId=?', newOwner.shiftId)?.openAuth, 'CUSTODY_PIN')
const blue = seed.one('SELECT humanAmount, referenceStatus, referenceAmount, rawDifference, freshDifference FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', newOwner.shiftId, 'OPENING')
eq('explicit zero is a physical count, not a blank or guessed count', Number(blue?.humanAmount), 0)
eq('after multiple missed days the reference stays pending', blue?.referenceStatus, 'PENDING_RECONCILIATION')
eq('no fabricated official reference for the missing days', blue?.referenceAmount, null)
eq('no retroactive blamed difference for the new worker', blue?.rawDifference, null)
eq('no inherited difference for the new worker', blue?.freshDifference, null)
const exception = seed.one('SELECT actorUserId, authMethod, payloadJson FROM "CustodyEvent" WHERE shiftId=? AND type=?', newOwner.shiftId, 'OPEN_UNSCHEDULED')
eq('exception is signed by replacement, not manager or prior owner', exception?.actorUserId, replacement)
eq('exception has personal PIN evidence', exception?.authMethod, 'CUSTODY_PIN')
eq('append-only exception keeps actual reason', JSON.parse(exception?.payloadJson ?? '{}').reason, baseline.note)
eq('manager audit includes separate exception entry', seed.one('SELECT note FROM "AuditLog" WHERE action=? AND entity=? AND entityId=?', 'CUSTODY_UNSCHEDULED_OPEN', 'Shift', newOwner.shiftId)?.note, baseline.note)
eq('previous owner stays the old owner', seed.one('SELECT custodianUserId FROM "CustodyShiftMeta" WHERE shiftId=?', old.shiftId)?.custodianUserId, prior)
eq('old Shift end is not rewritten by the new opening', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', old.shiftId)?.closedAt, oldClose)
eq('old manager case remains open; no transfer of liability', seed.count('CustodyResolution', 'shiftId=? AND status=?', old.shiftId, 'OPEN'), 1)
eq('old invoice attribution is never rewritten', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.shiftId, old.shiftId)
eq('new owner has a financial sales fence', (await custodyService.actorForFinancialOperation()).expectedShiftId, newOwner.shiftId)

// Exercise the public IPC actually used by POS, not only the custody fence.
const product = seed.product('کالای فروش ادامه‌دار S434')
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=? WHERE id=?').run(10, variant)
const cash = seed.insert('PaymentMethod', { key: 'S434_CASH', label: 'وجه صندوق', kind: 'CASH', isActive: 1 })
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 434, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const sale = await handlers.get(IPC.saleCreate)({ sender }, {
  deductInventory: false, lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }]
})
eq('sale after absent custodian succeeds via public IPC', sale.ok, true)
eq('new sale belongs only to the new real custodian', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, replacement)
eq('new sale belongs only to the newly opened Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, newOwner.shiftId)

// A later outage must be handled by the public opening command itself: it
// cannot depend on an earlier status() poll or on the old person's PIN.
sql.prepare('UPDATE "CustodyShiftMeta" SET rolloverAt=? WHERE shiftId=?')
  .run(Date.now() - 2 * 86400000, newOwner.shiftId)
const managerReason = 'صندوق‌دار جدید بعد از دو روز بازنگشت؛ مدیر شخصاً صندوق را شمارش کرد.'
const publicOpening = await handlers.get(IPC.custodyOpen)({ sender }, {
  userId: manager, password: 'Manager434!', operationalTotal: 1_000_000, note: managerReason
})
eq('public opening automatically rolls over expired last owner and admits manager', publicOpening.ok, true)
const managerShiftId = publicOpening.data?.shiftId
eq('manager is the newly authenticated owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', managerShiftId)?.userId, manager)
eq('the previous substitute was closed by SYSTEM, not reattributed', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', newOwner.shiftId)?.closedAt != null, true)
eq('one manager exception event records a reason', JSON.parse(seed.one('SELECT payloadJson FROM "CustodyEvent" WHERE shiftId=? AND type=?', managerShiftId, 'OPEN_UNSCHEDULED')?.payloadJson ?? '{}').reason, managerReason)
eq('prior substitute sale remains attributed to substitute', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, replacement)
const managerSale = await handlers.get(IPC.saleCreate)({ sender }, {
  deductInventory: false, lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }]
})
eq('POS sale still works immediately after automatic rollover', managerSale.ok, true)
eq('manager owns only their own new sale', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', managerSale.data?.id)?.shiftId, managerShiftId)
const managerReport = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager434!', take: 50 })
eq('manager report exposes append-only exception reason', managerReport.events.find((event) => event.type === 'OPEN_UNSCHEDULED' && event.shiftId === newOwner.shiftId)?.payload?.reason, baseline.note)
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const outputPath = join(dir, 'outside-plan-audit.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath })
notePanelUnlocked('test', 'MANAGER')
const exportResult = await custodyService.exportReport({ managerSession: true,
  from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), take: 50 })
eq('manager audit export is available', exportResult.format, 'csv')
eq('manager audit export preserves the entrant reason', readFileSync(outputPath, 'utf8').includes(baseline.note), true)
console.log(`\n✓ ${checks} off-roster opening and continued-sales checks passed`)
