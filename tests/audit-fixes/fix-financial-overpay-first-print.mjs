/**
 * OVERPAY credit is issued without a spendable code in the IPC result. Only
 * the issuing window/staff/invoice may print it once without manager approval;
 * other prints require a fresh password. Printer output is stubbed, SQLite is
 * temporary, and no real printer, customer file or installer is involved.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-overpay-first-print.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-overpay-paper-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 3456, isDestroyed: () => false, once: () => {} }
const otherSender = { id: 3457, isDestroyed: () => false, once: () => {} }
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { runWithPanelSessionOwner, notePanelUnlocked, isManagerSessionUnlocked } = await import('../../src/main/services/panelSession.ts')
const { PrintCancelledError, PrintOutcomeUnknownError } = await import('../../src/main/print/printer.ts')
const { PANEL_KEYS } = await import('@shared/panels')
const { IPC } = await import('@shared/ipc')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const grantService = await import('../../src/main/ipc/creditFirstPrintGrant.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('overpay paper actor'), otherUser = seed.user('another worker')
const cat = seed.category('overpay print'), product = seed.product('shirt', cat)
let variantSeq = 0
const variant = (price) => {
  const id = seed.variant(product, `size-${++variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=100, salePrice=? WHERE id=?').run(price, id)
  return id
}
const v1000 = variant(1000)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'current', number: 1, userId,
  openedAt: Date.now() - 5000, dayJalali: toJalaliDate(new Date()) })
const ipc = (channel, payload, who = sender) => handlers.get(channel)({ sender: who }, payload)
const assertOk = (result) => { assert.equal(result.ok, true, result.error); return result.data }
const paperFor = (credit) => ({ creditId: credit.id, invoiceId: credit.invoiceId,
  firstPrintGrant: credit.firstPrintGrant, markPrinted: false, copies: 5, userId: otherUser })
const originalPrint = printService.printCredit
const printCalls = []
printService.printCredit = async (input) => {
  printCalls.push(input)
  sql.prepare('UPDATE "StoreCredit" SET printCount=printCount+1 WHERE id=?').run(input.id)
  return { id: input.id, copies: 1, warnings: [] }
}
registerIpcHandlers()
try {
  const create = async (paid, asCredit = false, lines = [{ variantId: v1000, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }]) =>
    assertOk(await ipc(IPC.saleCreate, { lines, payments: paid ? [{ methodId: cash, amount: paid, destination: 'CASH' }] : [],
      ...(paid > lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0)
        ? { confirmOverpay: true, overpayAsCredit: asCredit } : {}) }))
  const sold = await create(1300, true)
  const credit = sold.overpayCredit
  assert.ok(credit)
  assert.equal(credit.invoiceId, sold.id)
  assert.equal(credit.amount, 300)
  assert.match(credit.firstPrintGrant, /^[0-9a-f]{64}$/)
  assert.equal(credit.code, undefined)
  assert.equal(sql.prepare('SELECT userId FROM "StoreCredit" WHERE id=?').get(credit.id).userId, userId)
  assert.equal(runWithPanelSessionOwner(sender.id, () => isManagerSessionUnlocked()), false)
  const code = sql.prepare('SELECT code FROM "StoreCredit" WHERE id=?').get(credit.id).code
  assert.doesNotMatch(JSON.stringify(sold), new RegExp(code), 'sale response must not expose the spendable code')
  const printable = await printService.creditDocDataFor(credit.id, await settingsService.receiptTemplate())
  assert.equal(printable.code, code, 'only Main builds the paper from the persisted spendable code')
  assert.match(printable.sourceLabel, /اضافه/)
  assert.match(await printService.creditHtml(credit.id), new RegExp(code))
  assert.equal((await ipc(IPC.printCredit, { id: credit.id, reprint: false })).ok, false,
    'generic credential print must remain manager-session-only')
  assert.equal((await ipc(IPC.creditPreviewHtml, { id: credit.id })).ok, false)
  assert.equal((await ipc(IPC.overpayCreditPrint, { creditId: credit.id, invoiceId: sold.id })).ok, false,
    'an invoice id alone is not a first-print permit')
  assert.equal((await ipc(IPC.overpayCreditPrint, { ...paperFor(credit), firstPrintGrant: null })).ok, false)
  assert.equal((await ipc(IPC.overpayCreditPrint, paperFor(credit), otherSender)).ok, false)
  assert.equal((await ipc(IPC.overpayCreditPrint, { ...paperFor(credit), creditId: credit.id + 1 })).ok, false)
  assert.equal((await ipc(IPC.overpayCreditPrint, { ...paperFor(credit), invoiceId: sold.id + 1 })).ok, false)
  assert.equal((await ipc(IPC.overpayCreditPrint, { ...paperFor(credit), reprint: true })).ok, false)
  sql.prepare('UPDATE "Shift" SET userId=? WHERE id=?').run(otherUser, shiftId)
  assert.equal((await ipc(IPC.overpayCreditPrint, paperFor(credit))).ok, false,
    'another active worker cannot spend the original worker’s first-print permit')
  sql.prepare('UPDATE "Shift" SET userId=? WHERE id=?').run(userId, shiftId)
  assert.equal(printCalls.length, 0)
  assertOk(await ipc(IPC.overpayCreditPrint, paperFor(credit)))
  assert.deepEqual(printCalls.at(-1), { id: credit.id, copies: 1, markPrinted: true,
    reprint: false, password: undefined, userId })
  assert.equal((await ipc(IPC.overpayCreditPrint, paperFor(credit))).ok, false, 'permit is single use')
  assert.equal((await ipc(IPC.overpayCreditPrint, { creditId: credit.id, invoiceId: sold.id,
    password: 'invalid', reprint: true })).ok, false)
  assert.equal(printCalls.length, 1)
  assertOk(await ipc(IPC.overpayCreditPrint, { creditId: credit.id, invoiceId: sold.id,
    password: DEFAULT_MANAGER_PASSWORD, reprint: true }))
  assert.equal(printCalls.at(-1).reprint, true)
  assert.equal(printCalls.at(-1).password, DEFAULT_MANAGER_PASSWORD)
  assert.equal(runWithPanelSessionOwner(sender.id, () => isManagerSessionUnlocked()), false,
    'a password for this paper does not open a manager session')
  console.log('✓ sale/create: no credential leaks; owner/actor/invoice-bound first paper, no replay; passworded reprint')

  const laterSale = await create(1300)
  assert.equal(laterSale.overpayCredit, null)
  const fromExisting = assertOk(await ipc(IPC.saleOverpayCredit, { invoiceId: laterSale.id, amount: 200 }))
  assert.match(fromExisting.firstPrintGrant, /^[0-9a-f]{64}$/)
  const existingPrint = paperFor(fromExisting)
  printService.printCredit = async () => { throw new PrintCancelledError() }
  assert.equal((await ipc(IPC.overpayCreditPrint, existingPrint)).code, 'PRINT_CANCELLED')
  printService.printCredit = async (input) => {
    printCalls.push(input)
    sql.prepare('UPDATE "StoreCredit" SET printCount=printCount+1 WHERE id=?').run(input.id)
    return { id: input.id, copies: 1, warnings: [] }
  }
  assertOk(await ipc(IPC.overpayCreditPrint, existingPrint))
  assert.equal(printCalls.at(-1).id, fromExisting.id)
  assert.equal((await ipc(IPC.overpayCreditPrint, existingPrint)).ok, false)
  console.log('✓ existing overpay issue: canceled dialog leaves one retriable permit; successful retry consumes it')

  const remaining = assertOk(await ipc(IPC.saleOverpayCredit, { invoiceId: laterSale.id, amount: 100 }))
  const uncertainPrint = paperFor(remaining)
  printService.printCredit = async () => { throw new PrintOutcomeUnknownError('printed outcome unknown') }
  assert.equal((await ipc(IPC.overpayCreditPrint, uncertainPrint)).code, 'PRINT_OUTCOME_UNKNOWN')
  assert.equal((await ipc(IPC.overpayCreditPrint, uncertainPrint)).ok, false,
    'uncertain printer outcome must not trigger another seller paper')
  assert.deepEqual(Object.values(seed.one('SELECT amount, usedAmount, status FROM "StoreCredit" WHERE id=?', remaining.id)),
    [100, 0, 'ACTIVE'], 'print uncertainty does not cancel, change or burn the financial right')
  printService.printCredit = async (input) => {
    printCalls.push(input)
    return { id: input.id, copies: 1, warnings: [] }
  }
  assertOk(await ipc(IPC.overpayCreditPrint, { creditId: remaining.id, invoiceId: laterSale.id,
    password: DEFAULT_MANAGER_PASSWORD, reprint: true }))
  console.log('✓ UNKNOWN print: no automatic replay; the original credit remains, manager decides after checking the printer')

  const unpaid = await create(0)
  const payment = assertOk(await ipc(IPC.salePaymentAdd, { invoiceId: unpaid.id, amount: 1300,
    methodId: cash, destination: 'CASH', confirmOverpay: true, overpayAsCredit: true }))
  assert.match(payment.overpayCredit.firstPrintGrant, /^[0-9a-f]{64}$/)
  assertOk(await ipc(IPC.overpayCreditPrint, paperFor(payment.overpayCredit)))
  const afterReturnInvoice = await create(1000, false, [
    { variantId: variant(500), qty: 1, unitPrice: 500, discount: 0, tax: 0 },
    { variantId: variant(500), qty: 1, unitPrice: 500, discount: 0, tax: 0 }
  ])
  const itemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id DESC', afterReturnInvoice.id).id
  runWithPanelSessionOwner(sender.id, () => notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL'))
  const returnRequest = { invoiceId: afterReturnInvoice.id, full: false,
    lines: [{ saleItemId: itemId, qty: 1 }], refundMethod: 'NONE', confirmOverpay: true,
    overpayAsCredit: true, idempotencyKey: 'return-request:overpay-first-print-0001' }
  const returned = assertOk(await ipc(IPC.saleReturn, returnRequest))
  const replayedReturn = assertOk(await ipc(IPC.saleReturn, returnRequest))
  assert.equal(replayedReturn.replayed, true)
  assert.equal(replayedReturn.overpayCredit.firstPrintGrant, undefined,
    'replay does not issue another OVERPAY first-print grant')
  assert.ok(returned.overpayCredit)
  const returnSnapshot = seed.one('SELECT idempotencyResponseJson FROM "SaleReturn" WHERE id=?', returned.id)
    .idempotencyResponseJson
  assert.equal(returnSnapshot.includes('"firstPrintGrant"'), false,
    'print permits are ephemeral and never enter the persisted response snapshot')
  assert.equal(returnSnapshot.includes('"code"'), false,
    'OVERPAY snapshot does not persist the redeemable code')
  assert.equal(returned.overpayCredit.invoiceId, afterReturnInvoice.id)
  assert.match(returned.overpayCredit.firstPrintGrant, /^[0-9a-f]{64}$/)
  assert.equal(returned.firstPrintGrant, null, 'ordinary return credit and OVERPAY credit have different grants')
  assertOk(await ipc(IPC.overpayCreditPrint, paperFor(returned.overpayCredit)))
  console.log('✓ payment/add and return-created OVERPAY: each gets its own issuance-bound first-print permit')

  const beforeEdit = await create(1000)
  const editVariant = variant(700)
  const afterEdit = assertOk(await ipc(IPC.saleUpdate, { id: beforeEdit.id, keepPayments: true,
    lines: [{ variantId: editVariant, qty: 1, unitPrice: 700, discount: 0, tax: 0 }],
    confirmOverpay: true, overpayAsCredit: true }))
  assert.equal(afterEdit.overpayCredit?.amount, 300)
  assert.match(afterEdit.overpayCredit.firstPrintGrant, /^[0-9a-f]{64}$/)
  assert.equal(afterEdit.overpayCredit.invoiceId, beforeEdit.id)
  assertOk(await ipc(IPC.overpayCreditPrint, paperFor(afterEdit.overpayCredit)))
  console.log('✓ sale/update: reducing items below existing payment issues a separate, bounded OVERPAY paper permit')

  const manual = seed.insert('StoreCredit', { code: 'MANUAL-NOT-OVERPAY', amount: 100, source: 'MANUAL',
    sourceInvoiceId: sold.id, status: 'ACTIVE', userId, printCount: 0 })
  assert.equal((await ipc(IPC.overpayCreditPrint, { creditId: manual, invoiceId: sold.id,
    password: DEFAULT_MANAGER_PASSWORD, reprint: true })).ok, false,
  'a manager password on this route cannot print an unrelated manual/return credit')
  console.log('✓ manager route is source-locked; manual credits cannot masquerade as OVERPAY')
} finally {
  printService.printCredit = originalPrint
}

// The two permitted kinds cannot be confused even when the numerical document
// and credit IDs happen to match. Expiry and window destruction revoke grants
// without touching the persisted financial right.
const owner = 87731, actor = 488, documentId = 11, creditId = 12
const overpayToken = grantService.issueOverpayFirstPrintGrant(owner, actor, documentId, creditId)
const returnToken = grantService.issueCreditFirstPrintGrant(owner + 1, actor, documentId, creditId)
assert.throws(() => grantService.reserveCreditFirstPrintGrant(owner,
  { creditId, returnId: documentId, actorUserId: actor, token: overpayToken }))
assert.throws(() => grantService.reserveOverpayFirstPrintGrant(owner + 1,
  { creditId, invoiceId: documentId, actorUserId: actor, token: returnToken }))
assert.throws(() => grantService.reserveOverpayFirstPrintGrant(owner,
  { creditId, invoiceId: documentId, actorUserId: actor + 1, token: overpayToken }))
assert.throws(() => grantService.reserveOverpayFirstPrintGrant(owner,
  { creditId, invoiceId: documentId + 1, actorUserId: actor, token: overpayToken }))
const originalNow = Date.now, issuedAt = originalNow()
try {
  Date.now = () => issuedAt + 5 * 60_000 + 1
  assert.throws(() => grantService.reserveOverpayFirstPrintGrant(owner,
    { creditId, invoiceId: documentId, actorUserId: actor, token: overpayToken }))
} finally {
  Date.now = originalNow
}
grantService.clearCreditFirstPrintGrants(owner)
assert.throws(() => grantService.reserveOverpayFirstPrintGrant(owner,
  { creditId, invoiceId: documentId, actorUserId: actor, token: overpayToken }))
const otherWindowGrant = grantService.reserveCreditFirstPrintGrant(owner + 1,
  { creditId, returnId: documentId, actorUserId: actor, token: returnToken })
grantService.finishCreditFirstPrintGrant(owner + 1, otherWindowGrant, false)
console.log('✓ Main-memory grants: five-minute TTL, scope separation, actor/invoice isolation and per-window revocation')
