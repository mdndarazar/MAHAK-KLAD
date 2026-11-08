/**
 * E100-054 controls: (1) remove the intermediate B exchange by consolidating
 * B+C+D into one document; (2) replay the exact chain with a 10% discount on
 * the root items and full-price replacements. Every run uses fresh temp SQLite.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.env.MAHK_E100_054_MODE ?? 'single-document'
assert.ok(['single-document', 'discounted-chain'].includes(mode), 'MAHK_E100_054_MODE must be single-document or discounted-chain')
const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-054-control-'))
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
const userId = seed.user(`E100-054 ${mode} audit cashier`)
const cash = seed.insert('PaymentMethod', { key: `E100-054-${mode}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: `E100-054-${mode}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`e100-054-${mode}`)
const shiftId = seed.insert('Shift', { name: `E100-054 ${mode}`, number: mode === 'single-document' ? 54054 : 54055, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const variants = []
let variantSeq = 0
const num = x => Number(x ?? 0)
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const events = []
function variant(name, price) {
  const product = seed.product(`E100-054-${++variantSeq}-${name}`, category)
  const id = seed.variant(product, `E100-054-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const row = { id, name, price, expectedStock: 10 }
  variants.push(row)
  return row
}
const line = (v, discount = 0) => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount, tax: 0 })
const payment = (kind, amount) => ({ methodId: kind === 'CASH' ? cash : card, amount, destination: kind })
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
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId),
    returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId),
    cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    transfers: num(seed.one('SELECT COUNT(*) n FROM "CardTransferRequest" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId).n),
    redemptions: num(seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', shiftId).n),
    allocations: num(seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId).n),
    stockMovements: num(seed.one(`SELECT COUNT(*) n FROM "StockMovement" WHERE variantId IN (${variants.map(() => '?').join(',')})`, ...variants.map(v => v.id)).n),
  }
}
function creditState() {
  return seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,source,returnId,exchangeInvoiceId,restrictScope,restrictVariantIdsJson FROM "StoreCredit" ORDER BY id')
    .map(r => ({ ...r, id: num(r.id), amount: num(r.amount), usedAmount: num(r.usedAmount), usedCount: num(r.usedCount), returnId: r.returnId == null ? null : num(r.returnId), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : num(r.exchangeInvoiceId) }))
}
function stockState() {
  return variants.map(v => ({ name: v.name, expected: v.expectedStock,
    actual: num(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock),
    ledger: num(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) }))
}
function invoices() {
  return seed.rows('SELECT id,sourceInvoiceId,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
    .map(i => ({ id: num(i.id), sourceInvoiceId: i.sourceInvoiceId == null ? null : num(i.sourceInvoiceId), grandTotal: num(i.grandTotal), paidTotal: num(i.paidTotal), settled: i.settledAt != null,
      items: seed.rows('SELECT variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', i.id).map(x => ({ variantId: num(x.variantId), qty: num(x.qty), unitPrice: num(x.unitPrice), discount: num(x.discount), lineTotal: num(x.lineTotal) })) }))
}
function returns() {
  return seed.rows('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE shiftId=? ORDER BY id', shiftId)
    .map(r => ({ ...r, id: num(r.id), invoiceId: num(r.invoiceId), total: num(r.total), refundAmount: num(r.refundAmount), refundStoreCreditAmount: num(r.refundStoreCreditAmount), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : num(r.exchangeInvoiceId), exchangeTotal: num(r.exchangeTotal), exchangeDiff: num(r.exchangeDiff) }))
}
function allocations() {
  return seed.rows('SELECT id,returnId,redemptionId,sourceCreditId,amount,saleItemId,creditRestored,settlementAdjusted FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?) ORDER BY id', shiftId)
    .map(a => ({ ...a, id: num(a.id), returnId: num(a.returnId), redemptionId: num(a.redemptionId), sourceCreditId: num(a.sourceCreditId), amount: num(a.amount), saleItemId: a.saleItemId == null ? null : num(a.saleItemId), creditRestored: !!a.creditRestored, settlementAdjusted: !!a.settlementAdjusted }))
}
async function checkpoint(label) {
  const reported = await salesService.reportRows({ shiftId })
  const service = { cash: num(reported.totals.cashTotal), card: num(reported.totals.cardTotal), refundCash: num(reported.totals.refundCashTotal), refundCard: num(reported.totals.refundCardTotal) }
  const raw = physical()
  assert.deepEqual(service, expected, `${mode}/${label}: service totals match planned flow`)
  assert.deepEqual(raw, service, `${mode}/${label}: raw payment/refund documents match report`)
  const blue = num(await physicalMovementForCustodyShift(shiftId))
  assert.equal(blue, expected.cash + expected.card - expected.refundCash - expected.refundCard, `${mode}/${label}: blue matches physical flow`)
  const stocks = stockState()
  for (const s of stocks) {
    assert.equal(s.actual, s.expected, `${mode}/${label}: stock ${s.name}`)
    assert.equal(s.actual, 10 + s.ledger, `${mode}/${label}: raw stock ledger ${s.name}`)
  }
  const inv = invoices()
  assert.ok(inv.every(x => x.paidTotal === x.grandTotal && x.settled), `${mode}/${label}: every invoice fully paid and settled`)
  const checkPayments = num(seed.one(`SELECT COUNT(*) n FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId
    WHERE p.createdShiftId=? AND UPPER(m.kind) IN ('CHECK','CHEQUE')`, shiftId).n)
  assert.equal(checkPayments, 0, 'no checks/debt instruments')
  const event = { label, expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, service, raw, blue,
    counts: counts(), invoices: inv, returns: returns(), allocations: allocations(), credits: creditState(), stocks }
  events.push(event)
  return event
}
function signature() { return JSON.stringify({ counts: counts(), physical: physical(), credits: creditState(), stocks: stockState(), returns: returns(), invoices: invoices(), allocations: allocations() }) }
function addStock(v, delta) { v.expectedStock += delta }
function itemId(invoiceId, v) {
  const row = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', invoiceId, v.id)
  assert.ok(row, `sale line for ${v.name}`)
  return num(row.id)
}
function rootLine(v, discount) { return { variantId: v.id, qty: 1, unitPrice: v.price, discount, tax: 0 } }

const result = { generatedAt: new Date().toISOString(), mode, isolatedDatabase: process.env.HARNESS_DB, status: 'RUNNING', events, config: {}, failures: [] }
try {
  const A = variant('A-root-200k', 200_000), B = variant('B-root-200k', 200_000), C = variant('C-root-300k', 300_000), D = variant('D-root-300k', 300_000)
  const B1 = variant('B1-220k', 220_000), C1 = variant('C1-290k', 290_000), D1 = variant('D1-290k', 290_000), B2 = variant('B2-reexchange-200k', 200_000)
  const aux = Array.from({ length: 6 }, (_, i) => variant(`aux-${i + 1}-100k`, 100_000))
  const credits = []
  for (let i = 1; i <= 6; i++) {
    const issued = await storeCreditService.issueManual({ amount: 200_000, multiUse: true, maxUses: 10, carryRemainder: true, days: 30, userId, managerPassword: DEFAULT_MANAGER_PASSWORD })
    const row = seed.one('SELECT id,code FROM "StoreCredit" WHERE id=?', issued.id)
    credits.push({ id: num(row.id), code: row.code })
    await checkpoint(`issue unrestricted source credit ${i}: 200,000`)
  }
  const discountPerItem = mode === 'discounted-chain' ? { A: 20_000, B: 20_000, C: 30_000, D: 30_000 } : { A: 0, B: 0, C: 0, D: 0 }
  const cashShare = mode === 'discounted-chain' ? 150_000 : 200_000
  const cardShare = mode === 'discounted-chain' ? 150_000 : 200_000
  const root = await salesService.create({
    userId, shiftId,
    lines: [rootLine(A, discountPerItem.A), rootLine(B, discountPerItem.B), rootLine(C, discountPerItem.C), rootLine(D, discountPerItem.D)],
    storeCredits: credits.map(c => ({ code: c.code, requestedAmount: 100_000 })),
    payments: [payment('CASH', cashShare), payment('CARD', cardShare)],
    saleRequestIdempotencyKey: `e100-054-${mode}-root`,
  })
  const rootId = num(root.id)
  assert.equal(num(root.grandTotal), mode === 'discounted-chain' ? 900_000 : 1_000_000)
  assert.equal(num(root.storeCreditApplied), 600_000)
  for (const v of [A, B, C, D]) addStock(v, -1)
  expected.cash += cashShare; expected.card += cardShare
  await checkpoint(`root sale: net=${root.grandTotal}; credit=600,000; cash=${cashShare}; POS=${cardShare}`)

  const auxSale = await salesService.create({
    userId, shiftId, lines: aux.map(v => line(v)),
    storeCredits: credits.map(c => ({ code: c.code, requestedAmount: 100_000 })), payments: [],
    saleRequestIdempotencyKey: `e100-054-${mode}-aux`,
  })
  assert.equal(num(auxSale.grandTotal), 600_000); assert.equal(num(auxSale.storeCreditApplied), 600_000)
  for (const v of aux) addStock(v, -1)
  await checkpoint('auxiliary invoice consumes remaining 100,000 on each of the six multi-use codes')

  const rootItems = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', rootId)
  const net = v => num(rootItems.find(x => num(x.variantId) === v.id).lineTotal)
  result.config = { rootGross: 1_000_000, discount: mode === 'discounted-chain' ? 100_000 : 0, rootNet: num(root.grandTotal), creditUsedRoot: 600_000, cash: cashShare, POS: cardShare,
    originalNetLines: { A: net(A), B: net(B), C: net(C), D: net(D) }, replacementsUndiscounted: { B1: B1.price, C1: C1.price, D1: D1.price },
    creditLifecycle: 'six unrestricted multi-use 200,000 codes; 100,000 redeemed on root and 100,000 each on auxiliary invoice; all USED/usedCount=2' }

  const aReturn = await salesService.createReturn({ userId, shiftId, invoiceId: rootId, full: false,
    lines: [{ saleItemId: itemId(rootId, A), qty: 1 }], refundMethod: 'NONE',
    confirmOverpay: true, overpayAsCredit: true, overpayManagerPassword: DEFAULT_MANAGER_PASSWORD })
  const expectedAReturn = net(A)
  assert.equal(num(aReturn.total), expectedAReturn)
  assert.equal(num(aReturn.sourceCreditRestoredAmount), expectedAReturn)
  addStock(A, 1)
  await checkpoint(`return A at net ${expectedAReturn}; source credit restored; no physical refund`)
  result.aReturn = { id: num(aReturn.id), netAmount: num(aReturn.total), sourceCreditRestored: num(aReturn.sourceCreditRestoredAmount), method: 'NONE', successorIds: (aReturn.sourceCreditSuccessors ?? []).map(x => num(x.id)) }

  if (mode === 'single-document') {
    const input = { userId, shiftId, invoiceId: rootId,
      lines: [B, C, D].map(v => ({ saleItemId: itemId(rootId, v), qty: 1 })),
      replacements: [line(B1), line(C1), line(D1)] }
    const before = signature()
    const op = await salesService.createExchange(input)
    assert.equal(num(op.diff), 0, 'combined B+C+D exchange nets +20,000 and -20,000 to zero')
    for (const v of [B, C, D]) addStock(v, 1)
    for (const v of [B1, C1, D1]) addStock(v, -1)
    await checkpoint('single consolidated exchange B+C+D; no intermediate B exchange document')
    result.combinedExchange = { returnId: num(op.returnId), exchangeInvoiceId: num(op.exchangeInvoiceId), returnTotal: num(op.returnTotal), exchangeTotal: num(op.exchangeTotal), diff: num(op.diff), beforeSignature: before, afterSignature: signature() }
    result.status = 'PASS'
  } else {
    const bExchange = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
      lines: [{ saleItemId: itemId(rootId, B), qty: 1 }], replacements: [line(B1)], methodId: card })
    const bExpected = B1.price - net(B)
    assert.equal(num(bExchange.diff), bExpected)
    assert.equal(num(bExchange.cardReceived), bExpected)
    expected.card += bExpected
    addStock(B, 1); addStock(B1, -1)
    await checkpoint(`B exchange net ${net(B)} to ${B1.price}; POS received ${bExpected}`)
    result.bExchange = { returnId: num(bExchange.returnId), exchangeInvoiceId: num(bExchange.exchangeInvoiceId), sourceNet: net(B), replacement: B1.price, diff: num(bExchange.diff), cardReceived: num(bExchange.cardReceived), sourceCreditRestored: num(bExchange.sourceCreditRestoredAmount ?? 0) }

    const cdNet = net(C) + net(D), cdReplacement = C1.price + D1.price, cdDiff = cdReplacement - cdNet
    let tenderCode = null
    if (cdDiff > 0) {
      tenderCode = seed.rows('SELECT id,code,amount,usedAmount,status,restrictScope FROM "StoreCredit" WHERE returnId=? ORDER BY id', aReturn.id)
        .map(x => ({ ...x, available: num(x.amount) - num(x.usedAmount) }))
        .find(x => ['ACTIVE', 'PARTIALLY_USED'].includes(x.status) && String(x.restrictScope ?? 'ALL').toUpperCase() === 'ALL' && x.available >= cdDiff)
      assert.ok(tenderCode, `A return produced an unrestricted active barcode for the ${cdDiff} positive C+D difference`)
    }
    const beforeCd = signature()
    let cdExchange = null, cdError = ''
    try {
      cdExchange = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
        lines: [C, D].map(v => ({ saleItemId: itemId(rootId, v), qty: 1 })), replacements: [line(C1), line(D1)],
        ...(cdDiff > 0 ? { exchangeCreditCode: tenderCode.code, idempotencyKey: 'e100-054-discounted-cd-credit' } : { refundMode: 'STORE_CREDIT' }) })
    } catch (e) { cdError = String(e?.message ?? e) }
    if (cdError) {
      assert.equal(signature(), beforeCd, 'rejected C+D exchange is mutation-free')
      await checkpoint(`C+D exchange rejected without mutation: ${cdError}`)
      result.cdExchange = { sourceNet: cdNet, replacement: cdReplacement, diff: cdDiff, tender: cdDiff > 0 ? 'BARCODE' : 'STORE_CREDIT', error: cdError, mutationFree: true }
      result.status = 'BLOCKED'
    } else {
      assert.equal(num(cdExchange.diff), cdDiff)
      if (cdDiff > 0) assert.equal(num(cdExchange.barcodeCreditApplied), cdDiff)
      expected.card += num(cdExchange.cardReceived)
      expected.cash += num(cdExchange.cashReceived)
      for (const v of [C, D]) addStock(v, 1)
      for (const v of [C1, D1]) addStock(v, -1)
      await checkpoint(`C+D exchange net ${cdNet} to ${cdReplacement}; diff ${cdDiff}; tender=${cdDiff > 0 ? 'BARCODE' : 'STORE_CREDIT'}`)
      result.cdExchange = { returnId: num(cdExchange.returnId), exchangeInvoiceId: num(cdExchange.exchangeInvoiceId), sourceNet: cdNet, replacement: cdReplacement, diff: num(cdExchange.diff), barcodeCreditApplied: num(cdExchange.barcodeCreditApplied), cashReceived: num(cdExchange.cashReceived), cardReceived: num(cdExchange.cardReceived), tender: cdDiff > 0 ? 'BARCODE' : 'STORE_CREDIT', error: null }

      const bChildId = num(bExchange.exchangeInvoiceId)
      const bChildItem = itemId(bChildId, B1)
      let final, finalError = ''
      const beforeFinal = signature()
      try {
        final = await salesService.createExchange({ userId, shiftId, invoiceId: bChildId,
          lines: [{ saleItemId: bChildItem, qty: 1 }], replacements: [line(B2)],
          refundMode: 'CASH' })
      } catch (e) { finalError = String(e?.message ?? e) }
      if (finalError) {
        assert.equal(signature(), beforeFinal, 'rejected B1-to-B2 re-exchange is mutation-free')
        await checkpoint(`B1 re-exchange blocked without mutation: ${finalError}`)
        result.reexchange = { error: finalError, mutationFree: true }
        result.status = 'BLOCKED'
      } else {
        assert.equal(num(final.diff), -20_000)
        const cashRefund = num(final.cashRefunded)
        expected.refundCash += cashRefund
        addStock(B1, 1)
        addStock(B2, -1)
        await checkpoint(`B1 220,000 to B2 200,000; cash refund=${cashRefund}`)
        const finalReturn = seed.one('SELECT refundMethod,refundAmount,refundStoreCreditAmount FROM "SaleReturn" WHERE id=?', final.returnId)
        result.reexchange = { returnId: num(final.returnId), exchangeInvoiceId: num(final.exchangeInvoiceId), diff: num(final.diff), requestedRefundMode: 'CASH', actualRefundMethod: finalReturn.refundMethod, cashRefunded: cashRefund, refundStoreCreditAmount: num(finalReturn.refundStoreCreditAmount), sourceCreditRestoredAmount: num(final.sourceCreditRestoredAmount), error: null }
        result.status = 'PASS'
      }
    }
  }
} catch (e) {
  result.status = 'FAIL'
  result.unexpectedError = String(e?.stack ?? e)
  throw e
} finally {
  result.events = events
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, rawPhysical: physical(), blue: num(await physicalMovementForCustodyShift(shiftId)), counts: counts(), invoices: invoices(), returns: returns(), allocations: allocations(), credits: creditState(), stocks: stockState() }
  const stem = mode === 'single-document' ? 'deep-e2e-e100-054-single-document-control' : 'deep-e2e-e100-054-discounted-chain-control'
  const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const f = x => Number(x ?? 0).toLocaleString('fa-IR')
  const md = [
    mode === 'single-document' ? '# E100-054 کنترل بدون زنجیره: تعویض B+C+D در یک سند' : '# E100-054 کنترل تخفیف‌دار: تکرار زنجیره با تخفیف ۱۰٪', '',
    `**وضعیت:** ${result.status}. **DB:** SQLite موقت ایزوله.`, '',
    mode === 'single-document'
      ? 'بعد از همان برگشت A، B و C و D در یک درخواست واحد از فاکتور ریشه تعویض شدند؛ سند تعویض مثبت B که در اجرای اصلی بین برگشت A و C+D آمده بود حذف شد. این کنترل اثر «تجمیع گام‌های B+C+D» را می‌سنجد؛ برگشت A همچنان یک سند رسمی قبلی است.'
      : 'همان ترتیب E100-054 اجرا شد، اما روی اقلام فاکتور ریشه ۱۰٪ تخفیف متناسب اعمال شد؛ قیمت‌های جایگزین B1/C1/D1 بدون تخفیف ماندند تا اختلاف با قیمت خالصی که مشتری واقعاً پرداخته سنجیده شود. فاکتور کمکیِ مصرف دوم کدها مانند اجرای اصلی بدون تخفیف باقی ماند.', '',
    '## محاسبهٔ net',
    `ریشه: gross=۱٬۰۰۰٬۰۰۰، تخفیف=${f(result.config?.discount ?? 0)}، net=${f(result.config?.rootNet ?? 0)}؛ خطوط net=${JSON.stringify(result.config?.originalNetLines ?? {})}.`,
    `تسویهٔ ریشه: اعتبار ${f(result.config?.creditUsedRoot ?? 600000)} + نقد ${f(result.config?.cash ?? 0)} + POS ${f(result.config?.POS ?? 0)}.`, '',
    '## نتایج عملیات',
    mode === 'single-document'
      ? `یک exchange برای B+C+D: بازگشتی=${f(result.combinedExchange?.returnTotal)}، جایگزین=${f(result.combinedExchange?.exchangeTotal)}، اختلاف=${f(result.combinedExchange?.diff)}؛ ${result.combinedExchange ? 'پذیرفته شد' : result.status}.`
      : `برگشت A: ${f(result.aReturn?.netAmount)}؛ B: ${f(result.bExchange?.sourceNet)}→${f(result.bExchange?.replacement)}، اختلاف +${f(result.bExchange?.diff)}؛ C+D: ${f(result.cdExchange?.sourceNet)}→${f(result.cdExchange?.replacement)}، اختلاف ${f(result.cdExchange?.diff)}؛ خطای C+D=${result.cdExchange?.error ?? 'ندارد'}؛ B1→B2: اختلاف ${f(result.reexchange?.diff)}، روش درخواستی ${result.reexchange?.requestedRefundMode ?? '—'}، روش ثبت‌شده ${result.reexchange?.actualRefundMethod ?? '—'}، سهم اعتبار برگشتی ${f(result.reexchange?.sourceCreditRestoredAmount)}، بازپرداخت نقدی ${f(result.reexchange?.cashRefunded)}.`,
    ...(mode === 'discounted-chain' && result.reexchange?.actualRefundMethod === 'STORE_CREDIT' ? ['در گام B1→B2، ورودی CASH خواسته بود؛ چون مازاد قابل‌بازگشت از pool اعتبار بود نه پول واقعی، سیستم نقد نداد و ۲۰٬۰۰۰ را به منبع اعتبار برگرداند.'] : []),
    '',
    `**ماندهٔ واقعی:** cash=${f(result.final?.rawPhysical?.cash)}، POS=${f(result.final?.rawPhysical?.card)}، refund cash=${f(result.final?.rawPhysical?.refundCash)}، refund POS=${f(result.final?.rawPhysical?.refundCard)}، blue=${f(result.final?.blue)}.`,
    `**فاکتورها:** ${JSON.stringify(result.final?.invoices ?? [])}`,
    `**برگشت‌ها:** ${JSON.stringify(result.final?.returns ?? [])}`,
    `**Allocationها:** ${JSON.stringify(result.final?.allocations ?? [])}`,
    '',
    'هر checkpoint در JSON، انتظار/واقعی cash و POS، refund، blue، stock/ledger، فاکتورها، اعتبارها و allocationها را نگه می‌دارد.',
    'فقط DB تست ایزوله و گزارش تغییر کرد؛ production code، DB واقعی و policy تغییر نکردند.'
  ]
  writeFileSync(join(out, `${stem}.md`), md.join('\n') + '\n')
}
