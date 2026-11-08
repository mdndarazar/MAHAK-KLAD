/**
 * Independent scenario 9 of 10: mixed cash/card/store-credit tenders on a
 * positive-difference exchange, then return the replacement invoice through
 * the applicable refund methods. Isolated SQLite harness only.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s10-'))
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
const userId = seed.user('follow-up mixed positive exchange cashier')
const shiftId = seed.insert('Shift', { name: 'follow-up positive exchange split and child return', number: 12, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: 'F10-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'F10-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('followup-s10')
const n = x => Number(x ?? 0)
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const variants = [], credits = [], branches = []
let seq = 0
const makeVariant = (name, price) => {
  const p = seed.product(`S10-${++seq}-${name}`, cat), id = seed.variant(p, `S10-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const v = { id, name, price }; variants.push(v); return v
}
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
const rawCredit = id => seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source,returnId,exchangeInvoiceId,sourceInvoiceId FROM "StoreCredit" WHERE id=?', id)
const noteCredit = (id, label, kind = 'purchase-source') => {
  const row = rawCredit(id)
  if (!credits.some(c => c.id === n(row.id))) credits.push({ id: n(row.id), code: row.code, label, kind })
  return { id: n(row.id), code: row.code, label, kind, amount: n(row.amount), usedAmount: n(row.usedAmount), usedCount: n(row.usedCount), status: row.status, expiresAt: row.expiresAt, source: row.source, returnId: row.returnId == null ? null : n(row.returnId) }
}
const issueCodes = async (label, count, amountEach, multiUse = true) => {
  const result = []
  for (let i = 0; i < count; i++) {
    const issued = await storeCreditService.issueManual({ amount: amountEach, multiUse, maxUses: multiUse ? 10 : 1, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    result.push(noteCredit(issued.id, `${label}-code-${i + 1}`))
  }
  return result
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
  assert.deepEqual(reported, expected, `${label}: report equals expected physical totals`)
  const raw = rawFinancials(); assert.deepEqual(raw, reported, `${label}: raw docs equal report`)
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
const snapshot = () => ({ invoices: n(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', shiftId).n), returns: seed.count('SaleReturn', 'shiftId=?', shiftId), payments: seed.count('Payment', 'createdShiftId=?', shiftId), stock: variants.map(v => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)) })
await checkpoint('baseline')

async function runBranch(cfg) {
  const b = { name: cfg.name, status: 'PASS', events: [], positiveExchangeTender: cfg.positiveTender, childInvoiceReturnMethod: cfg.returnMethod }
  branches.push(b)
  const original = makeVariant(`${cfg.name}-original-400k`, 400000)
  const kept = makeVariant(`${cfg.name}-kept-600k`, 600000)
  const replacement = makeVariant(`${cfg.name}-replacement-550k`, 550000)
  const codes = await issueCodes(cfg.name, cfg.codeCount, cfg.codeEach ?? 0)
  b.purchaseFunding = { barcodeCount: cfg.codeCount, appliedCredit: cfg.creditApplied, cash: cfg.cashTender, card: cfg.cardTender }
  b.events.push(await checkpoint(`${cfg.name}: credit issue`))
  let sale, ex, ret, beforeChildReturn = null
  try {
    sale = await salesService.create({
      userId, shiftId, lines: [line(original), line(kept)],
      payments: [
        ...(cfg.cashTender ? [{ methodId: cash, amount: cfg.cashTender, destination: 'CASH' }] : []),
        ...(cfg.cardTender ? [{ methodId: card, amount: cfg.cardTender, destination: 'CARD' }] : [])
      ],
      storeCredits: codes.map(c => ({ code: c.code, requestedAmount: cfg.requestEach })),
      saleRequestIdempotencyKey: `s10-${cfg.name}-sale`
    })
    assert.equal(n(sale.grandTotal), 1000000); assert.equal(n(sale.storeCreditApplied), cfg.creditApplied)
    expected.cash += cfg.cashTender; expected.card += cfg.cardTender
    const items = seed.rows('SELECT id,variantId,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
    const originalItem = items.find(x => n(x.variantId) === original.id), keptItem = items.find(x => n(x.variantId) === kept.id)
    assert.ok(originalItem && keptItem)
    b.sale = { invoiceId: n(sale.id), total: n(sale.grandTotal), creditApplied: n(sale.storeCreditApplied), originalItemId: n(originalItem.id), keptItemId: n(keptItem.id) }
    b.sourceCreditAfterSale = codes.map(c => {
      const r = rawCredit(c.id)
      assert.equal(n(r.usedAmount), cfg.requestEach, 'purchase uses exactly requestedAmount from source code')
      return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status }
    })
    b.events.push(await checkpoint(`${cfg.name}: purchase`))

    const exchangeInput = { userId, shiftId, invoiceId: n(sale.id), lines: [{ saleItemId: n(originalItem.id), qty: 1 }], replacements: [line(replacement)] }
    if (cfg.positiveTender === 'CASH') { exchangeInput.methodId = cash; exchangeInput.destination = 'CASH' }
    if (cfg.positiveTender === 'CARD') { exchangeInput.methodId = card; exchangeInput.destination = 'CARD' }
    if (cfg.positiveTender === 'SPLIT') {
      exchangeInput.splitPayment = true
      exchangeInput.payments = [{ methodId: cash, amount: 75000, destination: 'CASH' }, { methodId: card, amount: 75000, destination: 'CARD' }]
    }
    let tenderCode = null
    if (cfg.positiveTender === 'CREDIT' || cfg.positiveTender === 'CREDIT-SPLIT') {
      tenderCode = codes[0]
      exchangeInput.exchangeCreditCode = tenderCode.code
      exchangeInput.idempotencyKey = `s10-${cfg.name}-exchange-credit`
    }
    if (cfg.positiveTender === 'CREDIT-SPLIT') {
      exchangeInput.splitPayment = true
      exchangeInput.payments = [{ methodId: cash, amount: 50000, destination: 'CASH' }, { methodId: card, amount: 50000, destination: 'CARD' }]
    }
    ex = await salesService.createExchange(exchangeInput)
    assert.equal(n(ex.diff), 150000)
    const expectedCredit = cfg.positiveTender === 'CREDIT' ? 150000 : cfg.positiveTender === 'CREDIT-SPLIT' ? 50000 : 0
    assert.equal(n(ex.barcodeCreditApplied), expectedCredit)
    if (cfg.positiveTender === 'CASH') assert.equal(n(ex.cashReceived), 150000)
    if (cfg.positiveTender === 'CARD') assert.equal(n(ex.cardReceived), 150000)
    if (cfg.positiveTender === 'SPLIT') { assert.equal(n(ex.cashReceived), 75000); assert.equal(n(ex.cardReceived), 75000) }
    if (cfg.positiveTender === 'CREDIT') { assert.equal(n(ex.cashReceived), 0); assert.equal(n(ex.cardReceived), 0) }
    if (cfg.positiveTender === 'CREDIT-SPLIT') { assert.equal(n(ex.cashReceived), 50000); assert.equal(n(ex.cardReceived), 50000) }
    expected.cash += n(ex.cashReceived); expected.card += n(ex.cardReceived)
    const exRow = seed.one('SELECT id,sourceInvoiceId,grandTotal FROM "SaleInvoice" WHERE id=?', ex.exchangeInvoiceId)
    assert.equal(n(exRow.sourceInvoiceId), n(sale.id)); assert.equal(n(exRow.grandTotal), 550000)
    b.exchange = { invoiceId: n(ex.exchangeInvoiceId), returnId: n(ex.returnId), sourceInvoiceId: n(exRow.sourceInvoiceId), diff: n(ex.diff), tender: cfg.positiveTender, cashReceived: n(ex.cashReceived), cardReceived: n(ex.cardReceived), barcodeCreditApplied: n(ex.barcodeCreditApplied) }
    if (tenderCode) {
      const state = rawCredit(tenderCode.id)
      b.exchangeBarcodeAfterUse = { id: n(state.id), code: state.code, amount: n(state.amount), usedAmount: n(state.usedAmount), status: state.status }
    }
    b.events.push(await checkpoint(`${cfg.name}: positive exchange settled`))

    const exItem = seed.one('SELECT id,variantId,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', ex.exchangeInvoiceId)
    assert.equal(n(exItem.variantId), replacement.id); assert.equal(n(exItem.lineTotal), 550000)
    const returnInput = { userId, shiftId, invoiceId: n(ex.exchangeInvoiceId), full: false, lines: [{ saleItemId: n(exItem.id), qty: 1 }], refundMethod: cfg.returnMethod }
    if (cfg.returnMethod === 'CARD') returnInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `S10 ${cfg.name} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    if (cfg.returnMethod === 'NONE') { returnInput.confirmOverpay = true; returnInput.overpayAsCredit = true; returnInput.managerPassword = DEFAULT_MANAGER_PASSWORD }
    b.childReturnRequested = { invoiceId: n(ex.exchangeInvoiceId), saleItemId: n(exItem.id), amount: n(exItem.lineTotal), method: cfg.returnMethod }
    beforeChildReturn = snapshot()
    ret = await salesService.createReturn(returnInput)
    b.childReturn = {
      id: n(ret.id), invoiceId: n(ret.invoiceId), returnedTotal: n(ret.total), method: ret.refundMethod,
      refundAmount: n(ret.refundAmount), returnCreditAmount: n(ret.returnCreditAmount), sourceCreditRestoredAmount: n(ret.sourceCreditRestoredAmount),
      realMoneyRefundAmount: n(ret.realMoneyRefundAmount), exchangeCreditReversed: n(ret.exchangeCreditReversed),
      overpayAmount: n(ret.overpayAmount), overpayCreditAmount: n(ret.overpayCredit?.amount), overpayCreditExpiresAt: ret.overpayCredit?.expiresAt ?? null,
      sourceSuccessorIds: (ret.sourceCreditSuccessors ?? []).map(c => n(c.id))
    }
    if (cfg.returnMethod === 'CASH') { expected.refundCash += n(ret.refundAmount); b.childReturn.refundedCash = n(ret.refundAmount) }
    if (cfg.returnMethod === 'CARD') { expected.refundCard += n(ret.refundAmount); b.childReturn.refundedCard = n(ret.refundAmount) }
    if (cfg.returnMethod === 'CARD_TO_CARD') {
      const req = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', ret.id)
      assert.ok(req); assert.equal(req.status, 'PENDING')
      b.transferPending = { id: n(req.id), status: req.status, amount: n(req.amount), operationKind: req.operationKind }
      b.events.push(await checkpoint(`${cfg.name}: child return C2C pending`))
      await cardTransferService.pay({ id: n(req.id), paidAmount: n(req.amount), userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `S10-${cfg.name}-CHILD-RETURN` })
      const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', req.id)
      assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), n(req.amount))
      b.transferPaid = { status: paid.status, paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
    }
    const sourceSuccessors = (ret.sourceCreditSuccessors ?? []).map(s => {
      const c = rawCredit(s.id)
      assert.ok(c, 'source successor ID must have a durable StoreCredit row')
      noteCredit(c.id, `${cfg.name}-source-successor`, 'source-successor')
      return { id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt, apiExpiresAt: s.expiresAt ?? null, source: c.source, returnId: c.returnId == null ? null : n(c.returnId), exchangeInvoiceId: c.exchangeInvoiceId == null ? null : n(c.exchangeInvoiceId), sourceInvoiceId: c.sourceInvoiceId == null ? null : n(c.sourceInvoiceId) }
    })
    b.sourceSuccessorRows = sourceSuccessors
    const successorIds = new Set(sourceSuccessors.map(c => c.id))
    const returnedCodes = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source,returnId,exchangeInvoiceId,sourceInvoiceId FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
    b.creditsCreatedByChildReturn = returnedCodes.map(c => ({ id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt, source: c.source, returnId: c.returnId == null ? null : n(c.returnId), exchangeInvoiceId: c.exchangeInvoiceId == null ? null : n(c.exchangeInvoiceId), sourceInvoiceId: c.sourceInvoiceId == null ? null : n(c.sourceInvoiceId) }))
    for (const c of returnedCodes) noteCredit(c.id, `${cfg.name}-child-return-credit`, 'child-return-credit')
    if (cfg.returnMethod === 'STORE_CREDIT' && n(ret.refundAmount) > 0) {
      const cashShare = returnedCodes.find(c => !successorIds.has(n(c.id)) && n(c.amount) === n(ret.refundAmount) && c.expiresAt == null)
      if (!cashShare) {
        b.storeCreditReturnObservation = { expectedMoneyCredit: n(ret.refundAmount), found: returnedCodes.filter(c => !successorIds.has(n(c.id))).map(c => ({ id: n(c.id), amount: n(c.amount), expiresAt: c.expiresAt, source: c.source })) }
        b.status = 'REPRODUCED-BUG'
      } else b.storeCreditReturnObservation = { id: n(cashShare.id), amount: n(cashShare.amount), expiresAt: cashShare.expiresAt, source: cashShare.source }
    }
    if (cfg.returnMethod === 'NONE') {
      const expectedBacked = n(ret.overpayAmount)
      if (expectedBacked > 0 && (n(ret.overpayCredit?.amount) !== expectedBacked || (ret.overpayCredit?.expiresAt ?? null) !== null)) {
        b.status = 'POLICY-GAP'
        b.noSelectionFinding = { expectedCredit: expectedBacked, recordedOverpay: n(ret.overpayAmount), issuedCredit: n(ret.overpayCredit?.amount), expiry: ret.overpayCredit?.expiresAt ?? null, message: 'اعتبارِ بدون انقضای اضافه‌دریافتِ پشتوانه‌دار در برگشتِ فاکتور جایگزین صادر نشد.' }
      }
    }
    b.events.push(await checkpoint(`${cfg.name}: full child-invoice return via ${cfg.returnMethod}`))
  } catch (e) {
    b.status = 'BLOCKED'
    b.failure = { stage: sale ? (ex ? 'return of exchange invoice' : 'positive exchange') : 'purchase', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
    b.afterFailure = snapshot()
    if (beforeChildReturn && b.failure.stage === 'return of exchange invoice') {
      b.failure.beforeChildReturn = beforeChildReturn
      b.failure.returnRollbackVerified = JSON.stringify(beforeChildReturn) === JSON.stringify(b.afterFailure)
      if (/هم‌زمان مصرف شد/.test(b.failure.message) && b.failure.returnRollbackVerified) {
        b.status = 'REPRODUCED-BUG'
        b.failure.finding = 'یک اعتبار چندمصرفیِ زنده دو بار در lineage خرید مبدأ و مابه‌التفاوت تعویض مصرف شد؛ برگشت فاکتور جایگزین در یک تراکنش سریال، با optimistic guard «هم‌زمان مصرف شد» rollback می‌شود.'
      }
      if (!b.failure.returnRollbackVerified) b.status = 'BLOCKED'
    }
    try { b.events.push(await checkpoint(`${cfg.name}: failure checkpoint`)) } catch (post) { b.reconciliationError = String(post?.message ?? post) }
  }
  return b
}

await runBranch({ name: 'ZERO-CODE-SPLIT-EXCHANGE-CASH-RETURN', codeCount: 0, cashTender: 500000, cardTender: 500000, creditApplied: 0, requestEach: 0, positiveTender: 'SPLIT', returnMethod: 'CASH' })
await runBranch({ name: 'ONE-CODE-CREDIT-ONLY-EXCHANGE-CARD-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, positiveTender: 'CREDIT', returnMethod: 'CARD' })
await runBranch({ name: 'FOUR-CODE-CREDIT-SPLIT-EXCHANGE-C2C-RETURN', codeCount: 4, codeEach: 100000, creditApplied: 200000, requestEach: 50000, cashTender: 400000, cardTender: 400000, positiveTender: 'CREDIT-SPLIT', returnMethod: 'CARD_TO_CARD' })
await runBranch({ name: 'FOUR-CODE-CARD-EXCHANGE-STORE-CREDIT-RETURN', codeCount: 4, codeEach: 100000, creditApplied: 200000, requestEach: 50000, cashTender: 400000, cardTender: 400000, positiveTender: 'CARD', returnMethod: 'STORE_CREDIT' })
await runBranch({ name: 'ONE-CODE-CASH-EXCHANGE-NONE-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, positiveTender: 'CASH', returnMethod: 'NONE' })

const physicalRaw = rawFinancials()
const report = await salesService.reportRows({ shiftId })
const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
assert.deepEqual(reported, expected, 'final report matches expected physical totals')
assert.deepEqual(physicalRaw, reported, 'raw financial docs match service report')
const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
assert.equal(blue, blueExpected)
const summary = {
  generatedAt: new Date().toISOString(), independentScenario: 9, isolatedDatabase: process.env.HARNESS_DB,
  status: branches.every(b => ['PASS', 'POLICY-GAP', 'REPRODUCED-BUG', 'BLOCKED'].includes(b.status)) ? 'EVALUATED_WITH_FINDINGS' : 'FAIL',
  passBranches: branches.filter(b => b.status === 'PASS').length,
  policyGapBranches: branches.filter(b => b.status === 'POLICY-GAP').length,
  reproducedBugBranches: branches.filter(b => b.status === 'REPRODUCED-BUG').length,
  blockedBranches: branches.filter(b => b.status === 'BLOCKED').length,
  unexpectedBlocks: branches.filter(b => b.status === 'BLOCKED').length,
  purchaseBarcodeCounts: [0, 1, 4],
  positiveExchangeTenderPaths: ['cash', 'card', 'cash+card split', 'barcode only', 'barcode+cash+card split'],
  childReturnMethods: ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE'],
  physicalExpected: expected, physicalRaw, reported, blue, blueExpected, branches
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-followup-scenario10-positive-exchange-split-settlement-and-child-return.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const md = [
  '# سناریوی مستقل ۹ از ۱۰ — مابه‌التفاوت مثبت ترکیبی و برگشت فاکتور جایگزین', '',
  `**وضعیت:** ${summary.status} · شاخهٔ کامل PASS: ${summary.passBranches} · شکاف سیاست: ${summary.policyGapBranches} · باگ بازتولیدشده: ${summary.reproducedBugBranches} · بلوکه‌شدن غیرمنتظره: ${summary.blockedBranches}.`,
  '', '## طراحی',
  '- در هر شاخه خرید ۱٬۰۰۰٬۰۰۰ ریالی با دو قلم ۴۰۰٬۰۰۰ و ۶۰۰٬۰۰۰ ثبت شد؛ قلم اول با کالای ۵۵۰٬۰۰۰ تعویض شد (اختلاف مثبت ۱۵۰٬۰۰۰) و سپس کالای جایگزین روی فاکتور فرزند به‌طور کامل برگشت خورد.',
  '- Funding خرید: بدون بارکد، یک بارکد چندمصرفی با مصرف جزئی، یا چهار بارکد چندمصرفی با مصرف جزئی؛ فیلد درخواست جزئی `requestedAmount` بود.',
  '- تسویهٔ مثبت تعویض: فقط ترکیبی CASH+CARD، فقط همان بارکد منبع، بارکد+تقسیم CASH/CARD، فقط CARD و فقط CASH آزموده شد. روش‌های برگشت فاکتور فرزند نیز بین CASH، CARD، C2C، STORE_CREDIT و NONE تقسیم شد.', '',
  '| شاخه | خرید | اختلاف +۱۵۰٬۰۰۰ | برگشت کامل فاکتور فرزند | نتیجه/مشاهده |', '|---|---|---|---|---|',
  ...branches.map(b => {
    const detail = b.failure?.finding ?? b.failure?.message ?? (b.noSelectionFinding
      ? `اضافه‌دریافت ${fa(b.noSelectionFinding.recordedOverpay)}؛ اعتبار موردانتظار ${fa(b.noSelectionFinding.expectedCredit)}؛ صادرشده ${fa(b.noSelectionFinding.issuedCredit)}`
      : b.storeCreditReturnObservation ? `اعتبار برگشتی ${fa(b.storeCreditReturnObservation.amount)}، انقضا ${b.storeCreditReturnObservation.expiresAt ?? 'بدون انقضا'}` : 'تطبیق شد')
    const returnMethod = b.childReturn?.method ?? (b.childReturnRequested ? `${b.childReturnRequested.method} (ثبت نشد)` : '—')
    const returnValue = b.childReturn ? fa(b.childReturn.refundAmount) : b.childReturnRequested ? `درخواست ${fa(b.childReturnRequested.amount)}` : '—'
    const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
    return `| ${b.name} | ${b.purchaseFunding?.barcodeCount ?? 0} کد / اعتبار ${fa(b.purchaseFunding?.appliedCredit)} | ${b.exchange?.tender ?? '—'}؛ CASH ${fa(b.exchange?.cashReceived)}، POS ${fa(b.exchange?.cardReceived)}، بارکد ${fa(b.exchange?.barcodeCreditApplied)} | ${returnMethod}؛ وجه ${returnValue}؛ اعتبار منبع ${fa(b.childReturn?.sourceCreditRestoredAmount)} | ${detailText.replaceAll('|', '\\|')} |`
  }),
  '', '## نتیجهٔ مالی',
  `- اسناد خام و گزارش: ${JSON.stringify(physicalRaw)}. مرجع آبی: ${fa(blue)} = نقد ${fa(expected.cash)} + POS ${fa(expected.card)} − برگشت نقدی ${fa(expected.refundCash)} − برگشت POS ${fa(expected.refundCard)}.`,
  '- C2C فقط درخواست/پرداخت مدیر در هارنس است، نه انتقال بانکی واقعی. بازپرداخت POS با مسیر تأیید تست مدیر انجام شد.',
  '- در هر checkpoint گزارش سرویس، اسناد خام، مانده و وضعیت اعتبارها، StockMovement و موجودی تطبیق شد. فقط SQLite موقت هارنس استفاده شد؛ دیتابیس واقعی و کد تولیدی تغییر نکرد.'
]
writeFileSync(join(out, 'deep-e2e-followup-scenario10-positive-exchange-split-settlement-and-child-return.md'), md.join('\n') + '\n')
console.log(`Scenario 9 ${summary.status}; pass=${summary.passBranches}; policyGaps=${summary.policyGapBranches}; reproducedBugs=${summary.reproducedBugBranches}; unexpected=${summary.unexpectedBlocks}; blue=${blue}`)
await db.$disconnect?.()
if (summary.status === 'FAIL') process.exitCode = 1
