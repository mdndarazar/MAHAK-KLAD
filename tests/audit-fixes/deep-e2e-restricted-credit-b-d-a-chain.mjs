import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-restricted-b-d-a-chain-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { printService } = await import('../../src/main/services/PrintService.ts')
const { storeCreditService } = await import('../../src/main/services/StoreCreditService.ts')
const { physicalMovementForCustodyShift } = await import('../../src/main/services/CustodyAggregateService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { toJalaliDate, faDigits } = await import('../../src/shared/jalali.ts')

const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('restricted-B-D-A-chain-audit')
const cashMethod = seed.insert('PaymentMethod', { key: 'RBDA-CASH', label: 'isolated cash', kind: 'CASH', isActive: 1, sortOrder: 1 })
const n = x => Number(x ?? 0)
const line = (variantId, unitPrice) => ({ variantId, qty: 1, unitPrice, discount: 0, tax: 0 })
let sequence = 0

function addVariant(categoryId, label, price) {
  const product = seed.product(`RBDA-${++sequence}-${label}`, categoryId)
  const id = seed.variant(product, `RBDA-${sequence}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=? WHERE id=?').run(price, id)
  return { id, label, price }
}
function rawCredit(id) {
  return seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,expiresAtJalali,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE id=?', id)
}
async function issueRestricted(amount, categoryId, note) {
  const issued = await storeCreditService.issueManual({ amount, multiUse: false, maxUses: 1, carryRemainder: true, days: 30,
    restrictScope: 'CATEGORY', restrictCategoryIds: [categoryId], userId, managerPassword: DEFAULT_MANAGER_PASSWORD, note })
  return { ...issued, code: rawCredit(issued.id).code }
}
function creditsForReturn(returnId) {
  return seed.rows('SELECT id,code,amount,expiresAt,expiresAtJalali,status,source,restrictScope,restrictCategoryIdsJson FROM "StoreCredit" WHERE returnId=? ORDER BY id', returnId)
    .map(c => ({ id: n(c.id), code: c.code, amount: n(c.amount), expiresAt: c.expiresAt == null ? null : n(c.expiresAt),
      expiresAtJalali: c.expiresAtJalali, status: c.status, source: c.source, restrictScope: c.restrictScope,
      restrictCategoryIdsJson: c.restrictCategoryIdsJson }))
}
async function snapshot(shiftId, variants, creditIds) {
  return {
    stocks: variants.map(v => ({ label: v.label, stock: n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', v.id).stock) })),
    credits: creditIds.map(id => { const c = rawCredit(id); return { id: n(c.id), code: c.code, amount: n(c.amount), usedAmount: n(c.usedAmount), status: c.status, expiresAt: c.expiresAt == null ? null : n(c.expiresAt) } }),
    returns: seed.rows('SELECT id,kind,total,exchangeDiff,exchangeSettlement,exchangeInvoiceId FROM "SaleReturn" WHERE shiftId=? ORDER BY id', shiftId)
      .map(r => ({ id: n(r.id), kind: r.kind, total: n(r.total), diff: n(r.exchangeDiff), settlement: r.exchangeSettlement, exchangeInvoiceId: r.exchangeInvoiceId == null ? null : n(r.exchangeInvoiceId) })),
    blue: n(await physicalMovementForCustodyShift(shiftId))
  }
}

const caseSpecs = [
  { label: 'B-valid-diff20', bExpired: false, bDifference: 20_000 },
  { label: 'B-expired-diff20', bExpired: true, bDifference: 20_000 },
  { label: 'B-expired-diff60', bExpired: true, bDifference: 60_000 }
]
const cases = []

for (const spec of caseSpecs) {
  const shiftId = seed.insert('Shift', { name: `RBDA ${spec.label}`, number: 700 + cases.length, dayJalali: toJalaliDate(new Date()), openedAt: Date.now(), userId })
  const categories = {
    A: seed.category(`RBDA-${spec.label}-A`), B: seed.category(`RBDA-${spec.label}-B`),
    C: seed.category(`RBDA-${spec.label}-C`), D: seed.category(`RBDA-${spec.label}-D`)
  }
  const A = addVariant(categories.A, 'A-200k', 200_000)
  const B = addVariant(categories.B, 'B-200k', 200_000)
  const C = addVariant(categories.C, 'C-300k', 300_000)
  const D = addVariant(categories.D, 'D-300k', 300_000)
  const B1 = addVariant(categories.B, `B1-${200_000 - spec.bDifference}`, 200_000 - spec.bDifference)
  const D1 = addVariant(categories.D, 'D1-280k', 280_000)
  const A1 = addVariant(categories.A, 'A1-180k', 180_000)
  const variants = [A,B,C,D,B1,D1,A1]
  const item = { label: spec.label, bExpired: spec.bExpired, bDifference: spec.bDifference, shiftId,
    verdict: 'INCOMPLETE', stages: [], expected: { B: spec.bExpired ? Math.max(0, spec.bDifference - 50_000) : spec.bDifference,
      D: 20_000, A: 20_000 } }
  cases.push(item)
  try {
    const bCredit = await issueRestricted(50_000, categories.B, `${spec.label}: B-only 50k source`)
    const dCredit = await issueRestricted(50_000, categories.D, `${spec.label}: D-only 50k source`)
    const cCredits = [await issueRestricted(50_000, categories.C, `${spec.label}: C-only 50k source 1`),
      await issueRestricted(50_000, categories.C, `${spec.label}: C-only 50k source 2`)]
    const root = await salesService.create({ userId, shiftId, lines: [A,B,C,D].map(v => line(v.id, v.price)),
      storeCredits: [bCredit,dCredit,...cCredits].map(c => ({ code: c.code, requestedAmount: 50_000 })),
      payments: [{ methodId: cashMethod, amount: 800_000, destination: 'CASH' }],
      saleRequestIdempotencyKey: `rbda-${spec.label}-root` })
    if (n(root.grandTotal) !== 1_000_000 || n(root.storeCreditApplied) !== 200_000 || n(root.paidTotal) !== 1_000_000) throw new Error('Root sale totals did not match 1,000,000 total / 200,000 credit / 800,000 cash')
    const rootItems = seed.rows('SELECT id,variantId FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', root.id)
    const sourceItems = Object.fromEntries([A,B,C,D].map(v => [v.label[0], rootItems.find(x => n(x.variantId) === v.id)]))
    if (Object.values(sourceItems).some(x => !x)) throw new Error('Could not locate original A/B/C/D sale items')
    item.root = { invoiceId: n(root.id), total: n(root.grandTotal), creditApplied: n(root.storeCreditApplied), cashPaid: 800_000,
      restrictedSources: { B: { id: n(bCredit.id), code: bCredit.code, category: categories.B, amount: 50_000 },
        D: { id: n(dCredit.id), code: dCredit.code, category: categories.D, amount: 50_000 },
        C: cCredits.map(c => ({ id: n(c.id), code: c.code, category: categories.C, amount: 50_000 })) } }
    item.initial = await snapshot(shiftId, variants, [bCredit.id,dCredit.id,...cCredits.map(c => c.id)])
    if (spec.bExpired) {
      const expiresAt = Date.now() - 86_400_000
      sql.prepare('UPDATE "StoreCredit" SET expiresAt=?,expiresAtJalali=?,updatedAt=? WHERE id=?').run(expiresAt, toJalaliDate(new Date(expiresAt)), Date.now(), bCredit.id)
      item.bExpiryFixture = { expiresAt, note: 'Temporary harness DB only; simulate an already-expired source after the original sale.' }
    }
    const originalSources = { B: { id: n(bCredit.id), expiresAt: rawCredit(bCredit.id).expiresAt == null ? null : n(rawCredit(bCredit.id).expiresAt) },
      D: { id: n(dCredit.id), expiresAt: rawCredit(dCredit.id).expiresAt == null ? null : n(rawCredit(dCredit.id).expiresAt) } }
    const stages = [
      { key: 'B', source: sourceItems.B, sourceCredit: bCredit, replacement: B1, difference: spec.bDifference,
        expectedAmount: spec.bExpired ? Math.max(0, spec.bDifference - 50_000) : spec.bDifference,
        expectedExpiry: spec.bExpired ? null : originalSources.B.expiresAt, note: 'B source: exact B-only restricted credit' },
      { key: 'D', source: sourceItems.D, sourceCredit: dCredit, replacement: D1, difference: 20_000,
        expectedAmount: 20_000, expectedExpiry: originalSources.D.expiresAt, note: 'D source: exact D-only restricted credit' },
      { key: 'A', source: sourceItems.A, sourceCredit: null, replacement: A1, difference: 20_000,
        expectedAmount: 20_000, expectedExpiry: null, note: 'A source: cash-backed; fresh non-expiring credit' }
    ]
    let chainBroken = false
    for (let index=0; index<stages.length; index++) {
      const st = stages[index]
      if (chainBroken) { item.stages.push({ stage: st.key, verdict: 'SKIPPED', reason: 'An earlier exchange in the same chain was blocked or mismatched.' }); continue }
      const before = await snapshot(shiftId, variants, [bCredit.id,dCredit.id,...cCredits.map(c => c.id)])
      const exchangeInput = {
        invoiceId: n(root.id),
        lines: [{ saleItemId: n(st.source.id), qty: 1 }],
        replacements: [line(st.replacement.id, st.replacement.price)]
      }
      const preview = await salesService.previewExchangeFunding(exchangeInput)
      if (!preview.ok) throw new Error(`Preview ${st.key} failed: ${preview.error ?? ''}`)
      const nominalDifference = n(preview.nominalDiff)
      const effectiveDifference = n(preview.effectiveDiff)
      if (nominalDifference !== -st.difference)
        throw new Error(`Nominal ${st.key} difference ${nominalDifference} did not match expected ${-st.difference}`)
      let result = null, error = null
      try {
        result = await salesService.createExchange({ ...exchangeInput, userId, shiftId,
          expectedSettlementDiff: effectiveDifference,
          ...(effectiveDifference < 0 ? { refundMode: 'STORE_CREDIT' } : { methodId: cashMethod }),
          idempotencyKey: `rbda-${spec.label}-${st.key}` })
      } catch (e) { error = String(e?.message ?? e) }
      const after = await snapshot(shiftId, variants, [bCredit.id,dCredit.id,...cCredits.map(c => c.id)])
      if (!result) {
        item.stages.push({ stage: st.key, verdict: 'BLOCKED', error, mutationFree: JSON.stringify(before) === JSON.stringify(after), before, after })
        chainBroken = true
        continue
      }
      const issued = creditsForReturn(result.returnId)
      const issuedTotal = issued.reduce((sum,c)=>sum+c.amount,0)
      const expectedDifference = effectiveDifference
      const expectedAmount = st.expectedAmount
      const expiryMatches = expectedAmount === 0 ? issued.length === 0
        : st.expectedExpiry == null ? issued.every(c => c.expiresAt == null)
          : issued.filter(c => c.expiresAt === st.expectedExpiry).reduce((sum,c)=>sum+c.amount,0) === expectedAmount
      const oldCredit = st.sourceCredit ? rawCredit(st.sourceCredit.id) : null
      const oldSourceStillUsed = !oldCredit || (oldCredit.status === 'USED' && n(oldCredit.usedAmount) === 50_000)
      const expectedBlue = n(before.blue) + Math.max(0, effectiveDifference)
      const noUnbackedRefund = n(result.cashRefunded) === 0 && n(result.cardRefunded) === 0 && n(after.blue) === expectedBlue
      const positiveCashCorrect = effectiveDifference <= 0 || n(result.cashReceived) + n(result.cardReceived) === effectiveDifference
      const expiredShareClosed = !st.sourceCredit || !spec.bExpired || st.key !== 'B' || n(result.sourceCreditClosedExpiredAmount) === 50_000
      let expiredSharePrinted = !spec.bExpired || st.key !== 'B'
      if (!expiredSharePrinted) {
        const html = await printService.returnHtml(n(result.returnId))
        expiredSharePrinted = html.includes('سهم اعتبار منقضی و بسته‌شده') && html.includes('۵۰٬۰۰۰') &&
          html.includes(faDigits(String(rawCredit(st.sourceCredit.id).expiresAtJalali)))
      }
      const expectedMatch = n(result.diff) === expectedDifference && issuedTotal === expectedAmount && expiryMatches &&
        oldSourceStillUsed && noUnbackedRefund && positiveCashCorrect && expiredShareClosed && expiredSharePrinted
      const ret = seed.one('SELECT id,kind,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeDiff,exchangeSettlement,exchangeInvoiceId FROM "SaleReturn" WHERE id=?', result.returnId)
      const allocations = seed.rows('SELECT id,sourceCreditId,amount FROM "CreditReturnAllocation" WHERE returnId=?', result.returnId)
        .map(a => ({ id:n(a.id), sourceCreditId:n(a.sourceCreditId), amount:n(a.amount) }))
      item.stages.push({ stage: st.key, verdict: expectedMatch ? 'PASS' : 'MISMATCH', note: st.note,
        sourceSaleItemId: n(st.source.id), replacement: st.replacement.label, priceDifference: st.difference,
        exchange: { returnId:n(result.returnId), exchangeInvoiceId:n(result.exchangeInvoiceId), diff:n(result.diff),
          sourceCreditRestoredAmount:n(result.sourceCreditRestoredAmount), sourceCreditClosedExpiredAmount:n(result.sourceCreditClosedExpiredAmount), sourceCreditSuccessors:(result.sourceCreditSuccessors ?? []).map(c=>({id:n(c.id),amount:n(c.amount),expiresAt:c.expiresAt == null ? null : n(c.expiresAt)})),
          cashRefunded:n(result.cashRefunded), cardRefunded:n(result.cardRefunded), cashReceived:n(result.cashReceived), cardReceived:n(result.cardReceived),
          returnDocument: ret ? { id:n(ret.id),kind:ret.kind,total:n(ret.total),refundMethod:ret.refundMethod,refundAmount:n(ret.refundAmount),refundStoreCreditAmount:n(ret.refundStoreCreditAmount),diff:n(ret.exchangeDiff),settlement:ret.exchangeSettlement,exchangeInvoiceId:n(ret.exchangeInvoiceId) } : null,
          allocations, issuedCredits:issued, oldSource:oldCredit ? { id:n(oldCredit.id),code:oldCredit.code,status:oldCredit.status,usedAmount:n(oldCredit.usedAmount),expiresAt:oldCredit.expiresAt == null ? null : n(oldCredit.expiresAt) } : null },
        preview: { nominalDifference, effectiveDifference },
        check: { expectedEffectiveDifference: expectedDifference, actualDifference:n(result.diff), expectedCredit:expectedAmount, actualCredit:issuedTotal,
          expectedExpiry:st.expectedExpiry, expiryMatches, oldSourceStillUsed, noUnbackedRefund, positiveCashCorrect,
          expectedBlue, actualBlue:n(after.blue), expiredShareClosed, expiredSharePrinted }, before, after })
      if (!expectedMatch) chainBroken = true
    }
    item.verdict = item.stages.every(s => s.verdict === 'PASS') ? 'PASS'
      : item.stages.some(s => s.verdict === 'BLOCKED') ? 'BLOCKED' : 'MISMATCH'
  } catch (e) {
    item.verdict = 'HARNESS_ERROR'
    item.error = String(e?.message ?? e)
    item.stack = String(e?.stack ?? '')
  }
}

const summary = {
  generatedAt: new Date().toISOString(), isolatedDatabase: process.env.HARNESS_DB,
  title: 'B→B1 first, D→D1 second, A→A1 third; exact item-category credit restrictions; each replacement is 20,000 cheaper except specified B 60,000 branch.',
  policy: { BValid20: '20,000 successor with exact B source expiry; old B code remains USED.',
    BExpired20: 'Expired 50,000 B share stays closed and is printed with its original expiry; remaining 150,000 money funds the replacement, so the customer pays the effective 30,000 gap.',
    BExpired60: 'The expired B share stays closed; only the 10,000 real-money-backed excess becomes a separate non-expiring credit.',
    DValid20: '20,000 D-source successor with exact D source expiry; old D code remains USED.',
    ACashBacked20: '20,000 backed by actual cash becomes a fresh non-expiring store credit; no restricted credit is restored.' },
  totals: { cases: cases.length, pass: cases.filter(c=>c.verdict==='PASS').length,
    blocked: cases.filter(c=>c.verdict==='BLOCKED').length, mismatches: cases.filter(c=>c.verdict==='MISMATCH').length,
    harnessErrors: cases.filter(c=>c.verdict==='HARNESS_ERROR').length },
  cases
}
const out = resolve(process.cwd(), 'reports'); mkdirSync(out,{recursive:true})
writeFileSync(join(out,'deep-e2e-restricted-credit-b-d-a-chain.json'),JSON.stringify(summary,null,2)+'\n')
const verdictLabel = v => ({PASS:'PASS',BLOCKED:'BLOCKED',MISMATCH:'MISMATCH',HARNESS_ERROR:'HARNESS_ERROR',SKIPPED:'SKIPPED'})[v] ?? v
const lines = [
  '# زنجیرهٔ تعویض B→B1، سپس D→D1، سپس A→A1','',
  `**نتیجه:** ${summary.totals.pass}/${summary.totals.cases} زنجیره کامل؛ ${summary.totals.blocked} متوقف؛ ${summary.totals.mismatches} مغایرت؛ ${summary.totals.harnessErrors} خطای harness.`,
  `**DB:** SQLite موقت ایزوله (${summary.isolatedDatabase})؛ هیچ DB زنده یا stage استفاده نشد.`,
  '**فروش پایه:** A=۲۰۰٬۰۰۰، B=۲۰۰٬۰۰۰، C=۳۰۰٬۰۰۰، D=۳۰۰٬۰۰۰؛ جمع ۱٬۰۰۰٬۰۰۰. اعتبارها: B-only=۵۰٬۰۰۰، D-only=۵۰٬۰۰۰، دو اعتبار C-only=۵۰٬۰۰۰ هرکدام؛ نقد=۸۰۰٬۰۰۰. هر محدودیت با دستهٔ دقیق همان قلم تعریف شد.',
  '**ترتیب هر زنجیره:** B→B1 نخست؛ سپس D→D1؛ سپس A→A1. اختلاف D و A هرکدام ۲۰٬۰۰۰. برای B سه شاخه اجرا شد: معتبر/۲۰هزار، منقضی/۲۰هزار، منقضی/۶۰هزار.',
  '', '| حالت | B→B1 | D→D1 (دوم) | A→A1 (سوم) | زنجیره |','|---|---|---|---|---|',
  ...cases.map(c=>`| ${c.label} | ${verdictLabel(c.stages.find(s=>s.stage==='B')?.verdict)} | ${verdictLabel(c.stages.find(s=>s.stage==='D')?.verdict)} | ${verdictLabel(c.stages.find(s=>s.stage==='A')?.verdict)} | ${verdictLabel(c.verdict)} |`),
  '', '## جزئیات مرحله‌ها',
  ...cases.flatMap(c=>[`### ${c.label} — ${verdictLabel(c.verdict)}`,
    `- منبع B منقضی: ${c.bExpired}; اختلاف B: ${n(c.bDifference).toLocaleString('fa-IR')}; انتظار اعتبار B: ${n(c.expected.B).toLocaleString('fa-IR')}.`,
    ...c.stages.map(s=>`- **${s.stage}**: ${verdictLabel(s.verdict)}${s.priceDifference == null ? '' : `؛ اختلاف ${n(s.priceDifference).toLocaleString('fa-IR')}`} ${s.error ? `؛ خطا: ${s.error}` : ''}${s.check ? `؛ تطبیق: ${JSON.stringify(s.check)}` : ''}${s.reason ? `؛ علت: ${s.reason}` : ''}`),
    c.error ? `- خطای harness: ${c.error}` : '']),
  '', '## محدودهٔ ایمنی','- فقط SQLite موقت و service-layer؛ موارد انقضا صرفاً در DB آزمایشی با تغییر تاریخ خام شبیه‌سازی شدند.',
  '- هیچ چک، فروش نسیه، دریافت نسیه، تسویهٔ نسیه، production source یا DB واقعی استفاده/تغییر نشد.'
]
writeFileSync(join(out,'deep-e2e-restricted-credit-b-d-a-chain.md'),lines.join('\n')+'\n')
console.log(`B-D-A chain: PASS=${summary.totals.pass}/${summary.totals.cases}; BLOCKED=${summary.totals.blocked}; MISMATCH=${summary.totals.mismatches}; HARNESS_ERROR=${summary.totals.harnessErrors}; report=reports/deep-e2e-restricted-credit-b-d-a-chain.md`)
await db.$disconnect?.()
if (summary.totals.pass !== summary.totals.cases || summary.totals.blocked || summary.totals.mismatches || summary.totals.harnessErrors) process.exitCode=1
