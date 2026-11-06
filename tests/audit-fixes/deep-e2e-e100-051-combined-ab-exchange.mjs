/**
 * Diagnostic control for E100-051: exchange A and B together from the root invoice
 * in one exchange document, so there is no prior A-return document in the chain.
 * Test-only; uses a fresh temporary SQLite database and never connects to a live DB.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-e100-051-combined-'))
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
const userId = seed.user('E100-051 combined A+B audit cashier')
const card = seed.insert('PaymentMethod', { key: 'E100-051-CARD', label: 'isolated POS', kind: 'CARD', isActive: 1, sortOrder: 1 })
const category = seed.category('e100-051-combined-ab')
const shiftId = seed.insert('Shift', { name: 'E100-051 combined A+B diagnostic', number: 51051, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
const variants = []
let variantSeq = 0
const num = x => Number(x ?? 0)
function variant(name, price) {
  const product = seed.product(`E100-051-${++variantSeq}-${name}`, category)
  const id = seed.variant(product, `E100-051-${variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  const row = { id, name, price, startStock: 10 }
  variants.push(row)
  return row
}
const line = v => ({ variantId: v.id, qty: 1, unitPrice: v.price, discount: 0, tax: 0 })
function count(table) {
  const queries = {
    SaleInvoice: ['SELECT COUNT(*) n FROM "SaleInvoice" WHERE shiftId=?', [shiftId]],
    SaleReturn: ['SELECT COUNT(*) n FROM "SaleReturn" WHERE shiftId=?', [shiftId]],
    Payment: ['SELECT COUNT(*) n FROM "Payment" WHERE createdShiftId=?', [shiftId]],
    CashMovement: ['SELECT COUNT(*) n FROM "CashMovement" WHERE shiftId=?', [shiftId]],
    CardTransferRequest: ['SELECT COUNT(*) n FROM "CardTransferRequest" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', [shiftId]],
    StoreCreditRedemption: ['SELECT COUNT(*) n FROM "StoreCreditRedemption" WHERE invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)', [shiftId]],
    CreditReturnAllocation: ['SELECT COUNT(*) n FROM "CreditReturnAllocation" WHERE returnId IN (SELECT id FROM "SaleReturn" WHERE shiftId=?)', [shiftId]],
    StockMovement: [`SELECT COUNT(*) n FROM "StockMovement" WHERE variantId IN (${variants.map(() => '?').join(',')})`, variants.map(v => v.id)],
  }
  const [query, params] = queries[table]
  return num(sql.prepare(query).get(...params).n)
}
function creditRow(id) {
  return seed.one('SELECT id,code,amount,usedAmount,usedCount,status,restrictScope,restrictVariantIdsJson FROM "StoreCredit" WHERE id=?', id)
}
function physical() {
  const rows = seed.one(`SELECT
    COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card
    FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`, shiftId)
  const cashRefund = seed.one("SELECT COALESCE(SUM(amount),0) amount FROM \"CashMovement\" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')", shiftId)
  const cardRefund = seed.one("SELECT COALESCE(SUM(refundAmount),0) amount FROM \"SaleReturn\" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL", shiftId)
  return { cash: num(rows.cash), card: num(rows.card), refundCash: num(cashRefund.amount), refundCard: num(cardRefund.amount) }
}
function snapshot() {
  const tables = ['SaleInvoice', 'SaleReturn', 'Payment', 'CashMovement', 'CardTransferRequest', 'StoreCreditRedemption', 'CreditReturnAllocation', 'StockMovement']
  const counts = Object.fromEntries(tables.map(t => [t, count(t)]))
  const stocks = variants.map(v => ({ name: v.name, startStock: v.startStock, actual: num(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: num(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) }))
  const credits = seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,restrictScope,restrictVariantIdsJson FROM "StoreCredit" ORDER BY id')
    .map(r => ({ ...r, id: num(r.id), amount: num(r.amount), usedAmount: num(r.usedAmount), usedCount: num(r.usedCount) }))
  return { counts, physical: physical(), blue: num(physicalMovementForCustodyShiftSync()), stocks, credits }
}
function physicalMovementForCustodyShiftSync() {
  // The aggregate service is async; this helper is intentionally not used for final
  // values. Keep a raw, independently computed blue figure in synchronous snapshots.
  const p = physical()
  return p.cash + p.card - p.refundCash - p.refundCard
}
function signature(s) { return JSON.stringify(s) }

const result = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  case: 'E100-051 combined A+B exchange from original root invoice; no separate prior A return',
  setup: {}, operation: {}, status: '',
}
try {
  const A = variant('A-root-200k', 200_000)
  const B = variant('B-root-200k', 200_000)
  const C = variant('C-root-300k', 300_000)
  const D = variant('D-root-300k', 300_000)
  const A1 = variant('A1-200k', 200_000)
  const B1 = variant('B1-180k', 180_000)
  const aux1 = variant('aux-1-100k', 100_000)
  const aux2 = variant('aux-2-100k', 100_000)
  const allowlist = [B, C, D, B1, aux1, aux2].map(v => v.id)
  const sourceCredits = []
  for (let i = 1; i <= 2; i++) {
    const issued = await storeCreditService.issueManual({
      amount: 200_000, multiUse: true, maxUses: 10, carryRemainder: true, days: 30,
      userId, managerPassword: DEFAULT_MANAGER_PASSWORD,
      restrictScope: 'VARIANTS', restrictVariantIds: allowlist,
    })
    const stored = creditRow(issued.id)
    sourceCredits.push({ id: num(issued.id), code: stored.code })
  }
  const sale = await salesService.create({
    userId, shiftId,
    lines: [A, B, C, D].map(line),
    storeCredits: sourceCredits.map(c => ({ code: c.code, requestedAmount: 100_000 })),
    payments: [{ methodId: card, amount: 800_000, destination: 'CARD' }],
    saleRequestIdempotencyKey: 'e100-051-combined-root',
  })
  assert.equal(num(sale.grandTotal), 1_000_000)
  assert.equal(num(sale.storeCreditApplied), 200_000)
  const rootSettlement = seed.one('SELECT grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', sale.id)
  assert.equal(num(rootSettlement.paidTotal), num(rootSettlement.grandTotal))
  assert.ok(rootSettlement.settledAt != null)
  const rootId = num(sale.id)
  const rootItems = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', rootId)
  const itemId = v => num(rootItems.find(r => num(r.variantId) === v.id).id)

  const aux = await salesService.create({
    userId, shiftId, lines: [aux1, aux2].map(line),
    storeCredits: sourceCredits.map(c => ({ code: c.code, requestedAmount: 100_000 })), payments: [],
    saleRequestIdempotencyKey: 'e100-051-combined-auxiliary-redemption',
  })
  assert.equal(num(aux.grandTotal), 200_000)
  assert.equal(num(aux.storeCreditApplied), 200_000)
  const auxSettlement = seed.one('SELECT grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', aux.id)
  assert.equal(num(auxSettlement.paidTotal), num(auxSettlement.grandTotal))
  assert.ok(auxSettlement.settledAt != null)
  const before = snapshot()
  assert.equal(before.physical.card, 800_000)
  assert.equal(before.blue, 800_000)
  assert.ok(before.credits.every(c => c.status === 'USED' && c.usedAmount === 200_000 && c.usedCount === 2))

  result.setup = {
    prices: { A: 200_000, B: 200_000, C: 300_000, D: 300_000, A1: 200_000, B1: 180_000 },
    rootInvoiceId: rootId, auxiliaryInvoiceId: num(aux.id), sourceCredits,
    sourceCreditLifecycle: 'two restricted multi-use codes; each 100,000 on root and 100,000 on auxiliary invoice; both USED, usedCount=2',
    sourceScope: 'B/C/D and B1/auxiliary variants; A and A1 excluded',
    rootSettlement: { POS: 800_000, credit: 200_000, total: 1_000_000 },
    before,
  }

  let operation, error = ''
  try {
    operation = await salesService.createExchange({
      userId, shiftId, invoiceId: rootId,
      lines: [{ saleItemId: itemId(A), qty: 1 }, { saleItemId: itemId(B), qty: 1 }],
      replacements: [line(A1), line(B1)],
      refundMode: 'STORE_CREDIT',
    })
  } catch (e) { error = String(e?.message ?? e) }
  const after = snapshot()
  result.operation = {
    requestedTogether: ['A 200,000 → A1 200,000', 'B 200,000 → B1 180,000'],
    netDifference: -20_000, settlementRequested: 'STORE_CREDIT',
    error: error || null,
    returnedOperation: operation ? {
      returnId: operation.returnId == null ? null : num(operation.returnId),
      exchangeInvoiceId: operation.exchangeInvoiceId == null ? null : num(operation.exchangeInvoiceId),
      diff: num(operation.diff), cashRefunded: num(operation.cashRefunded), cardRefunded: num(operation.cardRefunded),
      barcodeCreditApplied: num(operation.barcodeCreditApplied), sourceCreditRestoredAmount: num(operation.sourceCreditRestoredAmount),
      refundStoreCreditAmount: num(operation.refundStoreCreditAmount),
    } : null,
    before, after,
  }
  if (error) {
    assert.equal(signature(after), signature(before), 'rejected combined exchange must be completely mutation-free')
    result.status = 'BLOCKED'
    result.operation.mutationFree = true
  } else {
    // Claude low-risk: diff=0 می‌تواند درست باشد به شرطِ صدورِ جانشینِ 20,000
    assert.equal(num(operation.diff), 0)
    assert.equal(num(operation.sourceCreditRestoredAmount), 20_000)
    assert.equal(after.blue, 800_000, 'STORE_CREDIT exchange must not change physical blue')
    assert.equal(after.physical.refundCash, 0)
    assert.equal(after.physical.refundCard, 0)
    // جانشینِ 20k باید با همان scope صادر شده باشد
    const successor = after.credits.find(c => num(c.amount) === 20_000 && c.status === 'ACTIVE')
    assert.ok(successor && successor.restrictScope === 'VARIANTS', 'successor 20k with same scope should exist')
    result.status = 'PASS'
    result.operation.mutationFree = false
    const ret = seed.one('SELECT id,invoiceId,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeInvoiceId,exchangeTotal,exchangeDiff,exchangeSettlement FROM "SaleReturn" WHERE id=?', operation.returnId)
    const child = seed.one('SELECT id,sourceInvoiceId,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE id=?', operation.exchangeInvoiceId)
    const allocations = seed.rows('SELECT id,returnId,redemptionId,sourceCreditId,amount,saleItemId,creditRestored,settlementAdjusted FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id', operation.returnId)
      .map(x => ({ ...x, id: num(x.id), returnId: num(x.returnId), redemptionId: num(x.redemptionId), sourceCreditId: num(x.sourceCreditId), amount: num(x.amount), saleItemId: x.saleItemId == null ? null : num(x.saleItemId), creditRestored: !!x.creditRestored, settlementAdjusted: !!x.settlementAdjusted }))
    const childLines = seed.rows('SELECT variantId,qty,unitPrice,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', operation.exchangeInvoiceId)
      .map(x => ({ variantId: num(x.variantId), qty: num(x.qty), unitPrice: num(x.unitPrice), lineTotal: num(x.lineTotal) }))
    result.operation.documents = { return: ret, childInvoice: child, childLines, allocations }
  }

  const report = await salesService.reportRows({ shiftId })
  const servicePhysical = { cash: num(report.totals.cashTotal), card: num(report.totals.cardTotal), refundCash: num(report.totals.refundCashTotal), refundCard: num(report.totals.refundCardTotal) }
  const blue = num(await physicalMovementForCustodyShift(shiftId))
  const invoices = seed.rows('SELECT id,sourceInvoiceId,grandTotal,paidTotal,settledAt FROM "SaleInvoice" WHERE shiftId=? ORDER BY id', shiftId)
    .map(x => ({ id: num(x.id), sourceInvoiceId: x.sourceInvoiceId == null ? null : num(x.sourceInvoiceId), grandTotal: num(x.grandTotal), paidTotal: num(x.paidTotal), settled: x.settledAt != null }))
  assert.ok(invoices.every(x => x.grandTotal === x.paidTotal && x.settled), 'all persisted invoices must be fully settled')
  assert.deepEqual(servicePhysical, physical(), 'service report equals raw payment/refund documents')
  assert.equal(blue, after.blue, 'blue aggregate matches independently computed physical balance')
  const expectedStockDelta = error ? {} : { [A.id]: 1, [B.id]: 1, [A1.id]: -1, [B1.id]: -1 }
  for (const s of after.stocks) {
    const v = variants.find(x => x.name === s.name)
    const delta = expectedStockDelta[v.id] ?? 0
    const prior = before.stocks.find(x => x.name === s.name)
    assert.equal(s.actual, prior.actual + delta, `stock after combined exchange: ${s.name}`)
    assert.equal(s.ledger, prior.ledger + delta, `stock ledger after combined exchange: ${s.name}`)
  }
  result.reconciliation = { invoices, servicePhysical, rawPhysical: physical(), serviceBlue: blue, rawBlue: after.blue, noChecksOrDebt: true }
} catch (e) {
  result.status = 'FAIL'
  result.unexpectedError = String(e?.stack ?? e)
  throw e
} finally {
  const out = resolve(process.cwd(), 'reports')
  mkdirSync(out, { recursive: true })
  const stem = 'deep-e2e-e100-051-combined-ab-exchange'
  writeFileSync(join(out, `${stem}.json`), JSON.stringify(result, null, 2) + '\n')
  const fa = x => Number(x ?? 0).toLocaleString('fa-IR')
  const before = result.operation.before ?? { physical: { card: 0 }, blue: 0 }
  const after = result.operation.after ?? { physical: { card: 0 }, blue: 0 }
  const lines = [
    '# E100-051 کنترل تشخیصی: تعویض A و B با هم در یک سند', '',
    `**وضعیت:** ${result.status}. **DB:** SQLite موقت ایزوله.`,
    '',
    '## پرسش آزمون',
    'برای جداسازی اثر زنجیره، برگشت جداگانهٔ A حذف شد و A و B با هم، مستقیماً از فاکتور ریشه و در یک درخواست exchange به A1 و B1 تعویض شدند. بنابراین پیش از این درخواست هیچ SaleReturn قبلی برای A وجود نداشت. این کنترل حکم policy دربارهٔ سهم‌بندی اعتبار محدودشده نیست.',
    '',
    '## پیکربندی',
    `A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=D=۳۰۰٬۰۰۰؛ فاکتور ریشه ۱٬۰۰۰٬۰۰۰، با ۸۰۰٬۰۰۰ POS و ۲۰۰٬۰۰۰ اعتبار. دو کد multi-use محدود به B/C/D و اقلام مجاز بعدی بودند؛ هر کدام ۱۰۰٬۰۰۰ در فاکتور ریشه و ۱۰۰٬۰۰۰ در فاکتور کمکی مصرف شدند و به USED با usedCount=2 رسیدند. A و A1 خارج از scope بودند.`,
    '',
    '## عملیات واحد',
    'درخواست واحد: A=۲۰۰٬۰۰۰→A1=۲۰۰٬۰۰۰ و B=۲۰۰٬۰۰۰→B1=۱۸۰٬۰۰۰؛ اختلاف خالص −۲۰٬۰۰۰؛ روش انتخابی STORE_CREDIT. این همان روش غیرنقدی است که در مورد اصلی پس از برگشت A جداگانه نیز امتحان شد.',
    '',
    `نتیجهٔ سرویس: ${result.operation.error ? `رد شد: ${result.operation.error}` : `پذیرفته شد؛ return=${result.operation.returnedOperation?.returnId} و exchangeInvoice=${result.operation.returnedOperation?.exchangeInvoiceId}`}.`,
    '',
    '## وضعیت مالی/موجودی',
    `POS قبل/بعد: ${fa(before.physical.card)} / ${fa(after.physical.card)}؛ blue قبل/بعد: ${fa(before.blue)} / ${fa(after.blue)}.`,
    `رد mutation-free: ${result.operation.mutationFree ? 'بله' : 'خیر'}.`,
    '',
    'JSON کنار این فایل شامل شمار اسناد، ردیف‌های پرداخت/اعتبار، ماندهٔ اعتبارها، موجودی و ledger انبار، سطرهای تعویض و allocationهاست.',
    '',
    '## برداشت محدود',
    result.status === 'PASS'
      ? 'در این چیدمانِ یک‌سندی، سرویس A و B را با هم تعویض کرد؛ در نتیجه رد مورد اصلی به وجود برگشت جداگانهٔ قبلی/زنجیره حساس است. این PASS به‌تنهایی ثابت نمی‌کند محاسبهٔ تخصیص اعتبار محدودشده در سیاست مالک درست است.'
      : 'در این چیدمانِ یک‌سندی هم سرویس متوقف شد، پس وجود سند برگشت قبلی به‌تنهایی علت کافی نیست. علت دقیق پیام و محل توقف باید از trace/گارد گزارش‌شده تفکیک شود؛ این نتیجه به‌تنهایی حکم policy دربارهٔ تخصیص اعتبار محدودشده نیست.',
    '',
    'فقط تست DB ایزوله و گزارش تولید شد؛ production code، سیاست و DB واقعی تغییر نکردند.'
  ]
  writeFileSync(join(out, `${stem}.md`), lines.join('\n') + '\n')
}
