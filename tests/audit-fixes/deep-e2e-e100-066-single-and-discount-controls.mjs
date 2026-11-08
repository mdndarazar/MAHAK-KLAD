/**
 * E100-066 controls: consolidated B+C+D without an intermediate exchange;
 * repeat the same chain with 10% discounts on every invoice, and with discount
 * only on the original invoice. Fresh temporary SQLite DB per invocation.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.env.MAHK_E100_066_MODE ?? 'single-document'
assert.ok(['single-document', 'discount-chain', 'discount-first-only'].includes(mode), 'MAHK_E100_066_MODE must be single-document, discount-chain, or discount-first-only')
const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-066-control-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user(`E100-066 ${mode} audit cashier`)
const cash = seed.insert('PaymentMethod', { key: `E100-066-${mode}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: `E100-066-${mode}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`e100-066-${mode}`)
const shiftId = seed.insert('Shift', { name: `E100-066 ${mode}`, number: mode === 'single-document' ? 66066 : mode === 'discount-chain' ? 66067 : 66068, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const variants = []
let seq = 0
const num = x => Number(x ?? 0)
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const events = []
function makeVariant(name, price) {
  const product = seed.product(`E100-066-${++seq}-${name}`, category)
  const id = seed.variant(product, `E100-066-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const row = { id, name, price, expectedStock: 10 }
  variants.push(row)
  return row
}
const line = (v, discount = 0) => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount, tax: 0 })
const payment = (type, amount) => ({ methodId: type === 'CASH' ? cash : card, amount, destination: type })
function physical() {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')", shiftId)
  const r = seed.one("SELECT COALESCE(SUM(refundAmount),0) amount FROM \"SaleReturn\" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL", shiftId)
  return { cash: num(p.cash), card: num(p.card), refundCash: num(c.amount), refundCard: num(r.amount) }
}
function counts() {
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    transfers: num(seed.one('SELECT COUNT(*) n FROM "CardTransferRequest" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId).n),
    redemptions: num(seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', shiftId).n),
    allocations: num(seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId).n),
    stockMovements: num(seed.one(`SELECT COUNT(*) n FROM "StockMovement" WHERE variantId IN (${variants.map(() => '?').join(',')})`, ...variants.map(v => v.id)).n),
  }
}
function credits() {
  return seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,source,returnId,exchangeInvoiceId,restrictScope FROM "StoreCredit" ORDER BY id')
    .map(x => ({ ...x, id: num(x.id), amount: num(x.amount), usedAmount: num(x.usedAmount), usedCount: num(x.usedCount), returnId: x.returnId == null ? null : num(x.returnId), exchangeInvoiceId: x.exchangeInvoiceId == null ? null : num(x.exchangeInvoiceId) }))
}
function stocks() {
  return variants.map(v => ({ name: v.name, expected: v.expectedStock, actual: num(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: num(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) }))
}
function invoiceRows() {
  return seed.rows('SELECT id,sourceInvoiceId,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
    .map(i => ({ id: num(i.id), sourceInvoiceId: i.sourceInvoiceId == null ? null : num(i.sourceInvoiceId), grandTotal: num(i.grandTotal), paidTotal: num(i.paidTotal), settled: i.settledAt != null,
      items: seed.rows('SELECT variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', i.id).map(x => ({ variantId: num(x.variantId), qty: num(x.qty), unitPrice: num(x.unitPrice), lineTotal: num(x.lineTotal) })) }))
}
function returnRows() {
  return seed.rows('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE shiftId=? ORDER BY id', shiftId)
    .map(x => ({ ...x, id: num(x.id), invoiceId: num(x.invoiceId), total: num(x.total), refundAmount: num(x.refundAmount), exchangeInvoiceId: x.exchangeInvoiceId == null ? null : num(x.exchangeInvoiceId), exchangeTotal: num(x.exchangeTotal), exchangeDiff: num(x.exchangeDiff) }))
}
function allocationRows() {
  return seed.rows('SELECT id,returnId,redemptionId,sourceCreditId,amount,saleItemId,creditRestored,settlementAdjusted FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?) ORDER BY id', shiftId)
    .map(x => ({ ...x, id: num(x.id), returnId: num(x.returnId), redemptionId: num(x.redemptionId), sourceCreditId: num(x.sourceCreditId), amount: num(x.amount), saleItemId: x.saleItemId == null ? null : num(x.saleItemId), creditRestored: !!x.creditRestored, settlementAdjusted: !!x.settlementAdjusted }))
}
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const service = { cash: num(report.totals.cashTotal), card: num(report.totals.cardTotal), refundCash: num(report.totals.refundCashTotal), refundCard: num(report.totals.refundCardTotal) }
  assert.deepEqual(service, expected, `${mode}/${label}: physical report matches expectation`)
  assert.deepEqual(physical(), service, `${mode}/${label}: raw payment/refund ledger matches report`)
  const blue = num(await physicalMovementForCustodyShift(shiftId))
  assert.equal(blue, expected.cash + expected.card - expected.refundCash - expected.refundCard)
  const stock = stocks()
  for (const x of stock) { assert.equal(x.actual, x.expected); assert.equal(x.actual, 10 + x.ledger) }
  const invoice = invoiceRows()
  assert.ok(invoice.every(x => x.grandTotal === x.paidTotal && x.settled), 'no unpaid or unsettled invoice')
  const checks = num(seed.one(`SELECT COUNT(*) n FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? AND UPPER(m.kind) IN ('CHECK','CHEQUE')`, shiftId).n)
  assert.equal(checks, 0)
  const event = { label, expected: { ...expected, blue }, actual: physical(), blue, counts: counts(), invoices: invoice, returns: returnRows(), allocations: allocationRows(), credits: credits(), stocks: stock }
  events.push(event); return event
}
function signature() { return JSON.stringify({ counts: counts(), physical: physical(), credits: credits(), stocks: stocks(), returns: returnRows(), invoices: invoiceRows(), allocations: allocationRows() }) }
function adjust(v, d) { v.expectedStock += d }
function saleItemId(invoiceId, v) { const row = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', invoiceId, v.id); assert.ok(row); return num(row.id) }
const isDiscounted = mode !== 'single-document'
const discountEveryExchange = mode === 'discount-chain'
const reportStem = ({ 'single-document': 'deep-e2e-e100-066-single-document-control', 'discount-chain': 'deep-e2e-e100-066-discount-chain-control', 'discount-first-only': 'deep-e2e-e100-066-discount-first-only-control' })[mode]
const result = { generatedAt: new Date().toISOString(), mode, isolatedDatabase: process.env.HARNESS_DB, status: 'RUNNING', config: {}, events }
try {
  const A = makeVariant('A-root-200k', 200_000), B = makeVariant('B-root-200k', 200_000), C = makeVariant('C-root-300k', 300_000), D = makeVariant('D-root-300k', 300_000)
  const B1 = makeVariant('B1-220k', 220_000), C1 = makeVariant('C1-290k', 290_000), D1 = makeVariant('D1-290k', 290_000), B2 = makeVariant('B2-200k', 200_000)
  const codes = []
  for (let i = 1; i <= 6; i++) {
    const issued = await storeCreditService.issueManual({ amount: 50_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    const row = seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?', issued.id)
    codes.push({ id: num(row.id), code: row.code })
    await checkpoint(`issue source credit ${i}: 50,000`)
  }
  const rootDiscount = isDiscounted ? { A: 20_000, B: 20_000, C: 30_000, D: 30_000 } : { A: 0, B: 0, C: 0, D: 0 }
  const cashSale = isDiscounted ? 600_000 : 700_000
  const root = await salesService.create({ userId, shiftId,
    lines: [line(A, rootDiscount.A), line(B, rootDiscount.B), line(C, rootDiscount.C), line(D, rootDiscount.D)],
    storeCredits: codes.map(c => ({ code: c.code, requestedAmount: 50_000 })), payments: [payment('CASH', cashSale)],
    saleRequestIdempotencyKey: `e100-066-${mode}-root` })
  const rootId = num(root.id)
  const rootNet = isDiscounted ? 900_000 : 1_000_000
  assert.equal(num(root.grandTotal), rootNet); assert.equal(num(root.storeCreditApplied), 300_000)
  expected.cash += cashSale
  for (const v of [A, B, C, D]) adjust(v, -1)
  await checkpoint(`root sale gross=1,000,000; discount=${rootNet === 900000 ? 100000 : 0}; net=${rootNet}; credit=300,000; cash=${cashSale}`)
  const rootItems = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', rootId)
  const net = v => num(rootItems.find(x => num(x.variantId) === v.id).lineTotal)
  result.config = { gross: 1_000_000, discount: 1_000_000 - rootNet, net: rootNet, lineNet: { A: net(A), B: net(B), C: net(C), D: net(D) }, sourceCredits: 'six single-use codes ×50,000 =300,000, all redeemed on original invoice; scope=ALL', cash: cashSale }

  const returned = await salesService.createReturn({ userId, shiftId, invoiceId: rootId, full: false, lines: [{ saleItemId: saleItemId(rootId, A), qty: 1 },], refundMethod: 'NONE', confirmOverpay: true, overpayAsCredit: true, overpayManagerPassword: DEFAULT_MANAGER_PASSWORD })
  assert.equal(num(returned.total), net(A)); assert.equal(num(returned.sourceCreditRestoredAmount), net(A))
  adjust(A, 1)
  await checkpoint(`return A at net ${net(A)}; credit source restored, no cash refund`)
  result.aReturn = { returnId: num(returned.id), amount: num(returned.total), sourceCreditRestored: num(returned.sourceCreditRestoredAmount), successors: (returned.sourceCreditSuccessors ?? []).map(x => num(x.id)) }

  const replacements = v => discountEveryExchange ? Math.round(v.price * 0.1) : 0
  if (mode === 'single-document') {
    const exchange = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
      lines: [B, C, D].map(v => ({ saleItemId: saleItemId(rootId, v), qty: 1 })), replacements: [B1, C1, D1].map(v => line(v)) })
    assert.equal(num(exchange.returnTotal), 800_000); assert.equal(num(exchange.exchangeTotal), 800_000); assert.equal(num(exchange.diff), 0)
    for (const v of [B, C, D]) adjust(v, 1)
    for (const v of [B1, C1, D1]) adjust(v, -1)
    await checkpoint('single B+C+D exchange in one document; no intermediate B exchange')
    result.singleExchange = { returnId: num(exchange.returnId), exchangeInvoiceId: num(exchange.exchangeInvoiceId), returnTotal: num(exchange.returnTotal), exchangeTotal: num(exchange.exchangeTotal), diff: num(exchange.diff) }
    result.status = 'PASS'
  } else {
    const bReplacement = line(B1, replacements(B1))
    const bDiff = num(bReplacement.unitPrice - bReplacement.discount) - net(B)
    const bExchange = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
      lines: [{ saleItemId: saleItemId(rootId, B), qty: 1 }], replacements: [bReplacement], methodId: card })
    assert.equal(num(bExchange.diff), bDiff); assert.equal(num(bExchange.cardReceived), bDiff)
    expected.card += bDiff; adjust(B, 1); adjust(B1, -1)
    await checkpoint(`B: net ${net(B)} to B1 net ${bReplacement.unitPrice - bReplacement.discount}; POS +${bDiff}`)
    result.bExchange = { returnId: num(bExchange.returnId), childInvoiceId: num(bExchange.exchangeInvoiceId), sourceNet: net(B), replacementGross: B1.price, replacementDiscount: bReplacement.discount, replacementNet: bReplacement.unitPrice - bReplacement.discount, diff: num(bExchange.diff), cardReceived: num(bExchange.cardReceived) }

    const cdNet = net(C) + net(D)
    const cReplacement = line(C1, replacements(C1)), dReplacement = line(D1, replacements(D1))
    const cdReplacementNet = (C1.price - cReplacement.discount) + (D1.price - dReplacement.discount)
    const cdDiff = cdReplacementNet - cdNet
    let cdOp = null, cdError = ''
    const beforeCd = signature()
    try {
      if (cdDiff < 0) {
        cdOp = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
          lines: [C, D].map(v => ({ saleItemId: saleItemId(rootId, v), qty: 1 })), replacements: [cReplacement, dReplacement], refundMode: 'STORE_CREDIT' })
      } else {
        const code = seed.rows('SELECT id,code,amount,usedAmount,status,restrictScope FROM "StoreCredit" WHERE returnId=? ORDER BY id', returned.id)
          .map(x => ({ ...x, available: num(x.amount) - num(x.usedAmount) }))
          .find(x => ['ACTIVE', 'PARTIALLY_USED'].includes(x.status) && String(x.restrictScope ?? 'ALL').toUpperCase() === 'ALL' && x.available >= cdDiff)
        assert.ok(code, `A return produced an ALL-scope source successor covering ${cdDiff}`)
        cdOp = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
          lines: [C, D].map(v => ({ saleItemId: saleItemId(rootId, v), qty: 1 })), replacements: [cReplacement, dReplacement],
          exchangeCreditCode: code.code, idempotencyKey: `e100-066-${mode}-cd-tender` })
      }
    } catch (e) { cdError = String(e?.message ?? e) }
    if (cdError) {
      assert.equal(signature(), beforeCd, 'blocked C+D and retries leave all documents/credits/stock untouched')
      await checkpoint(`C+D rejected without mutation: ${cdError}`)
      if (cdDiff < 0) {
        const beforeRetry = signature(); let retryError = ''
        try { await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
          lines: [C, D].map(v => ({ saleItemId: saleItemId(rootId, v), qty: 1 })), replacements: [cReplacement, dReplacement], refundMode: 'STORE_CREDIT' })
        } catch (e) { retryError = String(e?.message ?? e) }
        assert.ok(retryError); assert.equal(signature(), beforeRetry)
        await checkpoint(`C+D STORE_CREDIT retry rejected without mutation: ${retryError}`)
        result.cdRetryError = retryError
      }
      result.cdExchange = { sourceNet: cdNet, replacementNet: cdReplacementNet, diff: cdDiff, error: cdError, mutationFree: true }
      result.status = 'BLOCKED'
    } else {
      assert.equal(num(cdOp.diff), cdDiff)
      if (cdDiff > 0) assert.equal(num(cdOp.barcodeCreditApplied), cdDiff)
      expected.cash += num(cdOp.cashReceived); expected.card += num(cdOp.cardReceived)
      for (const v of [C, D]) adjust(v, 1); for (const v of [C1, D1]) adjust(v, -1)
      await checkpoint(`C+D: net ${cdNet} to replacement net ${cdReplacementNet}; diff=${cdDiff}`)
      result.cdExchange = { returnId: num(cdOp.returnId), childInvoiceId: num(cdOp.exchangeInvoiceId), sourceNet: cdNet, replacementNet: cdReplacementNet, diff: num(cdOp.diff), barcodeCreditApplied: num(cdOp.barcodeCreditApplied), cashReceived: num(cdOp.cashReceived), cardReceived: num(cdOp.cardReceived), error: null }
      const bChild = num(bExchange.exchangeInvoiceId), bChildItem = saleItemId(bChild, B1)
      const b2Line = line(B2, replacements(B2))
      const b2Net = B2.price - b2Line.discount
      const b1Net = num(seed.one('SELECT lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', bChild, B1.id).lineTotal)
      const diff = b2Net - b1Net
      const pre = signature(); let last = null, lastError = ''
      try { last = await salesService.createExchange({ userId, shiftId, invoiceId: bChild, lines: [{ saleItemId: bChildItem, qty: 1 }], replacements: [b2Line], refundMode: diff < 0 ? 'CASH' : undefined }) }
      catch (e) { lastError = String(e?.message ?? e) }
      if (lastError) {
        assert.equal(signature(), pre); await checkpoint(`B1 re-exchange rejected without mutation: ${lastError}`)
        result.reexchange = { diff, error: lastError, mutationFree: true }; result.status = 'BLOCKED'
      } else {
        assert.equal(num(last.diff), diff)
        expected.cash += num(last.cashReceived); expected.card += num(last.cardReceived)
        expected.refundCash += num(last.cashRefunded); expected.refundCard += num(last.cardRefunded)
        adjust(B1, 1); adjust(B2, -1)
        await checkpoint(`B1 net ${b1Net} to B2 net ${b2Net}; diff=${diff}`)
        const returnRow = seed.one('SELECT refundMethod,refundAmount FROM "SaleReturn" WHERE id=?', last.returnId)
        result.reexchange = { returnId: num(last.returnId), childInvoiceId: num(last.exchangeInvoiceId), sourceNet: b1Net, replacementNet: b2Net, diff, actualRefundMethod: returnRow.refundMethod, cashRefunded: num(last.cashRefunded), sourceCreditRestored: num(last.sourceCreditRestoredAmount), error: null }
        result.status = 'PASS'
      }
    }
  }
} catch (e) { result.status = 'FAIL'; result.unexpectedError = String(e?.stack ?? e); throw e }
finally {
  result.events = events
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, physical: physical(), blue: num(await physicalMovementForCustodyShift(shiftId)), counts: counts(), invoices: invoiceRows(), returns: returnRows(), allocations: allocationRows(), credits: credits(), stocks: stocks() }
  const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${reportStem}.json`), JSON.stringify(result, null, 2) + '\n')
  const f = x => Number(x ?? 0).toLocaleString('fa-IR')
  const reexchangeSummary = result.reexchange
    ? (result.reexchange.error ? `BLOCKED: ${result.reexchange.error}` : `${f(result.reexchange.diff)} / ${result.reexchange.actualRefundMethod ?? 'PASS'}`)
    : (result.cdExchange?.error ? 'اجرا نشد؛ C+D متوقف شد' : 'اجرا نشد')
  const summary = mode === 'single-document'
    ? `برگشت A=${f(result.aReturn?.amount)}؛ یک تعویض B+C+D: ${f(result.singleExchange?.returnTotal)}→${f(result.singleExchange?.exchangeTotal)}، اختلاف=${f(result.singleExchange?.diff)}؛ ${result.status}.`
    : `ریشه net=${f(result.config.net)} (تخفیف ${f(result.config.discount)}؛ خطوط ${JSON.stringify(result.config.lineNet)}). برگشت A=${f(result.aReturn?.amount)}؛ B: ${f(result.bExchange?.sourceNet)}→${f(result.bExchange?.replacementNet)} (${f(result.bExchange?.diff)}); C+D: ${f(result.cdExchange?.sourceNet)}→${f(result.cdExchange?.replacementNet)} (${f(result.cdExchange?.diff)}) ${result.cdExchange?.error ? 'BLOCKED' : 'PASS'}; B1→B2: ${reexchangeSummary}.`
  const title = mode === 'single-document' ? 'E100-066 کنترل بدون زنجیره: تعویض B+C+D در یک سند' : mode === 'discount-chain' ? 'E100-066 زنجیره با ۱۰٪ تخفیف روی همهٔ فاکتورهای زنجیره' : 'E100-066 زنجیره با تخفیف فقط روی فاکتور اول'
  const md = [`# ${title}`, '', `**وضعیت:** ${result.status}. **DB:** SQLite موقت ایزوله.`, '',
    mode === 'single-document'
      ? 'پس از همان برگشت A، B+C+D یک‌جا از فاکتور ریشه در یک درخواست exchange انجام شدند؛ تعویض مثبت B به‌صورت سند واسط حذف شد. فاکتور فروش اصلی، بی‌تخفیف و با همان شش کد ۵۰٬۰۰۰تایی ALL بود.'
      : mode === 'discount-chain'
        ? 'تخفیف ۱۰٪ متناسب روی خطوط فاکتور اولیه و همچنین روی خطوط جایگزین در هر exchange اعمال شد؛ فاکتور کمکی وجود ندارد چون در E100-066 شش کد single-use هستند و همه روی همان خرید مصرف می‌شوند.'
        : 'تخفیف ۱۰٪ متناسب فقط روی خطوط فاکتور اولیه اعمال شد؛ B1/C1/D1/B2 با قیمت کامل باقی ماندند تا قیمت خالص پرداخت‌شدهٔ خرید اولیه با قیمت جاری جایگزین سنجیده شود.',
    '', '## محاسبهٔ مبالغ',
    `فاکتور اول gross=۱٬۰۰۰٬۰۰۰، تخفیف=${f(result.config.discount ?? 0)}، net=${f(result.config.net ?? 0)}؛ خطوط خالص=${JSON.stringify(result.config.lineNet ?? {})}. اعتبار=۳۰۰٬۰۰۰؛ وجه واقعی اولیه=${f(result.config.cash ?? 0)} نقد.`,
    '', '## نتیجهٔ عملیات', summary, '',
    `وضعیت نهایی واقعی: cash=${f(result.final.physical.cash)}، POS=${f(result.final.physical.card)}، refund نقد=${f(result.final.physical.refundCash)}، refund POS=${f(result.final.physical.refundCard)}، blue=${f(result.final.blue)}.`,
    `تعداد فاکتور=${result.final.counts.invoices}؛ برگشت=${result.final.counts.returns}؛ Payment=${result.final.counts.payments}؛ CashMovement=${result.final.counts.cashMovements}؛ allocations=${result.final.counts.allocations}.`,
    `برگشت‌های ثبت‌شده: ${JSON.stringify(result.final.returns)}`, `Allocationهای منبع: ${JSON.stringify(result.final.allocations)}`,
    '', 'JSON هر checkpoint را با انتظار/واقعی وجه، blue، فاکتورها، اعتبارها، stock و ledger ذخیره کرده است.',
    'فقط تست و گزارش DB موقت ایزوله؛ production code، policy و DB واقعی دست‌نخورده ماندند.']
  writeFileSync(join(out, `${reportStem}.md`), md.join('\n') + '\n')
}
