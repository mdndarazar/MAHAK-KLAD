/**
 * A frozen old cash/aggregate handover inside today's actual Shift must not
 * wait for either previous person. Public emergency cover requires the PRESENT
 * active worker's PIN, fresh drawer+POS count and reason, supersedes only the
 * unfinished workflow, and keeps its independent frozen count, original sale,
 * outgoing owner and blue reference intact. No old PIN/count can be reused.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s438-live-frozen-handover-cover.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-live-frozen-cover-s438-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
import { grantMiddayFixture } from './grant-midday-fixture.mjs'
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(); const seed = makeSeeder(db); const sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.equal(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
async function rejects(label, code, fn) {
  await assert.rejects(fn, (error) => error?.code === code, label)
  checks++; console.log(`  ✓ ${label}`)
}
const manager = seed.user('مدیر S438')
const prior = seed.user('مسئول قدیمی S438')
const stalledReceiver = seed.user('گیرندهٔ تلاش ناتمام S438')
const replacement = seed.user('صندوق‌دار حاضر S438')
const nonOperational = seed.user('انباردار S438')
const temporary = seed.user('صندوقدار با PIN موقت S438')
const inactive = seed.user('صندوقدار غیرفعال S438')
for (const id of [prior, stalledReceiver, replacement, temporary, inactive]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('STOCKKEEPER', nonOperational)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager438!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager438!' })
await grantMiddayFixture({ manager, password: 'Manager438!', custodian: prior })
for (const [id, temporary, permanent] of [
  [prior, 'PriorTemp438!', 'PriorFinal438!'],
  [stalledReceiver, 'ReceiverTemp438!', 'ReceiverFinal438!'],
  [replacement, 'ReplacementTemp438!', 'ReplacementFinal438!'],
  [nonOperational, 'StockTemp438!', 'StockFinal438!'],
  [inactive, 'InactiveTemp438!', 'InactiveFinal438!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager438!', reason: 'PIN برای بررسی جایگزینیِ شمارش نیمه‌تمام' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
await custodyService.setPin({ userId: temporary, newPassword: 'TempOnly438!', managerUserId: manager,
  managerPassword: 'Manager438!', reason: 'PIN موقت جای PIN شخصی را نمی‌گیرد' })
sql.prepare('UPDATE "User" SET isActive=? WHERE id=?').run(0, inactive)
const old = await custodyService.open({ userId: prior, password: 'PriorFinal438!', operationalTotal: 1000 })
const oldInvoice = seed.invoice({ receiptNo: 438001, grandTotal: 1000, status: 'SETTLED' })
sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=? WHERE id=?').run(prior, old.shiftId, oldInvoice.id)
// An already-stored pre-blue attempt. New public IPC starts force blue, but
// installed historical databases can still have a live old attempt at restart.
const priorHandover = await custodyService.handoverStart({ password: 'PriorFinal438!', operationalTotal: 1000,
  toUserId: stalledReceiver, idempotencyKey: 's438-previous-handover' })
const frozenId = seed.insert('CustodyCount', { shiftId: old.shiftId,
  handoverId: priorHandover.id, kind: 'HANDOVER_RECOUNT_DIFFERENCE_PENDING', countedCash: 900,
  expectedCash: 1000, differenceCash: -100, countedByUserId: stalledReceiver,
  authMethod: 'CUSTODY_PIN', operationalDay: toJalaliDate(new Date()),
  idempotencyKey: 's438-legacy-blind-count' })
const watermark = JSON.parse(seed.one('SELECT ledgerWatermark FROM "CustodyHandover" WHERE id=?', priorHandover.id)?.ledgerWatermark ?? '{}')
sql.prepare('UPDATE "CustodyHandover" SET ledgerWatermark=? WHERE id=?').run(JSON.stringify({ ...watermark,
  differencePending: { countId: frozenId, countedCash: 900, expectedCash: 1000, differenceCash: -100 }
}), priorHandover.id)
// Same short committed freeze as in handoverAccept(), with an older receiver's
// still-durable blind count. This fixture is not a product edit.
sql.prepare('UPDATE "CustodyState" SET state=?, epoch=epoch+1 WHERE key=?').run('HANDOVER_RECOUNT', 'MAIN')
eq('restart sees the frozen old attempt, not a made-up new owner', (await custodyService.status()).state, 'HANDOVER_RECOUNT')
const before = seed.count('Shift')
const reason = 'تحویل قدیمی ناتمام است و مسئول قبلی نیست؛ صندوق را مستقلاً شمردم.'
await rejects('wrong replacement PIN cannot bypass frozen ownership', 'PIN_WRONG',
  () => custodyService.emergencyCover({ userId: replacement, password: 'bad', operationalTotal: 850, reason }))
await rejects('no physical total cannot count as recovery', 'CUSTODY_AGGREGATE_COUNT_REQUIRED',
  () => custodyService.emergencyCover({ userId: replacement, password: 'ReplacementFinal438!', reason }))
await rejects('short reason cannot bypass the frozen count', 'EMERGENCY_REASON_REQUIRED',
  () => custodyService.emergencyCover({ userId: replacement, password: 'ReplacementFinal438!', operationalTotal: 850, reason: 'نه' }))
await rejects('non-operational employee cannot assume the drawer', 'NO_PERMISSION',
  () => custodyService.emergencyCover({ userId: nonOperational, password: 'StockFinal438!', operationalTotal: 850, reason }))
await rejects('temporary PIN cannot take over interrupted handover', 'PIN_MUST_CHANGE',
  () => custodyService.emergencyCover({ userId: temporary, password: 'TempOnly438!', operationalTotal: 850, reason }))
await rejects('inactive worker cannot take over interrupted handover', 'INACTIVE',
  () => custodyService.emergencyCover({ userId: inactive, password: 'InactiveFinal438!', operationalTotal: 850, reason }))
eq('rejected attempts do not create a Shift', seed.count('Shift'), before)
eq('rejected attempts retain the earlier actual state', seed.one('SELECT state FROM "CustodyState" WHERE key=?', 'MAIN')?.state, 'HANDOVER_RECOUNT')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 438, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const response = await invoke(IPC.custodyEmergencyCover, { userId: replacement, password: 'ReplacementFinal438!',
  operationalTotal: 850, countedCash: 1000, reason })
eq('real present cashier covers frozen handover through public IPC', response.ok, true)
const covered = response.data
eq('cover starts exactly one new Shift', seed.count('Shift'), before + 1)
eq('cover becomes actual authenticated owner', seed.one('SELECT userId FROM "Shift" WHERE id=?', covered?.shiftId)?.userId, replacement)
eq('previous handover is superseded, not accepted or deleted', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', priorHandover.id)?.status, 'SUPERSEDED_EMERGENCY')
eq('old physical count is unchanged', seed.one('SELECT countedCash FROM "CustodyCount" WHERE id=?', frozenId)?.countedCash, 900)
eq('old physical count still belongs to old Shift', seed.one('SELECT shiftId FROM "CustodyCount" WHERE id=?', frozenId)?.shiftId, old.shiftId)
eq('old invoice stays with its old cashier', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.userId, prior)
eq('old invoice keeps its Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', oldInvoice.id)?.shiftId, old.shiftId)
eq('no accused discrepancy case is manufactured', seed.count('CustodyDiscrepancyCase'), 0)
const outgoing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', covered.handoverId, 'OUT')
const incoming = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', covered.handoverId, 'IN')
eq('absent outgoing worker did not sign a human count', outgoing?.humanAmount, null)
eq('absent side is explicitly system evidence', outgoing?.countOrigin, 'ABSENT_UNCOUNTED')
eq('old PIN was not borrowed for OUT', outgoing?.authMethod, 'SYSTEM_ABSENCE')
eq('new human count is only the new worker real 850', Number(incoming?.humanAmount), 850)
eq('new count is attested with replacement PIN', incoming?.authMethod, 'CUSTODY_PIN')
eq('previous count is not used as fresh blame', incoming?.freshDifference, null)
eq('card total cannot become cash float', seed.count('CashMovement', 'shiftId=? AND type=?', covered.shiftId, 'OPENING_FLOAT'), 0)
const event = seed.one('SELECT payloadJson, actorUserId FROM "CustodyEvent" WHERE type=? AND handoverId=?', 'BLUE_HANDOVER_SUPERSEDED_EMERGENCY', priorHandover.id)
eq('audit attributes the supersession to the real new worker', event?.actorUserId, replacement)
eq('audit records which old state was left behind', JSON.parse(event?.payloadJson ?? '{}').previousState, 'HANDOVER_RECOUNT')
eq('audit confirms no earlier counts were reused', JSON.parse(event?.payloadJson ?? '{}').priorCountsNotReused, true)
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager438!', take: 150 })
eq('manager report retains separate supersession event', report.events.some((row) => row.type === 'BLUE_HANDOVER_SUPERSEDED_EMERGENCY' && row.handoverId === priorHandover.id), true)
eq('manager report retains the covering worker reason', report.events.some((row) => row.type === 'BLUE_EMERGENCY_COVER_COMMITTED' && row.handoverId === covered.handoverId && row.payload?.reason === reason), true)
await rejects('a repeated cover cannot create another replacement Shift', 'EMERGENCY_SAME_CUSTODIAN',
  () => custodyService.emergencyCover({ userId: replacement, password: 'ReplacementFinal438!', operationalTotal: 850, reason }))
eq('replay never makes an extra Shift', seed.count('Shift'), before + 1)
await rejects('late original receiver cannot finish superseded old attempt', 'HANDOVER_NOT_PENDING',
  () => custodyService.handoverAccept({ handoverId: priorHandover.id, password: 'ReceiverFinal438!', operationalTotal: 900 }))
const product = seed.product('فروش پس از پوشش S438')
const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=? WHERE id=?').run(10, variant)
const cash = seed.insert('PaymentMethod', { key: 'S438_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const sale = await invoke(IPC.saleCreate, { deductInventory: false,
  lines: [{ variantId: variant, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] })
eq('POS sale succeeds immediately after frozen cover', sale.ok, true)
eq('new sale belongs only to the covering worker', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.userId, replacement)
eq('new sale is on the new Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, covered.shiftId)

// An interrupted pre-blue emergency has its OWN real previous witness and
// original reason. Superseding it with the manager's NEW PIN/count must never
// overwrite that evidence, even if its old selected witness is unavailable.
const oldEmergency = await custodyService.handoverStart({ password: 'ReplacementFinal438!', operationalTotal: 850,
  toUserId: stalledReceiver, idempotencyKey: 's438-older-emergency' })
const originalReason = 'پوشش قدیمی پیش از قطع دستگاه نیمه‌تمام ماند و شمارش قبلی محفوظ است.'
sql.prepare('UPDATE "CustodyHandover" SET status=?, resolutionKind=?, resolutionReason=? WHERE id=?')
  .run('EMERGENCY_RECOUNT', 'EMERGENCY_COVER', originalReason, oldEmergency.id)
sql.prepare('UPDATE "CustodyState" SET state=?, epoch=epoch+1 WHERE key=?').run('HANDOVER_RECOUNT', 'MAIN')
eq('legacy emergency has its own frozen workflow', (await custodyService.status()).state, 'HANDOVER_RECOUNT')
const managerReason = 'پوشش قدیمی متوقف شد؛ مدیر مبلغ واقعی را تازه و مستقل شمارش کرد.'
const managerResponse = await invoke(IPC.custodyMasterOverride, { managerUserId: manager, managerPassword: 'Manager438!',
  operationalTotal: 850, reason: managerReason })
eq('manager can supersede a frozen emergency with own PIN/count', managerResponse.ok, true)
const managerShift = managerResponse.data?.shiftId
eq('manager owns only newly opened Shift', seed.one('SELECT userId FROM "Shift" WHERE id=?', managerShift)?.userId, manager)
eq('old emergency is superseded, not silently completed', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', oldEmergency.id)?.status, 'SUPERSEDED_EMERGENCY')
eq('old attempt retains its original resolution kind', seed.one('SELECT resolutionKind FROM "CustodyHandover" WHERE id=?', oldEmergency.id)?.resolutionKind, 'EMERGENCY_COVER')
eq('old emergency reason is not rewritten by new manager reason', seed.one('SELECT resolutionReason FROM "CustodyHandover" WHERE id=?', oldEmergency.id)?.resolutionReason, originalReason)
eq('earlier worker sale still belongs to earlier actual Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', sale.data?.id)?.shiftId, covered.shiftId)
eq('manager may now sell on own Shift', (await custodyService.actorForFinancialOperation()).expectedShiftId, managerShift)
console.log(`\n✓ ${checks} live frozen cover continuity checks passed`)
