/** Claude-02 independent probes. Fresh throwaway SQLite per mode; NO product code / customer DB touched.
 * HARNESS_BIGINT=1 node --import ./test/harness/register.mjs tools/audit-probes/credit-exchange-claude02-probe.mjs <mode> */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode = process.argv[2]
const RealDate = Date
let offset = 0
// Real clock advance (sale snapshot untouched): every later `new Date()`/Date.now() is shifted.
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a) } static now() { return RealDate.now() + offset } }
const advance = (ms) => { offset += ms; globalThis.Date = FakeDate }
if (!process.env.HARNESS_DB) {
  process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'c02-'))
  process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
}
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { confirmCreditDelivery } = await import('../../src/main/services/ReturnEntitlementService.ts')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const N = (x) => x == null ? null : Number(x)
const att = async fn => { try { return { ok: true, v: await fn() } } catch (e) { return { ok: false, err: String(e?.message ?? e).split('\n')[0].slice(0, 220) } } }
const out = (cls, ev) => console.log(JSON.stringify({ mode, cls, ev }, (k, v) => typeof v === 'bigint' ? Number(v) : v))
let userId, shiftId, cashM, cat
const setup = () => {
  userId = seed.user('claude02'); cat = seed.category('c')
  shiftId = seed.insert('Shift', { name: 's1', number: 1, userId, openedAt: Date.now() - 60_000, dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
  cashM = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'Cash', isActive: 1 })
}
const newShift = (n) => seed.insert('Shift', { name: 's' + n, number: n, userId, openedAt: Date.now() - 60_000, dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
const variant = (p) => { const id = seed.variant(seed.product('p', cat)); sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=100 WHERE id=?').run(p, id); return id }
const line = (v, p) => ({ variantId: v, qty: 1, unitPrice: p, discount: 0, tax: 0 })
const items = (inv) => seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', inv).map(r => r.id)
const sale = (lines, cash, credit = null, key = 'k', extra = {}) => salesService.create({ userId, shiftId, lines,
  payments: cash > 0 ? [{ methodId: cashM, amount: cash, destination: 'CASH' }] : [],
  ...(credit ? { storeCreditCode: credit.code, storeCreditAmount: credit.spend, storeCreditIdempotencyKey: key } : {}), ...extra })
const gift = (amount, o = {}) => db.$transaction(tx => issueStoreCredit(tx, { amount, source: 'MANUAL', multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, userId, note: 'synthetic', ...o }))
const ret = (inv, ids, method = 'NONE', amount = 0, full = false, sid = shiftId) => salesService.createReturn({ invoiceId: inv,
  lines: ids.map(saleItemId => ({ saleItemId, qty: 1 })), full, refundMethod: method, refundAmount: amount, userId, shiftId: sid })
const exch = (inv, sid, nv, np, refundMode, extra = {}) => salesService.createExchange({ invoiceId: inv, lines: [{ saleItemId: sid, qty: 1 }],
  replacements: [line(nv, np)], userId, shiftId, ...(refundMode ? { refundMode } : {}), ...extra })
const credits = () => seed.rows('SELECT id,status,source,amount,usedAmount,multiUse,expiresAt,returnId FROM "StoreCredit" ORDER BY id')
  .map(r => ({ id: r.id, st: r.status, src: r.source, amt: N(r.amount), used: N(r.usedAmount), multi: r.multiUse, exp: r.expiresAt ? new RealDate(Number(r.expiresAt)).toISOString().slice(0, 10) : null }))
const allocs = () => seed.rows('SELECT returnId,kind,amount,supplementUnspent,successorCreditId FROM "CreditReturnAllocation" ORDER BY id')
  .map(r => ({ ret: r.returnId, kind: r.kind, amt: N(r.amount), supp: N(r.supplementUnspent), succ: r.successorCreditId }))
const deliveries = () => seed.rows('SELECT creditId,status,sourceKind FROM "CreditDelivery" ORDER BY id')
const spendable = async () => { const s = []; for (const c of seed.rows('SELECT id,code,amount,usedAmount FROM "StoreCredit"')) if ((await att(() => findRedeemable(db, c.code))).ok) s.push({ id: c.id, left: N(c.amount) - N(c.usedAmount) }); return s }
const deliver = (creditId) => confirmCreditDelivery({ creditId, witnessKind: 'CUSTOMER_HANDOFF', witnessRef: 'handed to customer at desk', managerPassword: PW, actorUserId: userId })
const codeOf = (id) => seed.one('SELECT code FROM "StoreCredit" WHERE id=?', id).code
const slim = r => r && ({ id: r.id, creditOpportunity: r.creditOpportunity, refundAmount: r.refundAmount, storeCredit: r.storeCredit && { id: r.storeCredit.id, amount: N(r.storeCredit.amount) }, diff: r.diff, invoiceRemaining: r.invoiceRemaining })
const once10 = async () => { const a = variant(2_500_000), b = variant(2_500_000); const A = await gift(10_000_000)
  const inv = await sale([line(a, 2_500_000), line(b, 2_500_000)], 0, { ...A, spend: 5_000_000 }, 'g10'); return { A, inv, it: items(inv.id) } }
const { createManagerCorrectionApprovalSecret } = await import('../../src/main/services/AuthService.ts')
const APW = 'approver-secret-123'
const rc = (id, extra = {}) => { sql.prepare('UPDATE "User" SET passwordHash=? WHERE id=?').run(createManagerCorrectionApprovalSecret(APW), userId); return salesService.returnReconcileVoid({ id, userId, reason: 'اصلاح آزمایشی', panelPassword: PW, approverUserId: userId, approverPassword: APW, ...extra }) }
const rd = (id) => salesService.returnDelete({ id, userId, reason: 'ابطال آزمایشی', managerPassword: PW, overrideReason: 'آزمایش' })

if (mode === "race-worker" || mode === "race-check") { process.env.X=1 } else setup()
if (mode === 'b1-deliver-spend-then-second') {
  const { A, inv, it } = await once10()
  const r1 = await ret(inv.id, [it[0]])
  const B1 = r1.creditOpportunity.pendingDelivery[0].creditId
  const before = await spendable()
  const d = await att(() => deliver(B1))
  const s2 = await att(() => sale([line(variant(1_000_000), 1_000_000)], 0, { code: codeOf(B1), spend: 1_000_000 }, 'b1spend'))
  const r2 = await att(() => ret(inv.id, [it[1]]))
  const mid = { credits: credits(), allocs: allocs(), spendable: await spendable() }
  // now return the 1M bought with B1 (B1 multi-use)
  const r3 = s2.ok ? await att(() => ret(s2.v.id, items(s2.v.id), 'NONE', 0, true)) : null
  out('B1_DELIVERED_PARTLY_SPENT_THEN_SECOND_RETURN', { spendableBeforeDelivery: before, deliver: d.ok || d.err, s2: s2.ok ? N(s2.v.storeCreditApplied) : s2.err,
    r2: r2.ok ? slim(r2.v) : r2.err, mid, r3: r3 && (r3.ok ? slim(r3.v) : r3.err), final: credits(), finalAllocs: allocs(), finalSpendable: await spendable() })
}
if (mode === 'void-first-of-two') {
  const { inv, it } = await once10()
  const r1 = await ret(inv.id, [it[0]]); const r2 = await ret(inv.id, [it[1]])
  out('VOID_ONE_OF_TWO_BRANCHED_RETURNS', { reconcileFirst: (await att(() => rc(r1.id))).err ?? 'OK', deleteFirst: (await att(() => rd(r1.id))).err ?? 'OK',
    reconcileSecond: (await att(() => rc(r2.id))).err ?? 'OK', credits: credits(), returnsLive: seed.count('SaleReturn', 'voidedAt IS NULL') })
}
if (mode === 'void-one-step-unspent') {
  const { inv, it } = await once10()
  const r1 = await ret(inv.id, it, 'NONE', 0, true)
  out('VOID_ONE_STEP_REACTIVATION_UNSPENT', { reconcile: (await att(() => rc(r1.id, { creditOutcome: 'CANCELED_UNUSED' }))).err ?? 'OK', del: (await att(() => rd(r1.id))).err ?? 'OK', credits: credits() })
}
if (mode === 'exchange-after-branch') {
  const { inv, it } = await once10()
  await ret(inv.id, [it[0]])
  const same = await att(() => exch(inv.id, it[1], variant(2_500_000), 2_500_000, null))
  const cheaper = await att(() => exch(inv.id, it[1], variant(2_000_000), 2_000_000, 'STORE_CREDIT'))
  out('EXCHANGE_INSTEAD_OF_SECOND_RETURN', { same: same.ok ? slim(same.v) : same.err, cheaper: cheaper.ok ? slim(cheaper.v) : cheaper.err, credits: credits() })
}
if (mode === 'expiry-between-returns') {
  const { inv, it } = await once10()
  const r1 = await ret(inv.id, [it[0]])
  const B1 = r1.creditOpportunity.pendingDelivery[0].creditId
  advance(31 * 86_400_000); const s2 = newShift(2)
  const dB1 = await att(() => deliver(B1))
  const r2 = await att(() => ret(inv.id, [it[1]], 'NONE', 0, false, s2))
  out('ROOT_EXPIRES_BETWEEN_RETURNS_REAL_CLOCK', { r1: slim(r1), deliverB1AfterExpiry: dB1.ok || dB1.err, r2: r2.ok ? slim(r2.v) : r2.err, credits: credits(), allocs: allocs(), spendable: await spendable(), redemption: seed.rows('SELECT amount,expiryAtRedeem,compensatedAt,reversedAt FROM "StoreCreditRedemption"') })
}
if (mode === 'expiry-one-step') {
  const { inv, it } = await once10()
  advance(31 * 86_400_000); const s2 = newShift(2)
  const r = await att(() => ret(inv.id, it, 'NONE', 0, true, s2))
  out('ROOT_EXPIRED_ONE_STEP_REAL_CLOCK', { r: r.ok ? slim(r.v) : r.err, credits: credits(), allocs: allocs(), spendable: await spendable() })
}
if (mode === 'real-money-root') {
  const x = variant(10_000_000)
  const o = await sale([line(x, 10_000_000)], 10_000_000)
  const rr = await ret(o.id, items(o.id), 'STORE_CREDIT', 10_000_000, true)
  const R = rr.storeCredit?.id
  const Rrow = credits().find(c => c.id === R)
  const dR = await att(() => deliver(R))
  const spendR = await att(async () => { const a = variant(2_500_000), b = variant(2_500_000); return sale([line(a, 2_500_000), line(b, 2_500_000)], 0, { code: codeOf(R), spend: 5_000_000 }, 'R5') })
  let r1 = null, r2 = null
  if (spendR.ok) { const it = items(spendR.v.id); r1 = await att(() => ret(spendR.v.id, [it[0]])); r2 = await att(() => ret(spendR.v.id, [it[1]])) }
  const cashTry = spendR.ok ? null : null
  out('REAL_MONEY_ORIGIN_CREDIT_10M_SPENT_5M_TWO_STEP', { Rrow, deliverR: dR.ok || dR.err, spendR: spendR.ok ? N(spendR.v.storeCreditApplied) : spendR.err,
    r1: r1 && (r1.ok ? slim(r1.v) : r1.err), r2: r2 && (r2.ok ? slim(r2.v) : r2.err), credits: credits(), allocs: allocs(), entitlements: seed.rows('SELECT returnId,state,cashRight,giftOpportunity,debtReduced,cashPaid,cashConverted FROM "ReturnEntitlement"'), spendable: await spendable() })
}
if (mode === 'mixed-once-two-step') {
  const a = variant(2_500_000), b = variant(2_500_000); const A = await gift(10_000_000)
  const inv = await sale([line(a, 2_500_000), line(b, 2_500_000)], 2_000_000, { ...A, spend: 3_000_000 }, 'mx'); const it = items(inv.id)
  const r1wrong = await att(() => ret(inv.id, [it[0]], 'CASH', 2_500_000))
  const r1 = await att(() => ret(inv.id, [it[0]], 'CASH', 1_000_000))
  const r2 = await att(() => ret(inv.id, [it[1]], 'CASH', 1_000_000))
  out('MIXED_ONCE_GIFT_3M_PLUS_CASH_2M_TWO_STEP', { r1wrong: r1wrong.ok ? 'ACCEPTED(!)' : r1wrong.err, r1: r1.ok ? slim(r1.v) : r1.err, r2: r2.ok ? slim(r2.v) : r2.err, credits: credits(), allocs: allocs(),
    cashOut: N(seed.one("SELECT COALESCE(SUM(refundAmount),0) s FROM \"SaleReturn\" WHERE refundMethod='CASH' AND voidedAt IS NULL").s) })
}
if (mode === 'allcash-child-cash-refund') {
  const a = variant(15_980_000), b = variant(15_000_000)
  const o = await sale([line(a, 15_980_000)], 15_980_000)
  const ex = await exch(o.id, items(o.id)[0], b, 15_000_000, 'STORE_CREDIT')
  const Nid = ex.storeCredit?.id
  const Nrow = credits().find(c => c.id === Nid); const Ndel = deliveries().find(d => d.creditId === Nid)
  const Nspend = await att(() => sale([line(variant(980_000), 980_000)], 0, { code: codeOf(Nid), spend: 980_000 }, 'n'))
  const cid = items(ex.exchangeInvoiceId)[0]
  const over = await att(() => ret(ex.exchangeInvoiceId, [cid], 'CASH', 15_980_000, true))
  const ok = await att(() => ret(ex.exchangeInvoiceId, [cid], 'CASH', 15_000_000, true))
  const exp = await att(() => cashboxService.expected({ shiftId }))
  out('ALLCASH_EXCHANGE_CHILD_CASH_REFUND', { N: Nrow, Ndelivery: Ndel ?? 'NO_DELIVERY_ROW', NspendableImmediately: Nspend.ok, over: over.ok ? 'ACCEPTED(!)' : over.err, exact: ok.ok ? slim(ok.v) : ok.err,
    expectedCash: exp.ok ? N(exp.v.expectedCash) : exp.err, drawerOracle: 15_980_000 - (ok.ok ? 15_000_000 : 0) })
}
if (mode === 'cheque-exchange-cheaper') {
  const a = variant(1_000_000), b = variant(800_000)
  const o = await sale([line(a, 1_000_000)], 300_000)
  await salesService.addPayment({ invoiceId: o.id, kind: 'CHEQUE', amount: 700_000, chequeNo: 'C-1', bankName: 'ملت', dueDateJalali: toJalaliDate(new Date()), userId })
  const before = seed.one('SELECT status,paidTotal,grandTotal FROM "SaleInvoice" WHERE id=?', o.id)
  const ex = await att(() => exch(o.id, items(o.id)[0], b, 800_000, 'STORE_CREDIT'))
  const ex2 = ex.ok ? null : await att(() => exch(o.id, items(o.id)[0], b, 800_000, null))
  out('CHEQUE_PENDING_EXCHANGE_CHEAPER', { before, ex: ex.ok ? slim(ex.v) : ex.err, exDefault: ex2 && (ex2.ok ? slim(ex2.v) : ex2.err), credits: credits(),
    cheque: seed.rows("SELECT amount,chequeStatus,voidedAt,voidReason FROM \"Payment\" WHERE kind='CHEQUE'"), children: seed.rows('SELECT id,status,paidTotal,grandTotal FROM "SaleInvoice" WHERE sourceInvoiceId=?', o.id),
    origView: await (async () => { const v = await salesService.payments({ invoiceId: o.id }); return { remaining: v?.remaining, pendingCheque: v?.pendingChequeTotal, review: v?.chequeReviewCount } })(),
    ret: seed.rows('SELECT kind,total,exchangeDiff,debtReduction,refundAmount,refundMethod,exchangeSettlement FROM "SaleReturn"'),
    chequeAudit: seed.rows("SELECT action,note FROM \"AuditLog\" WHERE entity='Payment' ORDER BY id").map(r => r.action + ':' + String(r.note).slice(0, 90)) })
}
if (mode === 'cheque-return-then-void') {
  const a = variant(1_000_000)
  const o = await sale([line(a, 1_000_000)], 0)
  await salesService.addPayment({ invoiceId: o.id, kind: 'CHEQUE', amount: 1_000_000, chequeNo: 'C-2', bankName: 'ملت', dueDateJalali: toJalaliDate(new Date()), userId })
  const r = await ret(o.id, items(o.id), 'NONE', 0, true)
  const afterRet = seed.one("SELECT chequeStatus,voidedAt IS NOT NULL v,voidReason FROM \"Payment\" WHERE kind='CHEQUE'")
  const d = await att(() => rd(r.id))
  const afterVoid = seed.one("SELECT chequeStatus,voidedAt IS NOT NULL v FROM \"Payment\" WHERE kind='CHEQUE'")
  out('CHEQUE_AUTO_VOID_THEN_RETURN_VOID_RESTORES', { afterRet, deleteReturn: d.ok ? 'OK' : d.err, afterVoid, evidenceColumns: seed.rows('PRAGMA table_info("Payment")').map(c => c.name).filter(n => /cheque|physical|handed|bank/i.test(n)) })
}
if (mode === 'cash-refund-reconcile-2days') {
  const a = variant(1_000_000), b = variant(1_000_000)
  const o = await sale([line(a, 1_000_000), line(b, 1_000_000)], 2_000_000)
  const r = await ret(o.id, [items(o.id)[0]], 'CASH', 1_000_000)
  const r2 = await ret(o.id, [items(o.id)[1]], 'CASH', 1_000_000)
  const e1a = await cashboxService.expected({ shiftId })
  sql.prepare('UPDATE "Shift" SET closedAt=? WHERE id=?').run(Date.now(), shiftId)
  advance(86_400_000); const s2 = newShift(2)
  const c1 = await att(() => rc(r.id, { cashRecovered: 600_000 }))
  const c2 = await att(() => rc(r2.id, { cardRecovered: 1_000_000, cardReference: 'TRX-778899' }))
  const e1b = await cashboxService.expected({ shiftId }), e2 = await cashboxService.expected({ shiftId: s2 })
  out('CASH_REFUND_RECONCILE_NEXT_DAY', { expectedShift1Before: N(e1a.expectedCash), expectedShift1After: N(e1b.expectedCash), expectedShift2: N(e2.expectedCash),
    c1: c1.ok ? 'OK' : c1.err, c2: c2.ok ? 'OK' : c2.err,
    effects: seed.rows('SELECT type,amount,shiftId,occurredAtJalali FROM "ReturnCorrectionEffect" ORDER BY id'), movements: seed.rows('SELECT type,amount,shiftId FROM "CashMovement"'),
    s2components: e2.components && Object.fromEntries(Object.entries(e2.components).filter(([, v]) => typeof v !== 'object' && v)) })
}
if (mode === 'race-setup') {
  const a = variant(1_000_000), b = variant(900_000)
  const o = await sale([line(a, 1_000_000)], 1_000_000)
  console.log(JSON.stringify({ db: process.env.HARNESS_DB, inv: o.id, item: items(o.id)[0], b, userId, shiftId }))
}
if (mode === 'race-worker') {
  const p = JSON.parse(process.argv[3]); userId = p.userId; shiftId = p.shiftId
  const t = Number(process.argv[4]); while (RealDate.now() < t) {}
  const r = await att(() => exch(p.inv, p.item, p.b, 900_000, 'STORE_CREDIT'))
  console.log(JSON.stringify({ worker: process.pid, ok: r.ok, err: r.err ?? null, code: r.ok ? N(r.v.storeCredit?.amount) : null }))
}
if (mode === 'race-check') {
  const p = JSON.parse(process.argv[3])
  out('RACE_TWO_PROCESSES', { children: seed.count('SaleInvoice', 'sourceInvoiceId=? AND voidedAt IS NULL', p.inv), returns: seed.count('SaleReturn', 'invoiceId=? AND voidedAt IS NULL', p.inv), credits: credits(), stockB: seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', p.b).stock })
}
