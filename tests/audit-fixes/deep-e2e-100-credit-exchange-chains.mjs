/**
 * 100 independent, isolated service-layer E2E scenarios for barcode-credit,
 * cash/POS, returns, multi-item exchanges, child-invoice re-exchange and C2C.
 * Each scenario gets its own Shift in one fresh temporary SQLite DB and checkpoints
 * every credit issue/redemption, sale, rejected retry, return, exchange and transfer.
 * No check/debt workflow or live DB is used.
 * Run: node --import ./test/harness/register.mjs tests/audit-fixes/deep-e2e-100-credit-exchange-chains.mjs
 * Optional pilot only: MAHAK_E2E_CASE_LIMIT=3 node --import ./test/harness/register.mjs ...
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e2e-100-'))
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
const userId = seed.user('100-chain audit cashier')
const cash = seed.insert('PaymentMethod', { key: 'E100-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const card = seed.insert('PaymentMethod', { key: 'E100-CARD', label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 2 })
const category = seed.category('e2e-100-credit-chain')
const now = () => new Date().toISOString()
const n = x => Number(x ?? 0)
const results = []
let variantSeq = 0
const creditCounts = [0, 1, 2, 3, 4, 6]
const creditUnits = [25_000, 50_000, 100_000]
const tenderKinds = ['CASH', 'CARD', 'SPLIT']
const lifecycleKinds = ['SINGLE_USED', 'MULTI_LIVE', 'MULTI_USED_TWICE']

function rawCredit(id) {
  return seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,source,returnId,exchangeInvoiceId,sourceInvoiceId,restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE id=?', id)
}
function newVariant(ctx, name, price, stock = 10) {
  const product = seed.product(`E100-${++variantSeq}-${name}`, category)
  const id = seed.variant(product, `E100-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=?,salePrice=? WHERE id=?').run(stock, price, id)
  const row = { id, name, price, baseline: stock, expected: stock }
  ctx.variants.push(row)
  return row
}
const line = (v, qty = 1) => ({ variantId: v.id, qty, unitPrice: v.price, discount: 0, tax: 0 })
const saleItems = invoiceId => seed.rows('SELECT id,variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', invoiceId)
function keepCredit(ctx, id, label) {
  if (id == null) return null
  const prior = ctx.credits.find(x => x.id === n(id))
  if (prior) return prior
  const row = rawCredit(id)
  assert.ok(row, `credit ${id} exists`)
  const item = { id: n(row.id), code: row.code, label }
  ctx.credits.push(item)
  return item
}
function rememberReturnCredits(ctx, returnId, label) {
  return seed.rows('SELECT id,code FROM "StoreCredit" WHERE returnId=? ORDER BY id', returnId)
    .map((row, i) => keepCredit(ctx, row.id, `${label}-${i + 1}`))
}
function adjustStock(ctx, deltas = {}) {
  for (const [id, delta] of Object.entries(deltas)) {
    const row = ctx.variants.find(v => v.id === Number(id))
    assert.ok(row, `known SKU ${id}`)
    row.expected += delta
  }
}
function creditIntegrityFindings(ctx) {
  const findings = []
  for (const credit of ctx.credits) {
    const row = rawCredit(credit.id)
    if (!row) continue
    const redemptions = seed.rows('SELECT id,amount,reversedAt FROM "StoreCreditRedemption" WHERE creditId=? ORDER BY id', credit.id)
    const active = redemptions.filter(x => x.reversedAt == null)
    const restorations = seed.rows('SELECT redemptionId,amount FROM "CreditReturnAllocation" WHERE sourceCreditId=? AND creditRestored=1', credit.id)
    const restoredByRedemption = new Map()
    for (const allocation of restorations) restoredByRedemption.set(n(allocation.redemptionId), (restoredByRedemption.get(n(allocation.redemptionId)) ?? 0) + n(allocation.amount))
    const netRows = active.map(x => ({ ...x, netAmount: Math.max(0, n(x.amount) - (restoredByRedemption.get(n(x.id)) ?? 0)) }))
    const netActiveAmount = netRows.reduce((sum, x) => sum + x.netAmount, 0)
    const live = row.status === 'ACTIVE' || row.status === 'PARTIALLY_USED'
    const badCount = n(row.usedCount) < 0 || n(row.usedCount) > redemptions.length
    const mismatch = badCount || (live && n(row.usedAmount) !== netActiveAmount) || (row.status === 'USED' && n(row.usedAmount) < netActiveAmount)
    if (mismatch) findings.push({
      type: 'ACTIVE_REDEMPTION_BALANCE_MISMATCH', creditId: n(row.id), code: row.code, label: credit.label,
      status: row.status, amount: n(row.amount), usedAmount: n(row.usedAmount), usedCount: n(row.usedCount),
      redemptionRows: redemptions.length, activeRedemptionAmount: active.reduce((sum, x) => sum + n(x.amount), 0), restoredAmount: restorations.reduce((sum, x) => sum + n(x.amount), 0),
      netActiveRedemptionAmount: netActiveAmount,
      activeRedemptionIds: active.map(x => n(x.id)),
      message: 'Credit available balance does not match net active redemptions after explicit return restorations, or usedCount is outside the redemption history bounds.'
    })
  }
  return findings
}
function rawPhysical(shiftId) {
  const p = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const c = seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`, shiftId)
  const r = seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`, shiftId)
  return { cash: n(p.cash), card: n(p.card), refundCash: n(c.amount), refundCard: n(r.amount) }
}
function creditState(ctx) {
  return ctx.credits.map(c => {
    const r = rawCredit(c.id)
    const redemptions = seed.rows('SELECT id,amount,remainderAfter,seq,reversedAt,invoiceId FROM "StoreCreditRedemption" WHERE creditId=? ORDER BY id', c.id)
    const active = redemptions.filter(x => x.reversedAt == null)
    const restorations = seed.rows('SELECT redemptionId,amount FROM "CreditReturnAllocation" WHERE sourceCreditId=? AND creditRestored=1', c.id)
    const restoredByRedemption = new Map()
    for (const allocation of restorations) restoredByRedemption.set(n(allocation.redemptionId), (restoredByRedemption.get(n(allocation.redemptionId)) ?? 0) + n(allocation.amount))
    const netRows = active.map(x => ({ ...x, restoredAmount: restoredByRedemption.get(n(x.id)) ?? 0, netAmount: Math.max(0, n(x.amount) - (restoredByRedemption.get(n(x.id)) ?? 0)) }))
    const netActiveAmount = netRows.reduce((sum, x) => sum + x.netAmount, 0)
    assert.ok(n(r.usedAmount) >= 0 && n(r.usedAmount) <= n(r.amount), `${ctx.name}/${c.label}: no negative/overdrawn barcode balance`)
    assert.ok(n(r.usedCount) >= 0 && n(r.usedCount) <= redemptions.length, `${ctx.name}/${c.label}: usedCount stays within redemption history`)
    for (const x of netRows) assert.ok(x.restoredAmount <= n(x.amount), `${ctx.name}/${c.label}: credit restoration never exceeds redemption ${x.id}`)
    if (r.status === 'ACTIVE' || r.status === 'PARTIALLY_USED') {
      assert.equal(n(r.usedAmount), netActiveAmount, `${ctx.name}/${c.label}: live-source usedAmount equals redemptions net of explicit return restorations`)
    } else if (r.status === 'USED') {
      assert.ok(n(r.usedAmount) >= netActiveAmount, `${ctx.name}/${c.label}: terminal USED source never understates net active redemptions`)
    }
    const delivery = seed.one('SELECT status,handoffType,deliveredAt,userId,note FROM "StoreCreditDelivery" WHERE creditId=?', c.id)
    return {
      id: n(r.id), code: r.code, label: c.label, amount: n(r.amount), usedAmount: n(r.usedAmount),
      available: n(r.amount) - n(r.usedAmount), usedCount: n(r.usedCount), status: r.status,
      expiresAt: r.expiresAt, source: r.source, returnId: r.returnId == null ? null : n(r.returnId),
      exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId),
      restrictScope: r.restrictScope, restrictVariantIdsJson: r.restrictVariantIdsJson,
      delivery: delivery ?? null,
      redemptions: redemptions.map(x => ({ id: n(x.id), amount: n(x.amount), restoredAmount: restoredByRedemption.get(n(x.id)) ?? 0, netAmount: Math.max(0, n(x.amount) - (restoredByRedemption.get(n(x.id)) ?? 0)), remainderAfter: n(x.remainderAfter), seq: n(x.seq), reversed: !!x.reversedAt, invoiceId: x.invoiceId == null ? null : n(x.invoiceId) }))
    }
  })
}
async function checkpoint(ctx, operation, { flow = {}, stock = {}, note = '' } = {}) {
  for (const k of Object.keys(ctx.expected)) ctx.expected[k] += n(flow[k])
  adjustStock(ctx, stock)
  const report = await salesService.reportRows({ shiftId: ctx.shiftId })
  const reported = { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }
  const raw = rawPhysical(ctx.shiftId)
  assert.deepEqual(reported, ctx.expected, `${ctx.name}/${operation}: service physical totals vs policy expectation`)
  assert.deepEqual(raw, reported, `${ctx.name}/${operation}: raw payment/cash/refund documents vs report`)
  const blueExpected = ctx.expected.cash + ctx.expected.card - ctx.expected.refundCash - ctx.expected.refundCard
  const blueActual = n(await physicalMovementForCustodyShift(ctx.shiftId))
  const blueRaw = raw.cash + raw.card - raw.refundCash - raw.refundCard
  assert.equal(blueActual, blueExpected, `${ctx.name}/${operation}: blue equals expected real cash+POS movement`)
  assert.equal(blueRaw, blueActual, `${ctx.name}/${operation}: independent raw blue equals service blue`)
  const stocks = ctx.variants.map(v => {
    const actual = n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)
    const delta = n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d)
    assert.equal(actual, v.expected, `${ctx.name}/${operation}: expected on-hand stock for ${v.name}`)
    assert.equal(actual, v.baseline + delta, `${ctx.name}/${operation}: raw stock ledger for ${v.name}`)
    return { sku: v.name, baseline: v.baseline, expected: v.expected, actual, ledgerDelta: delta }
  })
  const invoiceRows = seed.rows('SELECT id,receiptNo,status,grandTotal,paidTotal,settledAt,sourceInvoiceId,exchangeReturnId FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', ctx.shiftId)
  for (const i of invoiceRows) {
    assert.equal(n(i.paidTotal), n(i.grandTotal), `${ctx.name}/${operation}: invoice ${i.id} is fully funded; no debt/credit sale`)
    assert.ok(i.settledAt != null, `${ctx.name}/${operation}: invoice ${i.id} has a settlement timestamp`)
  }
  const checkPayments = n(seed.one(`SELECT COUNT(*) total FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId
    WHERE p.createdShiftId=? AND UPPER(m.kind) IN ('CHECK','CHEQUE')`, ctx.shiftId).total)
  assert.equal(checkPayments, 0, `${ctx.name}/${operation}: no check tender or debt instrument`)
  const invoices = invoiceRows.map(i => ({ id: n(i.id), receiptNo: i.receiptNo, status: i.status, grandTotal: n(i.grandTotal), paidTotal: n(i.paidTotal), settledAt: i.settledAt, sourceInvoiceId: i.sourceInvoiceId == null ? null : n(i.sourceInvoiceId), exchangeReturnId: i.exchangeReturnId == null ? null : n(i.exchangeReturnId), items: saleItems(i.id).map(x => ({ id: n(x.id), variantId: n(x.variantId), qty: n(x.qty), unitPrice: n(x.unitPrice), lineTotal: n(x.lineTotal) })) }))
  const returns = seed.rows('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement,voidedAt FROM "SaleReturn" WHERE shiftId=? ORDER BY id', ctx.shiftId)
    .map(r => ({ id: n(r.id), invoiceId: n(r.invoiceId), kind: r.kind, total: n(r.total), refundMethod: r.refundMethod, refundAmount: n(r.refundAmount), refundStoreCreditAmount: n(r.refundStoreCreditAmount), exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId), exchangeTotal: n(r.exchangeTotal), exchangeDiff: n(r.exchangeDiff), exchangeSettlement: r.exchangeSettlement, voided: !!r.voidedAt }))
  const cardTransfers = seed.rows('SELECT id,returnId,status,operationKind,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?) ORDER BY id', ctx.shiftId)
    .map(x => ({ id: n(x.id), returnId: n(x.returnId), status: x.status, operationKind: x.operationKind, amount: n(x.amount), paidAmount: n(x.paidAmount), paidMethod: x.paidMethod, trackingNo: x.trackingNo }))
  const creditAllocations = seed.rows(`SELECT a.id,a.eventKey,a.invoiceId,a.returnId,a.redemptionId,a.sourceCreditId,a.amount,a.creditRestored,a.settlementAdjusted,a.saleItemId
    FROM "CreditReturnAllocation" a JOIN "SaleReturn" r ON r.id=a.returnId WHERE r.shiftId=? ORDER BY a.id`, ctx.shiftId)
    .map(a => ({ id: n(a.id), eventKey: a.eventKey, invoiceId: n(a.invoiceId), returnId: n(a.returnId), redemptionId: n(a.redemptionId), sourceCreditId: n(a.sourceCreditId), amount: n(a.amount), creditRestored: !!a.creditRestored, settlementAdjusted: !!a.settlementAdjusted, saleItemId: a.saleItemId == null ? null : n(a.saleItemId) }))
  const event = {
    scenario: ctx.name, operation, at: now(), note,
    expectedFlow: { ...ctx.expected, blue: blueExpected }, reported, raw, blueActual, blueRaw,
    stock: stocks, credits: creditState(ctx), invoices, returns, cardTransfers, creditAllocations,
    counts: { paymentRows: seed.count('Payment', 'createdShiftId=?', ctx.shiftId), checkPayments, cashMovements: seed.count('CashMovement', 'shiftId=?', ctx.shiftId), returns: returns.length, invoices: invoices.length, cardTransfers: cardTransfers.length }
  }
  ctx.events.push(event)
  return event
}
function mutationSignature(ctx) {
  const stock = ctx.variants.map(v => [v.id, n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock)])
  const credit = ctx.credits.map(c => { const r = rawCredit(c.id); return [c.id, n(r.amount), n(r.usedAmount), n(r.usedCount), r.status] })
  return {
    invoices: seed.count('SaleInvoice', 'shiftId=?', ctx.shiftId),
    returns: seed.count('SaleReturn', 'shiftId=?', ctx.shiftId),
    payments: seed.count('Payment', 'createdShiftId=?', ctx.shiftId),
    cashMovements: seed.count('CashMovement', 'shiftId=?', ctx.shiftId),
    transfers: seed.count('CardTransferRequest', 'sourceInvoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', ctx.shiftId),
    stock, credit
  }
}
async function issueCredit(ctx, amount, { multiUse = false, label, restrictVariantIds = null } = {}) {
  const issued = await storeCreditService.issueManual({
    amount, multiUse, maxUses: multiUse ? 10 : 1, carryRemainder: true, days: 30, userId,
    managerPassword: DEFAULT_MANAGER_PASSWORD,
    ...(restrictVariantIds ? { restrictScope: 'VARIANTS', restrictVariantIds } : {})
  })
  const c = keepCredit(ctx, issued.id, label)
  await checkpoint(ctx, `credit issue ${label}: ${amount}${multiUse ? ' multi-use' : ' single-use'}`)
  return { ...c, amount: n(rawCredit(c.id).amount), expiresAt: rawCredit(c.id).expiresAt }
}
const paymentRows = (kind, amount) => amount ? [{ methodId: kind === 'CASH' ? cash : card, amount, destination: kind }] : []
function rootReturnMethod(i, tender, physicalRight) {
  if (physicalRight <= 0) return i % 2 ? 'NONE' : 'STORE_CREDIT'
  const modes = tender === 'CASH' ? ['CASH', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE']
    : tender === 'CARD' ? ['CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE']
      : ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE']
  return modes[Math.floor(i / 2) % modes.length]
}
function physicalRefundMode(i, tender, backing) {
  if (backing <= 0) return 'STORE_CREDIT'
  const primary = tender === 'CARD' ? 'CARD' : 'CASH'
  const options = ['STORE_CREDIT', primary, 'STORE_CREDIT', primary]
  return options[Math.floor(i / 3) % options.length]
}
function tenderMode(i, hasCredit) {
  const forced = process.env.MAHAK_E2E_FORCE_EXCHANGE_TENDER
  if (forced != null) {
    assert.ok(['CASH', 'CARD', 'BARCODE'].includes(forced), `unsupported forced exchange tender ${forced}`)
    return forced
  }
  const options = hasCredit ? ['CASH', 'CARD', 'BARCODE'] : ['CASH', 'CARD']
  return options[Math.floor(i / 4) % options.length]
}
function captureNewReturnCredits(ctx, ret, label) {
  const codes = rememberReturnCredits(ctx, ret.id, label)
  for (const s of ret.sourceCreditSuccessors ?? []) keepCredit(ctx, s.id, `${label}-source-successor`)
  if (ret.overpayCredit?.id) keepCredit(ctx, ret.overpayCredit.id, `${label}-overpay-credit`)
  return codes
}
function eligibleTenderCode(ctx, minimum = 20_000) {
  for (const c of ctx.credits) {
    const r = rawCredit(c.id)
    if ((r.status === 'ACTIVE' || r.status === 'PARTIALLY_USED') && String(r.restrictScope ?? 'ALL').toUpperCase() === 'ALL') {
      if (n(r.amount) - n(r.usedAmount) >= minimum) return { code: r.code, id: n(r.id), available: n(r.amount) - n(r.usedAmount) }
    }
  }
  return null
}
function addPhysicalResponse(ctx, operation, kind) {
  const amount = n(kind === 'CASH' ? operation.cashReceived : operation.cardReceived)
  if (kind === 'CASH') ctx.expected.cash += amount
  else ctx.expected.card += amount
}
function addRefundResponse(ctx, operation, kind) {
  const amount = n(kind === 'CASH' ? operation.cashRefunded : operation.cardRefunded)
  if (kind === 'CASH') ctx.expected.refundCash += amount
  else ctx.expected.refundCard += amount
  return amount
}
async function markExpectedRejection(ctx, label, operation) {
  const before = mutationSignature(ctx)
  let error = ''
  try { await operation() } catch (e) { error = String(e?.message ?? e) }
  if (!error) return { rejected: false, error: '', before, after: mutationSignature(ctx) }
  const after = mutationSignature(ctx)
  assert.deepEqual(after, before, `${ctx.name}/${label}: rejected operation must be mutation-free`)
  ctx.expectedBlocks.push({ label, message: error, mutationFree: true })
  await checkpoint(ctx, `${label} blocked without mutation: ${error}`)
  return { rejected: true, error, before, after }
}
async function settleC2C(ctx, ret, expectedAmount, label) {
  const req = seed.one('SELECT id,status,amount,operationKind FROM "CardTransferRequest" WHERE returnId=?', ret.id)
  assert.ok(req, `${ctx.name}/${label}: C2C transfer request exists`)
  assert.equal(req.status, 'PENDING')
  assert.equal(n(req.amount), expectedAmount)
  await checkpoint(ctx, `${label}: C2C pending; no blue/cash movement; returned stock still held`)
  await cardTransferService.pay({ id: n(req.id), paidAmount: n(req.amount), userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `E100-${ctx.index}-${label}` })
  const paid = seed.one('SELECT status,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?', req.id)
  assert.equal(paid.status, 'PAID')
  assert.equal(n(paid.paidAmount), expectedAmount)
  assert.equal(paid.paidMethod, 'MANAGER_CARD_TO_CARD')
  return { id: n(req.id), status: paid.status, amount: n(req.amount), paidAmount: n(paid.paidAmount), paidMethod: paid.paidMethod, trackingNo: paid.trackingNo }
}
function saleInput({ ctx, lines, credits = [], payments = [], key }) {
  return {
    userId, shiftId: ctx.shiftId, lines, payments,
    ...(credits.length ? { storeCredits: credits } : {}),
    saleRequestIdempotencyKey: key
  }
}
async function applyExchange(ctx, spec) {
  const before = mutationSignature(ctx)
  const preview = await salesService.previewExchangeFunding({
    invoiceId: spec.input.invoiceId,
    lines: spec.input.lines,
    replacements: spec.input.replacements,
    full: spec.input.full,
    invoiceDiscount: spec.input.invoiceDiscount,
    invoiceTax: spec.input.invoiceTax,
    serviceCharge: spec.input.serviceCharge
  })
  assert.equal(preview.ok, true, `${ctx.name}/${spec.label}: settlement preview must succeed: ${preview.error ?? ''}`)
  assert.equal(n(preview.nominalDiff), spec.expectedDiff, `${ctx.name}/${spec.label}: nominal replacement-minus-return value`)
  spec.input.expectedSettlementDiff = n(preview.effectiveDiff)
  let operation, error = ''
  try { operation = await salesService.createExchange(spec.input) }
  catch (e) { error = String(e?.message ?? e) }
  if (error) {
    const after = mutationSignature(ctx)
    assert.deepEqual(after, before, `${ctx.name}/${spec.label}: failed exchange must rollback documents, credit, and stock`)
    await checkpoint(ctx, `${spec.label} rejected atomically: ${error}`)
    return { ok: false, error }
  }
  const diff = n(operation.diff)
  assert.equal(diff, n(preview.effectiveDiff), `${ctx.name}/${spec.label}: committed difference must match the effective-funding preview`)
  if (diff > 0) {
    if (spec.tender === 'BARCODE') {
      assert.equal(n(operation.barcodeCreditApplied), diff, `${ctx.name}/${spec.label}: full positive difference covered by barcode`)
      assert.equal(n(operation.cashReceived), 0); assert.equal(n(operation.cardReceived), 0)
    } else {
      const actual = n(spec.tender === 'CASH' ? operation.cashReceived : operation.cardReceived)
      assert.equal(actual, diff, `${ctx.name}/${spec.label}: physical positive difference received once`)
      assert.equal(n(operation.barcodeCreditApplied), 0)
      addPhysicalResponse(ctx, operation, spec.tender)
    }
  } else {
    const limit = Math.max(0, Math.min(-diff, spec.realMoneyBacking))
    const cashOut = addRefundResponse(ctx, operation, 'CASH')
    const cardOut = addRefundResponse(ctx, operation, 'CARD')
    assert.ok(cashOut + cardOut <= limit, `${ctx.name}/${spec.label}: physical refund ${cashOut + cardOut} exceeds available real-money backing ${limit}; barcode must not become cash`)
    if (spec.tender === 'STORE_CREDIT') {
      assert.equal(cashOut + cardOut, 0, `${ctx.name}/${spec.label}: store-credit settlement has no physical refund`)
    }
  }
  ctx.invoices.push(n(operation.exchangeInvoiceId))
  if (operation.returnId != null) rememberReturnCredits(ctx, operation.returnId, `${spec.label}-credit`)
  adjustStock(ctx, spec.stockDelta)
  const event = await checkpoint(ctx, `${spec.label} success; diff=${diff}; return=${operation.returnId}; exchangeInvoice=${operation.exchangeInvoiceId}`, { note: spec.note ?? '' })
  return { ok: true, operation, event }
}
async function createPositiveInput(ctx, { invoiceId, targetLines, replacements, diff, mode, label, creditCode }) {
  if (mode === 'BARCODE') {
    let selected = creditCode ? { code: creditCode } : eligibleTenderCode(ctx, diff)
    if (!selected) {
      const issued = await issueCredit(ctx, diff, { multiUse: true, label: `${label}-fresh-tender-code` })
      selected = { code: issued.code }
    }
    return { userId, shiftId: ctx.shiftId, invoiceId, lines: targetLines, replacements,
      exchangeCreditCode: selected.code, idempotencyKey: `e100-${ctx.index}-${label}-credit` }
  }
  return { userId, shiftId: ctx.shiftId, invoiceId, lines: targetLines, replacements, methodId: mode === 'CASH' ? cash : card }
}
async function runCase(index) {
  const shiftId = seed.insert('Shift', { name: `E100 scenario ${String(index + 1).padStart(3, '0')}`, number: index + 100, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
  const ctx = {
    index: index + 1, name: `E100-${String(index + 1).padStart(3, '0')}`, shiftId,
    variants: [], credits: [], invoices: [], events: [], expectedBlocks: [], findings: [], expected: { cash: 0, card: 0, refundCash: 0, refundCard: 0 },
    config: {}
  }
  let stage = 'baseline'
  try {
    await checkpoint(ctx, 'baseline; isolated shift starts at zero blue and stock ledger')
    const A = newVariant(ctx, 'A-root-200k', 200_000)
    const B = newVariant(ctx, 'B-root-200k', 200_000)
    const C = newVariant(ctx, 'C-root-300k', 300_000)
    const D = newVariant(ctx, 'D-root-300k', 300_000)
    const creditCount = process.env.MAHAK_E2E_FORCE_CREDIT_COUNT == null
      ? creditCounts[index % creditCounts.length] : Number(process.env.MAHAK_E2E_FORCE_CREDIT_COUNT)
    const unit = process.env.MAHAK_E2E_FORCE_CREDIT_UNIT == null
      ? creditUnits[Math.floor(index / 6) % creditUnits.length] : Number(process.env.MAHAK_E2E_FORCE_CREDIT_UNIT)
    const lifecycle = process.env.MAHAK_E2E_FORCE_LIFECYCLE ?? lifecycleKinds[Math.floor(index / 18) % lifecycleKinds.length]
    const tender = process.env.MAHAK_E2E_FORCE_TENDER ?? tenderKinds[Math.floor(index / 3) % tenderKinds.length]
    const scopeMode = process.env.MAHAK_E2E_FORCE_SCOPE ?? (index % 10 === 0 ? 'VARIANTS_BCD' : index % 10 === 1 ? 'VARIANTS_ALL' : 'ALL')
    assert.ok([0, 1, 2, 3, 4, 6].includes(creditCount), `unsupported forced credit count ${creditCount}`)
    assert.ok([25_000, 50_000, 100_000].includes(unit), `unsupported forced credit unit ${unit}`)
    assert.ok(lifecycleKinds.includes(lifecycle), `unsupported forced lifecycle ${lifecycle}`)
    assert.ok(tenderKinds.includes(tender), `unsupported forced purchase tender ${tender}`)
    assert.ok(['ALL', 'VARIANTS_ALL', 'VARIANTS_BCD'].includes(scopeMode), `unsupported forced scope ${scopeMode}`)
    const multi = lifecycle !== 'SINGLE_USED'
    const consumeRemainder = lifecycle === 'MULTI_USED_TWICE' || (lifecycle === 'MULTI_LIVE' && index % 5 === 0)
    const sourceCreditTotal = creditCount * unit
    const eligibleForA = scopeMode !== 'VARIANTS_BCD'
    const returnedCreditExpected = eligibleForA ? Math.min(200_000, sourceCreditTotal) : 0
    const moneyRight = 200_000 - returnedCreditExpected
    const physicalSale = 1_000_000 - sourceCreditTotal
    const cashShare = tender === 'CASH' ? physicalSale : tender === 'CARD' ? 0 : Math.floor(physicalSale / 2)
    const cardShare = physicalSale - cashShare
    const returnMethod = process.env.MAHAK_E2E_FORCE_RETURN_METHOD ?? rootReturnMethod(index, tender, moneyRight)
    const b1Price = process.env.MAHAK_E2E_FORCE_B1_PRICE == null
      ? (index % 2 === 0 ? 180_000 : 220_000) : Number(process.env.MAHAK_E2E_FORCE_B1_PRICE)
    const cdPositive = process.env.MAHAK_E2E_FORCE_CD_POSITIVE == null
      ? Math.floor(index / 2) % 2 === 1 : process.env.MAHAK_E2E_FORCE_CD_POSITIVE === '1'
    assert.ok(['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE'].includes(returnMethod), `unsupported forced return method ${returnMethod}`)
    assert.ok([180_000, 220_000].includes(b1Price), `unsupported forced B1 price ${b1Price}`)
    const c1Price = cdPositive ? 310_000 : 290_000
    const d1Price = cdPositive ? 310_000 : 290_000
    const B1 = newVariant(ctx, `B1-${b1Price}`, b1Price)
    const C1 = newVariant(ctx, `C1-${c1Price}`, c1Price)
    const D1 = newVariant(ctx, `D1-${d1Price}`, d1Price)
    const B2 = newVariant(ctx, 'B2-reexchange-200k', 200_000)
    const auxVariants = multi && consumeRemainder && creditCount > 0
      ? Array.from({ length: creditCount }, (_, c) => newVariant(ctx, `aux-${c + 1}-${unit}`, unit)) : []
    ctx.config = { creditCount, unit, lifecycle, consumeRemainder, tender, scopeMode, sourceCreditTotal, returnedCreditExpected, moneyRight, cashShare, cardShare, returnMethod, b1Price, cdExchangeDiff: cdPositive ? 20_000 : -20_000 }
    const items = [A, B, C, D]
    const allowedIds = scopeMode === 'VARIANTS_BCD'
      ? [B, C, D, B1, C1, D1, B2, ...auxVariants].map(v => v.id)
      : scopeMode === 'VARIANTS_ALL'
        ? [...items, B1, C1, D1, B2, ...auxVariants].map(v => v.id) : null
    const codes = []
    for (let c = 0; c < creditCount; c++) {
      stage = `issue source barcode ${c + 1}/${creditCount}`
      const allowed = allowedIds
      const issued = await issueCredit(ctx, multi ? unit * 2 : unit, { multiUse: multi, label: `source-${c + 1}`, restrictVariantIds: allowed })
      codes.push({ id: issued.id, code: issued.code, requestedAmount: unit, scope: scopeMode })
    }
    stage = 'root four-item sale'
    const payments = [...paymentRows('CASH', cashShare), ...paymentRows('CARD', cardShare)]
    const sale = await salesService.create(saleInput({ ctx, lines: items.map(v => line(v)), credits: codes.map(c => ({ code: c.code, requestedAmount: c.requestedAmount })), payments, key: `e100-${ctx.index}-root` }))
    assert.equal(n(sale.grandTotal), 1_000_000)
    assert.equal(n(sale.storeCreditApplied), sourceCreditTotal)
    ctx.rootInvoice = n(sale.id); ctx.invoices.push(n(sale.id))
    const rootRows = saleItems(sale.id)
    const rootItem = v => rootRows.find(r => n(r.variantId) === v.id)
    await checkpoint(ctx, `root sale A+B+C+D=1,000,000; ${creditCount} barcodes=${sourceCreditTotal}; cash=${cashShare}; POS=${cardShare}`, {
      flow: { cash: cashShare, card: cardShare }, stock: { [A.id]: -1, [B.id]: -1, [C.id]: -1, [D.id]: -1 },
      note: `${lifecycle}; initial barcode count varied across 0/1/2/3/4/6; source scope=${scopeMode}`
    })

    // Spend the residual balance for multi-use codes in an independent invoice in
    // selected scenarios; this catches valid repeated redemption and later USED status.
    if (multi && consumeRemainder && creditCount > 0) {
      stage = 'second legitimate redemption of multi-use source codes'
      const auxLines = auxVariants.map(v => line(v))
      const auxSale = await salesService.create(saleInput({ ctx, lines: auxLines, credits: codes.map(c => ({ code: c.code, requestedAmount: unit })), payments: [], key: `e100-${ctx.index}-multi-reuse` }))
      assert.equal(n(auxSale.grandTotal), sourceCreditTotal)
      assert.equal(n(auxSale.storeCreditApplied), sourceCreditTotal)
      ctx.invoices.push(n(auxSale.id))
      await checkpoint(ctx, `multi-use codes legitimately redeemed a second time for ${sourceCreditTotal}`, {
        stock: Object.fromEntries(auxLines.map(x => [x.variantId, -1])),
        note: 'second distinct redemption sequence per code; no physical payment and no blue increase'
      })
    }

    // A fully spent barcode must never pay a second time. A still-live multi-use
    // code is not probed here; it remains available for a later exchange tender.
    if (creditCount === 0) {
      stage = 'zero-code control: issue and spend a probe barcode'
      const probe = await issueCredit(ctx, 20_000, { multiUse: false, label: 'zero-code-probe' })
      const v = newVariant(ctx, 'zero-code-probe-item', 20_000)
      const probeSale = await salesService.create(saleInput({ ctx, lines: [line(v)], credits: [{ code: probe.code, requestedAmount: 20_000 }], payments: [], key: `e100-${ctx.index}-probe-once` }))
      ctx.invoices.push(n(probeSale.id))
      await checkpoint(ctx, 'zero-code root sale remains zero-barcode; separate one-time probe is consumed', { stock: { [v.id]: -1 } })
      codes.push({ id: probe.id, code: probe.code, requestedAmount: 20_000, scope: 'PROBE_ONLY' })
    }
    const consumedCode = codes.find(c => {
      const r = rawCredit(c.id)
      return n(r.usedAmount) === n(r.amount)
    })
    if (consumedCode) {
      stage = 'read-only double-spend check for fully consumed barcode'
      const before = mutationSignature(ctx)
      const attempt = await markExpectedRejection(ctx, 'panel lookup/preview check of fully used barcode', () => storeCreditService.lookup({ code: consumedCode.code, userId }))
      if (!attempt.rejected) {
        ctx.findings.push({ type: 'USED_CODE_STILL_LOOKUP_REDEEMABLE', barcodeId: consumedCode.id, code: consumedCode.code, before, after: attempt.after, message: 'Read-only credit lookup still considered a fully used code redeemable.' })
        ctx.status = 'FAIL'
      }
      await checkpoint(ctx, 'read-only used-code guard; no invoice/payment/stock/redemption mutation', { note: attempt.error })
    }

    // Probe unauthorised conversion of credit-funded value to cash in 20% of cases.
    // Any accepted payout is checked against the money-backed right, not merely the API result.
    let returned = null
    if (moneyRight === 0 && index % 5 === 0) {
      stage = 'cash-out probe against credit-only returned item'
      const badMethod = tender === 'CARD' ? 'CARD' : 'CASH'
      const badInput = {
        userId, shiftId, invoiceId: sale.id, full: false,
        lines: [{ saleItemId: n(rootItem(A).id), qty: 1 }], refundMethod: badMethod,
        refundAmount: 10_000, confirmOverpay: true, overpayAsCredit: true,
        overpayManagerPassword: DEFAULT_MANAGER_PASSWORD
      }
      if (badMethod === 'CARD') badInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `E100-${ctx.index} credit-only payout probe`, managerPassword: DEFAULT_MANAGER_PASSWORD }
      const before = mutationSignature(ctx)
      let error = ''
      try { returned = await salesService.createReturn(badInput) } catch (e) { error = String(e?.message ?? e) }
      if (error) {
        assert.deepEqual(mutationSignature(ctx), before, `${ctx.name}: credit-only attempted cashout must rollback`)
        ctx.expectedBlocks.push({ label: 'credit-only cashout probe', message: error, mutationFree: true, expected: 'no physical refund from fully credit-funded item' })
        await checkpoint(ctx, `credit-only cashout blocked safely: ${error}`)
      } else {
        const actualRaw = rawPhysical(ctx.shiftId)
        const physicalOut = actualRaw.refundCash + actualRaw.refundCard - ctx.expected.refundCash - ctx.expected.refundCard
        if (physicalOut > 0) ctx.findings.push({ type: 'CREDIT_TO_CASH_CONVERSION', physicalOut, permittedBacking: 0, returnId: n(returned.id) })
        const restored = n(returned.sourceCreditRestoredAmount)
        assert.equal(restored, returnedCreditExpected, `${ctx.name}: cashout probe source restoration`)
        if (physicalOut > 0) throw new Error(`POLICY_BREACH: ${physicalOut} physical refund issued for a credit-only returned item`)
        captureNewReturnCredits(ctx, returned, 'credit-only-cashout-probe-credit')
        adjustStock(ctx, { [A.id]: 1 })
        ctx.expectedBlocks.push({ label: 'credit-only cashout probe accepted with zero cash', message: 'accepted, but actual physical payout remained zero', mutationFree: false, expected: 'no cash conversion' })
        await checkpoint(ctx, 'credit-only cashout selection did not cause any physical payout; source credit restored', { note: `refund=${n(returned.refundAmount)}; raw physical delta=${physicalOut}` })
      }
    }

    if (!returned) {
      stage = 'return root item A'
      const actualMode = returnMethod
      const retInput = { userId, shiftId, invoiceId: sale.id, full: false, lines: [{ saleItemId: n(rootItem(A).id), qty: 1 }], refundMethod: actualMode }
      if (['CASH', 'CARD', 'CARD_TO_CARD'].includes(actualMode)) retInput.refundAmount = moneyRight
      if (actualMode === 'CARD') retInput.cardPosOverride = { acknowledgedNoReverse: true, reason: `E100-${ctx.index} POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
      if (actualMode === 'NONE') { retInput.confirmOverpay = true; retInput.overpayAsCredit = true; retInput.overpayManagerPassword = DEFAULT_MANAGER_PASSWORD }
      returned = await salesService.createReturn(retInput)
      assert.equal(n(returned.total), 200_000)
      assert.equal(n(returned.sourceCreditRestoredAmount), returnedCreditExpected, `${ctx.name}: only backed source barcode share restored`)
      if (['CASH', 'CARD', 'CARD_TO_CARD'].includes(actualMode)) assert.equal(n(returned.refundAmount), moneyRight, `${ctx.name}: requested physical share matches real-money backing`)
      captureNewReturnCredits(ctx, returned, 'root-return-credit')
      if (actualMode === 'CARD_TO_CARD') {
        const transfer = await settleC2C(ctx, returned, moneyRight, 'root return')
        returned.c2cPaid = transfer
        adjustStock(ctx, { [A.id]: 1 })
      } else adjustStock(ctx, { [A.id]: 1 })
      if (actualMode === 'STORE_CREDIT' && moneyRight > 0) {
        const returnRows = seed.rows('SELECT id,amount,expiresAt,source FROM "StoreCredit" WHERE returnId=? ORDER BY id', returned.id)
        const nonSuccessor = returnRows.filter(r => !(returned.sourceCreditSuccessors ?? []).some(s => n(s.id) === n(r.id)))
        const backedMoney = nonSuccessor.reduce((sum, r) => sum + n(r.amount), 0)
        assert.ok(backedMoney >= moneyRight, `${ctx.name}: explicit STORE_CREDIT covers real-money return share`)
        assert.ok(nonSuccessor.filter(r => n(r.amount) > 0).every(r => r.expiresAt == null), `${ctx.name}: money-backed return credit is non-expiring`)
      }
      if (actualMode === 'NONE' && moneyRight > 0) {
        const overpay = n(returned.overpayCredit?.amount ?? 0)
        assert.equal(overpay, moneyRight, `${ctx.name}: no-method backed money becomes equal non-expiring credit`)
        assert.equal(returned.overpayCredit?.expiresAt ?? null, null)
      }
      await checkpoint(ctx, `return A 200,000 via ${actualMode}; source barcode restored=${returnedCreditExpected}; real-money right=${moneyRight}`, {
        flow: { refundCash: actualMode === 'CASH' ? n(returned.refundAmount) : 0, refundCard: actualMode === 'CARD' ? n(returned.refundAmount) : 0 },
        stock: {}, note: `return #${returned.id}; C2C=${returned.c2cPaid ? 'manager-paid; not blue' : 'not used'}; only cash/POS refund enters blue`
      })
    }
    ctx.returnId = n(returned.id)

    // Every main scenario now has a root return; exchange B, exchange C+D together,
    // then re-exchange B1 through the child invoice the customer presents.
    stage = 'exchange B to B1'
    const bOriginalLine = n(rootItem(B).id)
    let exB
    if (b1Price < B.price) {
      const bSourceBacking = Math.max(0, Math.min(B.price, sourceCreditTotal - returnedCreditExpected))
      const refundMode = physicalRefundMode(index, tender, B.price - bSourceBacking)
      const input = { userId, shiftId, invoiceId: sale.id, lines: [{ saleItemId: bOriginalLine, qty: 1 }], replacements: [line(B1)], refundMode }
      if (refundMode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `E100-${ctx.index} negative exchange POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
      const outcome = await applyExchange(ctx, { label: 'exchange B 200k to B1 180k', input, expectedDiff: -20_000, realMoneyBacking: B.price - bSourceBacking,
        tender: refundMode, stockDelta: { [B.id]: 1, [B1.id]: -1 }, note: 'negative exchange; physical payout must be no greater than real-money funding after pooled source-credit restoration' })
      if (!outcome.ok) {
        if (B.price - bSourceBacking >= 20_000 && refundMode !== 'STORE_CREDIT') throw new Error(`UNEXPECTED_BLOCK: funded negative B exchange rejected: ${outcome.error}`)
        const fallback = await applyExchange(ctx, { label: 'retry B negative exchange as store credit after backed-tender block',
          input: { userId, shiftId, invoiceId: sale.id, lines: [{ saleItemId: bOriginalLine, qty: 1 }], replacements: [line(B1)], refundMode: 'STORE_CREDIT' },
          expectedDiff: -20_000, realMoneyBacking: 0, tender: 'STORE_CREDIT', stockDelta: { [B.id]: 1, [B1.id]: -1 }, note: `initial settlement blocked safely: ${outcome.error}` })
        if (!fallback.ok) throw new Error(`fallback negative B exchange failed: ${fallback.error}`)
        exB = fallback.operation
      } else {
        exB = outcome.operation
      }
    } else {
      const mode = tenderMode(index, ctx.credits.length > 0)
      const input = await createPositiveInput(ctx, { invoiceId: sale.id, targetLines: [{ saleItemId: bOriginalLine, qty: 1 }], replacements: [line(B1)], diff: 20_000, mode, label: 'B-positive-exchange' })
      const outcome = await applyExchange(ctx, { label: 'exchange B 200k to B1 220k', input, expectedDiff: 20_000, tender: mode, realMoneyBacking: 0,
        stockDelta: { [B.id]: 1, [B1.id]: -1 }, note: 'positive difference settled by exactly one cash, POS, or barcode tender' })
      if (!outcome.ok) throw new Error(`positive B exchange blocked: ${outcome.error}`)
      exB = outcome.operation
    }
    const bChildInvoice = n(exB.exchangeInvoiceId)
    assert.ok(bChildInvoice > 0)
    const bChildItem = saleItems(bChildInvoice).find(r => n(r.variantId) === B1.id)
    assert.ok(bChildItem, `${ctx.name}: B1 exists on child exchange invoice`)
    const bDifferenceCredit = seed.rows('SELECT id,code,amount,usedAmount,status FROM "StoreCredit" WHERE returnId=? ORDER BY id', exB.returnId ?? 0)
    for (const c of bDifferenceCredit) keepCredit(ctx, c.id, 'B-exchange-difference-credit')

    stage = 'exchange C and D together'
    const cdDiff = c1Price + d1Price - C.price - D.price
    assert.ok(cdDiff === 20_000 || cdDiff === -20_000)
    const cOriginalLine = n(rootItem(C).id), dOriginalLine = n(rootItem(D).id)
    let exCD
    if (cdDiff < 0) {
      const priorCreditRestored = returnedCreditExpected + n(exB.sourceCreditRestoredAmount ?? 0)
      const backing = Math.max(0, C.price + D.price - Math.max(0, sourceCreditTotal - priorCreditRestored))
      const refundMode = physicalRefundMode(index + 7, tender, backing)
      const input = { userId, shiftId, invoiceId: sale.id, lines: [{ saleItemId: cOriginalLine, qty: 1 }, { saleItemId: dOriginalLine, qty: 1 }], replacements: [line(C1), line(D1)], refundMode }
      if (refundMode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `E100-${ctx.index} two-item POS exchange refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
      const outcome = await applyExchange(ctx, { label: 'exchange C+D together, 700k to 680k', input, expectedDiff: -20_000, realMoneyBacking: backing, tender: refundMode,
        stockDelta: { [C.id]: 1, [D.id]: 1, [C1.id]: -1, [D1.id]: -1 },
        note: 'two source items returned in one exchange document; physical refund bounded by invoice-level real-money backing' })
      if (!outcome.ok) {
        if (backing >= 20_000 && refundMode !== 'STORE_CREDIT') throw new Error(`UNEXPECTED_BLOCK: funded two-item exchange rejected: ${outcome.error}`)
        const fallback = await applyExchange(ctx, { label: 'retry two-item negative exchange using store credit',
          input: { userId, shiftId, invoiceId: sale.id, lines: [{ saleItemId: cOriginalLine, qty: 1 }, { saleItemId: dOriginalLine, qty: 1 }], replacements: [line(C1), line(D1)], refundMode: 'STORE_CREDIT' },
          expectedDiff: -20_000, realMoneyBacking: 0, tender: 'STORE_CREDIT', stockDelta: { [C.id]: 1, [D.id]: 1, [C1.id]: -1, [D1.id]: -1 }, note: `initial tender safely blocked: ${outcome.error}` })
        if (!fallback.ok) throw new Error(`fallback C+D exchange failed: ${fallback.error}`)
        exCD = fallback.operation
      } else {
        exCD = outcome.operation
      }
    } else {
      const mode = tenderMode(index + 3, ctx.credits.length > 0)
      const input = await createPositiveInput(ctx, { invoiceId: sale.id, targetLines: [{ saleItemId: cOriginalLine, qty: 1 }, { saleItemId: dOriginalLine, qty: 1 }], replacements: [line(C1), line(D1)], diff: 20_000, mode, label: 'CD-positive-exchange' })
      const outcome = await applyExchange(ctx, { label: 'exchange C+D together, 700k to 720k', input, expectedDiff: 20_000, tender: mode, realMoneyBacking: 0,
        stockDelta: { [C.id]: 1, [D.id]: 1, [C1.id]: -1, [D1.id]: -1 }, note: 'two returned items and two replacements in one exchange; positive difference collected once' })
      if (!outcome.ok) throw new Error(`positive two-item exchange blocked: ${outcome.error}`)
      exCD = outcome.operation
    }

    stage = 're-exchange B1 from its child invoice'
    const secondDiff = B2.price - B1.price
    assert.ok(secondDiff === 20_000 || secondDiff === -20_000)
    let exB2
    if (secondDiff > 0) {
      // Prefer the credit generated by B's first negative exchange, then a live
      // returned source barcode; issue a fresh tender only when the case has none.
      const diffCredit = bDifferenceCredit.find(c => {
        const r = rawCredit(c.id)
        return n(r.amount) - n(r.usedAmount) >= secondDiff && r.status === 'ACTIVE' && String(r.restrictScope ?? 'ALL').toUpperCase() === 'ALL'
      })
      const mode = diffCredit ? 'BARCODE' : tenderMode(index + 2, ctx.credits.length > 0)
      const input = await createPositiveInput(ctx, { invoiceId: bChildInvoice, targetLines: [{ saleItemId: n(bChildItem.id), qty: 1 }], replacements: [line(B2)], diff: secondDiff, mode, label: 'B1-reexchange-positive', creditCode: diffCredit?.code })
      const outcome = await applyExchange(ctx, { label: 're-exchange already-exchanged B1 from invoice 2 to B2 200k', input, expectedDiff: secondDiff, tender: mode, realMoneyBacking: 0,
        stockDelta: { [B1.id]: 1, [B2.id]: -1 }, note: 'source is the child invoice that actually sold B1; tests second-generation exchange and no duplicate refund' })
      if (!outcome.ok) throw new Error(`second-generation positive exchange blocked: ${outcome.error}`)
      exB2 = outcome.operation
    } else {
      const priorCreditOnChild = n(exB.barcodeCreditApplied ?? 0) + n(exB.sourceCreditRestoredAmount ?? 0)
      const childMoneyBacking = Math.max(0, B1.price - Math.min(B1.price, priorCreditOnChild))
      let mode = physicalRefundMode(index + 5, tender, childMoneyBacking)
      const input = { userId, shiftId, invoiceId: bChildInvoice, lines: [{ saleItemId: n(bChildItem.id), qty: 1 }], replacements: [line(B2)], refundMode: mode }
      if (mode === 'CARD') input.cardPosOverride = { acknowledgedNoReverse: true, reason: `E100-${ctx.index} child re-exchange POS refund`, managerPassword: DEFAULT_MANAGER_PASSWORD }
      let outcome = await applyExchange(ctx, { label: 're-exchange B1 from invoice 2 down to B2 200k', input, expectedDiff: -20_000, realMoneyBacking: childMoneyBacking, tender: mode,
        stockDelta: { [B1.id]: 1, [B2.id]: -1 },
        note: 'downward re-exchange of a previously exchanged item; refund bounded by physical funds on the child chain' })
      if (!outcome.ok) {
        if (childMoneyBacking >= 20_000 && mode !== 'STORE_CREDIT') throw new Error(`UNEXPECTED_BLOCK: backed second-generation refund rejected: ${outcome.error}`)
        mode = 'STORE_CREDIT'
        outcome = await applyExchange(ctx, { label: 'retry child re-exchange with noncash store credit', input: { userId, shiftId, invoiceId: bChildInvoice, lines: [{ saleItemId: n(bChildItem.id), qty: 1 }], replacements: [line(B2)], refundMode: mode }, expectedDiff: -20_000, realMoneyBacking: 0, tender: mode,
          stockDelta: { [B1.id]: 1, [B2.id]: -1 }, note: `no backed child cash or card available for first selection: ${outcome.error}` })
      }
      if (!outcome.ok) throw new Error(`second-generation negative exchange blocked: ${outcome.error}`)
      exB2 = outcome.operation
    }
    const lastReturn = seed.one('SELECT invoiceId,exchangeInvoiceId,exchangeDiff FROM "SaleReturn" WHERE id=?', exB2.returnId)
    assert.equal(n(lastReturn.invoiceId), bChildInvoice, `${ctx.name}: returned/exchanged SKU is the earlier B1 child-invoice item`)
    assert.equal(n(seed.one('SELECT sourceInvoiceId FROM "SaleInvoice" WHERE id=?', exB2.exchangeInvoiceId).sourceInvoiceId), bChildInvoice)
    ctx.reexchange = { returnId: n(exB2.returnId), childSourceInvoice: bChildInvoice, newInvoice: n(exB2.exchangeInvoiceId), diff: n(exB2.diff) }

    // Check return-restoration shares against the redemption amount. The distinct
    // exchange-consume-credit event records source credit consumed by a replacement
    // invoice (not a returned/restored share), so it must not be added to return value.
    const redemptions = seed.rows('SELECT id,amount FROM "StoreCreditRedemption" WHERE invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', ctx.shiftId)
    for (const redemption of redemptions) {
      const allocated = n(seed.one(
        'SELECT COALESCE(SUM(amount),0) total FROM "CreditReturnAllocation" WHERE redemptionId=? AND eventKey NOT LIKE ?',
        redemption.id, 'exchange-consume-credit:%'
      ).total)
      assert.ok(allocated <= n(redemption.amount), `${ctx.name}: return-restoration allocation ${allocated} exceeds redemption ${redemption.id} amount ${redemption.amount}`)
    }
    await checkpoint(ctx, 'final chain: root return, B exchange, C+D two-item exchange, B1 re-exchange, all barcode/redemption/allocation caps', {
      note: 'final blue is recomputed from raw physical documents; each barcode usedAmount/count and every stock ledger reconciled'
    })
    ctx.status = ctx.findings.length ? 'FAIL' : 'PASS'
    ctx.summary = `n=${creditCount}, unit=${unit}, ${lifecycle}/${consumeRemainder ? 'reused' : 'residual'}, ${tender}, return=${returnMethod}; B→${b1Price}, C+D diff=${cdPositive ? '+20k' : '-20k'}, B1→B2=${secondDiff > 0 ? '+20k' : '-20k'}`
  } catch (e) {
    const failureMessage = String(e?.message ?? e)
    const requiresAllocationReview = failureMessage.includes('تخصیص منشأ اعتبار ندارد') ||
      failureMessage.includes('سهم اعتبارِ قابل‌ردیابی ندارد') ||
      failureMessage.includes('اعتبارهای باقی‌مانده محدود به scope')
    ctx.status = requiresAllocationReview ? 'BLOCKED' : 'FAIL'
    ctx.failure = { stage, message: failureMessage, stack: String(e?.stack ?? '') }
    if (requiresAllocationReview) ctx.blocked = {
      classification: 'SAFE_STOP_REQUIRES_POLICY_REVIEW',
      reason: 'Exchange was rejected because a prior return has no source-credit allocation row; the runner confirmed the attempted exchange was mutation-free. Determine whether this prior return truly makes funding ambiguous or is unrelated to the new exchange.'
    }
    ctx.findings.push(...creditIntegrityFindings(ctx))
    try {
      const actual = rawPhysical(ctx.shiftId), report = await salesService.reportRows({ shiftId: ctx.shiftId })
      ctx.postFailure = { actual, report: { cash: n(report.totals.cashTotal), card: n(report.totals.cardTotal), refundCash: n(report.totals.refundCashTotal), refundCard: n(report.totals.refundCardTotal) }, signature: mutationSignature(ctx), expectedBeforeFailure: ctx.expected, stock: ctx.variants.map(v => ({ sku: v.name, expected: v.expected, actual: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })) }
      try { await checkpoint(ctx, `post-failure reconciliation at stage ${stage}`) } catch (verify) { ctx.postFailure.reconciliationError = String(verify?.message ?? verify) }
    } catch (verify) { ctx.postFailure = { verificationError: String(verify?.message ?? verify) } }
  }
  results.push(ctx)
}

const caseLimit = Math.max(1, Math.min(100, Number(process.env.MAHAK_E2E_CASE_LIMIT ?? 100)))
const selectedCase = process.env.MAHAK_E2E_CASE_INDEX == null ? null : Number(process.env.MAHAK_E2E_CASE_INDEX)
if (selectedCase != null) assert.ok(Number.isInteger(selectedCase) && selectedCase >= 1 && selectedCase <= 100, 'MAHAK_E2E_CASE_INDEX must be 1..100')
const caseIndices = selectedCase == null ? Array.from({ length: caseLimit }, (_, i) => i) : [selectedCase - 1]
for (const i of caseIndices) await runCase(i)

const finalSettlementRows = seed.one(`SELECT COUNT(*) total,
  COALESCE(SUM(CASE WHEN paidTotal<>grandTotal THEN 1 ELSE 0 END),0) unpaid,
  COALESCE(SUM(CASE WHEN settledAt IS NULL THEN 1 ELSE 0 END),0) unsettled FROM "SaleInvoice"`)
const finalCheckPayments = n(seed.one(`SELECT COUNT(*) total FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId
  WHERE UPPER(m.kind) IN ('CHECK','CHEQUE')`).total)
const financialSafety = {
  invoiceCount: n(finalSettlementRows.total), unpaidInvoices: n(finalSettlementRows.unpaid), unsettledInvoices: n(finalSettlementRows.unsettled),
  checkPayments: finalCheckPayments,
  debtTables: seed.rows("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE '%debt%' ORDER BY name").map(x => x.name)
}
assert.ok(financialSafety.invoiceCount > 0)
assert.equal(financialSafety.unpaidInvoices, 0, 'isolated suite has no unpaid/debt invoices')
assert.equal(financialSafety.unsettledInvoices, 0, 'isolated suite has no unsettled invoices')
assert.equal(financialSafety.checkPayments, 0, 'isolated suite has no check tender')
assert.equal(financialSafety.debtTables.length, 0, 'isolated harness has no debt table or debt-settlement path')
const summary = {
  generatedAt: now(), isolatedDatabase: process.env.HARNESS_DB,
  financialSafety,
  requestedScenarios: caseIndices.length, executedScenarios: results.length, caseLimit,
  selectedCase: selectedCase ?? null, forcedScope: process.env.MAHAK_E2E_FORCE_SCOPE ?? null,
  passed: results.filter(x => x.status === 'PASS').length,
  failed: results.filter(x => x.status === 'FAIL').length,
  blocked: results.filter(x => x.status === 'BLOCKED').length,
  unexpectedErrors: results.filter(x => x.status === 'FAIL').length,
  findings: results.reduce((sum, x) => sum + (x.findings?.length ?? 0), 0),
  expectedBlocks: results.reduce((sum, x) => sum + (x.expectedBlocks?.length ?? 0), 0),
  barcodeCountsTested: [...new Set(results.map(x => x.config?.creditCount).filter(x => x != null))].sort((a,b) => a-b),
  purchaseTenderKindsTested: [...new Set(results.map(x => x.config?.tender).filter(Boolean))],
  returnModesTested: [...new Set(results.map(x => x.config?.returnMethod).filter(Boolean))],
  noChecksDebtOrSettlements: financialSafety.checkPayments === 0 && financialSafety.unpaidInvoices === 0 && financialSafety.unsettledInvoices === 0 && financialSafety.debtTables.length === 0,
  blueDefinition: 'physical cash received + POS received - cash refund - POS refund; store credit and pending/paid C2C transfers are excluded',
  results
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
const reportStem = process.env.MAHAK_E2E_REPORT_STEM ?? 'deep-e2e-100-credit-exchange-chains'
const reportTitle = process.env.MAHAK_E2E_REPORT_TITLE ?? 'گزارش ۱۰۰ سناریوی مستقل زنجیرهٔ فروش/اعتبار/برگشت/تعویض'
const jsonPath = join(out, `${reportStem}.json`), markdownPath = join(out, `${reportStem}.md`)
writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n')
const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
const lines = [
  `# ${reportTitle}`, '', 
  `**اجرا:** ${summary.executedScenarios}/${summary.requestedScenarios} جریان · PASS ${summary.passed} · FAIL ${summary.failed} · خطای غیرمنتظره ${summary.unexpectedErrors} · توقف امن ${summary.blocked} · finding ${summary.findings} · رد مورد انتظار ${summary.expectedBlocks}.`,
  `**دیتابیس:** SQLite موقت ایزوله (${summary.isolatedDatabase}).`,
  `**تعریف blue:** ${summary.blueDefinition}.`,
  `**تسویه/چک/نسیه:** ${financialSafety.invoiceCount} فاکتور؛ پرداخت‌نشده ${financialSafety.unpaidInvoices}؛ تسویه‌نشده ${financialSafety.unsettledInvoices}؛ پرداخت چکی ${financialSafety.checkPayments}؛ جدول بدهی ${financialSafety.debtTables.length}.`,
  `**ماتریس:** تعداد بارکد فروش ${summary.barcodeCountsTested.join('/')}; tender فروش ${summary.purchaseTenderKindsTested.join('/')}; روش‌های برگشت ${summary.returnModesTested.join('/')}.`, '',
  'هر شماره یک جریان مستقل با shift، SKUها، فاکتورها و اعتبارهای خودش است؛ شاخه‌های پرداخت به‌عنوان سناریوی مستقل جدا شمرده نشده‌اند. هر عملیات و رد/تلاش تکراری checkpoint دارد؛ وضعیت BLOCKED یعنی ادامهٔ زنجیره به‌علت توقف امن انجام نشد و جداگانه گزارش شده است.', '',
  '| # | وضعیت | تعداد کد/مبلغ کد | مدل مصرف | tender | روش برگشت | مراحل تعویض | نتیجه/رد/خطا |', '|---:|---|---:|---|---|---|---|---|',
  ...results.map((r, i) => {
    const c = r.config ?? {}
    const stage = c.b1Price == null ? '—' : `B→${fa(c.b1Price)}; C+D ${c.cdExchangeDiff > 0 ? '+20k' : '-20k'}; B1→B2`
    const detail = r.failure?.message ?? r.findings?.map(x => x.type).join(', ') ?? r.summary ?? ''
    return `| ${r.index ?? i + 1} | ${r.status} | ${c.creditCount ?? '—'} × ${fa(c.unit)} | ${c.lifecycle ?? '—'} ${c.consumeRemainder ? 'و redemption دوم' : ''} | ${c.tender ?? '—'} | ${c.returnMethod ?? '—'} | ${stage} | ${String(detail).replaceAll('|', '\\|').replaceAll('\n', ' ')} |`
  }),
  '', '## یافته‌های double-spend / تبدیل اعتبار به پول نقد',
  ...results.flatMap((r, i) => (r.findings ?? []).map(f => `- سناریوی ${i + 1}: ${f.type}; ${JSON.stringify(f)}`)),
  '', '## توقف‌های ایمن نیازمند بازبینی سیاست/تخصیص',
  ...results.flatMap((r, i) => r.blocked ? [`- سناریوی ${i + 1}: ${r.blocked.classification}; ${r.failure?.message}; ${r.blocked.reason}`] : []),
  ...results.flatMap((r, i) => (r.expectedBlocks ?? []).map(b => `- سناریوی ${i + 1}، رد مورد انتظار و mutation-free: ${b.label}: ${b.message}`)), 
  ...(summary.findings === 0 ? ['- هیچ double-spend تأییدشده یا پرداخت نقد/POSِ بدون پشتوانه در نتایج نهایی ثبت نشد. هر تلاش بازاستفادهٔ کد کاملاًمصرف‌شده که رد شد، بدون invoice/payment/stock/redemption اضافی بود.'] : []),
  '', '## تطبیق ریزبه‌ریز',
  '- جزئیات هر رویداد در JSON کنار همین فایل است: انتظار و نتیجهٔ cash/POS/refunds/blue؛ stock SKU و ledger؛ invoice/return/exchange IDs؛ وضعیت/مانده/usedCount و redemption history هر کد؛ successor و delivery state؛ allocationهای منبع و وضعیت انتقال C2C.',
  '- در خرید اصلی تعداد کدها ۰،۱،۲،۳،۴ یا ۶ است؛ در موارد multi-use کدها یا نیمه‌مصرف‌شده می‌مانند یا با redemption دوم در فاکتور مستقل به‌طور مشروع مصرف می‌شوند. هر کد fully-used برای جلوگیری از double-spend دوباره امتحان می‌شود.',
  `- زنجیرهٔ هدف فروش چهارقلمی، برگشت A، تعویض B، تعویض هم‌زمان C+D و تعویض دوبارهٔ B1 از فاکتور child خودش بود؛ ${summary.passed} جریان کامل شدند و ${summary.blocked} مورد پیش از تکمیل، در گیت تخصیص منشأ اعتبار به‌صورت mutation-free متوقف شدند. تفاوت مثبت/منفی، tender نقد/POS/اعتبار و روش‌های برگشت در ماتریس چرخانده شدند.`,
  '', '## محدوده و محدودیت',
  '- فقط service-layer و SQLite موقت؛ پنل Electron واقعی، چاپگر واقعی و پایانهٔ POS واقعی اجرا نشدند.',
  '- هیچ چک، نسیه، دریافت نسیه، تسویهٔ نسیه، DB زنده، stage یا reset استفاده نشد.',
  '- کارت‌به‌کارت فقط در جدول درخواست آزمایشی و با مدیر test-paid می‌شود؛ انتقال واقعی بانکی نیست.',
  '- این تست هیچ production source را تغییر نمی‌دهد.'
]
writeFileSync(markdownPath, lines.join('\n') + '\n')
console.log(`100-chain suite: ${summary.executedScenarios}/${summary.requestedScenarios}; PASS=${summary.passed}; FAIL=${summary.failed}; BLOCKED=${summary.blocked}; findings=${summary.findings}; expectedBlocks=${summary.expectedBlocks}; report=${markdownPath}`)
await db.$disconnect?.()
if (summary.failed > 0 || summary.blocked > 0 || summary.executedScenarios !== summary.requestedScenarios) process.exitCode = 1
