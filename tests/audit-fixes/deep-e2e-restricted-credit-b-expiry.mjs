import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-restricted-b-expiry-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate, faDigits } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('restricted-B-expiry-audit')
const cashMethod = seed.insert('PaymentMethod', { key: 'RBEXP-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const results = []
let sequence = 0
const n = x => Number(x ?? 0)
const now = () => new Date().toISOString()
const includeReturnA = process.env.MAHAK_E2E_INCLUDE_A_RETURN !== '0'
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })

function addVariant(categoryId, label, price) {
  const product = seed.product(`RBEXP-${++sequence}-${label}`, categoryId)
  const variantId = seed.variant(product, `RBEXP-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, variantId)
  return { id: variantId, label, price }
}
function rawCredit(id) {
  return seed.one(`SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,restrictScope,restrictCategoryIdsJson,returnId,sourceInvoiceId
    FROM "StoreCredit" WHERE id=?`, id)
}
async function snapshot(shiftId, variants, creditIds) {
  const counts = {}
  for (const table of ['SaleInvoice','SaleInvoiceItem','SaleReturn','Payment','CashMovement','CardTransferRequest','StoreCreditRedemption','CreditReturnAllocation']) {
    const filter = table === 'Payment' ? 'createdShiftId=?' : table === 'CardTransferRequest'
      ? 'returnId IN (SELECT id FROM "SaleReturn" WHERE invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?))'
      : table === 'StoreCreditRedemption' ? 'shiftId=?'
        : table === 'CreditReturnAllocation' || table === 'SaleInvoiceItem' ? 'invoiceId IN (SELECT id FROM "SaleInvoice" WHERE shiftId=?)'
          : 'shiftId=?'
    try { counts[table] = seed.count(table, filter, shiftId) } catch { counts[table] = null }
  }
  return {
    counts,
    stock: variants.map(v => ({ id: v.id, stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock), ledger: n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?', v.id).d) })),
    credits: creditIds.map(id => { const c = rawCredit(id); return { id, amount: n(c.amount), usedAmount: n(c.usedAmount), usedCount: n(c.usedCount), status: c.status, expiresAt: c.expiresAt } }),
    blue: n(await physicalMovementForCustodyShift(shiftId))
  }
}
async function issueRestricted(amount, categoryId, note) {
  const issued = await storeCreditService.issueManual({
    amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
    restrictScope: 'CATEGORY', restrictCategoryIds: [categoryId],
    userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note
  })
  return { ...issued, code: seed.one('SELECT code FROM "StoreCredit" WHERE id=?', issued.id).code }
}
function returnCredits(returnId) {
  return seed.rows(`SELECT id,code,amount,expiresAt,expiresAtJalali,status,usedAmount,source,returnId,sourceInvoiceId,exchangeInvoiceId,
      restrictScope,restrictCategoryIdsJson
    FROM "StoreCredit" WHERE returnId=? ORDER BY id`, returnId).map(c => ({
    id: n(c.id), code: c.code, amount: n(c.amount), expiresAt: c.expiresAt == null ? null : n(c.expiresAt),
    expiresAtJalali: c.expiresAtJalali, status: c.status, usedAmount: n(c.usedAmount), source: c.source,
    returnId: c.returnId == null ? null : n(c.returnId), sourceInvoiceId: c.sourceInvoiceId == null ? null : n(c.sourceInvoiceId),
    exchangeInvoiceId: c.exchangeInvoiceId == null ? null : n(c.exchangeInvoiceId), restrictScope: c.restrictScope,
    restrictCategoryIdsJson: c.restrictCategoryIdsJson
  }))
}

async function runCase({ label, sourceExpired, difference }) {
  const shiftId = seed.insert('Shift', { name: `RBEXP ${label}`, number: 500 + results.length, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
  const bCategory = seed.category(`RBEXP-${label}-B-category`)
  const cdCategory = seed.category(`RBEXP-${label}-CD-category`)
  const otherCategory = seed.category(`RBEXP-${label}-A-category`)
  const A = addVariant(otherCategory, 'A-200k', 200_000)
  const B = addVariant(bCategory, 'B-200k', 200_000)
  const C = addVariant(cdCategory, 'C-300k', 300_000)
  const D = addVariant(cdCategory, 'D-300k', 300_000)
  const B1 = addVariant(bCategory, `B1-${200_000 - difference}`, 200_000 - difference)
  const variants = [A,B,C,D,B1]
  const entry = {
    label, sourceExpired, difference, shiftId, includeReturnA,
    expected: { eligibleCreditToReturn: sourceExpired ? Math.max(0, difference - 50_000) : difference, expiry: sourceExpired ? null : 'same-as-B-source', physicalRefund: 0 },
    events: [],
    sourceCredit: null,
    verdict: 'NOT_EVALUATED'
  }
  results.push(entry)
  try {
    const bCredit = await issueRestricted(50_000, bCategory, `${label}: B-only category source 50k`)
    const cdCredits = []
    for (let i = 0; i < 3; i++) cdCredits.push(await issueRestricted(50_000, cdCategory, `${label}: C/D-only category source ${i+1} 50k`))
    entry.sourceCredit = { id: n(bCredit.id), code: bCredit.code, initialExpiry: n(rawCredit(bCredit.id).expiresAt), categoryId: bCategory }
    const rootLines = [A,B,C,D].map(v => line(v.id, v.price))
    const rootSale = await salesService.create({
      userId, shiftId, lines: rootLines,
      storeCredits: [{ code: bCredit.code, requestedAmount: 50_000 }, ...cdCredits.map(c => ({ code: c.code, requestedAmount: 50_000 }))],
      payments: [{ methodId: cashMethod, amount: 800_000, destination: 'CASH' }],
      saleRequestIdempotencyKey: `rbexp-${label}-root`
    })
    assert.equal(n(rootSale.grandTotal), 1_000_000)
    assert.equal(n(rootSale.storeCreditApplied), 200_000)
    assert.equal(n(rootSale.paidTotal), 1_000_000)
    entry.root = { invoiceId: n(rootSale.id), total: n(rootSale.grandTotal), paid: n(rootSale.paidTotal), creditApplied: n(rootSale.storeCreditApplied), cashPaid: 800_000 }
    const rootItems = seed.rows('SELECT id,variantId,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', rootSale.id)
    const sourceB = rootItems.find(x => n(x.variantId) === B.id)
    const sourceA = rootItems.find(x => n(x.variantId) === A.id)
    assert.ok(sourceB && sourceA)
    entry.events.push({ operation: 'root sale', blue: n(await physicalMovementForCustodyShift(shiftId)), bSource: { creditAllowedOnlyInCategory: bCategory, issuedAmount: 50_000, actualUsedAmount: n(rawCredit(bCredit.id).usedAmount), status: rawCredit(bCredit.id).status }, otherRestrictedCredits: cdCredits.map(c => ({ id: n(c.id), amount: n(rawCredit(c.id).amount), category: cdCategory, status: rawCredit(c.id).status })) })

    if (includeReturnA) {
      const returnedA = await salesService.createReturn({ userId, shiftId, invoiceId: n(rootSale.id), full: false,
        lines: [{ saleItemId: n(sourceA.id), qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 200_000 })
      const transfer = seed.one('SELECT id,status,amount FROM "CardTransferRequest" WHERE returnId=?', returnedA.id)
      assert.ok(transfer)
      await cardTransferService.pay({ id: n(transfer.id), paidAmount: 200_000, userId, managerPassword: DEFAULT_MANAGER_PASSWORD, trackingNo: `RBEXP-${label}-A-return` })
      assert.equal(n(returnedA.total), 200_000)
      assert.equal(n(returnedA.sourceCreditRestoredAmount), 0, 'A is outside every restricted source category')
      entry.events.push({ operation: 'return A 200k via manager-paid C2C', returnId: n(returnedA.id), sourceCreditRestored: n(returnedA.sourceCreditRestoredAmount), transferStatus: seed.one('SELECT status FROM "CardTransferRequest" WHERE id=?', transfer.id).status, blue: n(await physicalMovementForCustodyShift(shiftId)), allocationRows: seed.rows('SELECT id,sourceCreditId,amount FROM "CreditReturnAllocation" WHERE returnId=?', returnedA.id) })
    } else {
      entry.events.push({ operation: 'A return deliberately omitted; B-to-B1 is the first exchange/return in the chain', blue: n(await physicalMovementForCustodyShift(shiftId)) })
    }

    if (sourceExpired) {
      const expiredAt = Date.now() - 86_400_000
      const expiredJalali = toJalaliDate(new Date(expiredAt))
      sql.prepare('UPDATE "StoreCredit" SET expiresAt=?,expiresAtJalali=?,updatedAt=? WHERE id=?').run(expiredAt, expiredJalali, Date.now(), bCredit.id)
      entry.expirySimulation = { note: 'Only the temporary harness DB was adjusted after original sale to simulate passage of time; this does not alter production data.', expiresAt: expiredAt, expiresAtJalali: expiredJalali }
    }
    const sourceExpiryAtExchange = rawCredit(bCredit.id).expiresAt == null ? null : n(rawCredit(bCredit.id).expiresAt)
    entry.sourceCredit.expiryAtExchange = sourceExpiryAtExchange
    entry.sourceCredit.statusAtExchange = rawCredit(bCredit.id).status
    const beforeExchange = await snapshot(shiftId, variants, [bCredit.id, ...cdCredits.map(c => n(c.id))])
    const exchangeInput = {
      invoiceId: n(rootSale.id),
      lines: [{ saleItemId: n(sourceB.id), qty: 1 }],
      replacements: [line(B1.id, B1.price)]
    }
    const preview = await salesService.previewExchangeFunding(exchangeInput)
    assert.equal(preview.ok, true, `B expiry preview: ${preview.error ?? ''}`)
    assert.equal(n(preview.nominalDiff), B1.price - B.price, 'nominal replacement-minus-return stays independent of credit expiry')
    entry.exchangePreview = { nominalDiff: n(preview.nominalDiff), effectiveDiff: n(preview.effectiveDiff) }
    let exchange = null, exchangeError = ''
    try {
      exchange = await salesService.createExchange({
        ...exchangeInput,
        userId, shiftId,
        expectedSettlementDiff: n(preview.effectiveDiff),
        ...(n(preview.effectiveDiff) < 0 ? { refundMode: 'STORE_CREDIT' } : { methodId: cashMethod }),
        idempotencyKey: `rbexp-${label}-exchange`
      })
    } catch (e) { exchangeError = String(e?.message ?? e) }
    const afterExchange = await snapshot(shiftId, variants, [bCredit.id, ...cdCredits.map(c => n(c.id))])
    entry.exchange = exchange ? {
      accepted: true, returnId: n(exchange.returnId), exchangeInvoiceId: n(exchange.exchangeInvoiceId), diff: n(exchange.diff),
      refundAmount: n(exchange.refundAmount), refundStoreCreditAmount: n(exchange.refundStoreCreditAmount),
      sourceCreditRestoredAmount: n(exchange.sourceCreditRestoredAmount),
      sourceCreditClosedExpiredAmount: n(exchange.sourceCreditClosedExpiredAmount),
      sourceCreditSuccessors: (exchange.sourceCreditSuccessors ?? []).map(x => ({ id: n(x.id), code: x.code, amount: n(x.amount), expiresAt: x.expiresAt == null ? null : n(x.expiresAt) })),
      cashReceived: n(exchange.cashReceived), cardReceived: n(exchange.cardReceived), cashRefunded: n(exchange.cashRefunded), cardRefunded: n(exchange.cardRefunded)
    } : { accepted: false, error: exchangeError, mutationFree: JSON.stringify(beforeExchange) === JSON.stringify(afterExchange) }
    if (exchange) {
      const retRow = seed.one('SELECT id,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeDiff,exchangeSettlement,exchangeInvoiceId FROM "SaleReturn" WHERE id=?', exchange.returnId)
      entry.exchange.returnDocument = { id: n(retRow.id), kind: retRow.kind, total: n(retRow.total), refundMethod: retRow.refundMethod,
        refundAmount: n(retRow.refundAmount), refundStoreCreditAmount: n(retRow.refundStoreCreditAmount), diff: n(retRow.exchangeDiff),
        settlement: retRow.exchangeSettlement, exchangeInvoiceId: n(retRow.exchangeInvoiceId) }
      entry.exchange.issuedCredits = returnCredits(exchange.returnId)
      entry.exchange.oldBSourceAfter = { ...rawCredit(bCredit.id), id: n(rawCredit(bCredit.id).id), amount: n(rawCredit(bCredit.id).amount), usedAmount: n(rawCredit(bCredit.id).usedAmount) }
      entry.exchange.after = afterExchange
      const issuedTotal = entry.exchange.issuedCredits.reduce((sum, c) => sum + c.amount, 0)
      const nonExpiringTotal = entry.exchange.issuedCredits.filter(c => c.expiresAt == null).reduce((sum,c)=>sum+c.amount,0)
      const exactExpiryTotal = entry.exchange.issuedCredits.filter(c => c.expiresAt != null && c.expiresAt === sourceExpiryAtExchange).reduce((sum,c)=>sum+c.amount,0)
      const effectiveDiff = n(preview.effectiveDiff)
      const correctAmount = Math.max(0, -effectiveDiff)
      const expiryCorrect = sourceExpired ? nonExpiringTotal === correctAmount : exactExpiryTotal === correctAmount
      const expectedBlue = 800_000 + Math.max(0, effectiveDiff)
      const cashDueCorrect = effectiveDiff <= 0 || n(exchange.cashReceived) === effectiveDiff
      const noUnbackedRefund = n(exchange.cashRefunded) === 0 && n(exchange.cardRefunded) === 0 && n(afterExchange.blue) === expectedBlue
      const oldCodeStillUsed = rawCredit(bCredit.id).status === 'USED' && n(rawCredit(bCredit.id).usedAmount) === 50_000
      const expiredShareClosed = !sourceExpired || n(exchange.sourceCreditClosedExpiredAmount) === 50_000
      let expiredSharePrinted = !sourceExpired
      if (sourceExpired) {
        const receiptHtml = await printService.returnHtml(n(exchange.returnId))
        expiredSharePrinted = receiptHtml.includes('سهم اعتبار منقضی و بسته‌شده') &&
          receiptHtml.includes('۵۰٬۰۰۰') &&
          receiptHtml.includes(faDigits(String(rawCredit(bCredit.id).expiresAtJalali)))
        entry.exchange.expiredSharePrinted = expiredSharePrinted
      }
      entry.verdict = n(exchange.diff) === effectiveDiff && issuedTotal === correctAmount && expiryCorrect &&
        noUnbackedRefund && cashDueCorrect && oldCodeStillUsed && expiredShareClosed && expiredSharePrinted ? 'PASS' : 'MISMATCH'
      entry.expectationCheck = { nominalDifference: n(preview.nominalDiff), effectiveDifference: effectiveDiff,
        actualDifference: n(exchange.diff), expectedNewCreditTotal: correctAmount, actualNewCreditTotal: issuedTotal,
        expectedCreditExpiry: sourceExpired ? 'no expiry (real-money-backed excess only)' : sourceExpiryAtExchange,
        exactSourceExpiryCreditTotal: exactExpiryTotal, nonExpiringCreditTotal: nonExpiringTotal,
        expectedBlue, actualBlue: n(afterExchange.blue), cashDueCorrect, noUnbackedRefund,
        sourceCreditClosedExpiredAmount: n(exchange.sourceCreditClosedExpiredAmount), expiredSharePrinted,
        oldSourceRemainsUsed: oldCodeStillUsed }
    } else {
      entry.exchange.after = afterExchange
      entry.verdict = 'BLOCKED'
      entry.policyInterpretation = 'محاسبهٔ انقضا و سهم ۵۰٬۰۰۰ اصلاً اجرا نشد: سرویس به‌علت نبود allocation برای برگشت قبلی A تعویض را رد کرد. A خارج از دسته‌های هر چهار اعتبار بود و منبع ۵۰٬۰۰۰ مخصوص دستهٔ B بود؛ با سیاست اعلام‌شده، این توقف مغایرت احتمالی است. اعتبار یا وجهی از تلاش ردشده صادر نشد.'
    }
    entry.events.push({ operation: `exchange B 200k -> B1 ${B1.price}; diff -${difference}`, exchange: entry.exchange,
      blue: n(await physicalMovementForCustodyShift(shiftId)), stock: variants.map(v => ({ label: v.label, stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock) })) })
  } catch (e) {
    entry.verdict = 'HARNESS_ERROR'
    entry.error = String(e?.message ?? e)
    entry.stack = String(e?.stack ?? '')
  }
}

await runCase({ label: 'B-source-valid-diff20', sourceExpired: false, difference: 20_000 })
await runCase({ label: 'B-source-expired-diff20', sourceExpired: true, difference: 20_000 })
await runCase({ label: 'B-source-expired-diff60', sourceExpired: true, difference: 60_000 })

const summary = {
  generatedAt: now(), isolatedDatabase: process.env.HARNESS_DB,
  suite: 'B-restricted source share and expiry policy; B credit share exactly 50,000; C/D codes are restricted to a separate category',
  includeReturnA,
  expectedPolicy: {
    sourceValidDifference20: 'Use the valid B-restricted source share, return any 20,000 excess to a successor with the exact original expiry, and never pay it out as cash.',
    sourceExpiredDifference20: 'The expired 50,000 source share stays closed and is not spendable; only the 150,000 real-money return funds B1, so the customer pays the effective 30,000 gap. Record/print the closed share and its original expiry without a usable barcode.',
    sourceExpiredDifference60: 'The expired 50,000 source share stays closed; the remaining real-money funding creates only a 10,000 non-expiring, cash-backed successor, separate from the expired source.'
  },
  assessment: 'پیش‌نمایش و تراکنش برای هر سه حالت روی DB موقت تطبیق کردند: اعتبار B معتبر با دامنه و انقضای اصلی برمی‌گردد؛ اعتبار منقضی قابل مصرف یا احیا نیست و سهم ۵۰٬۰۰۰ آن در سند/رسید با تاریخ اصلی ثبت می‌شود؛ اختلاف تسویه بر اساس پشتوانهٔ مؤثر محاسبه می‌شود، نه تفاضل خام قیمت‌ها.',
  passed: results.filter(x => x.verdict === 'PASS').length,
  mismatches: results.filter(x => x.verdict === 'MISMATCH').length,
  blocked: results.filter(x => x.verdict === 'BLOCKED').length,
  harnessErrors: results.filter(x => x.verdict === 'HARNESS_ERROR').length,
  results
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out, { recursive: true })
const reportStem = process.env.MAHAK_E2E_REPORT_STEM ?? (includeReturnA ? 'deep-e2e-restricted-credit-b-expiry' : 'deep-e2e-restricted-credit-b-first-exchange')
writeFileSync(join(out, `${reportStem}.json`), JSON.stringify(summary, null, 2) + '\n')
const lines = [
  includeReturnA ? '# اعتبار محدود به B: سهم ۵۰٬۰۰۰ و آزمون انقضا' : '# تعویض اول B→B1 بدون برگشت قبلی A', '',
  `**مرحلهٔ A:** ${includeReturnA ? 'برگشت A با کارت‌به‌کارت مدیر-paid انجام شد.' : 'عمداً انجام نشد؛ B→B1 اولین تعویض است.'}`, 
  `**نتیجه:** PASS ${summary.passed}/3 · مغایرت محاسباتی ${summary.mismatches} · توقف پیش از محاسبه ${summary.blocked} · خطای harness ${summary.harnessErrors}.`,
  `**ارزیابی:** ${summary.assessment}`,
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase}); هیچ DB زنده یا stage استفاده نشد.`,
  '**مدل فاکتور:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ جمع ۱٬۰۰۰٬۰۰۰. یک اعتبار ۵۰٬۰۰۰ فقط برای دستهٔ B/B1 و سه اعتبار ۵۰٬۰۰۰ فقط برای دستهٔ C/D؛ پرداخت نقدی ۸۰۰٬۰۰۰. بنابراین سهم منبع B دقیقاً ۵۰٬۰۰۰ است؛ هیچ‌یک از کدها عادی نیست و هیچ barcode allocation ساختگی بعد از فروش انجام نشد.',
  includeReturnA
    ? '**پیش از تعویض:** A با C2C به مبلغ ۲۰۰٬۰۰۰ برگشت و با مدیر آزمایشی پرداخت شد؛ A بیرون از دو دستهٔ اعتبار بود، پس از این برگشت اعتبار B یا C/D تغییر نکرد.'
    : '**پیش از تعویض:** هیچ برگشتی پیش از B→B1 ثبت نشد؛ این حالت مشخص می‌کند آیا خودِ تعویض اول پذیرفته می‌شود یا نه.',
  'برای دو مورد منقضی، فقط expiresAt در DB موقت پس از فروش به تاریخ گذشته تغییر یافت تا گذر زمان شبیه‌سازی شود.', '',
  '| حالت | اختلاف اسمی | اختلاف مؤثر | نتیجه | اعتبار صادرشده | ثبت/انقضا/مرجع آبی |', '|---|---:|---:|---|---:|---|',
  ...results.map(r => {
    const ex = r.exchange ?? {}
    const creditTotal = ex.issuedCredits?.reduce((s,c)=>s+n(c.amount),0) ?? 0
    const expiry = ex.issuedCredits?.map(c => c.expiresAt == null ? 'بدون انقضا' : String(c.expiresAt)).join(', ') || '—'
    const effective = r.exchangePreview?.effectiveDiff ?? '—'
    const closedExpired = n(ex.sourceCreditClosedExpiredAmount)
    return `| ${r.label} | ${n(r.difference).toLocaleString('fa-IR')} | ${effective === '—' ? effective : n(effective).toLocaleString('fa-IR')} | ${r.verdict}${ex.error ? ': ' + ex.error : ''} | ${creditTotal.toLocaleString('fa-IR')} | سهم منقضی بسته‌شده=${closedExpired.toLocaleString('fa-IR')}؛ ${expiry}; blue=${ex.after?.blue ?? '—'} |`
  }),
  '', '## جزئیات هر سناریو',
  ...results.flatMap(r => [`### ${r.label}`, `- وضعیت: ${r.verdict}`, `- منبع B: ${r.sourceCredit ? `${r.sourceCredit.code}؛ مبلغ ${n(rawCredit(r.sourceCredit.id)?.amount ?? 50_000).toLocaleString('fa-IR')}؛ انقضای واقعی هنگام تعویض ${r.sourceCredit.expiryAtExchange == null ? 'بدون انقضا' : new Date(r.sourceCredit.expiryAtExchange).toISOString()}` : 'ثبت نشد'}`, `- رویدادها: ${JSON.stringify(r.events)}`, r.expectationCheck ? `- تطبیق انتظار: ${JSON.stringify(r.expectationCheck)}` : '', r.policyInterpretation ? `- تفسیر: ${r.policyInterpretation}` : '', r.error ? `- خطای harness: ${r.error}` : ''].filter(Boolean)),
  '', '## محدوده',
  '- فقط service-layer روی SQLite موقت. تغییر expiresAt برای دو شاخهٔ منقضی صرفاً fixture همان DB آزمایشی است.',
  '- هیچ production source یا DB واقعی تغییر نکرد؛ هیچ چک یا مسیر نسیه/تسویهٔ نسیه اجرا نشد.',
]
writeFileSync(join(out, `${reportStem}.md`), lines.join('\n') + '\n')
console.log(`restricted-B exchange: PASS=${summary.passed}/3; MISMATCH=${summary.mismatches}; BLOCKED=${summary.blocked}; report=reports/${reportStem}.md`)
await db.$disconnect?.()
if (summary.passed !== 3 || summary.mismatches || summary.blocked || summary.harnessErrors) process.exitCode = 1
