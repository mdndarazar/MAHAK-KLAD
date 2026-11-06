/**
 * Independent scenario 7 of 10: partially used, still-valid multi-use credit
 * returns to its original code after a partial return. Zero/one/four purchase
 * barcode branches, return settlement matrix, and same-code exchange-difference
 * reuse. Temporary SQLite harness only.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s08-'))
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
const userId = seed.user('follow-up partial-credit source restoration cashier')
const shiftId = seed.insert('Shift', { name: 'follow-up partial-use source restore', number: 10, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: 'F08-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'F08-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('followup-s08')
const n = x => Number(x ?? 0)
const variants = [], credits = [], branches = []
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
let sequence = 0
const makeVariant = (name, price) => {
  const p = seed.product(`S08-${++sequence}-${name}`, cat), id = seed.variant(p, `S08-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const v = { id, name, price }; variants.push(v); return v
}
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
const issueMultiUse = async (label, count, amountEach) => {
  const result = []
  for (let i = 0; i < count; i++) {
    const issued = await storeCreditService.issueManual({ amount: amountEach, multiUse: true, maxUses: 10, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    const row = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?', issued.id)
    const code = { id: n(row.id), code: row.code, label: `${label}-original-${i + 1}`, amount: n(row.amount), expiresAt: row.expiresAt }
    credits.push(code); result.push(code)
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
  const independent = rawFinancials(); assert.deepEqual(independent, reported, `${label}: raw docs equal report`)
  const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, blueExpected, `${label}: blue physical reference`)
  const stock = variants.map(v => {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const delta = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actual, 10 + delta, `${label}: stock ledger ${v.name}`)
    return { variant: v.name, expected: 10 + delta, actual, ledgerDelta: delta }
  })
  const creditState = [...credits].map(c => {
    const r = seed.one('SELECT amount,usedAmount,usedCount,status,expiresAt,source FROM "StoreCredit" WHERE id=?', c.id)
    return { id: c.id, label: c.label, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source }
  })
  return { label, expected: { ...expected }, reported, independent, blue, blueExpected, stock, credits: creditState }
}
await checkpoint('baseline')

async function runBranch(cfg) {
  const b = { name: cfg.name, status: 'PASS', events: [], sourceRestorationPolicy: 'same-code restoration for valid, partially-used multi-use barcode' }
  branches.push(b)
  const itemA = makeVariant(`${cfg.name}-item-A-400k`, 400000)
  const itemB = makeVariant(`${cfg.name}-item-B-600k`, 600000)
  const replacement = makeVariant(`${cfg.name}-replacement-650k`, 650000)
  const codes = await issueMultiUse(cfg.name, cfg.codeCount, cfg.amountEach ?? 0)
  b.funding = { barcodeCount: cfg.codeCount, barcodeValueApplied: cfg.creditApplied, cashTender: cfg.cashTender, cardTender: cfg.cardTender }
  b.events.push(await checkpoint(`${cfg.name}: issue multi-use barcode(s)`))
  let sale, ret
  try {
    sale = await salesService.create({
      userId, shiftId, lines: [line(itemA), line(itemB)],
      payments: [
        ...(cfg.cashTender ? [{ methodId: cash, amount: cfg.cashTender, destination: 'CASH' }] : []),
        ...(cfg.cardTender ? [{ methodId: card, amount: cfg.cardTender, destination: 'CARD' }] : [])
      ],
      storeCredits: codes.map(c => ({ code: c.code, requestedAmount: cfg.requestedEach })),
      saleRequestIdempotencyKey: `s08-${cfg.name}-sale`
    })
    assert.equal(n(sale.grandTotal), 1000000)
    assert.equal(n(sale.storeCreditApplied), cfg.creditApplied)
    expected.cash += cfg.cashTender; expected.card += cfg.cardTender
    const items = seed.rows('SELECT id,variantId,qty,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
    const sourceItemA = items.find(x => n(x.variantId) === itemA.id)
    const sourceItemB = items.find(x => n(x.variantId) === itemB.id)
    assert.ok(sourceItemA && sourceItemB)
    b.sale = { id: n(sale.id), total: n(sale.grandTotal), cash: cfg.cashTender, card: cfg.cardTender, barcodeApplied: n(sale.storeCreditApplied) }
    b.sourceBarcodesAfterSale = codes.map(c => {
      const row = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)
      assert.equal(n(row.usedAmount), cfg.requestedEach, 'sale must spend only the requested partial share')
      assert.equal(row.status, 'PARTIALLY_USED', 'multi-use source remains live after partial spend')
      return { id: n(row.id), code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount), usedCount: n(row.usedCount), status: row.status, expiresAt: row.expiresAt }
    })
    b.events.push(await checkpoint(`${cfg.name}: purchase uses only part of each source barcode`))

    const returnInput = { userId, shiftId, invoiceId: n(sale.id), full: false, lines: [{ saleItemId: n(sourceItemA.id), qty: 1 }], refundMethod: cfg.returnMethod }
    if (['CASH', 'CARD', 'CARD_TO_CARD'].includes(cfg.returnMethod)) returnInput.refundAmount = cfg.returnAmount
    if (cfg.returnMethod === 'CARD') returnInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `S08 ${cfg.name} POS return`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    if (cfg.returnMethod === 'NONE') {
      returnInput.confirmOverpay = true
      returnInput.overpayAsCredit = true
      returnInput.managerPassword = DEFAULT_MANAGER_PASSWORD
    }
    ret = await salesService.createReturn(returnInput)
    b.partialReturn = {
      id: n(ret.id), total: n(ret.total), method: ret.refundMethod, refundAmount: n(ret.refundAmount),
      returnCreditAmount: n(ret.returnCreditAmount), sourceCreditRestoredAmount: n(ret.sourceCreditRestoredAmount),
      overpayAmount: n(ret.overpayAmount), overpayCreditAmount: n(ret.overpayCredit?.amount),
      overpayCreditExpiresAt: ret.overpayCredit?.expiresAt ?? null,
      sourceCreditSuccessorIds: (ret.sourceCreditSuccessors ?? []).map(x => n(x.id))
    }
    if (cfg.returnMethod === 'CASH') { assert.equal(n(ret.refundAmount), cfg.returnAmount); expected.refundCash += cfg.returnAmount }
    if (cfg.returnMethod === 'CARD') { assert.equal(n(ret.refundAmount), cfg.returnAmount); expected.refundCard += cfg.returnAmount }
    if (cfg.returnMethod === 'CARD_TO_CARD') {
      const req = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', ret.id)
      assert.ok(req); assert.equal(req.status, 'PENDING'); assert.equal(n(req.amount), cfg.returnAmount)
      b.returnTransferPending = { id: n(req.id), status: req.status, amount: n(req.amount), operationKind: req.operationKind }
      b.events.push(await checkpoint(`${cfg.name}: partial-return C2C pending`))
      await cardTransferService.pay({ id: n(req.id), paidAmount: cfg.returnAmount, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `S08-${cfg.name}-RETURN` })
      const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', req.id)
      assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), cfg.returnAmount)
      b.returnTransferPaid = { status: paid.status, paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
    }

    const sourceAfterReturn = codes.map(c => {
      const row = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', c.id)
      assert.equal(n(row.id), c.id, 'same source barcode record must remain the source')
      assert.equal(row.code, c.code, 'same code must be preserved for a partially used valid source')
      assert.equal(n(row.usedAmount), 0, 'returned share must be restored to the original live barcode')
      assert.equal(row.status, 'ACTIVE', 'the source barcode was not fully consumed and must remain usable')
      assert.equal(row.expiresAt, c.expiresAt, 'restoring a partial source must not rewrite the original expiry')
      return { id: n(row.id), code: row.code, amount: n(row.amount), usedAmount: n(row.usedAmount), usedCount: n(row.usedCount), status: row.status, expiresAt: row.expiresAt }
    })
    b.sourceBarcodesAfterReturn = sourceAfterReturn
    assert.equal(n(ret.sourceCreditRestoredAmount), cfg.creditApplied, 'returned credit value restores to source; no successor needed')
    assert.equal((ret.sourceCreditSuccessors ?? []).length, 0, 'partially-used valid source must not issue successor codes')
    const allocations = seed.rows('SELECT redemptionId,sourceCreditId,amount,creditRestored FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id', ret.id)
    b.creditReturnAllocations = allocations.map(x => ({ redemptionId: n(x.redemptionId), sourceCreditId: n(x.sourceCreditId), amount: n(x.amount), creditRestored: !!x.creditRestored }))
    assert.equal(allocations.reduce((s, x) => s + n(x.amount), 0), cfg.creditApplied, 'raw allocations equal returned barcode value')
    assert.ok(allocations.every(x => codes.some(c => c.id === n(x.sourceCreditId))), 'every partial-credit allocation points to its original barcode')
    const redemptions = seed.rows('SELECT id,creditId,amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=? ORDER BY id', sale.id)
    b.sourceRedemptions = redemptions.map(x => ({ id: n(x.id), creditId: n(x.creditId), amount: n(x.amount), reversedAt: x.reversedAt }))
    assert.ok(redemptions.every(x => x.reversedAt != null), 'return keeps old redemption history and marks source use reversed')

    const createdOnReturn = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id', ret.id)
    b.creditsIssuedOnReturn = createdOnReturn.map(x => ({ id: n(x.id), code: x.code, amount: n(x.amount), usedAmount: n(x.usedAmount), status: x.status, expiresAt: x.expiresAt, source: x.source }))
    if (cfg.returnMethod === 'STORE_CREDIT') {
      const cashReturnCredit = createdOnReturn.find(x => n(x.amount) === cfg.returnAmount && x.expiresAt == null)
      assert.ok(cashReturnCredit, 'the real-money share explicitly returned as STORE_CREDIT gets a separate no-expiry barcode')
      b.cashShareCredit = { id: n(cashReturnCredit.id), amount: n(cashReturnCredit.amount), expiresAt: cashReturnCredit.expiresAt, source: cashReturnCredit.source }
    }
    if (cfg.returnMethod === 'NONE') {
      const expectedOverpay = cfg.expectedOverpay
      if (n(ret.overpayAmount) !== expectedOverpay || n(ret.overpayCredit?.amount) !== expectedOverpay || (ret.overpayCredit?.expiresAt ?? null) !== null) {
        b.status = 'POLICY-GAP'
        b.noSelectionFinding = { expectedOverpay, recordedOverpay: n(ret.overpayAmount), issuedCredit: n(ret.overpayCredit?.amount), expiry: ret.overpayCredit?.expiresAt ?? null, message: 'درخواست تبدیل اضافه‌دریافتِ بی‌روش به اعتبارِ بدون انقضا کامل نشده است.' }
      } else {
        b.overpayCreditCode = seed.one('SELECT id,code,amount,expiresAt FROM "StoreCredit" WHERE id=?', ret.overpayCredit.id)
        b.overpayCreditCode = { id: n(b.overpayCreditCode.id), code: b.overpayCreditCode.code, amount: n(b.overpayCreditCode.amount), expiresAt: b.overpayCreditCode.expiresAt }
      }
    }
    b.events.push(await checkpoint(`${cfg.name}: partial return ${cfg.returnMethod}; source credit returned to same ID`))

    // A missing auto-issued overpayment code is itself the finding; do not hide it by
    // substituting cash or a different barcode in the next exchange.
    if (cfg.returnMethod === 'NONE' && !b.overpayCreditCode) {
      b.exchange = { status: 'NOT-REACHED', reason: 'No automatic overpayment barcode exists to apply to the next +50k difference.' }
      return b
    }

    const exchangeInput = { userId, shiftId, invoiceId: n(sale.id), lines: [{ saleItemId: n(sourceItemB.id), qty: 1 }], replacements: [line(replacement)] }
    if (cfg.nextSettlement === 'CASH') { exchangeInput.methodId = cash; exchangeInput.destination = 'CASH' }
    if (cfg.nextSettlement === 'CARD') { exchangeInput.methodId = card; exchangeInput.destination = 'CARD' }
    let differenceCode = null
    if (cfg.nextSettlement === 'SAME-SOURCE-CREDIT') differenceCode = codes[0]
    if (cfg.nextSettlement === 'OVERPAY-CREDIT') differenceCode = b.overpayCreditCode
    if (differenceCode) {
      exchangeInput.exchangeCreditCode = differenceCode.code
      exchangeInput.idempotencyKey = `s08-${cfg.name}-next-exchange-credit`
    }
    const before = {
      invoices: n(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', shiftId).n),
      returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
      payments: seed.count('Payment', 'createdShiftId=?', shiftId),
      stock: variants.map(v => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock))
    }
    try {
      const ex = await salesService.createExchange(exchangeInput)
      assert.equal(n(ex.diff), 50000)
      if (cfg.nextSettlement === 'CASH') { assert.equal(n(ex.cashReceived), 50000); expected.cash += 50000 }
      if (cfg.nextSettlement === 'CARD') { assert.equal(n(ex.cardReceived), 50000); expected.card += 50000 }
      if (differenceCode) { assert.equal(n(ex.barcodeCreditApplied), 50000); assert.equal(n(ex.cashReceived), 0); assert.equal(n(ex.cardReceived), 0) }
      b.exchange = { status: 'PASS', returnId: n(ex.returnId), invoiceId: n(ex.exchangeInvoiceId), sourceInvoiceId: n(seed.one('SELECT sourceInvoiceId FROM "SaleInvoice" WHERE id=?', ex.exchangeInvoiceId).sourceInvoiceId), diff: n(ex.diff), tender: cfg.nextSettlement, cashReceived: n(ex.cashReceived), cardReceived: n(ex.cardReceived), barcodeCreditApplied: n(ex.barcodeCreditApplied), differenceCreditId: differenceCode?.id ?? null }
      if (differenceCode) {
        const afterUse = seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt FROM "StoreCredit" WHERE id=?', differenceCode.id)
        b.differenceBarcodeAfterUse = { id: n(afterUse.id), code: afterUse.code, amount: n(afterUse.amount), usedAmount: n(afterUse.usedAmount), usedCount: n(afterUse.usedCount), status: afterUse.status, expiresAt: afterUse.expiresAt }
        if (cfg.nextSettlement === 'SAME-SOURCE-CREDIT') {
          assert.equal(n(afterUse.id), codes[0].id, 'the same original barcode pays the next difference')
          assert.equal(n(afterUse.usedAmount), 50000)
          assert.equal(afterUse.status, 'PARTIALLY_USED')
        }
      }
      b.events.push(await checkpoint(`${cfg.name}: next exchange positive difference via ${cfg.nextSettlement}`))
    } catch (e) {
      b.exchange = { status: 'BLOCKED', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
      const after = {
        invoices: n(seed.one('SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', shiftId).n),
        returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
        payments: seed.count('Payment', 'createdShiftId=?', shiftId),
        stock: variants.map(v => n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock))
      }
      b.exchange.rollbackVerified = JSON.stringify(before) === JSON.stringify(after)
      assert.equal(b.exchange.rollbackVerified, true)
      b.events.push(await checkpoint(`${cfg.name}: exchange rejection rollback`))
      b.status = 'BLOCKED'
    }
  } catch (e) {
    b.status = 'BLOCKED'
    b.failure = { stage: sale ? (ret ? 'return/exchange' : 'return') : 'sale', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
    try { b.events.push(await checkpoint(`${cfg.name}: error checkpoint`)); b.rollbackVerified = true }
    catch (post) { b.rollbackVerified = false; b.reconciliationError = String(post?.message ?? post) }
  }
  return b
}

await runBranch({ name: 'ZERO-CODE-CASH', codeCount: 0, cashTender: 1000000, cardTender: 0, creditApplied: 0, requestedEach: 0, returnMethod: 'CASH', returnAmount: 400000, nextSettlement: 'CASH' })
await runBranch({ name: 'ONE-CODE-CARD-SAME-SOURCE', codeCount: 1, amountEach: 500000, requestedEach: 200000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'CARD', returnAmount: 200000, nextSettlement: 'SAME-SOURCE-CREDIT' })
await runBranch({ name: 'FOUR-CODE-C2C-CARD', codeCount: 4, amountEach: 100000, requestedEach: 50000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'CARD_TO_CARD', returnAmount: 200000, nextSettlement: 'CARD' })
await runBranch({ name: 'FOUR-CODE-STORE-CREDIT-CASH', codeCount: 4, amountEach: 100000, requestedEach: 50000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'STORE_CREDIT', returnAmount: 200000, nextSettlement: 'CASH' })
await runBranch({ name: 'FOUR-CODE-CASH-SAME-SOURCE', codeCount: 4, amountEach: 100000, requestedEach: 50000, cashTender: 400000, cardTender: 400000, creditApplied: 200000, returnMethod: 'CASH', returnAmount: 200000, nextSettlement: 'SAME-SOURCE-CREDIT' })
await runBranch({ name: 'ONE-CODE-NONE-OVERPAY', codeCount: 1, amountEach: 500000, requestedEach: 200000, cashTender: 800000, cardTender: 0, creditApplied: 200000, returnMethod: 'NONE', expectedOverpay: 200000, nextSettlement: 'OVERPAY-CREDIT' })

const raw = rawFinancials()
const report = await salesService.reportRows({ shiftId })
const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
assert.deepEqual(reported, expected, 'final report equals expected physical totals')
assert.deepEqual(raw, reported, 'raw source documents equal service report')
const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
assert.equal(blue, blueExpected)
const summary = {
  generatedAt: new Date().toISOString(), independentScenario: 7, isolatedDatabase: process.env.HARNESS_DB,
  status: branches.every(b => ['PASS', 'POLICY-GAP'].includes(b.status)) ? 'EVALUATED_WITH_FINDINGS' : 'FAIL',
  passBranches: branches.filter(b => b.status === 'PASS').length,
  policyGapBranches: branches.filter(b => b.status === 'POLICY-GAP').length,
  unexpectedBlocks: branches.filter(b => b.status === 'BLOCKED').length,
  barcodeCountsTested: [0, 1, 4],
  partialSourceReturnRule: 'when the original multi-use credit remains valid and partially used, restore its returned share to that same original ID/code; do not issue a successor for that share',
  returnMethodsTested: ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE'],
  positiveExchangeTendersTested: ['CASH', 'CARD', 'same original source barcode', 'overpayment credit if issued'],
  physicalExpected: expected, physicalRaw: raw, reported, blue, blueExpected, branches
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-followup-scenario08-partial-credit-source-restoration.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const md = [
  '# سناریوی مستقل ۷ از ۱۰ — برگشت اعتبارِ نیمه‌مصرف‌شده به همان کد', '',
  `**وضعیت اجرا:** ${summary.status} · شاخهٔ کامل PASS: ${summary.passBranches} · شکاف سیاست: ${summary.policyGapBranches} · خطای هارنس/غیرمنتظره: ${summary.unexpectedBlocks}.`,
  '', '## طراحی',
  '- در همهٔ شاخه‌ها دو قلم ۴۰۰٬۰۰۰ و ۶۰۰٬۰۰۰ ریالی فروخته شد؛ قلم اول ۴۰۰٬۰۰۰ برگشت خورد و سپس قلم دوم ۶۰۰٬۰۰۰ با کالای ۶۵۰٬۰۰۰ تعویض شد (اختلاف مثبت ۵۰٬۰۰۰).',
  '- خریدها: بدون بارکد؛ یک بارکد چندمصرفی ۵۰۰٬۰۰۰ که فقط ۲۰۰٬۰۰۰ از آن مصرف شد؛ یا چهار بارکد چندمصرفی ۱۰۰٬۰۰۰ که هرکدام ۵۰٬۰۰۰ مصرف شد.',
  '- قاعدهٔ این سناریو: کدهای چندمصرفی هنوز معتبر و نیمه‌مصرف‌شده‌اند؛ سهم اعتباریِ کالای برگشتی باید به همان ID/code برگردد، نه به successor تازه.',
  '- مسیر برگشت‌ها میان CASH، CARD، CARD_TO_CARD، STORE_CREDIT و NONE تقسیم شد. اختلاف مثبت تعویض با CASH، CARD و همان بارکدِ منبع آزموده شد؛ C2C برای دریافت مثبت از مشتری مسیر مناسبی نیست.', '',
  '| شاخه | خرید | برگشت جزئی | تسویهٔ اختلاف +۵۰٬۰۰۰ | نتیجه | یافته |', '|---|---|---|---|---|---|',
  ...branches.map(b => {
    const next = b.exchange?.status === 'PASS' ? `${b.exchange.tender} · ${fa(b.exchange.diff)}` : b.exchange?.reason ?? b.exchange?.message ?? '—'
    const issue = b.noSelectionFinding?.message ?? b.failure?.message ?? (b.sourceBarcodesAfterReturn ? 'کد اصلی با همان ID فعال ماند و سهم برگشتی به آن برگشت' : '')
    return `| ${b.name} | ${b.funding?.barcodeCount ?? 0} کد / ${fa(b.funding?.barcodeValueApplied)} اعتبار | ${b.partialReturn?.method ?? '—'} / ${fa(b.partialReturn?.returnCreditAmount)} اعتبار منبع | ${next} | ${b.status} | ${String(issue).replaceAll('|', '\\|')} |`
  }),
  '', '## چرخهٔ اعتبار در شاخهٔ تک‌بارکدی',
  '- خرید: ۱٬۰۰۰٬۰۰۰ = ۴۰۰٬۰۰۰ نقد + ۴۰۰٬۰۰۰ POS + مصرف ۲۰۰٬۰۰۰ از بارکد ۵۰۰٬۰۰۰. پس از فروش، کد باید PARTIALLY_USED بماند و ۳۰۰٬۰۰۰ مانده داشته باشد.',
  '- برگشت قلم A به مبلغ ۴۰۰٬۰۰۰: سهم اعتبار ۲۰۰٬۰۰۰ به همان کد اصلی برمی‌گردد؛ انتظار این است که usedAmount به صفر و وضعیت به ACTIVE برگردد، بدون صدور successor.',
  '- تعویض قلم B: ۶۰۰٬۰۰۰ به ۶۵۰٬۰۰۰؛ همان کد اصلی ۵۰٬۰۰۰ برای اختلاف مصرف می‌شود. انتظار: همان ID با usedAmount=۵۰٬۰۰۰ و PARTIALLY_USED.',
  '', '## تطبیق مالی',
  `- اسناد خام و گزارش: ${JSON.stringify(raw)}. مرجع آبی: ${fa(blue)} = ${fa(expected.cash)} نقد + ${fa(expected.card)} POS − ${fa(expected.refundCash)} نقد برگشتی − ${fa(expected.refundCard)} POS برگشتی.`,
  '- C2C: درخواست PENDING و سپس ثبت پرداخت مدیر در هارنس؛ انتقال بانکی واقعی انجام نشده. بازپرداخت CARD با تأیید تست مدیر ثبت شد.',
  '- روش NONE: معیار پذیرش کاربر، صدور خودکار اعتبار بدون انقضا از اضافه‌دریافت است؛ اگر اعتبار صادر نشد، شاخه POLICY-GAP ثبت می‌شود و کمبود با پرداخت دیگری پنهان نمی‌شود.',
  '- در هر checkpoint، گزارش، اسناد خام، آبی، StockMovement و وضعیت/ماندهٔ همهٔ بارکدها بررسی شدند. فقط DB موقت SQLite هارنس استفاده شد؛ دیتابیس واقعی و source code تولیدی تغییر نکرد.'
]
writeFileSync(join(out, 'deep-e2e-followup-scenario08-partial-credit-source-restoration.md'), md.join('\n') + '\n')
console.log(`Scenario 7 ${summary.status}; pass=${summary.passBranches}; policyGaps=${summary.policyGapBranches}; unexpected=${summary.unexpectedBlocks}; blue=${blue}`)
await db.$disconnect?.()
if (summary.status === 'FAIL') process.exitCode = 1
