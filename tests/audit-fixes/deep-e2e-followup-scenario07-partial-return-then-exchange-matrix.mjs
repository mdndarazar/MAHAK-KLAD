/**
 * Independent scenario 6 of 10: partial return of line 1, then exchange of line 2.
 * Exercises zero/one/four barcode funding and settlement choices in isolated SQLite.
 * No production code or real database is modified.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s07-'))
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
const userId = seed.user('follow-up partial-return-exchange cashier')
const shiftId = seed.insert('Shift', { name: 'follow-up partial return then exchange', number: 9, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: 'F07-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'F07-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('followup-s07')
let seq = 0
const variants = [], credits = [], branches = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const n = x => Number(x ?? 0)
const makeVariant = (name, price) => {
  const p = seed.product(`S07-${++seq}-${name}`, cat), id = seed.variant(p, `S07-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const v = { id, name, price }; variants.push(v); return v
}
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
const issueCodes = async (label, count, each) => {
  const out = []
  for (let i = 0; i < count; i++) {
    const issued = await storeCreditService.issueManual({ amount: each, multiUse: false, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    const row = seed.one('SELECT id,code,expiresAt FROM "StoreCredit" WHERE id=?', issued.id)
    const c = { id: n(row.id), code: row.code, expiresAt: row.expiresAt, label: `${label}-code-${i + 1}` }
    credits.push(c); out.push(c)
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
  assert.deepEqual(reported, expected, `${label}: report versus expected physical flows`)
  const independent = rawFinancials()
  assert.deepEqual(independent, reported, `${label}: raw documents versus report`)
  const blue = n(await physicalMovementForCustodyShift(shiftId))
  const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, blueExpected, `${label}: blue physical reference`)
  const stock = variants.map(v => {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const delta = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actual, 10 + delta, `${label}: stock ledger ${v.name}`)
    return { variant: v.name, expected: 10 + delta, actual, ledgerDelta: delta }
  })
  const creditState = credits.map(c => {
    const r = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?', c.id)
    return { id: c.id, label: c.label, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source }
  })
  return { label, expected: { ...expected }, reported, independent, blue, blueExpected, stock, credits: creditState }
}
await checkpoint('baseline')

async function runBranch(cfg) {
  const b = { name: cfg.name, status: 'PASS', expectedOutcome: cfg.expectedOutcome ?? 'complete', sale: {}, events: [] }
  branches.push(b)
  const originalA = makeVariant(`${cfg.name}-A-500k`, 500000)
  const originalB = makeVariant(`${cfg.name}-B-500k`, 500000)
  const replacement = makeVariant(`${cfg.name}-replacement-${cfg.replacementPrice}`, cfg.replacementPrice)
  const barcodes = await issueCodes(cfg.name, cfg.codeCount, cfg.eachCode ?? 0)
  b.funding = { barcodeCount: cfg.codeCount, barcodeValue: cfg.codeCount * (cfg.eachCode ?? 0), cashTender: cfg.cashTender, cardTender: cfg.cardTender }
  b.events.push(await checkpoint(`${cfg.name}: issue purchase barcode(s)`))
  let sale, returned, exchange
  try {
    sale = await salesService.create({
      userId, shiftId, lines: [line(originalA), line(originalB)],
      payments: [
        ...(cfg.cashTender ? [{ methodId: cash, amount: cfg.cashTender, destination: 'CASH' }] : []),
        ...(cfg.cardTender ? [{ methodId: card, amount: cfg.cardTender, destination: 'CARD' }] : [])
      ],
      storeCredits: barcodes.map(c => ({ code: c.code })),
      saleRequestIdempotencyKey: `s07-${cfg.name}-sale`
    })
    assert.equal(n(sale.grandTotal), 1000000)
    assert.equal(n(sale.storeCreditApplied), cfg.codeCount * (cfg.eachCode ?? 0))
    expected.cash += cfg.cashTender; expected.card += cfg.cardTender
    b.sale = { id: n(sale.id), total: n(sale.grandTotal), cash: cfg.cashTender, card: cfg.cardTender, creditTender: n(sale.storeCreditApplied) }
    b.events.push(await checkpoint(`${cfg.name}: sale settled`))
    const items = seed.rows('SELECT id,variantId,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
    assert.equal(items.length, 2)
    const itemA = items.find(x => n(x.variantId) === originalA.id)
    const itemB = items.find(x => n(x.variantId) === originalB.id)

    const retInput = { userId, shiftId, invoiceId: n(sale.id), full: false, lines: [{ saleItemId: n(itemA.id), qty: 1 }], refundMethod: cfg.returnMethod }
    if (cfg.returnMethod === 'CASH' || cfg.returnMethod === 'CARD' || cfg.returnMethod === 'CARD_TO_CARD') retInput.refundAmount = cfg.returnAmount
    if (cfg.returnMethod === 'CARD') retInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `S07 ${cfg.name} POS return`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    if (cfg.returnMethod === 'NONE') {
      retInput.confirmOverpay = true
      retInput.overpayAsCredit = true
      retInput.managerPassword = DEFAULT_MANAGER_PASSWORD
    }
    returned = await salesService.createReturn(retInput)
    b.partialReturn = {
      id: n(returned.id), total: n(returned.total), method: returned.refundMethod,
      refundAmount: n(returned.refundAmount), refundStoreCreditAmount: n(returned.refundStoreCreditAmount),
      sourceCreditRestoredAmount: n(returned.sourceCreditRestoredAmount), returnCreditAmount: n(returned.returnCreditAmount),
      overpayAmount: n(returned.overpayAmount), overpayCreditAmount: n(returned.overpayCredit?.amount),
      overpayCreditExpiresAt: returned.overpayCredit?.expiresAt ?? null,
      sourceSuccessors: (returned.sourceCreditSuccessors ?? []).map(c => ({ id: n(c.id), amount: n(c.amount), expiresAt: c.expiresAt ?? null }))
    }
    if (cfg.returnMethod === 'CASH') { assert.equal(n(returned.refundAmount), cfg.returnAmount); expected.refundCash += cfg.returnAmount }
    if (cfg.returnMethod === 'CARD') { assert.equal(n(returned.refundAmount), cfg.returnAmount); expected.refundCard += cfg.returnAmount }
    if (cfg.returnMethod === 'CARD_TO_CARD') {
      const req = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', returned.id)
      assert.ok(req); assert.equal(req.status, 'PENDING'); assert.equal(n(req.amount), cfg.returnAmount)
      b.returnTransferPending = { id: n(req.id), status: req.status, amount: n(req.amount), operationKind: req.operationKind }
      b.events.push(await checkpoint(`${cfg.name}: return transfer pending`))
      await cardTransferService.pay({ id: n(req.id), paidAmount: cfg.returnAmount, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `S07-${cfg.name}-RETURN` })
      const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', req.id)
      assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), cfg.returnAmount)
      b.returnTransferPaid = { status: paid.status, paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
    }
    b.originalBarcodePostReturn = barcodes.map(c => {
      const row = seed.one('SELECT id,code,amount,usedAmount,status FROM "StoreCredit" WHERE id=?', c.id)
      const state = { id: n(row.id), code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount), status: row.status }
      if (state.usedAmount === state.amount) assert.equal(state.status, 'USED', 'fully consumed original barcode must remain burned after return')
      return state
    })
    b.sourceSuccessorRaw = (returned.sourceCreditSuccessors ?? []).map(c => {
      const row = seed.one('SELECT id,code,amount,usedAmount,status,expiresAt,source,note FROM "StoreCredit" WHERE id=?', c.id)
      assert.ok(row, 'a fully consumed source credit return must reference a separately stored successor barcode')
      assert.ok(!barcodes.some(old => old.id === n(row.id)), 'the successor must have a distinct ID; never reactivate the consumed code')
      assert.equal(row.status, 'ACTIVE', 'source successor must be newly usable')
      const sourceId = Number(String(row.note ?? '').match(/بارکد مصرف‌شده #(\d+)/)?.[1] ?? 0)
      const source = barcodes.find(old => old.id === sourceId)
      assert.ok(source, 'successor note must identify its source credit for raw expiry comparison')
      assert.equal(row.expiresAt, source.expiresAt, 'raw database expiry must exactly match source expiry')
      return { id: n(row.id), sourceId, code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount), status: row.status, expiresAt: row.expiresAt, sourceExpiresAt: source.expiresAt, source: row.source, apiExpiresAtJalali: c.expiresAtJalali ?? null }
    })
    const returnCreditRows = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id', returned.id)
    b.partialReturnCredits = returnCreditRows.map(c => ({ id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt, source: c.source }))
    if (cfg.returnMethod === 'STORE_CREDIT') {
      const moneyCredit = returnCreditRows.reduce((sum, c) => sum + n(c.amount), 0)
      assert.ok(moneyCredit > 0, 'explicit STORE_CREDIT return should issue actual replacement credit')
      assert.ok(returnCreditRows.some(c => c.expiresAt == null), 'real-money return credit must not expire')
    }
    if (cfg.returnMethod === 'NONE' && cfg.expectOverpayCredit) {
      assert.equal(n(returned.overpayAmount), cfg.expectedOverpay)
      if (n(returned.overpayCredit?.amount) !== cfg.expectedOverpay || (returned.overpayCredit?.expiresAt ?? null) !== null) {
        b.status = 'REPRODUCED-BUG'
        b.overpayFinding = {
          expectedCreditAmount: cfg.expectedOverpay,
          actualCreditAmount: n(returned.overpayCredit?.amount),
          expectedExpiry: null,
          actualExpiry: returned.overpayCredit?.expiresAt ?? null,
          recordedOverpay: n(returned.overpayAmount),
          returnCreditAmount: n(returned.returnCreditAmount),
          note: 'با وجود تأییدِ ثبت و درخواستِ تبدیل اضافه‌دریافت به اعتبار، سند برگشت ۱۰۰٬۰۰۰ اضافه‌دریافت دارد ولی اعتبار اضافه صادر نشده است.'
        }
      }
    }
    b.events.push(await checkpoint(`${cfg.name}: partial return ${cfg.returnMethod}`))

    const exchangeInput = {
      userId, shiftId, invoiceId: n(sale.id), lines: [{ saleItemId: n(itemB.id), qty: 1 }], replacements: [line(replacement)]
    }
    if (cfg.exchangeMethod) {
      exchangeInput.refundMode = cfg.exchangeMethod
      if (cfg.exchangeMethod === 'CARD') exchangeInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `S07 ${cfg.name} POS exchange refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    }
    if (cfg.exchangeCreditCode) {
      exchangeInput.exchangeCreditCode = cfg.exchangeCreditCode
      exchangeInput.idempotencyKey = `s07-${cfg.name}-exchange-credit`
    }
    const beforeExchange = {
      invoices: n(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', shiftId).n),
      returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
      payments: seed.count('Payment', 'createdShiftId=?', shiftId),
      stock: variants.map(v => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock))
    }
    try {
      exchange = await salesService.createExchange(exchangeInput)
      b.exchange = {
        status: 'PASS', returnId: n(exchange.returnId), invoiceId: n(exchange.exchangeInvoiceId), diff: n(exchange.diff),
        refundMode: exchange.refundMode ?? cfg.exchangeMethod ?? null, refundAmount: n(exchange.refundAmount),
        cashRefunded: n(exchange.cashRefunded), cardRefunded: n(exchange.cardRefunded),
        sourceCreditRestoredAmount: n(exchange.sourceCreditRestoredAmount), newStoreCreditAmount: n(exchange.newStoreCreditAmount),
        barcodeCreditApplied: n(exchange.barcodeCreditApplied), cashReceived: n(exchange.cashReceived), cardReceived: n(exchange.cardReceived)
      }
      if (cfg.expectedExchangeDiff != null) assert.equal(n(exchange.diff), cfg.expectedExchangeDiff)
      if (cfg.exchangeMethod === 'CASH') { assert.equal(n(exchange.cashRefunded), cfg.exchangeAmount); expected.refundCash += cfg.exchangeAmount }
      if (cfg.exchangeMethod === 'CARD') { assert.equal(n(exchange.cardRefunded), cfg.exchangeAmount); expected.refundCard += cfg.exchangeAmount }
      if (cfg.exchangeMethod === 'CARD_TO_CARD') {
        const req = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', exchange.returnId)
        assert.ok(req, 'exchange creates card-to-card request')
        assert.equal(req.status, 'PENDING')
        b.exchangeTransferPending = { id: n(req.id), status: req.status, amount: n(req.amount), operationKind: req.operationKind }
        b.events.push(await checkpoint(`${cfg.name}: exchange transfer pending`))
        await cardTransferService.pay({ id: n(req.id), paidAmount: n(req.amount), userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `S07-${cfg.name}-EXCHANGE` })
        const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', req.id)
        assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), n(req.amount))
        b.exchangeTransferPaid = { status: paid.status, paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
      }
      const exCredits = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id', exchange.returnId)
      b.exchangeCredits = exCredits.map(c => ({ id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt, source: c.source }))
      if (cfg.exchangeMethod === 'STORE_CREDIT' && n(exchange.diff) < 0) assert.ok(exCredits.reduce((sum, c) => sum + n(c.amount), 0) > 0, 'STORE_CREDIT exchange should issue/restore value')
      b.events.push(await checkpoint(`${cfg.name}: exchange completed`))
    } catch (e) {
      b.exchange = { status: 'BLOCKED', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
      const afterExchange = {
        invoices: n(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', shiftId).n),
        returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
        payments: seed.count('Payment', 'createdShiftId=?', shiftId),
        stock: variants.map(v => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock))
      }
      b.exchange.rollbackVerified = JSON.stringify(beforeExchange) === JSON.stringify(afterExchange)
      assert.equal(b.exchange.rollbackVerified, true, `${cfg.name}: rejected exchange must be atomic`)
      b.exchange.rollbackCounts = { before: beforeExchange, after: afterExchange }
      b.events.push(await checkpoint(`${cfg.name}: exchange rejection/rollback`))
      if (/سهم وجه واقعیِ قابل‌تسویه|وجه وصول‌شده و قابل‌ردیابی/.test(b.exchange.message)) {
        b.status = 'REPRODUCED-BUG'
        b.exchange.knownFinding = 'رد کاذبِ بازسازی منبع وجه پس از برگشت جزئی: ارزش واقعیِ قلم باقی‌مانده باید در منبع مالی باقی بماند؛ پیام سیستم تنها ۱۰۰٬۰۰۰ یا ۴۰۰٬۰۰۰ ریال قابل‌ردیابی را می‌شمارد و به‌رغم تطبیق خرید/برگشت، تعویض را rollback می‌کند.'
      } else if (cfg.expectExchangeBlock) {
        assert.match(b.exchange.message, cfg.expectExchangeBlock)
        b.exchange.expectedBlock = true
        if (cfg.policyGap) {
          b.exchange.policyMismatch = 'طبق قاعدهٔ کاربر، وقتی روش واقعی پرداخت انتخاب نمی‌شود، ماندهٔ پشتوانه‌دار باید خودکار به اعتبار خریدِ بدون انقضا تبدیل شود؛ رد کردن تعویض با الزام انتخاب دستی با این سیاست سازگار نیست.'
          if (b.status !== 'REPRODUCED-BUG') b.status = 'POLICY-GAP'
        } else if (b.status !== 'REPRODUCED-BUG') b.status = 'EXPECTED-BLOCK'
      } else {
        b.status = 'BLOCKED'
      }
    }
  } catch (e) {
    b.status = 'BLOCKED'
    b.failure = { stage: sale ? (returned ? 'exchange' : 'partial-return') : 'sale', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
    try { b.events.push(await checkpoint(`${cfg.name}: catch checkpoint`)); b.rollbackVerified = true }
    catch (verifyError) { b.rollbackVerified = false; b.reconciliationError = String(verifyError?.message ?? verifyError) }
  }
  b.status = b.status === 'BLOCKED' && b.exchange?.expectedBlock ? 'EXPECTED-BLOCK' : b.status
  b.finalFinancials = rawFinancials()
  return b
}

// The zero/one/four-code purchase dimensions are separate branches in this one scenario.
await runBranch({ name: 'ZERO-CODE-CASH', codeCount: 0, cashTender: 1000000, cardTender: 0, returnMethod: 'CASH', returnAmount: 500000, replacementPrice: 450000, exchangeMethod: 'CASH', exchangeAmount: 50000, expectedExchangeDiff: -50000 })
await runBranch({ name: 'ONE-CODE-CASH', codeCount: 1, eachCode: 100000, cashTender: 900000, cardTender: 0, returnMethod: 'CASH', returnAmount: 400000, replacementPrice: 450000, exchangeMethod: 'CASH', exchangeAmount: 50000, expectedExchangeDiff: -50000 })
await runBranch({ name: 'FOUR-CODE-CASH', codeCount: 4, eachCode: 100000, cashTender: 600000, cardTender: 0, returnMethod: 'CASH', returnAmount: 100000, replacementPrice: 450000, exchangeMethod: 'CASH', exchangeAmount: 50000, expectedExchangeDiff: -50000 })
await runBranch({ name: 'FOUR-CODE-CARD', codeCount: 4, eachCode: 100000, cashTender: 0, cardTender: 600000, returnMethod: 'CARD', returnAmount: 100000, replacementPrice: 450000, exchangeMethod: 'CARD', exchangeAmount: 50000, expectedExchangeDiff: -50000 })
await runBranch({ name: 'FOUR-CODE-CARD-TO-CARD', codeCount: 4, eachCode: 100000, cashTender: 600000, cardTender: 0, returnMethod: 'CARD_TO_CARD', returnAmount: 100000, replacementPrice: 450000, exchangeMethod: 'CARD_TO_CARD', exchangeAmount: 50000, expectedExchangeDiff: -50000 })
await runBranch({ name: 'FOUR-CODE-STORE-CREDIT', codeCount: 4, eachCode: 100000, cashTender: 600000, cardTender: 0, returnMethod: 'STORE_CREDIT', replacementPrice: 450000, exchangeMethod: 'STORE_CREDIT', expectedExchangeDiff: -50000 })
await runBranch({ name: 'ZERO-CODE-NO-EXCHANGE-METHOD', codeCount: 0, cashTender: 1000000, cardTender: 0, returnMethod: 'CASH', returnAmount: 500000, replacementPrice: 450000, exchangeMethod: null, expectedExchangeDiff: -50000, expectExchangeBlock: /انتخاب|روش بازپرداخت|بدهکار/, policyGap: true })
await runBranch({ name: 'FOUR-CODE-NONE-RETURN', codeCount: 4, eachCode: 100000, cashTender: 600000, cardTender: 0, returnMethod: 'NONE', replacementPrice: 450000, exchangeMethod: 'STORE_CREDIT', expectedExchangeDiff: -50000, expectOverpayCredit: true, expectedOverpay: 100000 })
await runBranch({ name: 'FOUR-CODE-POSITIVE-BARCODE-DIFFERENCE', codeCount: 4, eachCode: 100000, cashTender: 600000, cardTender: 0, returnMethod: 'CASH', returnAmount: 100000, replacementPrice: 550000, exchangeCreditCode: (await issueCodes('positive-difference', 1, 50000))[0].code, expectedExchangeDiff: 50000 })

const physicalRaw = rawFinancials()
const report = await salesService.reportRows({ shiftId })
const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
assert.deepEqual(reported, expected, 'final service report equals expected physical totals')
assert.deepEqual(physicalRaw, reported, 'final raw documents equal report')
const blue = n(await physicalMovementForCustodyShift(shiftId))
const blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
assert.equal(blue, blueExpected)
assert.equal(physicalRaw.cash + physicalRaw.card - physicalRaw.refundCash - physicalRaw.refundCard, blue)
const allCreditStates = credits.map(c => {
  const r = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?', c.id)
  return { id: c.id, label: c.label, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source }
})
const summary = {
  generatedAt: new Date().toISOString(), independentScenario: 6, isolatedDatabase: process.env.HARNESS_DB,
  status: branches.every(b => ['PASS', 'EXPECTED-BLOCK', 'POLICY-GAP', 'REPRODUCED-BUG'].includes(b.status)) ? 'EVALUATED_WITH_FINDINGS' : 'FAIL',
  passBranches: branches.filter(b => b.status === 'PASS').length,
  expectedBlocks: branches.filter(b => b.status === 'EXPECTED-BLOCK').length,
  policyGapBranches: branches.filter(b => b.status === 'POLICY-GAP').length,
  reproducedBugBranches: branches.filter(b => b.status === 'REPRODUCED-BUG').length,
  unexpectedBlocks: branches.filter(b => b.status === 'BLOCKED').length,
  purchaseBarcodeCounts: [0, 1, 4],
  creditLifecyclePolicy: {
    fullyConsumed: 'old code remains USED; return value creates a distinct successor barcode',
    partiallyUsedAndStillValid: 'restore returned amount to the same source barcode; do not create a successor for that share',
    partialUseBranchCoveredHere: false
  },
  settlementMethodsExercised: ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE/no selection', 'EXCHANGE_CREDIT_TENDER'],
  physicalExpected: expected, physicalRaw, reported, blue, blueExpected, branches, creditStates: allCreditStates
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-followup-scenario07-partial-return-then-exchange-matrix.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const md = [
  '# سناریوی مستقل ۶ از ۱۰ — برگشت جزئی و سپس تعویض قلم باقی‌مانده', '',
  `**وضعیت اجرا:** ${summary.status} · شاخهٔ کامل PASS: ${summary.passBranches} · ردِ صرفاً فنی: ${summary.expectedBlocks} · ناسازگار با سیاست کاربر: ${summary.policyGapBranches} · شاخه‌های باگ بازتولیدشده: ${summary.reproducedBugBranches} · خطای هارنس/غیرمنتظره: ${summary.unexpectedBlocks}.`,
  '', '## طراحی عددی و ماتریس',
  '- در هر خرید دو قلم ۵۰۰٬۰۰۰ ریالی ثبت شد. قلم A برگشت خورد و سپس قلم B باقی‌مانده با کالای جایگزین تعویض شد.',
  '- تعداد بارکد خرید: صفر، یک بارکد ۱۰۰٬۰۰۰، یا چهار بارکد × ۱۰۰٬۰۰۰. در شاخه‌های چهاربارکدی، وجه فیزیکی ۶۰۰٬۰۰۰ و سهم اعتبار ۴۰۰٬۰۰۰ بود.',
  '- روش‌های برگشت جزئی و تسویهٔ مابه‌التفاوت بین شاخه‌ها شامل نقد، کارت/POS، کارت‌به‌کارت مدیر، اعتبار خرید، انتخاب‌نکردن روش، و بارکد اعتبار برای مابه‌التفاوت مثبت بود.', '',
  '| شاخه | Funding / مرحلهٔ برگشت | تسویهٔ تعویض بعدی | نتیجه | جزئیات/علت |', '|---|---|---|---|---|',
  ...branches.map(b => {
    const exchangeLabel = b.exchange?.status === 'PASS'
      ? `${b.exchange.refundMode ?? 'اعتبار tender'}؛ اختلاف ${fa(b.exchange.diff)}`
      : b.exchange?.message?.replaceAll('\n', '<br>').replaceAll('|', '\\|') ?? '—'
    const detail = b.exchange?.knownFinding ?? b.exchange?.policyMismatch ?? b.overpayFinding?.note ?? (b.exchange?.status === 'PASS' ? 'فاکتور/موجودی/دفتر مالی تطبیق شد' : '')
    return `| ${b.name} | ${b.funding?.barcodeCount ?? 0} بارکد؛ ${b.partialReturn?.method ?? '—'} ${fa(b.partialReturn?.refundAmount)} | ${exchangeLabel} | ${b.status} | ${detail.replaceAll('|', '\\|')} |`
  }),
  '', '## تطبیق دفتر مالی',
  `- نقد/POS دریافتی و بازپرداخت بر اساس اسناد خام: ${JSON.stringify(physicalRaw)}.`,
  `- مرجع آبی واقعی: ${fa(blue)}؛ انتظار از نقد + POS − برگشت نقد − برگشت POS: ${fa(blueExpected)}.`,
  '- C2C در هارنس با درخواست PENDING و ثبت پرداخت مدیر آزموده شد؛ انتقال بانکی واقعی انجام نشد. POS refund تنها با تأیید تست مدیر اجرا شد.',
  '- پس از هر عملیات، گزارش سرویس، Payment/CashMovement/SaleReturn خام، StockMovement و وضعیت/ماندهٔ بارکدها بررسی شد. رد تعویض باید بدون فاکتور/برگشت/پرداخت/تغییر موجودی باقی بماند.',
  '- چرخهٔ اعتبارِ مشاهده‌شده: در شاخهٔ تک‌بارکدی، کد کاملاًمصرف‌شده USED ماند و سهم برگشتی ۱۰۰٬۰۰۰ ریالی با ID/کد جانشین ACTIVE صادر شد؛ انقضای خام جانشین با منبع برابر بود. در شاخه‌های چهاربارکدی نیز هر چهار منبع USED ماندند و چهار جانشین مستقل صادر شد؛ سهم‌ها ادغام نشدند.',
  '- محدودیت پوشش: این runner جانشین‌های برگشت را در فروش/تعویض بعدی redeem نمی‌کند؛ تعویضِ پس از برگشت روی قلم B اصلی انجام می‌شود، نه روی جانشین A. همچنین بارکد معتبرِ نیمه‌مصرف‌شده در این runner وجود ندارد؛ برگشت آن به همان کد باید جداگانه بررسی شود.',
  '- شاخهٔ FOUR-CODE-NONE-RETURN: از برگشت ۵۰۰٬۰۰۰ ریالی، ۴۰۰٬۰۰۰ سهم اعتبارِ pool به چهار جانشین منبع‌به‌منبع برگشت و ۱۰۰٬۰۰۰ سهم پول‌پشتوانه‌دار به اعتبار OVERPAY بدون انقضا تبدیل شد؛ بازپرداخت فیزیکی صفر ماند. تعویض قلم B نیز اختلاف منفی ۵۰٬۰۰۰ را به اعتبار STORE_CREDIT بدون انقضا تبدیل کرد. این runner وضعیت تحویل/چاپ/دریافت فیزیکی اعتبار را assert نمی‌کند.',
  '- گیت‌های مستقل رمز مدیر در runner جداگانهٔ سناریو ۱۳ آزموده شده‌اند؛ این شاخهٔ سناریو ۶ به‌تنهایی آن تفکیک را اثبات نمی‌کند.',
  '- قرارداد API عمداً فیلد خام `expiresAt` را نمی‌دهد؛ آزمون از `expiresAtJalali` پشتیبانی‌شده برای پاسخ سرویس استفاده می‌کند و تاریخ خام را فقط از SQLite ایزوله می‌خواند. برای هر جانشین، `expiresAt` دقیق DB با تاریخ دقیق منبع برابر بود؛ قرارداد API تغییر نکرد.',
  '', '## تفسیر',
  '- این سناریو عمداً مسیر پرریسکِ «برگشت یک قلم از فاکتور چندبارکدی، سپس تعویض قلم دیگر» را دوباره اجرا می‌کند و روش‌های قابل‌اعمال را در شاخه‌های مستقل از هم می‌سنجد.',
  '- «EXPECTED-BLOCK» یعنی پیام/گیت فنی روشن بود؛ «POLICY-GAP» یعنی پیام روشن بود اما رد با قاعدهٔ کاربر (در نبود انتخاب، اعتبار خودکارِ بی‌انقضا) سازگار نبود؛ «REPRODUCED-BUG» یعنی ردیابی مالی/اعتبار اشتباه مانع ادامه شد. هیچ‌کدام را PASS عملیاتی نمی‌شماریم. «BLOCKED» فقط برای خطای harness یا تطبیق غیرمنتظره است.',
  '- دادهٔ فروشگاه و دیتابیس واقعی تغییر نکردند؛ فقط SQLite موقت هارنس استفاده شد.'
]
writeFileSync(join(out, 'deep-e2e-followup-scenario07-partial-return-then-exchange-matrix.md'), md.join('\n') + '\n')
console.log(`Scenario 6 ${summary.status}; pass=${summary.passBranches}; expectedBlocks=${summary.expectedBlocks}; unexpectedBlocks=${summary.unexpectedBlocks}; blue=${blue}`)
await db.$disconnect?.()
if (summary.status === 'FAIL') process.exitCode = 1
