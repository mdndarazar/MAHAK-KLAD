/**
 * Ordinary return/exchange paper: the safe sale result never contains the
 * spendable code; only the manager-password print route may render that exact
 * return's credit. A failed print never cancels or replaces the original.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-ordinary-credit-print.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-ordinary-paper-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (ch, fn) => handlers.set(ch, fn)
const sender = { id: 1783, isDestroyed: () => false, once: () => {} }
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { runWithPanelSessionOwner, notePanelUnlocked, isManagerSessionUnlocked } = await import('../../src/main/services/panelSession.ts')
const { PANEL_KEYS } = await import('@shared/panels')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService, exchangeAccountingPrintData } = await import('../../src/main/services/PrintService.ts')
const { IPC } = await import('@shared/ipc')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('ordinary paper shift actor'), cat = seed.category('ordinary paper')
const product = seed.product('paper item', cat), v100 = seed.variant(product), v200 = seed.variant(product)
for (const [id, price] of [[v100, 100], [v200, 200]])
  sql.prepare('UPDATE "ProductVariant" SET stock=20, salePrice=? WHERE id=?').run(price, id)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'cash', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, userId,
  openedAt: Date.now() - 5000, dayJalali: toJalaliDate(new Date()) })
const makeSale = (variantId, price) => salesService.create({ userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: price, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: price, destination: 'CASH' }] })
const itemId = (invoiceId) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', invoiceId).id
registerIpcHandlers()
const ipc = (channel, p) => handlers.get(channel)({ sender }, p)
runWithPanelSessionOwner(sender.id, () => {
  notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL')
  assert.equal(isManagerSessionUnlocked(), false, 'a sales-return panel scope must not be mistaken for manager login')
})

const sale = await makeSale(v100, 100)
const returnRequest = { invoiceId: sale.id, full: true,
  lines: [{ saleItemId: itemId(sale.id), qty: 1 }], refundMethod: 'STORE_CREDIT',
  refundAmount: 100, printedHolderFirstName: 'لیلا', printedHolderPhone: '۰۹۱۲۲۲۲۲۲۲۲',
  userId: -1, shiftId }
const missingKey = await ipc(IPC.saleReturn, returnRequest)
assert.equal(missingKey.ok, false)
assert.match(missingKey.error, /کلید یکتای درخواست برگشت لازم است/)
assert.equal(seed.count('SaleReturn', 'invoiceId=?', sale.id), 0, 'IPC rejects missing idempotency keys before mutation')
const idempotencyKey = 'return-request:ordinary-paper-first-0001'
const raw = await ipc(IPC.saleReturn, { ...returnRequest, idempotencyKey })
const replay = await ipc(IPC.saleReturn, { ...returnRequest, idempotencyKey })
assert.equal(replay.ok, true, replay.error)
assert.equal(replay.data.replayed, true)
assert.equal(replay.data.id, raw.data.id)
assert.equal(replay.data.storeCredit.id, raw.data.storeCredit.id)
assert.equal(replay.data.firstPrintGrant, null, 'a replay cannot mint another first-print permit')
assert.equal(raw.ok, true, raw.error)
assert.equal(raw.data.storeCredit.code, undefined)
assert.equal(raw.data.storeCreditCode, undefined)
assert.match(raw.data.firstPrintGrant, /^[0-9a-f]{64}$/)
const creditId = raw.data.storeCredit.id, returnId = raw.data.id
assert.equal(seed.one('SELECT userId FROM "StoreCredit" WHERE id=?', creditId).userId, userId,
  'actor is taken from the current shift, not renderer payload')
const paper = await printService.creditDocDataFor(creditId, await (await import('../../src/main/services/SettingsService.ts')).settingsService.receiptTemplate())
assert.equal(paper.holderName, 'لیلا')
assert.equal(paper.holderPhone, '۰۹۱۲۲۲۲۲۲۲۲')

const originalPrint = printService.printCredit
const printCalls = []
printService.printCredit = async (p) => {
  printCalls.push(p)
  return { id: p.id, copies: 1, warnings: [] }
}
try {
  const request = { creditId, returnId, managerPassword: DEFAULT_MANAGER_PASSWORD, userId: -1 }
  assert.equal((await ipc(IPC.returnCreditPrint, { ...request, managerPassword: 'invalid' })).ok, false)
  assert.equal((await ipc(IPC.returnCreditPrint, { ...request, returnId: returnId + 1 })).ok, false)
  assert.equal((await ipc(IPC.returnCreditPrint, { ...request, creditId: creditId + 1 })).ok, false)
  assert.equal(printCalls.length, 0)
  const first = { creditId, returnId, firstPrintGrant: raw.data.firstPrintGrant, userId: -1 }
  const otherSender = { id: sender.id + 1, isDestroyed: () => false, once: () => {} }
  runWithPanelSessionOwner(otherSender.id, () => notePanelUnlocked(PANEL_KEYS.salesReturn, 'PANEL'))
  assert.equal((await handlers.get(IPC.returnCreditPrint)({ sender: otherSender }, first)).ok, false,
    'another window cannot replay the issuing window permit')
  assert.equal((await ipc(IPC.returnCreditPrint, { ...first, returnId: returnId + 1 })).ok, false)
  assert.equal((await ipc(IPC.returnCreditPrint, { ...first, creditId: creditId + 1 })).ok, false)
  const otherStaff = seed.user('different shift actor')
  sql.prepare('UPDATE "Shift" SET userId=? WHERE id=?').run(otherStaff, shiftId)
  assert.equal((await ipc(IPC.returnCreditPrint, first)).ok, false, 'a different actor cannot use the grant')
  sql.prepare('UPDATE "Shift" SET userId=? WHERE id=?').run(userId, shiftId)
  assert.equal((await ipc(IPC.returnCreditPrint, first)).ok, true)
  assert.equal((await ipc(IPC.returnCreditPrint, first)).ok, false, 'one permit is single use')
  assert.equal(printCalls.at(-1).id, creditId)
  assert.equal(printCalls.at(-1).userId, userId)
  assert.equal(printCalls.at(-1).reprint, false)
  assert.equal(printCalls.at(-1).password, undefined)
  assert.equal(runWithPanelSessionOwner(sender.id, () => isManagerSessionUnlocked()), false,
    'first print is not manager login')
  sql.prepare('UPDATE "StoreCredit" SET printCount=1 WHERE id=?').run(creditId)
  assert.equal((await ipc(IPC.returnCreditPrint, request)).ok, true)
  assert.equal(printCalls.at(-1).reprint, true)
  assert.equal(runWithPanelSessionOwner(sender.id, () => isManagerSessionUnlocked()), false,
    'a manager print password is not a persistent manager session')

  const source = await makeSale(v200, 200)
  const exchangeRequest = { invoiceId: source.id,
    lines: [{ saleItemId: itemId(source.id), qty: 1 }],
    replacements: [{ variantId: v100, qty: 1 }], refundMode: 'STORE_CREDIT',
    printedHolderLastName: 'اکبری', idempotencyKey: 'exchange-request:credit-print-e2e-01', userId: -1, shiftId }
  const beforeMissingExchangeKey = {
    returns: seed.count('SaleReturn', 'invoiceId=?', source.id),
    children: seed.count('SaleInvoice', 'sourceInvoiceId=?', source.id),
    credits: seed.count('StoreCredit', '1=1'), events: seed.count('ExchangeFundingEvent', '1=1')
  }
  const missingExchangeKey = await ipc(IPC.saleExchangeCreate, { ...exchangeRequest, idempotencyKey: undefined })
  assert.equal(missingExchangeKey.ok, false)
  assert.match(missingExchangeKey.error, /کلید یکتای درخواست تعویض لازم است/)
  assert.deepEqual({
    returns: seed.count('SaleReturn', 'invoiceId=?', source.id),
    children: seed.count('SaleInvoice', 'sourceInvoiceId=?', source.id),
    credits: seed.count('StoreCredit', '1=1'), events: seed.count('ExchangeFundingEvent', '1=1')
  }, beforeMissingExchangeKey, 'IPC rejects missing exchange idempotency before any mutation')
  const changed = await ipc(IPC.saleExchangeCreate, exchangeRequest)
  assert.equal(changed.ok, true, changed.error)
  assert.equal(changed.data.storeCredit.code, undefined)
  assert.match(changed.data.firstPrintGrant, /^[0-9a-f]{64}$/)
  const afterExchangeCommit = {
    returns: seed.count('SaleReturn', 'invoiceId=?', source.id),
    children: seed.count('SaleInvoice', 'sourceInvoiceId=?', source.id),
    credits: seed.count('StoreCredit', '1=1'),
    payments: seed.count('Payment', '1=1'),
    events: seed.count('ExchangeFundingEvent', '1=1')
  }
  const exchangeReplay = await ipc(IPC.saleExchangeCreate, exchangeRequest)
  assert.equal(exchangeReplay.ok, true, exchangeReplay.error)
  assert.equal(exchangeReplay.data.replayed, true)
  assert.equal(exchangeReplay.data.returnId, changed.data.returnId)
  assert.equal(exchangeReplay.data.exchangeInvoiceId, changed.data.exchangeInvoiceId)
  assert.equal(exchangeReplay.data.firstPrintGrant, null,
    'same-key replay cannot mint a second process-local first-print grant')
  assert.deepEqual({
    returns: seed.count('SaleReturn', 'invoiceId=?', source.id),
    children: seed.count('SaleInvoice', 'sourceInvoiceId=?', source.id),
    credits: seed.count('StoreCredit', '1=1'),
    payments: seed.count('Payment', '1=1'),
    events: seed.count('ExchangeFundingEvent', '1=1')
  }, afterExchangeCommit, 'IPC exchange retry has no duplicate financial or ledger effects')
  const exchangeReq = { creditId: changed.data.storeCredit.id, returnId: changed.data.returnId,
    managerPassword: DEFAULT_MANAGER_PASSWORD }
  const exchangeFirst = { creditId: exchangeReq.creditId, returnId: exchangeReq.returnId,
    firstPrintGrant: changed.data.firstPrintGrant }
  const { PrintCancelledError } = await import('../../src/main/print/printer.ts')
  printService.printCredit = async () => { throw new PrintCancelledError() }
  const canceled = await ipc(IPC.returnCreditPrint, exchangeFirst)
  assert.equal(canceled.code, 'PRINT_CANCELLED')
  printService.printCredit = async (p) => {
    printCalls.push(p)
    return { id: p.id, copies: 1, warnings: [] }
  }
  assert.equal((await ipc(IPC.returnCreditPrint, exchangeFirst)).ok, true,
    'a definite cancellation alone allows a new first-print attempt')
  assert.equal((await ipc(IPC.returnCreditPrint, exchangeFirst)).ok, false)
  assert.equal(printCalls.at(-1).id, exchangeReq.creditId)
  assert.equal(printCalls.at(-1).password, undefined)
  assert.equal(seed.one('SELECT customerName FROM "StoreCredit" WHERE id=?', exchangeReq.creditId).customerName, 'اکبری')
  const spendableExchangeCode = seed.one('SELECT code FROM "StoreCredit" WHERE id=?', exchangeReq.creditId).code
  const exchangeReceipt = await printService.exchangeHtml(exchangeReq.returnId)
  assert.doesNotMatch(exchangeReceipt, new RegExp(spendableExchangeCode),
    'printing the NEW exchange accounting receipt again must not bypass the code reprint gate')
  assert.match(exchangeReceipt, /برگهٔ اعتبار جداگانه چاپ می‌شود/)
  sql.prepare('UPDATE "SaleReturn" SET creditPaperSeparate=0 WHERE id=?').run(exchangeReq.returnId)
  assert.match(await printService.exchangeHtml(exchangeReq.returnId), new RegExp(spendableExchangeCode),
    'historical exchange receipts retain their original printed layout internally')
  const template = await (await import('../../src/main/services/SettingsService.ts')).settingsService.receiptTemplate()
  const legacyPaper = await printService.exchangeDataFor(exchangeReq.returnId, template)
  const routineLegacyPaper = exchangeAccountingPrintData(legacyPaper)
  assert.equal(routineLegacyPaper.storeCreditCode, null,
    'routine legacy receipt prints cannot reproduce a spendable code without approval')
  const { exchangeReceiptHtml } = await import('../../src/main/print/templates.ts')
  assert.doesNotMatch(exchangeReceiptHtml(routineLegacyPaper, template), new RegExp(spendableExchangeCode))
  assert.match(exchangeReceiptHtml(routineLegacyPaper, template), /کد تاریخی برای چاپ عادی پوشانده شد/)
  assert.equal(legacyPaper.storeCreditCode, spendableExchangeCode,
    'a manager can still explicitly print the original legacy paper')
  sql.prepare('UPDATE "SaleReturn" SET creditPaperSeparate=1 WHERE id=?').run(exchangeReq.returnId)
  assert.equal((await ipc(IPC.returnCreditPrint, { ...exchangeReq, returnId })).ok, false)
  sql.prepare('UPDATE "SaleReturn" SET voidedAt=? WHERE id=?').run(Date.now(), changed.data.returnId)
  assert.equal((await ipc(IPC.returnCreditPrint, exchangeReq)).ok, false)
  printService.printCredit = async () => { throw new Error('printer not available') }
  assert.equal((await ipc(IPC.returnCreditPrint, request)).ok, false)
  const still = seed.one('SELECT amount, usedAmount, status FROM "StoreCredit" WHERE id=?', creditId)
  assert.deepEqual([still.amount, still.usedAmount, still.status], [100, 0, 'ACTIVE'])
  const retrySale = await makeSale(v100, 100)
  const retry = await ipc(IPC.saleReturn, { invoiceId: retrySale.id, full: true,
    lines: [{ saleItemId: itemId(retrySale.id), qty: 1 }], refundMethod: 'STORE_CREDIT', refundAmount: 100,
    idempotencyKey: 'return-request:ordinary-paper-retry-0001' })
  assert.equal(retry.ok, true, retry.error)
  const retryFirst = { creditId: retry.data.storeCredit.id, returnId: retry.data.id,
    firstPrintGrant: retry.data.firstPrintGrant }
  assert.equal((await ipc(IPC.returnCreditPrint, retryFirst)).ok, false)
  assert.equal((await ipc(IPC.returnCreditPrint, retryFirst)).ok, false,
    'printer failure consumes seller permit: never auto-retry an uncertain outcome')
  assert.deepEqual(Object.values(seed.one('SELECT amount, usedAmount, status, printCount FROM "StoreCredit" WHERE id=?',
    retryFirst.creditId)), [100, 0, 'ACTIVE', 0])
  printService.printCredit = async (p) => {
    printCalls.push(p)
    return { id: p.id, copies: 1, warnings: [] }
  }
  assert.equal((await ipc(IPC.returnCreditPrint, { creditId: retryFirst.creditId,
    returnId: retryFirst.returnId, managerPassword: DEFAULT_MANAGER_PASSWORD })).ok, true,
  'manager may print the SAME issued code after printer failure, not replace/burn it')
  console.log('✓ paper: optional holders, window/actor-scoped first print, manager reprint/recovery, no code in DTO')
} finally {
  printService.printCredit = originalPrint
}
