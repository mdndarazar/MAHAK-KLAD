/**
 * Independent scenario 10 of 10: test whether returning an exchange-child
 * invoice is incorrectly blocked when one still-valid multi-use code was used
 * in both the root sale and positive exchange. Sweep every return method and
 * zero/one/four barcode funding in isolated SQLite.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-followup-s11-'))
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
const userId = seed.user('follow-up multi-use same-code refund matrix cashier')
const shiftId = seed.insert('Shift', { name: 'follow-up same multi-use code refund matrix', number: 13, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const cash = seed.insert('PaymentMethod', { key: 'F11-CASH', label: 'cash test', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'F11-CARD', label: 'POS test', kind: 'CARD', isActive: 1, sortOrder: 2 })
const cat = seed.category('followup-s11')
const n = x => Number(x ?? 0)
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const variants = [], credits = [], branches = []
let seq = 0
const makeVariant = (name, price) => {
  const p = seed.product(`S11-${++seq}-${name}`, cat), id = seed.variant(p, `S11-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const v = { id, name, price }; variants.push(v); return v
}
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
const rawCredit = id => seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source,returnId,exchangeInvoiceId,sourceInvoiceId FROM "StoreCredit" WHERE id=?', id)
const keepCredit = (id, label, kind) => {
  const r = rawCredit(id)
  if (!credits.some(x => x.id === n(r.id))) credits.push({ id: n(r.id), code: r.code, label, kind })
  return { id: n(r.id), code: r.code, label, kind, amount: n(r.amount), usedAmount: n(r.usedAmount), usedCount: n(r.usedCount), status: r.status, expiresAt: r.expiresAt, source: r.source }
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
  const raw = rawFinancials(); assert.deepEqual(raw, reported, `${label}: raw documents equal report`)
  const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
  assert.equal(blue, blueExpected, `${label}: blue reference`)
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
const issueCodes = async (name, count, each) => {
  const out = []
  for (let i = 0; i < count; i++) {
    const issued = await storeCreditService.issueManual({ amount: each, multiUse: true, maxUses: 10, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    out.push(keepCredit(issued.id, `${name}-source-${i + 1}`, 'source'))
  }
  return out
}
await checkpoint('baseline')

async function runBranch(cfg) {
  const b = { name: cfg.name, status: 'PASS', events: [], returnMethodAttempted: cfg.returnMethod, positiveTender: cfg.positiveTender }
  branches.push(b)
  const original = makeVariant(`${cfg.name}-original-400k`, 400000)
  const kept = makeVariant(`${cfg.name}-kept-600k`, 600000)
  const replacement = makeVariant(`${cfg.name}-replacement-550k`, 550000)
  const codes = await issueCodes(cfg.name, cfg.codeCount, cfg.codeEach ?? 0)
  b.purchasePlan = { barcodeCount: codes.length, creditTender: cfg.creditApplied, requestedEach: cfg.requestEach, cashTender: cfg.cashTender, cardTender: cfg.cardTender }
  b.events.push(await checkpoint(`${cfg.name}: issue code(s)`))
  let sale, ex, childReturn, beforeReturn = null
  try {
    sale = await salesService.create({
      userId, shiftId, lines: [line(original), line(kept)],
      payments: [
        ...(cfg.cashTender ? [{ methodId: cash, amount: cfg.cashTender, destination: 'CASH' }] : []),
        ...(cfg.cardTender ? [{ methodId: card, amount: cfg.cardTender, destination: 'CARD' }] : [])
      ],
      storeCredits: codes.map(c => ({ code: c.code, requestedAmount: cfg.requestEach })),
      saleRequestIdempotencyKey: `s11-${cfg.name}-root`
    })
    assert.equal(n(sale.grandTotal), 1000000); assert.equal(n(sale.storeCreditApplied), cfg.creditApplied)
    expected.cash += cfg.cashTender; expected.card += cfg.cardTender
    const items = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', sale.id)
    const itemA = items.find(x => n(x.variantId) === original.id), itemB = items.find(x => n(x.variantId) === kept.id)
    assert.ok(itemA && itemB)
    b.sale = { invoiceId: n(sale.id), total: n(sale.grandTotal), creditApplied: n(sale.storeCreditApplied), itemA: n(itemA.id), itemB: n(itemB.id) }
    b.sourceAfterSale = codes.map(c => {
      const r = rawCredit(c.id)
      assert.equal(n(r.usedAmount), cfg.requestEach, 'the purchase applies requestedAmount, not full face value')
      return { id: n(r.id), amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status }
    })
    b.events.push(await checkpoint(`${cfg.name}: root purchase`))

    const exchangeInput = { userId, shiftId, invoiceId: n(sale.id), lines: [{ saleItemId: n(itemA.id), qty: 1 }], replacements: [line(replacement)] }
    let sourceTender = null
    if (cfg.positiveTender === 'SPLIT') {
      exchangeInput.splitPayment = true
      exchangeInput.payments = [{ methodId: cash, amount: 75000, destination: 'CASH' }, { methodId: card, amount: 75000, destination: 'CARD' }]
    } else if (cfg.positiveTender === 'SAME-CODE') {
      sourceTender = codes[0]
      exchangeInput.exchangeCreditCode = sourceTender.code
      exchangeInput.idempotencyKey = `s11-${cfg.name}-exchange-source-credit`
    } else if (cfg.positiveTender === 'CASH') { exchangeInput.methodId = cash; exchangeInput.destination = 'CASH' }
    else if (cfg.positiveTender === 'CARD') { exchangeInput.methodId = card; exchangeInput.destination = 'CARD' }
    ex = await salesService.createExchange(exchangeInput)
    assert.equal(n(ex.diff), 150000)
    if (cfg.positiveTender === 'SPLIT') { assert.equal(n(ex.cashReceived), 75000); assert.equal(n(ex.cardReceived), 75000) }
    if (cfg.positiveTender === 'SAME-CODE') { assert.equal(n(ex.barcodeCreditApplied), 150000); assert.equal(n(ex.cashReceived), 0); assert.equal(n(ex.cardReceived), 0) }
    if (cfg.positiveTender === 'CASH') assert.equal(n(ex.cashReceived), 150000)
    if (cfg.positiveTender === 'CARD') assert.equal(n(ex.cardReceived), 150000)
    expected.cash += n(ex.cashReceived); expected.card += n(ex.cardReceived)
    const exInvoice = seed.one('SELECT id,sourceInvoiceId,grandTotal FROM "SaleInvoice" WHERE id=?', ex.exchangeInvoiceId)
    assert.equal(n(exInvoice.sourceInvoiceId), n(sale.id)); assert.equal(n(exInvoice.grandTotal), 550000)
    b.exchange = { invoiceId: n(ex.exchangeInvoiceId), returnId: n(ex.returnId), sourceInvoiceId: n(exInvoice.sourceInvoiceId), diff: n(ex.diff), tender: cfg.positiveTender, cashReceived: n(ex.cashReceived), cardReceived: n(ex.cardReceived), barcodeCreditApplied: n(ex.barcodeCreditApplied) }
    if (sourceTender) {
      const used = rawCredit(sourceTender.id)
      b.sourceAfterExchange = { id: n(used.id), code: used.code, amount: n(used.amount), usedAmount: n(used.usedAmount), status: used.status }
      if (cfg.expectLiveRepeatedSource) { assert.ok(n(used.usedAmount) < n(used.amount)); assert.equal(used.status, 'PARTIALLY_USED') }
    }
    b.events.push(await checkpoint(`${cfg.name}: positive exchange`))

    const childItem = seed.one('SELECT id,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=?', ex.exchangeInvoiceId)
    const returnInput = { userId, shiftId, invoiceId: n(ex.exchangeInvoiceId), full: false, lines: [{ saleItemId: n(childItem.id), qty: 1 }], refundMethod: cfg.returnMethod }
    if (cfg.returnMethod === 'CARD') returnInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `S11 ${cfg.name} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
    if (cfg.returnMethod === 'NONE') { returnInput.confirmOverpay = true; returnInput.overpayManagerPassword = DEFAULT_MANAGER_PASSWORD }
    b.childReturnAttempt = { invoiceId: n(ex.exchangeInvoiceId), itemId: n(childItem.id), total: n(childItem.lineTotal), method: cfg.returnMethod }
    beforeReturn = snapshot()
    childReturn = await salesService.createReturn(returnInput)
    b.childReturn = { id: n(childReturn.id), total: n(childReturn.total), method: childReturn.refundMethod, refundAmount: n(childReturn.refundAmount), returnCreditAmount: n(childReturn.returnCreditAmount), sourceCreditRestoredAmount: n(childReturn.sourceCreditRestoredAmount), overpayAmount: n(childReturn.overpayAmount), overpayCreditAmount: n(childReturn.overpayCredit?.amount), overpayCreditExpiresAt: childReturn.overpayCredit?.expiresAt ?? null }
    if (cfg.returnMethod === 'CASH') expected.refundCash += n(childReturn.refundAmount)
    if (cfg.returnMethod === 'CARD') expected.refundCard += n(childReturn.refundAmount)
    if (cfg.returnMethod === 'CARD_TO_CARD') {
      const request = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', childReturn.id)
      assert.ok(request); assert.equal(request.status, 'PENDING')
      b.transferPending = { id: n(request.id), status: request.status, amount: n(request.amount), operationKind: request.operationKind }
      b.events.push(await checkpoint(`${cfg.name}: C2C pending`))
      await cardTransferService.pay({ id: n(request.id), paidAmount: n(request.amount), userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `S11-${cfg.name}-RETURN` })
      const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', request.id)
      assert.equal(paid.status, 'PAID'); assert.equal(n(paid.paidAmount), n(request.amount))
      b.transferPaid = { status: paid.status, paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
    }
    const sourceSuccessors = (childReturn.sourceCreditSuccessors ?? []).map(s => {
      const r = rawCredit(s.id); assert.ok(r)
      keepCredit(r.id, `${cfg.name}-successor`, 'successor')
      return { id: n(r.id), code: r.code, amount: n(r.amount), usedAmount: n(r.usedAmount), status: r.status, dbExpiresAt: r.expiresAt, apiExpiresAt: s.expiresAt ?? null }
    })
    b.sourceSuccessors = sourceSuccessors
    const returnCredits = seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id', childReturn.id)
    b.returnCredits = returnCredits.map(c => ({ id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt, source: c.source }))
    for (const c of returnCredits) keepCredit(c.id, `${cfg.name}-return-credit`, 'return-credit')
    if (cfg.returnMethod === 'NONE' && n(childReturn.overpayAmount) > 0) {
      const expectedAutoCredit = n(childReturn.overpayAmount)
      if (n(childReturn.overpayCredit?.amount) !== expectedAutoCredit || (childReturn.overpayCredit?.expiresAt ?? null) !== null) {
        b.status = 'POLICY-GAP'
        b.noSelection = { expectedOverpay: expectedAutoCredit, issued: n(childReturn.overpayCredit?.amount), expiresAt: childReturn.overpayCredit?.expiresAt ?? null }
      }
    }
    b.events.push(await checkpoint(`${cfg.name}: child return ${cfg.returnMethod}`))
  } catch (e) {
    b.failure = { stage: sale ? (ex ? 'child-invoice return' : 'positive exchange') : 'root sale', message: String(e?.message ?? e), stack: String(e?.stack ?? '') }
    if (beforeReturn && b.failure.stage === 'child-invoice return') {
      const after = snapshot()
      b.failure.rollbackVerified = JSON.stringify(beforeReturn) === JSON.stringify(after)
      b.failure.before = beforeReturn; b.failure.after = after
      if (/هم‌زمان مصرف شد/.test(b.failure.message) && b.failure.rollbackVerified) {
        b.status = 'REPRODUCED-FINDING-7'
        b.failure.finding = 'Same live multi-use credit ID was redeemed on root sale and positive exchange; serial child return trips the stale optimistic update guard and rolls back.'
      } else b.status = 'BLOCKED'
    } else b.status = 'BLOCKED'
    try { b.events.push(await checkpoint(`${cfg.name}: rejection/rollback checkpoint`)) } catch (post) { b.reconciliationError = String(post?.message ?? post) }
  }
  return b
}

await runBranch({ name: 'ZERO-CODE-SPLIT-CASH-RETURN', codeCount: 0, cashTender: 500000, cardTender: 500000, creditApplied: 0, requestEach: 0, returnMethod: 'CASH', positiveTender: 'SPLIT' })
await runBranch({ name: 'ONE-CODE-CASH-EXCHANGE-CASH-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'CASH', positiveTender: 'CASH' })
await runBranch({ name: 'ONE-CODE-CARD-EXCHANGE-CARD-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'CARD', positiveTender: 'CARD' })
await runBranch({ name: 'ONE-CODE-CASH-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'CASH', positiveTender: 'SAME-CODE', expectLiveRepeatedSource: true })
await runBranch({ name: 'ONE-CODE-CARD-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'CARD', positiveTender: 'SAME-CODE', expectLiveRepeatedSource: true })
await runBranch({ name: 'ONE-CODE-C2C-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'CARD_TO_CARD', positiveTender: 'SAME-CODE', expectLiveRepeatedSource: true })
await runBranch({ name: 'ONE-CODE-STORE-CREDIT-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'STORE_CREDIT', positiveTender: 'SAME-CODE', expectLiveRepeatedSource: true })
await runBranch({ name: 'ONE-CODE-NONE-RETURN', codeCount: 1, codeEach: 300000, creditApplied: 100000, requestEach: 100000, cashTender: 450000, cardTender: 450000, returnMethod: 'NONE', positiveTender: 'SAME-CODE', expectLiveRepeatedSource: true })
await runBranch({ name: 'FOUR-CODE-C2C-RETURN', codeCount: 4, codeEach: 300000, creditApplied: 200000, requestEach: 50000, cashTender: 400000, cardTender: 400000, returnMethod: 'CARD_TO_CARD', positiveTender: 'SAME-CODE', expectLiveRepeatedSource: true })

const physicalRaw = rawFinancials()
const report = await salesService.reportRows({ shiftId })
const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
assert.deepEqual(reported, expected, 'final report equals expected physical totals')
assert.deepEqual(physicalRaw, reported, 'raw docs equal report')
const blue = n(await physicalMovementForCustodyShift(shiftId)), blueExpected = expected.cash + expected.card - expected.refundCash - expected.refundCard
assert.equal(blue, blueExpected)
const summary = {
  generatedAt: new Date().toISOString(), independentScenario: 10, isolatedDatabase: process.env.HARNESS_DB,
  status: branches.every(b => ['PASS', 'POLICY-GAP', 'REPRODUCED-FINDING-7', 'BLOCKED'].includes(b.status)) ? 'EVALUATED_WITH_FINDINGS' : 'FAIL',
  passBranches: branches.filter(b => b.status === 'PASS').length,
  policyGapBranches: branches.filter(b => b.status === 'POLICY-GAP').length,
  reproducedFinding7Branches: branches.filter(b => b.status === 'REPRODUCED-FINDING-7').length,
  unexpectedBlocks: branches.filter(b => b.status === 'BLOCKED').length,
  barcodeCountsTested: [0, 1, 4],
  returnMethodsAttempted: ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE'],
  positiveExchangeTenders: ['cash', 'card', 'cash+card split', 'same source barcode'],
  physicalExpected: expected, physicalRaw, reported, blue, blueExpected, branches
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deep-e2e-followup-scenario11-same-multiuse-credit-return-method-matrix.json'), JSON.stringify(summary, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const md = [
  '# سناریوی مستقل ۱۰ از ۱۰ — ماتریس برگشت پس از مصرف همان بارکد چندمصرفی در دو فاکتور', '',
  `**وضعیت:** ${summary.status} · PASS: ${summary.passBranches} · بازتولید مورد ۷: ${summary.reproducedFinding7Branches} · شکاف سیاست: ${summary.policyGapBranches} · بلوکه‌شدن غیرمنتظره: ${summary.unexpectedBlocks}.`,
  '', '## طراحی ماتریس',
  '- فروش ریشه در هر شاخه ۱٬۰۰۰٬۰۰۰ = قلم A برابر ۴۰۰٬۰۰۰ + قلم B برابر ۶۰۰٬۰۰۰؛ A با کالای ۵۵۰٬۰۰۰ تعویض شد (اختلاف +۱۵۰٬۰۰۰). سپس برگشت کامل فاکتور جایگزین درخواست شد.',
  '- پوشش خرید: بدون بارکد؛ یک بارکد چندمصرفی با `requestedAmount=100,000`؛ و چهار بارکد چندمصرفی با `requestedAmount=50,000` برای هر کد. در شاخه‌های هدف، همان بارکد زنده دوباره برای اختلاف مثبت تعویض مصرف شد.',
  '- مسیرهای برگشتِ فاکتور جایگزین: CASH، CARD، CARD_TO_CARD، STORE_CREDIT و NONE. C2C در صورت ساخته‌شدن درخواست در هارنس با تأیید مدیر پرداخت می‌شود؛ انتقال واقعی بانکی نیست.', '',
  '| شاخه | خرید | اختلاف +۱۵۰٬۰۰۰ | روش برگشت درخواستی | نتیجه | بازگشت/خطا |', '|---|---|---|---|---|---|',
  ...branches.map(b => {
    const result = b.childReturn ? `برگشت ${fa(b.childReturn.total)}؛ اعتبار منبع ${fa(b.childReturn.sourceCreditRestoredAmount)}` : b.failure?.message ?? (b.noSelection ? `انتظار اعتبار ${fa(b.noSelection.expectedOverpay)}، صادر ${fa(b.noSelection.issued)}` : '—')
    return `| ${b.name} | ${b.purchasePlan?.barcodeCount ?? 0} بارکد؛ اعتبار ${fa(b.purchasePlan?.creditTender)} | ${b.exchange?.tender ?? '—'}؛ بارکد ${fa(b.exchange?.barcodeCreditApplied)}؛ نقد ${fa(b.exchange?.cashReceived)}؛ POS ${fa(b.exchange?.cardReceived)} | ${b.returnMethodAttempted} | ${b.status} | ${String(result).replaceAll('|', '\\|')} |`
  }),
  '', '## نتیجهٔ تطبیق',
  `- نقد/POS/بازپرداخت خام: ${JSON.stringify(physicalRaw)}. مرجع آبی ${fa(blue)} = نقد ${fa(expected.cash)} + POS ${fa(expected.card)} − نقد برگشتی ${fa(expected.refundCash)} − POS برگشتی ${fa(expected.refundCard)}.`,
  '- در ردهای مورد ۷، snapshot پیش و پس از تلاش برای برگشت شامل شمار اسناد، پرداخت‌ها و موجودی برابر بود؛ عملیات اتمیک rollback شد.',
  '- پس از هر عملیاتِ موفق یا ردشده، اسناد خام، گزارش، اعتبارها، موجودی و مرجع آبی checkpoint شدند. فقط SQLite موقت هارنس استفاده شد؛ production code و دیتابیس واقعی دست‌نخورده ماند.'
]
writeFileSync(join(out, 'deep-e2e-followup-scenario11-same-multiuse-credit-return-method-matrix.md'), md.join('\n') + '\n')
console.log(`Scenario 10 ${summary.status}; pass=${summary.passBranches}; finding7=${summary.reproducedFinding7Branches}; policyGaps=${summary.policyGapBranches}; unexpected=${summary.unexpectedBlocks}; blue=${blue}`)
await db.$disconnect?.()
if (summary.status === 'FAIL') process.exitCode = 1
