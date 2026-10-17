/**
 * Live two-PIN OUT/IN warning: blind until IN, receiver-PIN readback, optional
 * old-owner cancellation with preserved documents, corrected fresh attempt,
 * independent confirmation/sales, self boundaries and explicit human zero.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s447-custody-peer-warning-and-recount.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-peer-warning-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
import { grantMiddayFixture } from './grant-midday-fixture.mjs'
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { IPC } = await import('@shared/ipc')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 447, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const day = toJalaliDate(new Date())
let checks = 0
function eq(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
async function reject(label, code, operation) {
  try { await operation() } catch (err) { eq(label, err?.code, code); return }
  throw new Error(`${label}: unexpectedly succeeded`)
}
const manager = seed.user('مدیر S447')
const giver = seed.user('مسئول اول S447')
const receiver = seed.user('مسئول دوم S447')
for (const id of [giver, receiver]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, newPassword: 'Manager447!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager447!' })
await grantMiddayFixture({ manager, password: 'Manager447!', custodian: giver })
for (const [id, temp, pin] of [[giver, 'GiverTmp447!', 'GiverOwn447!'], [receiver, 'ReceiverTmp447!', 'ReceiverOwn447!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager447!', reason: 'PIN مستقل برای آزمون هشدار دو شمارش' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
const opened = await custodyService.open({ userId: giver, password: 'GiverOwn447!', operationalTotal: 10_000_000 })
const cash = seed.insert('PaymentMethod', { key: 'S447_CASH', label: 'نقدی', kind: 'CASH', isActive: 1 })
function sale(receiptNo, amount, owner, shiftId) {
  const inv = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, owner, shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId: cash, amount, seq: 1, kind: 'CASH', destination: 'CASH',
    paidAt: Date.now(), paidAtJalali: day, createdByUserId: owner, createdShiftId: shiftId })
}
const first = await custodyService.handoverStart({ password: 'GiverOwn447!', operationalTotal: 10_000_000,
  toUserId: receiver, idempotencyKey: 's447:first-out', blueReference: true })
eq('start response does not reveal old money', Object.keys(first).sort(), ['id', 'state'])
const publicBefore = await custodyService.status()
eq('ordinary status hides previous counted amount', publicBefore.pendingHandover.countedAtStart, null)
eq('ordinary status hides receiver/giver totals', publicBefore.pendingHandover.blindCountedCash, null)
eq('ordinary status carries no comparison', Object.hasOwn(publicBefore.pendingHandover, 'peerComparison'), false)
await reject('review cannot read an OUT before an IN exists', 'BLUE_NOT_COUNTED',
  () => custodyService.handoverBlueReview({ handoverId: first.id, password: 'ReceiverOwn447!' }))
eq('IPC review pre-IN returns no amount', await invoke(IPC.custodyHandoverBlueReview,
  { handoverId: first.id, password: 'ReceiverOwn447!' }),
  { ok: false, error: 'این تحویل هنوز دو شمارش مستقل برای بازبینی ندارد.', code: 'BLUE_NOT_COUNTED' })
eq('first OUT is a real giver PIN count', seed.one('SELECT countOrigin FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', first.id, 'OUT').countOrigin, 'EXPLICIT_AMOUNT')
const firstIn = await invoke(IPC.custodyHandoverCountBlue, { handoverId: first.id, password: 'ReceiverOwn447!', operationalTotal: 15_000_000 })
eq('independent count accepted over IPC', firstIn.ok, true)
eq('MORE direction and exact 5M rial', firstIn.data.peerComparison,
  { status: 'DIFFERENT', direction: 'MORE', absoluteDifferenceRial: '5000000', selfCount: false })
eq('pending sales still belong to outgoing owner', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
const publicAfter = await custodyService.status()
eq('status still hides both counts after IN', publicAfter.pendingHandover.countedAtStart, null)
eq('status does not publish saved warning', Object.hasOwn(publicAfter.pendingHandover, 'peerComparison'), false)
const beforeReview = seed.one('SELECT version, ledgerWatermark FROM "CustodyHandover" WHERE id=?', first.id)
const countsBeforeReview = seed.count('CustodyCount', 'handoverId=?', first.id)
const snapshotsBeforeReview = seed.count('CustodyBlueSnapshot', 'handoverId=?', first.id)
const eventsBeforeReview = seed.count('CustodyEvent', 'handoverId=?', first.id)
const wrongReview = await invoke(IPC.custodyHandoverBlueReview, { handoverId: first.id, password: 'GiverOwn447!' })
eq('old owner cannot read result with their PIN', wrongReview.code, 'PIN_WRONG')
eq('wrong PIN reveals no money', Object.hasOwn(wrongReview, 'data'), false)
const reviewed = await invoke(IPC.custodyHandoverBlueReview, { handoverId: first.id, password: 'ReceiverOwn447!' })
eq('receiver can retrieve warning after an app refresh', reviewed.ok, true)
eq('readback matches first computation', reviewed.data.peerComparison, firstIn.data.peerComparison)
eq('readback restores reference preview too', reviewed.data.referenceStatus, firstIn.data.referenceStatus)
eq('readback does not change handover record', seed.one('SELECT version, ledgerWatermark FROM "CustodyHandover" WHERE id=?', first.id), beforeReview)
eq('readback writes no custody count', seed.count('CustodyCount', 'handoverId=?', first.id), countsBeforeReview)
eq('readback writes no snapshots', seed.count('CustodyBlueSnapshot', 'handoverId=?', first.id), snapshotsBeforeReview)
eq('readback writes no custody events', seed.count('CustodyEvent', 'handoverId=?', first.id), eventsBeforeReview)
const wrongConfirm = await invoke(IPC.custodyHandoverConfirmBlue, { handoverId: first.id, password: 'GiverOwn447!' })
eq('first person cannot approve on receiver behalf', wrongConfirm.code, 'PIN_WRONG')
const approved = await invoke(IPC.custodyHandoverConfirmBlue, { handoverId: first.id, password: 'ReceiverOwn447!' })
eq('no manager, reason or warning acknowledgement gates confirmation', approved.ok, true)
eq('receiver owns drawer despite nonzero peer delta', (await custodyService.status()).custodian?.id, receiver)
eq('sales are now assigned to actual receiver', (await custodyService.actorForFinancialOperation()).expectedShiftId, approved.data.shiftId)
eq('old shift was closed after successful transfer', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt != null, true)
eq('no automatic blame case for peer warning', seed.count('CustodyDiscrepancyCase'), 0)
await reject('completed pair cannot be re-read as current handover', 'BLUE_NOT_COUNTED',
  () => custodyService.handoverBlueReview({ handoverId: first.id, password: 'ReceiverOwn447!' }))
sale(447001, 1_000_000, receiver, approved.data.shiftId)
eq('a real sale after warning stays with new owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE receiptNo=?', 447001).userId, receiver)

const second = await custodyService.handoverStart({ password: 'ReceiverOwn447!', operationalTotal: 16_000_000,
  toUserId: giver, idempotencyKey: 's447:incorrect-out', blueReference: true })
const secondIn = await custodyService.handoverCountBlue({ handoverId: second.id, password: 'GiverOwn447!', operationalTotal: 11_000_000 })
eq('LESS direction and exact 5M rial', secondIn.peerComparison,
  { status: 'DIFFERENT', direction: 'LESS', absoluteDifferenceRial: '5000000', selfCount: false })
eq('raw blue variance is positive while the two-count warning is LESS', Math.sign(secondIn.rawDifference), 1)
const oldOut = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'OUT')
const oldIn = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'IN')
await reject('the incoming worker cannot cancel for the previous worker', 'PIN_WRONG',
  () => custodyService.handoverCancel({ handoverId: second.id, password: 'GiverOwn447!' }))
await custodyService.handoverCancel({ handoverId: second.id, password: 'ReceiverOwn447!' })
eq('cancelled attempt keeps current owner working', (await custodyService.status()).custodian?.id, receiver)
eq('canceled status is append-only history', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', second.id).status, 'CANCELED')
eq('previous OUT document is unchanged', seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'OUT'), oldOut)
eq('previous IN document is unchanged', seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'IN'), oldIn)
await reject('canceled attempt cannot leak its readback', 'BLUE_NOT_COUNTED',
  () => custodyService.handoverBlueReview({ handoverId: second.id, password: 'GiverOwn447!' }))
const corrected = await custodyService.handoverStart({ password: 'ReceiverOwn447!', operationalTotal: 11_000_000,
  toUserId: giver, idempotencyKey: 's447:corrected-out', blueReference: true })
eq('fresh attempt has a different handover ID', corrected.id !== second.id, true)
const equal = await custodyService.handoverCountBlue({ handoverId: corrected.id, password: 'GiverOwn447!', operationalTotal: 11_000_000 })
eq('fresh count no longer produces a peer warning', equal.peerComparison.status, 'EQUAL')
eq('fresh real OUT attested by first person himself', seed.one('SELECT actorUserId FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', corrected.id, 'OUT').actorUserId, receiver)
await custodyService.handoverConfirmBlue({ handoverId: corrected.id, password: 'GiverOwn447!' })
eq('fresh count allows transfer to new owner', (await custodyService.status()).custodian?.id, giver)
eq('old OUT still unchanged after fresh acceptance', seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'OUT'), oldOut)
eq('old IN still unchanged after fresh acceptance', seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', second.id, 'IN'), oldIn)

const selfZero = await custodyService.handoverStart({ password: 'GiverOwn447!', operationalTotal: 0,
  toUserId: giver, idempotencyKey: 's447:self-zero', blueReference: true })
const zeroCount = await custodyService.handoverCountBlue({ handoverId: selfZero.id, password: 'GiverOwn447!', operationalTotal: 0 })
eq('explicit zero + explicit zero are two comparable human attestations', zeroCount.peerComparison,
  { status: 'EQUAL', direction: null, absoluteDifferenceRial: '0', selfCount: true })
eq('zero OUT has genuine ZERO origin', seed.one('SELECT countOrigin FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', selfZero.id, 'OUT').countOrigin, 'EXPLICIT_ZERO')
eq('zero IN has genuine ZERO origin', seed.one('SELECT countOrigin FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', selfZero.id, 'IN').countOrigin, 'EXPLICIT_ZERO')
const beforeSelfShift = (await custodyService.status()).activeShiftId
await custodyService.handoverConfirmBlue({ handoverId: selfZero.id, password: 'GiverOwn447!' })
eq('self zero boundary does not close current Shift', (await custodyService.status()).activeShiftId, beforeSelfShift)
const selfChange = await custodyService.handoverStart({ password: 'GiverOwn447!', operationalTotal: 0,
  toUserId: giver, idempotencyKey: 's447:self-change', blueReference: true })
const selfIn = await custodyService.handoverCountBlue({ handoverId: selfChange.id, password: 'GiverOwn447!', operationalTotal: 200 })
eq('self-handover can warn on two independent counts', selfIn.peerComparison,
  { status: 'DIFFERENT', direction: 'MORE', absoluteDifferenceRial: '200', selfCount: true })
await custodyService.handoverConfirmBlue({ handoverId: selfChange.id, password: 'GiverOwn447!' })
eq('self mismatch also never gates confirmation', (await custodyService.status()).activeShiftId, beforeSelfShift)
eq('no automatic discrepancy verdict', seed.count('CustodyDiscrepancyCase'), 0)
console.log(`\n✓ ${checks} live peer warning and recount checks passed`)
