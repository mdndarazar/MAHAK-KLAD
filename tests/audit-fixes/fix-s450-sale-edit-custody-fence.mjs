/**
 * Sale-edit custody fence (Claude's minimal repair). Exercise the real IPC
 * handler and SQLite transactions; pause after Main captured A's fence, finish
 * A -> B handover, then resume update. The edit must be atomic and fail stale.
 * New requests from a previously opened renderer form additionally carry an
 * ephemeral, window-bound form-open witness; a new B form gets its own token.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s450-sale-edit-custody-fence.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-sale-edit-fence-s450-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
async function rejects(label, code, operation) {
  await assert.rejects(operation, (error) => error?.code === code, label)
  checks++; console.log(`  ✓ ${label}`)
}

const manager = seed.user('مدیر S450'), A = seed.user('تحویل‌دهنده S450'), B = seed.user('تحویل‌گیرنده S450')
for (const id of [A, B]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager450!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager450!' })
for (const [id, temporary, personal] of [[A, 'FirstTemp450!', 'FirstOwn450!'], [B, 'SecondTemp450!', 'SecondOwn450!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager450!', reason: 'آزمون ویرایش هم‌زمان با تحویل' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
const firstShift = await custodyService.open({ userId: A, password: 'FirstOwn450!', operationalTotal: 10_000_000 })
const product = seed.product('کالای آزمون ویرایش S450'), variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(10, 1_000_000, variant)
const cash = seed.insert('PaymentMethod', { key: 'S450_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const line = (qty) => ({ variantId: variant, qty, unitPrice: 1_000_000, discount: 0, tax: 0 })

const electron = await import('electron'), handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 450, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const sale = await invoke(IPC.saleCreate, {
  deductInventory: true, lines: [line(1)],
  payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }]
})
eq('A can create the original sale', sale.ok, true)
const invoiceId = sale.data.id
const invoiceRow = () => seed.one('SELECT id, userId, shiftId, grandTotal, paidTotal, status, note FROM "SaleInvoice" WHERE id=?', invoiceId)
const itemRows = () => seed.rows('SELECT id, invoiceId, variantId, qty, unitPrice, lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
const paymentRows = () => seed.rows('SELECT id, invoiceId, amount, methodId, createdShiftId, createdByUserId FROM "Payment" WHERE invoiceId=? ORDER BY id', invoiceId)
const stock = () => seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant)?.stock
const editAudits = () => seed.rows('SELECT id, action, entity, entityId, userId FROM "AuditLog" WHERE entityId=? AND entity IN (?,?) ORDER BY id', invoiceId, 'SaleInvoice', 'SaleInvoiceItemRevision')
const evidence = () => ({ invoice: invoiceRow(), items: itemRows(), payments: paymentRows(), stock: stock(), audits: editAudits(), revision: seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN')?.financialRevision })
eq('original sale belongs to A', [invoiceRow().userId, invoiceRow().shiftId], [A, firstShift.shiftId])
eq('initial stock deducted', stock(), 9)
const edit = (qty, extra = {}) => ({ id: invoiceId, keepPayments: true, lines: [line(qty)], ...extra })
const openEdit = async () => {
  const res = await invoke(IPC.saleGet, { id: invoiceId, forEdit: true })
  assert.equal(res.ok, true, res.error)
  assert.match(res.data.editFormToken, /^[a-f0-9]{64}$/)
  return res.data.editFormToken
}

await rejects('direct governed service call without a Main fence cannot edit', 'CUSTODY_OPERATOR_EVIDENCE_REQUIRED',
  () => salesService.update({ ...edit(2), userId: A, shiftId: firstShift.shiftId }))
eq('missing fence changes neither invoice nor stock', [itemRows()[0].qty, stock()], [1, 9])
const firstFence = await custodyService.actorForFinancialOperation()
await rejects('a fenced direct caller cannot forge the audit actor or active shift', 'CUSTODY_OPERATOR_STALE',
  () => salesService.update({ ...edit(2), userId: B, shiftId: firstShift.shiftId, custodyFence: firstFence }))
eq('actor mismatch leaves stock untouched', stock(), 9)

const usual = await invoke(IPC.saleUpdate, edit(2, { editFormToken: await openEdit() }))
eq('ordinary keepPayments sale edit succeeds under A', usual.ok, true)
eq('ordinary edit changes item, amount and stock', [itemRows()[0].qty, Number(invoiceRow().grandTotal), stock()], [2, 2_000_000, 8])
eq('ordinary edit preserves actual payment row', paymentRows().map((p) => [p.amount, p.createdByUserId, p.createdShiftId]), [[1_000_000, A, firstShift.shiftId]])
eq('normal edit retains invoice custody', [invoiceRow().userId, invoiceRow().shiftId], [A, firstShift.shiftId])
eq('normal edit writes one invoice and one item revision audit', editAudits().filter((a) => a.action === 'SALE_UPDATE').map((a) => a.entity).sort(), ['SaleInvoice', 'SaleInvoiceItemRevision'])

const paymentAttempt = await invoke(IPC.saleUpdate, { ...edit(3), editFormToken: await openEdit(), keepPayments: false,
  payments: [{ methodId: cash, amount: 3_000_000, destination: 'CASH' }] })
eq('existing payment-rewrite gate remains in force', paymentAttempt.ok, false)
eq('rejected payment rewrite did not touch payment or item', [paymentRows().length, itemRows()[0].qty], [1, 2])

// Stop at the first preflight read. IPC already acquired A's fence here, but
// neither an invoice SELECT nor the write transaction has happened yet.
const oldFindUnique = db.saleInvoice.findUnique
let entered, release
const paused = new Promise((resolve) => { entered = resolve })
const gate = new Promise((resolve) => { release = resolve })
let intercepted = false
db.saleInvoice.findUnique = async (query) => {
  if (!intercepted && query?.where?.id === invoiceId && query?.select?.issuedAt) {
    intercepted = true
    entered()
    await gate
  }
  return oldFindUnique(query)
}
let attempted
try {
  const AFormToken = await openEdit()
  const pendingEdit = invoke(IPC.saleUpdate, edit(3, { editFormToken: AFormToken }))
  let timeout
  try {
    await Promise.race([paused, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('sale edit never reached preflight')), 10_000)
    })])
  } finally {
    clearTimeout(timeout)
  }
  eq('the update started before handover', (await custodyService.status()).custodian.id, A)
  const handover = await custodyService.handoverStart({ password: 'FirstOwn450!', operationalTotal: 11_000_000,
    toUserId: B, idempotencyKey: 's450:first-to-second', blueReference: true })
  await custodyService.handoverCountBlue({ handoverId: handover.id, password: 'SecondOwn450!', operationalTotal: 11_000_000 })
  const received = await custodyService.handoverConfirmBlue({ handoverId: handover.id, password: 'SecondOwn450!' })
  eq('B took ownership while A update was paused', (await custodyService.status()).custodian.id, B)
  const beforeStale = evidence()
  release()
  attempted = await pendingEdit
  eq('A preflight edit fails closed after B accepts drawer', [attempted.ok, attempted.code], [false, 'CUSTODY_STALE'])
  eq('stale edit did not touch invoice, items, payments, stock, audit or financial revision', evidence(), beforeStale)
  eq('stale edit cannot switch the active custodian', (await custodyService.status()).custodian.id, B)
  const staleForm = await invoke(IPC.saleUpdate, edit(3, { editFormToken: AFormToken }))
  eq('a newly submitted A form cannot borrow B’s Main actor', [staleForm.ok, staleForm.code], [false, 'SALE_EDIT_FORM_STALE'])
  eq('stale form makes no invoice, stock or audit write', evidence(), beforeStale)

  const afterErrorSale = await invoke(IPC.saleCreate, { deductInventory: false,
    lines: [line(1)], payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] })
  eq('B can immediately sell after stale edit; the drawer is not locked', [afterErrorSale.ok, afterErrorSale.data?.shiftId], [true, received.shiftId])
  eq('stale edit still did not change original invoice', [itemRows()[0].qty, stock()], [2, 8])

  // B explicitly reopens the historical A invoice. Main supplies the B actor
  // and the new B form witness; the original invoice owner stays A.
  const historical = await invoke(IPC.saleUpdate, { ...edit(3), editFormToken: await openEdit(), userId: A,
    shiftId: firstShift.shiftId, custodyFence: firstFence })
  eq('B may edit an old invoice without reassigning the original sale', historical.ok, true)
  eq('invoice stays on A; edit audit belongs to current B',
    [invoiceRow().userId, invoiceRow().shiftId, editAudits().at(-1).userId], [A, firstShift.shiftId, B])
  eq('B historical edit applies only its real quantity delta', [itemRows()[0].qty, stock()], [3, 7])
  eq('historical edit still keeps the old payment evidence', paymentRows().map((p) => p.createdByUserId), [A])

  const pendingFormToken = await openEdit() // issued before HANDOVER_PENDING
  const nextHandover = await custodyService.handoverStart({ password: 'SecondOwn450!', operationalTotal: 12_000_000,
    toUserId: A, idempotencyKey: 's450:pending-for-next-count', blueReference: true })
  eq('new handover is pending, not a sales lock', (await custodyService.status()).state, 'HANDOVER_PENDING')
  const editDuringPending = await invoke(IPC.saleUpdate, edit(4, { editFormToken: pendingFormToken }))
  eq('edit continues under outgoing owner during pending', editDuringPending.ok, true)
  eq('pending edit does not change original invoice ownership', [invoiceRow().userId, invoiceRow().shiftId], [A, firstShift.shiftId])
  eq('pending edit audit is attributed to outgoing B', editAudits().at(-1).userId, B)
  const pendingSale = await invoke(IPC.saleCreate, { deductInventory: false,
    lines: [line(1)], payments: [{ methodId: cash, amount: 1_000_000, destination: 'CASH' }] })
  eq('new sale remains available to B while pending', [pendingSale.ok, pendingSale.data?.shiftId], [true, received.shiftId])
  await rejects('financial change after OUT requires a new independent count', 'BLUE_RECOUNT_REQUIRED',
    () => custodyService.handoverCountBlue({ handoverId: nextHandover.id, password: 'FirstOwn450!', operationalTotal: 12_000_000 }))
  eq('stale pending count returns to an ACTIVE B drawer, no permanent freeze',
    [(await custodyService.status()).state, (await custodyService.status()).custodian.id], ['ACTIVE', B])
  eq('SQLite integrity after stale error and pending retry', seed.one('PRAGMA integrity_check')?.integrity_check, 'ok')
} finally {
  release()
  db.saleInvoice.findUnique = oldFindUnique
}
console.log(`\n✓ ${checks} sale edit custody checks passed`)
