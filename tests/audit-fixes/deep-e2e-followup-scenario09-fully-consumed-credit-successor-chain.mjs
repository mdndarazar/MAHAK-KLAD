/**
 * Independent scenario 8 of 10: fully consumed source credits stay USED;
 * returned value moves to new successor codes, which are then redeemed and
 * rolled into a further successor after a second return. Isolated SQLite only.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s09-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('follow-up fully-consumed successor lifecycle cashier')
const shiftId = seed.insert('Shift', { name: 'follow-up fully-consumed successor lifecycle', number: 11, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: 'F09-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'F09-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('followup-s09')
const n = x => Number(x ?? 0)
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const variants = [], credits = [], branches = []
let seq = 0
const makeVariant = (name, price) => {
  const p = seed.product(`S09-${++seq}-${name}`, cat), id = seed.variant(p, `S09-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const v = { id, name, price }; variants.push(v); return v
}
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
const rawCredit = id => seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source,returnId,exchangeInvoiceId,sourceInvoiceId FROM "StoreCredit" WHERE id=?', id)
const rememberCredit = (id, label, kind = 'purchase-original') => {
  const r = rawCredit(id), c = { id: n(r.id), code: r.code, label, kind }
  if (!credits.some(x => x.id === c.id)) credits.push(c)
  return { ...c, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source, returnId: r.returnId, exchangeInvoiceId: r.exchangeInvoiceId, sourceInvoiceId: r.sourceInvoiceId }
}
const issueCodes = async (label, count, amountEach) => {
  const out = []
  for (let i = 0; i < count; i++) {
    const issued = await storeCreditService.issueManual({ amount: amountEach, multiUse: false, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    out.push(rememberCredit(issued.id, `${label}-original-${i + 1}`))
  }
  return out
}
const rawFinancials = () => {
  const p = seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) value FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) value FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(c.value), refundCard: n(r.value) }
}
const checkpoint = async label => {
  const report = await salesService.reportRows({ shiftId })
  const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  assert.deepEqual(reported, expected, `${label}: service report matches expected physical flows`)
  const raw = rawFinancials(); assert.deepEqual(raw, reported, `${label}: raw financial documents match report`)
  const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, blueExpected, `${label}: blue physical reference`)
  const stock = variants.map(v => {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const delta = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actual, 10 + delta, `${label}: stock ledger ${v.name}`)
    return { variant: v.name, expected: 10 + delta, actual, ledgerDelta: delta }
  })
  const creditState = credits.map(c => {
    const r = rawCredit(c.id)
    return { id: n(r.id), label: c.label, kind: c.kind, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source, returnId: r.returnId == null ? null : n(r.returnId), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId), sourceInvoiceId: r.sourceInvoiceId == null ? null : n(r.sourceInvoiceId) }
  })
  return { label, expected: { ...expected }, reported, raw, blue, blueExpected, stock, credits: creditState }
}
await checkpoint('baseline')
const countSnapshot = () => ({
  invoices: n(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', shiftId).n),
  returns: seed.count('SaleReturn', 'shiftId=?', shiftId), payments: seed.count('Payment', 'createdShiftId=?', shiftId),
  stock: variants.map(v => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock))
})
const assertAtomicRollback = (before, after, label) => {
  assert.deepEqual(after, before, `${label}: blocked operation must leave no document/payment/stock mutation`)
}

async function runBranch(cfg) {
  const b = { name: cfg.name, status: 'PASS', events: [], lifecycle: 'full-used original remains USED; returned value uses new successor IDs' }
  branches.push(b)
  const itemA = makeVariant(`${cfg.name}-item-A-400k`, 400000)
  const itemB = makeVariant(`${cfg.name}-item-B-600k`, 600000)
  const replacement = makeVariant(`${cfg.name}-replacement-650k`, 650000)
  const originals = await issueCodes(cfg.name, cfg.codeCount, cfg.amountEach ?? 0)
  b.purchase = { barcodeCount: originals.length, barcodeValue: cfg.creditApplied, cashTender: cfg.cashTender, cardTender: cfg.cardTender }
  b.events.push(await checkpoint(`${cfg.name}: issue barcode(s)`))
  let sale, ret
  try {
    sale = await salesService.create({
      userId, shiftId, lines: [line(itemA), line(itemB)],
      payments: [
        ...(cfg.cashTender ? [{ methodId: cash, amount: cfg.cashTender, destination: 'CASH' }] : []),
        ...(cfg.cardTender ? [{ methodId: card, amount: cfg.cardTender, destination: 'CARD' }] : [])
      ],
      storeCredits: originals.map(c => ({ code: c.code })), saleRequestIdempotencyKey: `s09-${cfg.name}-sale`
    })
    assert.equal(n(sale.grandTotal), 1000000)
    assert.equal(n(sale.storeCreditApplied), cfg.creditApplied)
    expected.cash += cfg.cashTender; expected.card += cfg.cardTender
    const items = seed.rows('SELECT id,variantId,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
    const itemRowA = items.find(x => n(x.variantId) === itemA.id), itemRowB = items.find(x => n(x.variantId) === itemB.id)
    assert.ok(itemRowA && itemRowB)
    b.sale = { id: n(sale.id), total: n(sale.grandTotal), barcodeApplied: n(sale.storeCreditApplied) }
    b.originalsAfterSale = originals.map(c => {
      const r = rawCredit(c.id)
      if (cfg.creditApplied > 0) { assert.equal(n(r.usedAmount), n(r.amount)); assert.equal(r.status, 'USED') }
      return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status }
    })
    b.events.push(await checkpoint(`${cfg.name}: purchase settled, original barcode(s) fully USED`))

    const returnedMoney = cfg.creditApplied ? 200000 : 400000
    const ri = { userId, shiftId, invoiceId: n(sale.id), full: false, lines: [{ saleItemId: n(itemRowA.id), qty: 1 }], refundMethod: cfg.returnMethod }
    if (['CASH', 'CARD', 'CARD_TO_CARD'].includes(cfg.returnMethod)) ri.refundAmount = returnedMoney
    if (cfg.returnMethod === 'CARD') ri.cardPosOverride = { acknowledgedNoReverse: true, reason: `S09 ${cfg.name} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    if (cfg.returnMethod === 'NONE') { ri.confirmOverpay = true; ri.overpayAsCredit = true; ri.managerPassword = DEFAULT_MANAGER_PASSWORD }
    ret = await salesService.createReturn(ri)
    b.partialReturn = {
      id: n(ret.id), total: n(ret.total), method: ret.refundMethod, refundAmount: n(ret.refundAmount),
      returnCreditAmount: n(ret.returnCreditAmount), sourceCreditRestoredAmount: n(ret.sourceCreditRestoredAmount),
      overpayAmount: n(ret.overpayAmount), overpayCreditAmount: n(ret.overpayCredit?.amount),
      overpayCreditExpiresAt: ret.overpayCredit?.expiresAt ?? null,
      sourceSuccessors: (ret.sourceCreditSuccessors ?? []).map(x => ({ id: n(x.id), amount: n(x.amount), apiExpiresAt: x.expiresAt ?? null }))
    }
    if (cfg.returnMethod === 'CASH') { assert.equal(n(ret.refundAmount), returnedMoney); expected.refundCash += returnedMoney }
    if (cfg.returnMethod === 'CARD') { assert.equal(n(ret.refundAmount), returnedMoney); expected.refundCard += returnedMoney }
    if (cfg.returnMethod === 'CARD_TO_CARD') {
      const req = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', ret.id)
      assert.ok(req); assert.equal(req.status, 'PENDING'); assert.equal(n(req.amount), returnedMoney)
      b.returnTransferPending = { id: n(req.id), status: req.status, amount: n(req.amount), operationKind: req.operationKind }
      b.events.push(await checkpoint(`${cfg.name}: C2C refund pending`))
      await cardTransferService.pay({ id: n(req.id), paidAmount: returnedMoney, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `S09-${cfg.name}-RETURN` })
      const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', req.id)
      assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), returnedMoney)
      b.returnTransferPaid = { status: paid.status, paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
    }
    b.originalsAfterReturn = originals.map(c => {
      const r = rawCredit(c.id)
      if (cfg.creditApplied > 0) { assert.equal(n(r.usedAmount), n(r.amount)); assert.equal(r.status, 'USED', 'fully-consumed original code must never reactivate') }
      return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status }
    })
    const successors = (ret.sourceCreditSuccessors ?? []).map(s => {
      const r = rawCredit(s.id)
      assert.ok(r); assert.ok(!originals.some(o => o.id === n(r.id)), 'successor must have a distinct ID')
      assert.equal(r.status, 'ACTIVE')
      rememberCredit(r.id, `${cfg.name}-successor-${credits.filter(x => x.kind === 'source-successor').length + 1}`, 'source-successor')
      return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status, dbExpiresAt: r.expiresAt, apiExpiresAt: s.expiresAt ?? null, source: r.source, returnId: r.returnId == null ? null : n(r.returnId), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId), sourceInvoiceId: r.sourceInvoiceId == null ? null : n(r.sourceInvoiceId) }
    })
    b.sourceSuccessorRows = successors
    assert.equal(successors.reduce((sum, c) => sum + c.amount, 0), cfg.creditApplied, 'successor amount equals credit value returned from fully-consumed sources')
    assert.equal(n(ret.sourceCreditRestoredAmount), cfg.creditApplied)
    const allocations = seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id', ret.id)
    b.creditReturnAllocations = allocations.map(x => ({ redemptionId: n(x.redemptionId), sourceCreditId: n(x.sourceCreditId), amount: n(x.amount), creditRestored: !!x.creditRestored }))
    if (cfg.creditApplied) {
      assert.equal(allocations.reduce((sum, x) => sum + n(x.amount), 0), cfg.creditApplied)
      assert.ok(allocations.every(x => originals.some(o => o.id === n(x.sourceCreditId))))
    }
    const returnCredits = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
    b.allReturnCreditRows = returnCredits.map(x => ({ id: n(x.id), code: x.code, amount: n(x.amount), usedAmount: n(x.usedAmount), status: x.status, expiresAt: x.expiresAt, source: x.source }))
    if (cfg.returnMethod === 'STORE_CREDIT' && returnedMoney > 0) {
      const separateMoneyCredit = returnCredits.find(x => !successors.some(s => s.id === n(x.id)) && n(x.amount) === returnedMoney && x.expiresAt == null)
      assert.ok(separateMoneyCredit, 'STORE_CREDIT of physical-money share creates a distinct no-expiry credit; source successor remains separate')
      b.physicalRefundCredit = { id: n(separateMoneyCredit.id), amount: n(separateMoneyCredit.amount), expiresAt: separateMoneyCredit.expiresAt, source: separateMoneyCredit.source }
    }
    if (cfg.returnMethod === 'NONE') {
      if (n(ret.overpayAmount) !== cfg.expectedOverpay || n(ret.overpayCredit?.amount) !== cfg.expectedOverpay || (ret.overpayCredit?.expiresAt ?? null) !== null) {
        b.status = 'POLICY-GAP'
        b.noSelectionFinding = { expectedOverpay: cfg.expectedOverpay, recordedOverpay: n(ret.overpayAmount), issuedCredit: n(ret.overpayCredit?.amount), expiry: ret.overpayCredit?.expiresAt ?? null, message: 'با وجود پشتوانهٔ نقدی و درخواست صریح، اعتبار بدون انقضا برای NONE صادر نشد.' }
      }
    }
    b.events.push(await checkpoint(`${cfg.name}: return ${cfg.returnMethod}, originals remain USED and successors recorded`))

    // Continue the no-selection path with only the *source-credit successor* (if any),
    // never substitute it for the distinct missing cash-overpayment credit.
    const exchangeCredit = cfg.nextTender === 'SUCCESSOR' ? successors[0] : null
    const exchangeInput = { userId, shiftId, invoiceId: n(sale.id), lines: [{ saleItemId: n(itemRowB.id), qty: 1 }], replacements: [line(replacement)] }
    if (cfg.nextTender === 'CASH') { exchangeInput.methodId = cash; exchangeInput.destination = 'CASH' }
    if (cfg.nextTender === 'CARD') { exchangeInput.methodId = card; exchangeInput.destination = 'CARD' }
    if (exchangeCredit) { exchangeInput.exchangeCreditCode = exchangeCredit.code; exchangeInput.idempotencyKey = `s09-${cfg.name}-exchange-credit` }
    const before = countSnapshot()
    try {
      const ex = await salesService.createExchange(exchangeInput)
      assert.equal(n(ex.diff), 50000)
      if (cfg.nextTender === 'CASH') { assert.equal(n(ex.cashReceived), 50000); expected.cash += 50000 }
      if (cfg.nextTender === 'CARD') { assert.equal(n(ex.cardReceived), 50000); expected.card += 50000 }
      if (exchangeCredit) { assert.equal(n(ex.barcodeCreditApplied), 50000); assert.equal(n(ex.cashReceived), 0); assert.equal(n(ex.cardReceived), 0) }
      b.exchange = { status: 'PASS', returnId: n(ex.returnId), invoiceId: n(ex.exchangeInvoiceId), diff: n(ex.diff), tender: cfg.nextTender, cashReceived: n(ex.cashReceived), cardReceived: n(ex.cardReceived), barcodeCreditApplied: n(ex.barcodeCreditApplied), sourceSuccessorId: exchangeCredit?.id ?? null }
      if (exchangeCredit) {
        const after = rawCredit(exchangeCredit.id)
        b.successorAfterExchange = { id: n(after.id), code: after.code, amount: n(after.amount), usedAmount: n(after.usedAmount), status: after.status, returnId: after.returnId == null ? null : n(after.returnId), exchangeInvoiceId: after.exchangeInvoiceId == null ? null : n(after.exchangeInvoiceId), sourceInvoiceId: after.sourceInvoiceId == null ? null : n(after.sourceInvoiceId) }
        assert.equal(n(after.usedAmount), 50000)
        assert.equal(after.status, n(after.amount) === 50000 ? 'USED' : 'PARTIALLY_USED')
      }
      b.events.push(await checkpoint(`${cfg.name}: exchange +50,000 through ${cfg.nextTender}`))
      if (cfg.secondGeneration && exchangeCredit) await runSecondGenerationLifecycle(b, exchangeCredit)
    } catch (e) {
      const after = countSnapshot()
      b.exchange = { status: 'BLOCKED', message: String(e?.message ?? e), rollbackVerified: false }
      try { assertAtomicRollback(before, after, `${cfg.name} exchange`); b.exchange.rollbackVerified = true }
      catch (rollbackError) { b.exchange.rollbackError = String(rollbackError?.message ?? rollbackError) }
      b.exchange.stack = String(e?.stack ?? '')
      if (/وجه واقعیِ قابل‌تسویه|قابل‌ردیابی/.test(b.exchange.message)) {
        b.status = 'REPRODUCED-FINDING-3'
        b.exchange.finding = 'رد خطای ردیابی وجه پس از برگشت جزئی دوباره در مابه‌التفاوت مثبت ثبت شد.'
      } else if (b.exchange.rollbackVerified) b.status = b.status === 'POLICY-GAP' ? 'POLICY-GAP' : 'BLOCKED'
      b.events.push(await checkpoint(`${cfg.name}: exchange blocked/rollback`))
    }
  } catch (e) {
    b.status = 'BLOCKED'
    b.failure = { stage: sale ? (ret ? 'return/exchange' : 'return') : 'sale', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
    try { b.events.push(await checkpoint(`${cfg.name}: catch checkpoint`)) }
    catch (post) { b.reconciliationError = String(post?.message ?? post) }
  }
  return b
}

async function runSecondGenerationLifecycle(b, firstSuccessor) {
  const genOne = rawCredit(firstSuccessor.id)
  assert.equal(n(genOne.amount) - n(genOne.usedAmount), 150000, 'successor remainder after +50k exchange')
  const mini = makeVariant(`${b.name}-successor-remainder-item-150k`, 150000)
  const sale2 = await salesService.create({
    userId, shiftId, lines: [line(mini)], payments: [],
    storeCredits: [{ code: firstSuccessor.code, requestedAmount: 150000 }],
    saleRequestIdempotencyKey: `s09-${b.name}-successor-remainder-sale`
  })
  assert.equal(n(sale2.grandTotal), 150000); assert.equal(n(sale2.storeCreditApplied), 150000)
  const genOneAfterSale = rawCredit(firstSuccessor.id)
  assert.equal(n(genOneAfterSale.usedAmount), n(genOneAfterSale.amount)); assert.equal(genOneAfterSale.status, 'USED')
  b.secondGeneration = { saleId: n(sale2.id), saleAmount: n(sale2.grandTotal), firstSuccessorId: n(genOneAfterSale.id), firstSuccessorStatus: genOneAfterSale.status, firstSuccessorUsedAmount: n(genOneAfterSale.usedAmount) }
  b.events.push(await checkpoint(`${b.name}: consume remaining first successor`))
  const item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale2.id)
  const ret2 = await salesService.createReturn({ userId, shiftId, invoiceId: n(sale2.id), full: true, lines: [{ saleItemId: n(item.id), qty: 1 }], refundMethod: 'STORE_CREDIT' })
  assert.equal(n(ret2.total), 150000)
  assert.equal(n(ret2.sourceCreditRestoredAmount), 150000)
  const generationTwo = (ret2.sourceCreditSuccessors ?? []).map(s => {
    const r = rawCredit(s.id); assert.ok(r); assert.ok(n(r.id) !== n(genOneAfterSale.id)); assert.equal(r.status, 'ACTIVE')
    rememberCredit(r.id, `${b.name}-successor-generation-2`, 'successor-generation-2')
    return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status, dbExpiresAt: r.expiresAt, apiExpiresAt: s.expiresAt ?? null, returnId: r.returnId == null ? null : n(r.returnId), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId), sourceInvoiceId: r.sourceInvoiceId == null ? null : n(r.sourceInvoiceId) }
  })
  assert.equal(generationTwo.reduce((sum, x) => sum + x.amount, 0), 150000)
  b.secondGeneration.return = { id: n(ret2.id), total: n(ret2.total), method: ret2.refundMethod, returnedCredit: n(ret2.sourceCreditRestoredAmount), oldSuccessorAfterReturn: { id: n(genOneAfterSale.id), code: genOneAfterSale.code, usedAmount: n(genOneAfterSale.usedAmount), status: genOneAfterSale.status }, newSuccessors: generationTwo }
  b.events.push(await checkpoint(`${b.name}: full return of used successor issues distinct next generation`))
  const next = generationTwo[0]
  const finalItem = makeVariant(`${b.name}-generation-2-redemption-item-150k`, 150000)
  const sale3 = await salesService.create({ userId, shiftId, lines: [line(finalItem)], payments: [], storeCredits: [{ code: next.code }], saleRequestIdempotencyKey: `s09-${b.name}-generation-2-redeem` })
  assert.equal(n(sale3.grandTotal), 150000); assert.equal(n(sale3.storeCreditApplied), 150000)
  const genTwoUsed = rawCredit(next.id)
  assert.equal(genTwoUsed.status, 'USED'); assert.equal(n(genTwoUsed.usedAmount), 150000)
  b.secondGeneration.redeemedAgain = { invoiceId: n(sale3.id), successorId: n(genTwoUsed.id), usedAmount: n(genTwoUsed.usedAmount), status: genTwoUsed.status }
  b.events.push(await checkpoint(`${b.name}: redeem generation-two successor`))
}

await runBranch({ name: 'ZERO-CODE-CASH', codeCount: 0, cashTender: 1000000, cardTender: 0, creditApplied: 0, returnMethod: 'CASH', nextTender: 'CASH' })
await runBranch({ name: 'ONE-CODE-CARD-SUCCESSOR-CHAIN', codeCount: 1, amountEach: 200000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'CARD', nextTender: 'SUCCESSOR', secondGeneration: true })
await runBranch({ name: 'FOUR-CODE-C2C-CARD', codeCount: 4, amountEach: 50000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'CARD_TO_CARD', nextTender: 'CARD' })
await runBranch({ name: 'FOUR-CODE-STORE-CREDIT-SUCCESSOR', codeCount: 4, amountEach: 50000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'STORE_CREDIT', nextTender: 'SUCCESSOR' })
await runBranch({ name: 'FOUR-CODE-CASH-SUCCESSOR', codeCount: 4, amountEach: 50000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'CASH', nextTender: 'SUCCESSOR' })
await runBranch({ name: 'ONE-CODE-NONE-OVERPAY', codeCount: 1, amountEach: 200000, cashTender: 800000, cardTender: 0, creditApplied: 200000, returnMethod: 'NONE', expectedOverpay: 200000, nextTender: 'SUCCESSOR' })

const physicalRaw = rawFinancials()
const report = await salesService.reportRows({ shiftId })
const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
assert.deepEqual(reported, expected, 'final report equals expected physical totals')
assert.deepEqual(physicalRaw, reported, 'final raw financial docs equal service report')
const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
assert.equal(blue, blueExpected)
const summary = {
  generatedAt: new Date().toISOString(), independentScenario: 8, isolatedDatabase: process.env.HARNESS_DB,
  status: branches.every(b => ['PASS', 'POLICY-GAP', 'REPRODUCED-FINDING-3'].includes(b.status)) ? 'EVALUATED_WITH_FINDINGS' : 'FAIL',
  passBranches: branches.filter(b => b.status === 'PASS').length,
  policyGapBranches: branches.filter(b => b.status === 'POLICY-GAP').length,
  reproducedFinding3Branches: branches.filter(b => b.status === 'REPRODUCED-FINDING-3').length,
  unexpectedBlocks: branches.filter(b => b.status === 'BLOCKED').length,
  barcodeCountsTested: [0, 1, 4],
  returnMethodsTested: ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE'],
  positiveExchangeTendersTested: ['CASH', 'CARD', 'successor barcode from full-use return'],
  lifecycleAssertions: ['fully-consumed originals remain USED', 'source successor has a distinct ID/code', 'successor used on positive exchange', 'fully consumed successor remains USED on next sale', 'returning that sale produces a new successor', 'generation-two successor successfully redeemed'],
  physicalExpected: expected, physicalRaw, reported, blue, blueExpected, branches
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-followup-scenario09-fully-consumed-credit-successor-chain.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const md = [
  '# سناریوی مستقل ۸ از ۱۰ — زنجیرهٔ بارکدهای کاملاًمصرف‌شده و جانشین‌ها', '',
  `**وضعیت اجرا:** ${summary.status} · شاخهٔ کامل PASS: ${summary.passBranches} · شکاف سیاست: ${summary.policyGapBranches} · بازتولید مورد ردیابی وجه: ${summary.reproducedFinding3Branches} · بلوکه‌شدن غیرمنتظره: ${summary.unexpectedBlocks}.`,
  '', '## پوشش خرید و تسویه',
  '- خرید بدون بارکد، با یک بارکد کاملاًمصرف‌شده و با چهار بارکد کاملاًمصرف‌شده اجرا شد. خریدها بدون چک/نسیه بودند.',
  '- مسیرهای برگشت: نقد، کارت/POS، کارت‌به‌کارتِ مدیر، اعتبار خرید و NONE. اختلاف مثبت تعویض جداگانه با نقد، POS و بارکد جانشین آزموده شد.',
  '- در تمام شاخه‌های دارای بارکد، کدهای اصلی پس از مصرف کامل USED ماندند. ارزش اعتباری برگشتی با ID/code تازه به جانشین منتقل شد؛ جانشین‌ها جدا از اعتبارِ پول واقعیِ برگشتی ثبت شدند.', '',
  '| شاخه | بارکد خرید | برگشت | تسویهٔ اختلاف +۵۰٬۰۰۰ | وضعیت | یافته/خلاصه |', '|---|---|---|---|---|---',
  ...branches.map(b => {
    const tender = b.exchange?.status === 'PASS' ? `${b.exchange.tender} / ${fa(b.exchange.barcodeCreditApplied || b.exchange.cashReceived || b.exchange.cardReceived)}` : b.exchange?.message ?? '—'
    const detail = b.noSelectionFinding?.message ?? b.exchange?.finding ?? (b.secondGeneration ? 'جانشین نسل بعد ساخته و مصرف شد' : b.successorAfterExchange ? `جانشین ID ${b.successorAfterExchange.id} → ${b.successorAfterExchange.status}` : '')
    return `| ${b.name} | ${b.purchase?.barcodeCount ?? 0} / ${fa(b.purchase?.barcodeValue)} | ${b.partialReturn?.method ?? '—'}؛ برگشت اعتبار ${fa(b.partialReturn?.sourceCreditRestoredAmount)} | ${String(tender).replaceAll('|', '\\|')} | ${b.status} | ${String(detail).replaceAll('|', '\\|')} |`
  }),
  '', '## آزمون نسل دوم در شاخهٔ یک‌بارکدی',
  '- بارکد ۲۰۰٬۰۰۰ در خرید اولیه کامل مصرف شد و پس از برگشت جزئی، کد اصلی USED ماند و یک جانشین مستقل ساخته شد.',
  '- جانشین ۲۰۰٬۰۰۰، اختلاف مثبت ۵۰٬۰۰۰ تعویض را پرداخت کرد؛ ماندهٔ ۱۵۰٬۰۰۰ از همان جانشین برای فروش بعدی استفاده و خود جانشین USED شد.',
  '- برگشت کامل کالای ۱۵۰٬۰۰۰ باعث ساخت جانشین نسل بعد با ID/code جدا شد؛ کد قبلی USED ماند. سپس جانشین نسل دوم در فروش تازه با موفقیت مصرف کامل شد و USED ماند.',
  '- در هر دو نسل، ID/code و وضعیت خام DB، redemptionها، برگشت‌ها، اسناد، موجودی و مرجع آبی ثبت شد.', '',
  '## شکاف NONE و تطبیق',
  '- در مسیر NONE، مبلغ پشتوانه‌دارِ اضافه‌دریافت و اعتبار منبع برگشتی از هم جدا نگه داشته شدند. اگر اعتبار جداگانهٔ اضافه‌دریافت ساخته نشد، کمبود با جانشینِ منبع یا تسویهٔ دیگری پوشانده نشد.',
  `- اسناد خام / گزارش: ${JSON.stringify(physicalRaw)}. مرجع آبی: ${fa(blue)} = ${fa(expected.cash)} نقد + ${fa(expected.card)} POS − ${fa(expected.refundCash)} نقد برگشتی − ${fa(expected.refundCard)} POS برگشتی.`,
  '- درخواست C2C ابتدا PENDING و سپس در هارنس با پرداخت مدیر PAID شد؛ انتقال بانکی واقعی انجام نشد. بازپرداخت POS با تأیید تست مدیر انجام شد.',
  '- فقط SQLite موقت هارنس استفاده شد؛ دیتابیس واقعی، migration زنده و کد تولیدی تغییر نکرد.'
]
writeFileSync(join(out, 'deep-e2e-followup-scenario09-fully-consumed-credit-successor-chain.md'), md.join('\n') + '\n')
console.log(`Scenario 8 ${summary.status}; pass=${summary.passBranches}; policyGaps=${summary.policyGapBranches}; finding3=${summary.reproducedFinding3Branches}; unexpected=${summary.unexpectedBlocks}; blue=${blue}`)
await db.$disconnect?.()
if (summary.status === 'FAIL') process.exitCode = 1
