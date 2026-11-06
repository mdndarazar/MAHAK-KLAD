/**
 * E100-071: isolated controls for the 11th BLOCKED case (VARIANTS_BCD).
 * Modes cover a consolidated exchange, baseline and fully discounted chains,
 * first-invoice-only discount, and a no-prior-return diagnostic. Each invocation
 * uses a fresh temporary SQLite DB; negative settlement is selectable.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.env.MAHK_E100_071_MODE ?? 'single-document'
const negativeRefundMode = process.env.MAHK_E100_071_NEGATIVE_REFUND_MODE ?? 'STORE_CREDIT'
const modes = ['single-document', 'baseline-chain', 'discount-chain', 'discount-first-only', 'no-prior-return']
assert.ok(modes.includes(mode), `MAHK_E100_071_MODE must be one of ${modes.join(', ')}`)
assert.ok(['CASH', 'STORE_CREDIT'].includes(negativeRefundMode), 'MAHK_E100_071_NEGATIVE_REFUND_MODE must be CASH or STORE_CREDIT')
const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-071-control-'))
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
const userId = seed.user(`E100-071 ${mode} audit cashier`)
const cash = seed.insert('PaymentMethod', { key: `E100-071-${mode}-${negativeRefundMode}-CASH`, label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: `E100-071-${mode}-${negativeRefundMode}-CARD`, label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category(`e100-071-${mode}`)
const shiftId = seed.insert('Shift', { name: `E100-071 ${mode} ${negativeRefundMode}`, number: 71071 + (modes.indexOf(mode) * 10) + (negativeRefundMode === 'CASH' ? 1 : 0), dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const sqlNum = x => Number(x ?? 0)
const variants = []
let seq = 0
const expected = { cash: 0, card: 0, refundCash: 0, refundCard: 0 }
const events = []
const isDiscounted = mode === 'discount-chain' || mode === 'discount-first-only'
const discountEveryExchange = mode === 'discount-chain'
const reportStem = mode === 'baseline-chain' || mode === 'discount-chain' || mode === 'no-prior-return'
  ? `deep-e2e-e100-071-${mode}-${negativeRefundMode === 'CASH' ? 'cash-refund' : 'store-credit-refund'}-control`
  : `deep-e2e-e100-071-${mode}-control`
const result = { generatedAt: new Date().toISOString(), mode, negativeRefundMode, isolatedDatabase: process.env.HARNESS_DB, status: 'RUNNING', config: {}, events }
function makeVariant(name, price) {
  const product = seed.product(`E100-071-${++seq}-${name}`, category)
  const id = seed.variant(product, `E100-071-${seq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const row = { id, name, price, expectedStock: 10 }
  variants.push(row)
  return row
}
const line = (v, discount = 0) => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount, tax: 0 })
const payment = (type, amount) => ({ methodId: type === 'CASH' ? cash : card, amount, destination: type })
function adjust(v, delta) { v.expectedStock += delta }
function saleItemId(invoiceId, v) {
  const row = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', invoiceId, v.id)
  assert.ok(row, `sale item exists for ${v.name}`)
  return sqlNum(row.id)
}
function physical() {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')", shiftId)
  const r = seed.one("SELECT COALESCE(SUM(refundAmount),0) amount FROM \"SaleReturn\" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL", shiftId)
  return { cash: sqlNum(p.cash), card: sqlNum(p.card), refundCash: sqlNum(c.amount), refundCard: sqlNum(r.amount) }
}
function counts() {
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', shiftId), returns: seed.count('SaleReturn', 'shiftId=?', shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', shiftId), cashMovements: seed.count('CashMovement', 'shiftId=?', shiftId),
    allocations: sqlNum(seed.one('SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', shiftId).n),
    redemptions: sqlNum(seed.one('SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', shiftId).n),
    checks: sqlNum(seed.one(`SELECT COUNT(*) n FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=? AND UPPER(m.kind) IN ('CHECK','CHEQUE')`, shiftId).n),
  }
}
function credits() {
  return seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,restrictScope,restrictVariantIdsJson,returnId,exchangeInvoiceId FROM "StoreCredit" ORDER BY id')
    .map(x => ({ ...x, id: sqlNum(x.id), amount: sqlNum(x.amount), usedAmount: sqlNum(x.usedAmount), usedCount: sqlNum(x.usedCount), returnId: x.returnId == null ? null : sqlNum(x.returnId), exchangeInvoiceId: x.exchangeInvoiceId == null ? null : sqlNum(x.exchangeInvoiceId) }))
}
function stocks() {
  return variants.map(v => ({ name: v.name, expected: v.expectedStock, actual: sqlNum(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: sqlNum(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) }))
}
function invoices() {
  return seed.rows('SELECT id,sourceInvoiceId,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
    .map(i => ({ id: sqlNum(i.id), sourceInvoiceId: i.sourceInvoiceId == null ? null : sqlNum(i.sourceInvoiceId), grandTotal: sqlNum(i.grandTotal), paidTotal: sqlNum(i.paidTotal), settled: i.settledAt != null,
      items: seed.rows('SELECT variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', i.id).map(x => ({ variantId: sqlNum(x.variantId), qty: sqlNum(x.qty), unitPrice: sqlNum(x.unitPrice), discount: sqlNum(x.discount), lineTotal: sqlNum(x.lineTotal) })) }))
}
function returns() {
  return seed.rows('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE shiftId=? ORDER BY id', shiftId)
    .map(x => ({ ...x, id: sqlNum(x.id), invoiceId: sqlNum(x.invoiceId), total: sqlNum(x.total), refundAmount: sqlNum(x.refundAmount), refundStoreCreditAmount: sqlNum(x.refundStoreCreditAmount), exchangeInvoiceId: x.exchangeInvoiceId == null ? null : sqlNum(x.exchangeInvoiceId), exchangeTotal: sqlNum(x.exchangeTotal), exchangeDiff: sqlNum(x.exchangeDiff) }))
}
function allocations() {
  return seed.rows('SELECT id,returnId,redemptionId,sourceCreditId,amount,saleItemId,creditRestored,settlementAdjusted FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?) ORDER BY id', shiftId)
    .map(x => ({ ...x, id: sqlNum(x.id), returnId: sqlNum(x.returnId), redemptionId: sqlNum(x.redemptionId), sourceCreditId: sqlNum(x.sourceCreditId), amount: sqlNum(x.amount), saleItemId: x.saleItemId == null ? null : sqlNum(x.saleItemId), creditRestored: !!x.creditRestored, settlementAdjusted: !!x.settlementAdjusted }))
}
function signature() { return JSON.stringify({ counts: counts(), physical: physical(), credits: credits(), stocks: stocks(), invoices: invoices(), returns: returns(), allocations: allocations() }) }
async function checkpoint(label) {
  const report = await salesService.reportRows({ shiftId })
  const service = { cash: sqlNum(report.totals.cashTotal), card: sqlNum(report.totals.cardTotal), refundCash: sqlNum(report.totals.refundCashTotal), refundCard: sqlNum(report.totals.refundCardTotal) }
  assert.deepEqual(service, expected, `${mode}/${label}: service ledger matches expectation`)
  assert.deepEqual(physical(), service, `${mode}/${label}: raw money ledger matches report`)
  const blue = sqlNum(await physicalMovementForCustodyShift(shiftId))
  assert.equal(blue, expected.cash + expected.card - expected.refundCash - expected.refundCard)
  const stock = stocks()
  for (const x of stock) { assert.equal(x.actual, x.expected); assert.equal(x.actual, 10 + x.ledger) }
  for (const x of invoices()) assert.ok(x.settled && x.grandTotal === x.paidTotal, 'no unpaid/unsettled invoice')
  assert.equal(counts().checks, 0)
  const event = { label, expected: { ...expected, blue }, actual: physical(), blue, counts: counts(), invoices: invoices(), returns: returns(), allocations: allocations(), credits: credits(), stocks: stock }
  events.push(event)
  return event
}
function rootDiscounts() { return isDiscounted ? { A: 20_000, B: 20_000, C: 30_000, D: 30_000 } : { A: 0, B: 0, C: 0, D: 0 } }
function replacementDiscount(v) { return discountEveryExchange ? Math.round(v.price * 0.1) : 0 }
function opAmounts(op) {
  return { cashReceived: sqlNum(op.cashReceived), cardReceived: sqlNum(op.cardReceived), cashRefunded: sqlNum(op.cashRefunded), cardRefunded: sqlNum(op.cardRefunded) }
}
function applyPhysical(op) {
  const a = opAmounts(op)
  expected.cash += a.cashReceived; expected.card += a.cardReceived
  expected.refundCash += a.cashRefunded; expected.refundCard += a.cardRefunded
  return a
}
function updateExchangeStock(source, replacement) { for (const v of source) adjust(v, 1); for (const v of replacement) adjust(v, -1) }

try {
  const A = makeVariant('A-root-200k', 200_000), B = makeVariant('B-root-200k', 200_000)
  const C = makeVariant('C-root-300k', 300_000), D = makeVariant('D-root-300k', 300_000)
  const B1 = makeVariant('B1-180k', 180_000), C1 = makeVariant('C1-310k', 310_000), D1 = makeVariant('D1-310k', 310_000), B2 = makeVariant('B2-200k', 200_000)
  const restrictedIds = [B, C, D, B1, C1, D1, B2].map(v => v.id)
  const codes = []
  for (let i = 1; i <= 4; i++) {
    const issued = await storeCreditService.issueManual({ amount: 100_000, multiUse: false, maxUses: 1, carryRemainder: true, days: 30, userId,
      managerPassword: DEFAULT_MANAGER_PASSWORD, restrictScope: 'VARIANTS', restrictVariantIds: restrictedIds })
    const row = seed.one('SELECT id,code,restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE id=?', issued.id)
    assert.equal(row.restrictScope, 'VARIANTS')
    assert.deepEqual(JSON.parse(row.restrictVariantIdsJson), restrictedIds)
    codes.push({ id: sqlNum(row.id), code: row.code })
    await checkpoint(`issue restricted source credit ${i}: 100,000; eligible variants=B,C,D,B1,C1,D1,B2`)
  }
  const rd = rootDiscounts()
  const cashSale = isDiscounted ? 250_000 : 300_000
  const cardSale = isDiscounted ? 250_000 : 300_000
  const root = await salesService.create({ userId, shiftId,
    lines: [line(A, rd.A), line(B, rd.B), line(C, rd.C), line(D, rd.D)],
    storeCredits: codes.map(c => ({ code: c.code, requestedAmount: 100_000 })),
    payments: [payment('CASH', cashSale), payment('CARD', cardSale)], saleRequestIdempotencyKey: `e100-071-${mode}-${negativeRefundMode}-root` })
  const rootId = sqlNum(root.id)
  const rootNet = isDiscounted ? 900_000 : 1_000_000
  assert.equal(sqlNum(root.grandTotal), rootNet); assert.equal(sqlNum(root.storeCreditApplied), 400_000)
  expected.cash += cashSale; expected.card += cardSale
  for (const v of [A, B, C, D]) adjust(v, -1)
  await checkpoint(`root sale gross=1,000,000; net=${rootNet}; restricted credit=400,000; cash=${cashSale}; POS=${cardSale}`)
  const rootItems = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', rootId)
  const net = v => sqlNum(rootItems.find(x => sqlNum(x.variantId) === v.id).lineTotal)
  result.config = { gross: 1_000_000, discount: 1_000_000-rootNet, net: rootNet, lineNet: { A: net(A), B: net(B), C: net(C), D: net(D) }, creditCount: 4, creditUnit: 100_000,
    sourceCreditTotal: 400_000, sourceScope: 'VARIANTS_BCD', restrictedVariantIds: restrictedIds, cash: cashSale, card: cardSale, negativeRefundMode }

  let returned = null
  if (mode !== 'no-prior-return') {
    const amountA = net(A)
    returned = await salesService.createReturn({ userId, shiftId, invoiceId: rootId, full: false,
      lines: [{ saleItemId: saleItemId(rootId, A), qty: 1 }], refundMethod: 'CASH', refundAmount: amountA })
    assert.equal(sqlNum(returned.total), amountA)
    assert.equal(sqlNum(returned.sourceCreditRestoredAmount), 0, 'A is outside every manager-restricted credit scope')
    assert.equal((returned.sourceCreditSuccessors ?? []).length, 0, 'no successor for the out-of-scope A return')
    expected.refundCash += amountA; adjust(A, 1)
    await checkpoint(`return A=${amountA} by CASH; source credit restored=0 because A is outside B/C/D scope`)
    result.aReturn = { returnId: sqlNum(returned.id), amount: amountA, refundMethod: 'CASH', refundAmount: sqlNum(returned.refundAmount), sourceCreditRestored: sqlNum(returned.sourceCreditRestoredAmount), successors: (returned.sourceCreditSuccessors ?? []).map(x => sqlNum(x.id)) }
  } else {
    result.aReturn = { omittedForDiagnostic: true, reason: 'isolate whether a prior A-return is required to reproduce the guard' }
  }

  const replacements = [B1, C1, D1].map(v => line(v, replacementDiscount(v)))
  if (mode === 'single-document') {
    const pre = signature(); let op = null, err = ''
    try { op = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
      lines: [B, C, D].map(v => ({ saleItemId: saleItemId(rootId, v), qty: 1 })), replacements }) }
    catch (e) { err = String(e?.message ?? e) }
    if (err) {
      assert.equal(signature(), pre, 'blocked consolidated exchange is mutation-free')
      await checkpoint(`consolidated B+C+D blocked without mutation: ${err}`)
      result.singleExchange = { sourceNet: 800_000, replacementNet: 800_000, diff: 0, error: err, mutationFree: true }
      result.status = 'BLOCKED'
    } else {
      assert.equal(sqlNum(op.returnTotal), 800_000); assert.equal(sqlNum(op.exchangeTotal), 800_000); assert.equal(sqlNum(op.diff), 0)
      updateExchangeStock([B, C, D], [B1, C1, D1]); applyPhysical(op)
      await checkpoint('consolidated B+C+D in one exchange; source=800,000 replacement=800,000 diff=0')
      result.singleExchange = { returnId: sqlNum(op.returnId), exchangeInvoiceId: sqlNum(op.exchangeInvoiceId), sourceNet: sqlNum(op.returnTotal), replacementNet: sqlNum(op.exchangeTotal), diff: sqlNum(op.diff), error: null }
      result.status = 'PASS'
    }
  } else {
    const sourceB = net(B), bReplacement = line(B1, replacementDiscount(B1)), replacementB = B1.price - bReplacement.discount
    const bDiff = replacementB - sourceB
    const bInput = { userId, shiftId, invoiceId: rootId, lines: [{ saleItemId: saleItemId(rootId, B), qty: 1 }], replacements: [bReplacement] }
    if (bDiff < 0) bInput.refundMode = negativeRefundMode
    else if (bDiff > 0) bInput.methodId = card
    const beforeB = signature(); let bOp = null, bError = ''
    try { bOp = await salesService.createExchange(bInput) }
    catch (e) { bError = String(e?.message ?? e) }
    if (bError) {
      assert.equal(signature(), beforeB, 'rejected B exchange and every ledger stay mutation-free')
      await checkpoint(`B exchange ${sourceB}→${replacementB}, diff=${bDiff}, refund=${negativeRefundMode}: blocked without mutation: ${bError}`)
      result.bExchange = { sourceNet: sourceB, replacementNet: replacementB, diff: bDiff, refundMode: bDiff < 0 ? negativeRefundMode : null, error: bError, mutationFree: true }
      result.status = 'BLOCKED'
    } else {
      assert.equal(sqlNum(bOp.diff), bDiff)
      const bAmounts = applyPhysical(bOp)
      if (bDiff < 0 && bAmounts.cashRefunded + bAmounts.cardRefunded > 0)
        assert.fail(`restricted-credit B exchange paid physical money ${bAmounts.cashRefunded + bAmounts.cardRefunded}; B's source credit is not refundable as cash`)
      adjust(B, 1); adjust(B1, -1)
      await checkpoint(`B exchange ${sourceB}→${replacementB}, diff=${bDiff}; actual=${JSON.stringify(bAmounts)}`)
      const bReturnLedger = seed.one('SELECT refundMethod,refundAmount,refundStoreCreditAmount,exchangeSettlement FROM "SaleReturn" WHERE id=?', bOp.returnId)
      result.bExchange = { returnId: sqlNum(bOp.returnId), childInvoiceId: sqlNum(bOp.exchangeInvoiceId), sourceNet: sourceB, replacementNet: replacementB, diff: sqlNum(bOp.diff), refundMode: bDiff < 0 ? negativeRefundMode : null, actualRefundMethod: bReturnLedger.refundMethod, refundAmount: sqlNum(bReturnLedger.refundAmount), refundStoreCreditAmount: sqlNum(bReturnLedger.refundStoreCreditAmount), exchangeSettlement: bReturnLedger.exchangeSettlement, ...bAmounts, error: null }
      const bChild = sqlNum(bOp.exchangeInvoiceId)
      const cdSource = net(C) + net(D)
      const cLine = line(C1, replacementDiscount(C1)), dLine = line(D1, replacementDiscount(D1))
      const cdReplacement = C1.price - cLine.discount + D1.price - dLine.discount
      const cdDiff = cdReplacement - cdSource
      const beforeCd = signature(); let cdOp = null, cdError = ''
      try { cdOp = await salesService.createExchange({ userId, shiftId, invoiceId: rootId,
        lines: [C, D].map(v => ({ saleItemId: saleItemId(rootId, v), qty: 1 })), replacements: [cLine, dLine], ...(cdDiff > 0 ? { methodId: card } : cdDiff < 0 ? { refundMode: negativeRefundMode } : {}) }) }
      catch (e) { cdError = String(e?.message ?? e) }
      if (cdError) {
        assert.equal(signature(), beforeCd, 'rejected C+D exchange remains mutation-free')
        await checkpoint(`C+D exchange ${cdSource}→${cdReplacement}, diff=${cdDiff}: blocked without mutation: ${cdError}`)
        result.cdExchange = { sourceNet: cdSource, replacementNet: cdReplacement, diff: cdDiff, error: cdError, mutationFree: true }
        result.status = 'BLOCKED'
      } else {
        assert.equal(sqlNum(cdOp.diff), cdDiff)
        const cdAmounts = applyPhysical(cdOp)
        updateExchangeStock([C, D], [C1, D1])
        await checkpoint(`C+D exchange ${cdSource}→${cdReplacement}, diff=${cdDiff}; actual=${JSON.stringify(cdAmounts)}`)
        result.cdExchange = { returnId: sqlNum(cdOp.returnId), childInvoiceId: sqlNum(cdOp.exchangeInvoiceId), sourceNet: cdSource, replacementNet: cdReplacement, diff: sqlNum(cdOp.diff), ...cdAmounts, error: null }

        const b2Line = line(B2, replacementDiscount(B2)), b1InvoiceItem = saleItemId(bChild, B1)
        const childRow = sqlNum(seed.one('SELECT lineTotal FROM "SaleInvoiceItem" WHERE id=?', b1InvoiceItem).lineTotal)
        const b2Net = B2.price - b2Line.discount, reDiff = b2Net - childRow
        const beforeRe = signature(); let reOp = null, reError = ''
        const reInput = { userId, shiftId, invoiceId: bChild, lines: [{ saleItemId: b1InvoiceItem, qty: 1 }], replacements: [b2Line] }
        if (reDiff < 0) reInput.refundMode = negativeRefundMode
        else if (reDiff > 0) reInput.methodId = card
        try { reOp = await salesService.createExchange(reInput) }
        catch (e) { reError = String(e?.message ?? e) }
        if (reError) {
          assert.equal(signature(), beforeRe, 're-exchange rejection is mutation-free')
          await checkpoint(`B1→B2 ${childRow}→${b2Net}, diff=${reDiff}: blocked without mutation: ${reError}`)
          result.reexchange = { sourceNet: childRow, replacementNet: b2Net, diff: reDiff, refundMode: reDiff < 0 ? negativeRefundMode : null, error: reError, mutationFree: true }
          result.status = 'BLOCKED'
        } else {
          assert.equal(sqlNum(reOp.diff), reDiff)
          const reAmounts = applyPhysical(reOp)
          adjust(B1, 1); adjust(B2, -1)
          await checkpoint(`B1→B2 ${childRow}→${b2Net}, diff=${reDiff}; actual=${JSON.stringify(reAmounts)}`)
          result.reexchange = { returnId: sqlNum(reOp.returnId), childInvoiceId: sqlNum(reOp.exchangeInvoiceId), sourceNet: childRow, replacementNet: b2Net, diff: reDiff, refundMode: reDiff < 0 ? negativeRefundMode : null, ...reAmounts, error: null }
          result.status = 'PASS'
        }
      }
    }
  }
} catch (e) {
  result.status = 'FAIL'; result.unexpectedError = String(e?.stack ?? e); throw e
} finally {
  result.events = events
  result.final = { expected: { ...expected, blue: expected.cash + expected.card - expected.refundCash - expected.refundCard }, actual: physical(), blue: sqlNum(await physicalMovementForCustodyShift(shiftId)), counts: counts(), invoices: invoices(), returns: returns(), allocations: allocations(), credits: credits(), stocks: stocks() }
  const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${reportStem}.json`), JSON.stringify(result, null, 2) + '\n')
  const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
  const summary = mode === 'single-document'
    ? `پس از برگشت A، B+C+D یک‌جا: ${fa(result.singleExchange?.sourceNet)}→${fa(result.singleExchange?.replacementNet)}، اختلاف=${fa(result.singleExchange?.diff)}؛ ${result.singleExchange?.error ? 'BLOCKED' : result.status}.`
    : `ریشه net=${fa(result.config.net)}؛ برگشت A=${fa(result.aReturn?.amount ?? 0)} ${result.aReturn?.omittedForDiagnostic ? '(حذف‌شده برای کنترل تشخیصی)' : 'با CASH'}؛ B=${fa(result.bExchange?.sourceNet)}→${fa(result.bExchange?.replacementNet)} (${fa(result.bExchange?.diff)}) ${result.bExchange?.error ? 'BLOCKED' : 'PASS'}؛ C+D=${fa(result.cdExchange?.sourceNet)}→${fa(result.cdExchange?.replacementNet)} (${fa(result.cdExchange?.diff)}) ${result.cdExchange?.error ? 'BLOCKED' : result.cdExchange ? 'PASS' : 'اجرا نشد'}؛ B1→B2=${result.reexchange ? `${fa(result.reexchange.diff)} ${result.reexchange.error ? 'BLOCKED' : 'PASS'}` : 'اجرا نشد'}.`
  const negativeStageReached = [result.bExchange?.diff, result.cdExchange?.diff, result.reexchange?.diff].some(x => Number(x) < 0)
  const title = `E100-071 کنترل ${mode}${negativeStageReached ? ` — refund ${negativeRefundMode}` : ''}`
  const md = [`# ${title}`, '', `**وضعیت:** ${result.status}. **DB:** SQLite موقت ایزوله.`, '',
    'چهار کد single-use manager-restricted به B/C/D و اقلام جایگزین صادر شدند؛ A عمداً خارج از scope است. این fixture اعتبار عادی ALL نیست.', '',
    `## پیکربندی مالی`,
    `Root gross=۱٬۰۰۰٬۰۰۰؛ تخفیف=${fa(result.config.discount)}؛ net=${fa(result.config.net)}؛ خطوط خالص=${JSON.stringify(result.config.lineNet)}. اعتبار محدودشده=${fa(result.config.sourceCreditTotal)}؛ نقد=${fa(result.config.cash)}؛ POS=${fa(result.config.card)}. روش ورودی settlement منفی=${negativeStageReached ? negativeRefundMode : 'در این اجرا اختلاف منفی رخ نداد'}.`, '',
    `## نتیجه`, summary, '',
    `Final cash=${fa(result.final.actual.cash)}؛ POS=${fa(result.final.actual.card)}؛ برگشت نقد=${fa(result.final.actual.refundCash)}؛ برگشت POS=${fa(result.final.actual.refundCard)}؛ blue=${fa(result.final.blue)}.`,
    `فاکتور=${result.final.counts.invoices}؛ برگشت=${result.final.counts.returns}؛ payment=${result.final.counts.payments}؛ cash movement=${result.final.counts.cashMovements}؛ allocation=${result.final.counts.allocations}؛ redemption=${result.final.counts.redemptions}.`,
    `برگشت‌ها: ${JSON.stringify(result.final.returns)}`, `Allocationها: ${JSON.stringify(result.final.allocations)}`,'',
    'JSON تمام checkpointها انتظار/واقعی وجه، blue، موجودی و دفتر stock، اعتبار/محدودیت‌ها، redemptionها، سندها و allocationها را نگه می‌دارد.',
    'فقط تست روی DB موقت ایزوله؛ production source، policy و DB واقعی دست‌نخورده ماندند.']
  writeFileSync(join(out, `${reportStem}.md`), md.join('\n') + '\n')
}
