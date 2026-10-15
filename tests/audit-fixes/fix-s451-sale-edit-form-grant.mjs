/**
 * S451 — A Main-issued form-open witness prevents a previously opened A form
 * from borrowing B's fresh financial actor. The witness never replaces PIN,
 * Main custody ownership, payment gates or the in-transaction custody fence.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s451-sale-edit-form-grant.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-sale-form-s451-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, label)
  checks++; console.log(`  ✓ ${label}`)
}

const manager = seed.user('مدیر ۴۵۱'), A = seed.user('مسئول الف ۴۵۱'), B = seed.user('مسئول ب ۴۵۱')
for (const id of [A, B]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager451!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager451!' })
for (const [id, temporary, own] of [[A, 'Temporary451A!', 'Personal451A!'], [B, 'Temporary451B!', 'Personal451B!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager451!', reason: 'شبیه‌سازی مسئول صندوق' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: own })
}
const firstShift = await custodyService.open({ userId: A, password: 'Personal451A!', operationalTotal: 10_000_000 })
const product = seed.product('فاکتور فرم ۴۵۱'), variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(30, 1_000_000, variant)
const cash = seed.insert('PaymentMethod', { key: 'S451_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const line = (qty) => ({ variantId: variant, qty, unitPrice: 1_000_000, discount: 0, tax: 0 })

const electron = await import('electron'), handlers = new Map(), destroyed = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender1 = { id: 4511, isDestroyed: () => false, once: (event, fn) => destroyed.set(4511, fn) }
const sender2 = { id: 4512, isDestroyed: () => false, once: (event, fn) => destroyed.set(4512, fn) }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (sender, channel, payload) => handlers.get(channel)({ sender }, payload)
const create = (sender, payments = []) => invoke(sender, IPC.saleCreate, { deductInventory: true, lines: [line(1)], payments })
const original = await create(sender1, [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }])
const second = await create(sender1)
eq('A can make two sales', [original.ok, second.ok], [true, true])
const id = original.data.id, otherId = second.data.id
const read = (sender, invoiceId = id, forEdit = true) => invoke(sender, IPC.saleGet, { id: invoiceId, ...(forEdit ? { forEdit: true } : {}) })
const edit = (invoiceId, token, qty, extra = {}) => ({
  id: invoiceId, editFormToken: token, keepPayments: true, lines: [line(qty)], ...extra
})
const update = (sender, payload) => invoke(sender, IPC.saleUpdate, payload)
const evidence = () => ({
  qty: seed.one('SELECT qty FROM "SaleInvoiceItem" WHERE invoiceId=?', id)?.qty,
  stock: seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant)?.stock,
  audits: seed.one('SELECT COUNT(*) AS n FROM "AuditLog" WHERE entity=? AND entityId=?', 'SaleInvoice', id)?.n,
  revision: seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN')?.financialRevision,
  owner: seed.one('SELECT userId, shiftId FROM "SaleInvoice" WHERE id=?', id)
})
const initial = evidence()

// Read-only callers do not create or receive a form witness.
const ordinary = await read(sender1, id, false)
eq('plain sale:get remains a read-only DTO without a token', [ordinary.ok, 'editFormToken' in ordinary.data], [true, false])
const noToken = await update(sender1, edit(id, undefined, 2))
eq('a governed edit without a form-open token fails closed', [noToken.ok, noToken.code], [false, 'SALE_EDIT_FORM_STALE'])
eq('missing token leaves DB unchanged', evidence(), initial)

const opened = await read(sender1)
const tokenA = opened.data.editFormToken
eq('Main issues an unpredictable 256-bit form witness', /^[a-f0-9]{64}$/.test(tokenA), true)
const otherWindow = await read(sender2)
eq('the same invoice opened in a different window gets another token', tokenA !== otherWindow.data.editFormToken, true)
const stolen = await update(sender2, edit(id, tokenA, 2))
eq('the same token from another window is rejected', [stolen.ok, stolen.code], [false, 'SALE_EDIT_FORM_STALE'])
const wrongInvoice = await update(sender1, edit(otherId, tokenA, 2))
eq('the same token for another invoice is rejected', [wrongInvoice.ok, wrongInvoice.code], [false, 'SALE_EDIT_FORM_STALE'])
const tampered = await update(sender1, edit(id, '0'.repeat(64), 2))
eq('a guessed token cannot edit', [tampered.ok, tampered.code], [false, 'SALE_EDIT_FORM_STALE'])
eq('failed cross-window, cross-invoice and guessed attempts change nothing', evidence(), initial)

// A business validation failure must not consume a witness: the cashier may
// correct the form and retry without refreshing or unlocking the drawer.
const refused = await update(sender1, edit(id, tokenA, 2, { keepPayments: false,
  payments: [{ methodId: cash, amount: 2_000_000, destination: 'CASH' }] }))
eq('the existing payment-rewrite gate still rejects', refused.ok, false)
eq('payment gate leaves everything untouched', evidence(), initial)
const valid = await update(sender1, edit(id, tokenA, 2, { userId: B, shiftId: 999, custodyFence: {
  epoch: 123, expectedShiftId: 999, expectedActorUserId: B
} }))
eq('corrected form retries successfully; renderer cannot forge B as actor', valid.ok, true)
eq('original ownership stays A after editing', evidence().owner, { userId: A, shiftId: firstShift.shiftId })
eq('item delta was applied once', [evidence().qty, evidence().stock], [2, 27])
const replay = await update(sender1, edit(id, tokenA, 3))
eq('a successfully used token cannot be replayed', [replay.ok, replay.code], [false, 'SALE_EDIT_FORM_STALE'])

// A duplicate while the first save awaits actor resolution must lose before
// any Main actor lookup; the first save still succeeds once resumed.
const concurrentToken = (await read(sender1, otherId)).data.editFormToken
const oldActor = custodyService.actorForFinancialOperation
let actorEntered, releaseActor
const atActor = new Promise((resolve) => { actorEntered = resolve })
const actorGate = new Promise((resolve) => { releaseActor = resolve })
let actorCalls = 0
custodyService.actorForFinancialOperation = async function () {
  if (++actorCalls === 1) { actorEntered(); await actorGate }
  return oldActor.call(this)
}
try {
  const first = update(sender1, edit(otherId, concurrentToken, 2))
  await atActor
  const duplicate = await update(sender1, edit(otherId, concurrentToken, 2))
  eq('an in-flight duplicate cannot reuse the reserved witness', [duplicate.ok, duplicate.code], [false, 'SALE_EDIT_FORM_STALE'])
  eq('duplicate is rejected before taking another actor', actorCalls, 1)
  const overlappingRead = await read(sender1, otherId)
  eq('same-window re-open waits for the in-flight edit rather than minting a pre-commit token',
    [overlappingRead.ok, overlappingRead.code], [false, 'SALE_EDIT_FORM_STALE'])
  releaseActor()
  eq('the original in-flight edit completes normally', (await first).ok, true)
} finally {
  releaseActor()
  custodyService.actorForFinancialOperation = oldActor
}

// Expiry is local to the form; it never changes CustodyState or prevents a new sale.
const expiredToken = (await read(sender1)).data.editFormToken
const oldNow = Date.now, issuedAt = Date.now()
let expired
try {
  Date.now = () => issuedAt + 13 * 60 * 60 * 1000
  expired = await update(sender1, edit(id, expiredToken, 3))
} finally {
  Date.now = oldNow
}
eq('expired token is rejected', [expired.ok, expired.code], [false, 'SALE_EDIT_FORM_STALE'])
const beforeHandover = evidence()

// A form opened just BEFORE HANDOVER_PENDING must remain usable by the outgoing
// A; the epoch rises, but the responsible shift and actor have not changed.
const pendingToken = (await read(sender1)).data.editFormToken
let handover = await custodyService.handoverStart({ password: 'Personal451A!', operationalTotal: 11_000_000,
  toUserId: B, idempotencyKey: 's451:A-to-B', blueReference: true })
eq('handover start moves to pending', (await custodyService.status()).state, 'HANDOVER_PENDING')
const pendingEdit = await update(sender1, edit(id, pendingToken, 3))
eq('A can save a form opened before pending', pendingEdit.ok, true)
eq('A remains owner of the original invoice in pending', evidence().owner, beforeHandover.owner)
const pendingSale = await create(sender1)
eq('A can also create a new sale in pending', [pendingSale.ok, pendingSale.data?.shiftId], [true, firstShift.shiftId])
await assert.rejects(
  () => custodyService.handoverCountBlue({ handoverId: handover.id, password: 'Personal451B!', operationalTotal: 11_000_000 }),
  (error) => error?.code === 'BLUE_RECOUNT_REQUIRED'
)
checks++
eq('sale after OUT requires a new count, without locking A drawer',
  [(await custodyService.status()).state, (await custodyService.status()).custodian.id], ['ACTIVE', A])
handover = await custodyService.handoverStart({ password: 'Personal451A!', operationalTotal: 11_000_000,
  toUserId: B, idempotencyKey: 's451:A-to-B-recount', blueReference: true })

// Interleave at the MOST dangerous point: A has reserved its grant, but Main
// has not acquired the actor. B's accepted handover must never let A's old
// form borrow B's new fence. The TX fence alone cannot catch this request.
const oldFormToken = (await read(sender1)).data.editFormToken
let entered, resume
const waiting = new Promise((resolve) => { entered = resolve })
const gate = new Promise((resolve) => { resume = resolve })
custodyService.actorForFinancialOperation = async function () {
  entered(); await gate
  return oldActor.call(this)
}
try {
  const pendingSave = update(sender1, edit(id, oldFormToken, 4))
  await waiting
  await custodyService.handoverCountBlue({ handoverId: handover.id, password: 'Personal451B!', operationalTotal: 11_000_000 })
  const accepted = await custodyService.handoverConfirmBlue({ handoverId: handover.id, password: 'Personal451B!' })
  eq('B becomes the custodian while A’s save waits for its Main actor', (await custodyService.status()).custodian.id, B)
  const snapshot = evidence()
  resume()
  const stale = await pendingSave
  eq('A form is rejected even when Main acquires B’s fresh fence', [stale.ok, stale.code], [false, 'SALE_EDIT_FORM_STALE'])
  eq('A stale form changes no invoice, stock, audit or custody revision', evidence(), snapshot)
  custodyService.actorForFinancialOperation = oldActor
  const BSale = await create(sender2)
  eq('B can immediately sell after rejection: drawer is not stuck', [BSale.ok, BSale.data?.shiftId], [true, accepted.shiftId])
  const BToken = (await read(sender2)).data.editFormToken
  const historical = await update(sender2, edit(id, BToken, 4, { userId: A, shiftId: firstShift.shiftId }))
  eq('B may freshly open and edit the historical A invoice', historical.ok, true)
  eq('historical invoice still belongs to A', evidence().owner, { userId: A, shiftId: firstShift.shiftId })
  eq('historical edit audit belongs to current B',
    seed.one('SELECT userId FROM "AuditLog" WHERE entity=? AND entityId=? AND action=? ORDER BY id DESC',
      'SaleInvoice', id, 'SALE_UPDATE')?.userId, B)
} finally {
  resume()
  custodyService.actorForFinancialOperation = oldActor
}

// A no-op manager reset is NOT a change in responsibility; an effective reset
// aborting a pending handover IS, even if B keeps the same Shift ID.
const noOpToken = (await read(sender2)).data.editFormToken
const noOp = await custodyService.resetShift({ managerUserId: manager, password: 'Manager451!',
  reason: 'بازبینی بی اثر صندوق فعال', confirmed: true })
eq('healthy reset is a no-op', noOp.outcome, 'NO_CHANGE')
eq('healthy review does not invalidate B form', (await update(sender2, edit(id, noOpToken, 5))).ok, true)
const resetToken = (await read(sender2)).data.editFormToken
await custodyService.handoverStart({ password: 'Personal451B!', operationalTotal: 11_000_000,
  toUserId: A, idempotencyKey: 's451:reset-pending', blueReference: true })
const restored = await custodyService.resetShift({ managerUserId: manager, password: 'Manager451!',
  reason: 'توقف تحویل ناتمام و بازیابی صندوق', confirmed: true })
eq('reset aborts incomplete handover but preserves the real B drawer',
  [restored.outcome, (await custodyService.status()).state, (await custodyService.status()).custodian.id],
  ['ABORTED_INCOMPLETE', 'ACTIVE', B])
const resetSnapshot = evidence()
const staleAfterReset = await update(sender2, edit(id, resetToken, 6))
eq('an effective reset invalidates even a same-shift form', [staleAfterReset.ok, staleAfterReset.code],
  [false, 'SALE_EDIT_FORM_STALE'])
eq('reset-stale form causes no financial write', evidence(), resetSnapshot)
const freshBToken = (await read(sender2)).data.editFormToken
eq('B can promptly edit after an effective reset', (await update(sender2, edit(id, freshBToken, 6))).ok, true)
eq('reset did not lock the drawer', (await create(sender2)).ok, true)

const canceledForm = (await read(sender2)).data.editFormToken
const bShiftBeforeCancel = (await custodyService.status()).activeShiftId
const canceledHandover = await custodyService.handoverStart({ password: 'Personal451B!', operationalTotal: 11_000_000,
  toUserId: A, idempotencyKey: 's451:canceled-handover', blueReference: true })
await custodyService.handoverCancel({ handoverId: canceledHandover.id, password: 'Personal451B!' })
eq('a canceled pending handover restores B without changing the responsible shift',
  [(await custodyService.status()).state, (await custodyService.status()).activeShiftId], ['ACTIVE', bShiftBeforeCancel])
eq('a form opened before pending/cancel still belongs to B',
  (await update(sender2, edit(id, canceledForm, 7))).ok, true)

const destroyToken = (await read(sender1)).data.editFormToken
// The sender is not really destroyed in this stub; invoke its lifecycle hook
// to prove that only its registry is revoked and sender2 remains independent.
destroyed.get(sender1.id)()
const revoked = await update(sender1, edit(id, destroyToken, 7))
eq('destroyed window token is revoked', [revoked.ok, revoked.code], [false, 'SALE_EDIT_FORM_STALE'])
const freshOtherWindow = (await read(sender2)).data.editFormToken
eq('destroying window 1 does not affect window 2', (await update(sender2, edit(id, freshOtherWindow, 7))).ok, true)

// GET itself can straddle a handover. Capture B BEFORE the invoice read; never
// read under B and then mint an A token for that pre-handover snapshot.
const { salesService } = await import('../../src/main/services/SalesService.ts')
const oldGet = salesService.get
let getEntered, resumeGet
const readPaused = new Promise((resolve) => { getEntered = resolve })
const readGate = new Promise((resolve) => { resumeGet = resolve })
let blockedGet = false
salesService.get = async function (invoiceId) {
  const snapshot = await oldGet.call(this, invoiceId)
  if (!blockedGet && invoiceId === id) {
    blockedGet = true
    getEntered()
    await readGate
  }
  return snapshot
}
try {
  const pendingRead = read(sender2)
  await readPaused
  const finalHandover = await custodyService.handoverStart({ password: 'Personal451B!', operationalTotal: 11_000_000,
    toUserId: A, idempotencyKey: 's451:B-to-A-during-get', blueReference: true })
  await custodyService.handoverCountBlue({ handoverId: finalHandover.id, password: 'Personal451A!', operationalTotal: 11_000_000 })
  const received = await custodyService.handoverConfirmBlue({ handoverId: finalHandover.id, password: 'Personal451A!' })
  resumeGet()
  const straddled = await pendingRead
  eq('a straddled GET still returns its B-bound form witness', [straddled.ok, /^[a-f0-9]{64}$/.test(straddled.data.editFormToken)], [true, true])
  const beforeStraddledSave = evidence()
  const rejected = await update(sender2, edit(id, straddled.data.editFormToken, 8))
  eq('B data read before handover cannot acquire an A token after handover', [rejected.ok, rejected.code], [false, 'SALE_EDIT_FORM_STALE'])
  eq('straddled GET form does not overwrite the invoice', evidence(), beforeStraddledSave)
  eq('A can sell after this GET race, without a drawer lock',
    [((await create(sender2)).data?.shiftId), (await custodyService.status()).custodian.id], [received.shiftId, A])
  const freshAForm = (await read(sender2)).data.editFormToken
  eq('the current A can explicitly reopen and edit after the GET race',
    (await update(sender2, edit(id, freshAForm, 8))).ok, true)
} finally {
  resumeGet()
  salesService.get = oldGet
}
eq('SQLite remains consistent after every stale attempt', seed.one('PRAGMA integrity_check')?.integrity_check, 'ok')
console.log(`\n✓ ${checks} sale edit form-grant checks passed`)
