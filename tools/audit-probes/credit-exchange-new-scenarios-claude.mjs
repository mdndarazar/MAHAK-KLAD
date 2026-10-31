/** Claude's independent scenarios (design-review round). Throwaway SQLite per mode; NO app code changed.
 * HARNESS_BIGINT=1 node --import ./test/harness/register.mjs tools/audit-probes/credit-exchange-new-scenarios-claude.mjs <mode> */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode = process.argv[2]
const modes = ['once10-full-return','once10-partial-return','once10-expired-return','allcash-child-return-cap',
  'allcash-child-return-after-N-spent','concurrent-exchange','sequential-replay','gift-reopen-twice','debt-gift-exchange']
if (!modes.includes(mode)) throw new Error('modes: ' + modes.join(','))
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), 'claude-ce-'))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const userId = seed.user('claude review')
const shiftId = seed.insert('Shift', { name: 's', number: 1, userId, openedAt: Date.now() - 60_000, dayJalali: toJalaliDate(new Date()), staffConfirmed: 1 })
const cashM = seed.insert('PaymentMethod', { key: 'CASH', kind: 'CASH', label: 'Cash', isActive: 1 })
const cat = seed.category('c')
const variant = (p) => { const id = seed.variant(seed.product('p', cat)); sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=100 WHERE id=?').run(p, id); return id }
const line = (v, p) => ({ variantId: v, qty: 1, unitPrice: p, discount: 0, tax: 0 })
const itemId = (inv, v) => seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? AND variantId=?', inv, v).id
const sale = (lines, cash, credit = null, key = 'k') => salesService.create({ userId, shiftId, lines,
  payments: cash > 0 ? [{ methodId: cashM, amount: cash, destination: 'CASH' }] : [],
  ...(credit ? { storeCreditCode: credit.code, storeCreditAmount: credit.spend, storeCreditIdempotencyKey: key } : {}) })
const gift = (amount, spend, o = {}) => db.$transaction(tx => issueStoreCredit(tx, { amount, source: 'MANUAL', multiUse: false, maxUses: 1,
  carryRemainder: false, days: 30, userId, note: 'synthetic', ...o })).then(c => ({ ...c, spend }))
const ret = (inv, sid, method, amount, full) => salesService.createReturn({ invoiceId: inv, lines: [{ saleItemId: sid, qty: 1 }],
  full, refundMethod: method, refundAmount: amount, userId, shiftId })
const exch = (inv, sid, nv, np, mode2, extra = {}) => salesService.createExchange({ invoiceId: inv, lines: [{ saleItemId: sid, qty: 1 }],
  replacements: [line(nv, np)], userId, shiftId, ...(mode2 ? { refundMode: mode2 } : {}), ...extra })
const att = async fn => { try { return { ok: true, v: await fn() } } catch (e) { return { ok: false, err: String(e?.message ?? e).split('\n')[0].slice(0, 160) } } }
const cr = () => seed.rows('SELECT id,status,source,amount,usedAmount,multiUse,returnId FROM "StoreCredit" ORDER BY id').map(r => ({ id: r.id, st: r.status, src: r.source, amt: Number(r.amount), used: Number(r.usedAmount), multi: r.multiUse }))
const out = (cls, ev) => console.log(JSON.stringify({ mode, cls, ev }))
const slim = r => r && ({ creditOpportunity: r.creditOpportunity, refundAmount: r.refundAmount, storeCredit: r.storeCredit && { amount: r.storeCredit.amount }, diff: r.diff })

if (mode.startsWith('once10')) {
  const a = variant(2_500_000), b = variant(2_500_000)
  const A = await gift(10_000_000, 5_000_000)
  const inv = await sale([line(a, 2_500_000), line(b, 2_500_000)], 0, A, 'g10')
  const afterSpend = cr()
  if (mode === 'once10-expired-return') { const past = Date.now() - 86_400_000; sql.prepare('UPDATE "StoreCredit" SET expiresAt=? WHERE id=?').run(past, A.id); sql.prepare('UPDATE "StoreCreditRedemption" SET expiryAtRedeem=? WHERE creditId=?').run(past, A.id) }
  const items = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id', inv.id).map(r => r.id)
  let r1, r2
  if (mode === 'once10-partial-return') r1 = await att(() => ret(inv.id, items[0], 'NONE', 0, false))
  else {
    r1 = await att(() => salesService.createReturn({ invoiceId: inv.id, lines: items.map(id => ({ saleItemId: id, qty: 1 })), full: true, refundMethod: 'NONE', refundAmount: 0, userId, shiftId }))
  }
  out('OWNER_ONCE_GIFT_10M_SPENT_5M', { afterSpend, ret: r1.ok ? slim(r1.v) : r1.err, afterReturn: cr(),
    spendableCodes: await Promise.all(seed.rows('SELECT code,id FROM "StoreCredit"').map(async c => ({ id: c.id, ok: (await att(() => findRedeemable(db, c.code))).ok }))) })
}
if (mode === 'allcash-child-return-cap' || mode === 'allcash-child-return-after-N-spent') {
  const a = variant(15_980_000), b = variant(15_000_000)
  const o = await sale([line(a, 15_980_000)], 15_980_000)
  const ex = await exch(o.id, itemId(o.id, a), b, 15_000_000, 'STORE_CREDIT')
  const N = seed.one('SELECT code,id FROM "StoreCredit" WHERE id=?', ex.storeCredit.id)
  let spent = null
  if (mode.endsWith('N-spent')) { const s = await sale([line(variant(980_000), 980_000)], 0, { code: N.code, spend: 980_000 }, 'spendN'); spent = s.storeCreditApplied }
  const cid = itemId(ex.exchangeInvoiceId, b)
  const over = await att(() => ret(ex.exchangeInvoiceId, cid, 'STORE_CREDIT', 15_980_000, true))
  const ok = await att(() => ret(ex.exchangeInvoiceId, cid, 'STORE_CREDIT', 15_000_000, true))
  out('REAL_CASH_RIGHT_SUM_AFTER_ALLCASH_EXCHANGE', { N: 980000, nSpent: spent, over15_98: over.ok ? slim(over.v) : over.err,
    exact15: ok.ok ? slim(ok.v) : ok.err, credits: cr() })
}
if (mode === 'concurrent-exchange') {
  const a = variant(1_000_000), b = variant(900_000)
  const o = await sale([line(a, 1_000_000)], 1_000_000)
  const sid = itemId(o.id, a)
  const rs = await Promise.all([att(() => exch(o.id, sid, b, 900_000, 'STORE_CREDIT')), att(() => exch(o.id, sid, b, 900_000, 'STORE_CREDIT'))])
  out('RACE_TWO_EXCHANGES', { results: rs.map(r => r.ok ? 'OK' : r.err), children: seed.count('SaleInvoice', 'sourceInvoiceId=? AND voidedAt IS NULL', o.id), activeCodes: cr(), stockOfNew: seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', b).stock })
}
if (mode === 'sequential-replay') {
  const a = variant(1_000_000), b = variant(900_000)
  const o = await sale([line(a, 1_000_000)], 1_000_000)
  const sid = itemId(o.id, a)
  const r1 = await att(() => exch(o.id, sid, b, 900_000, 'STORE_CREDIT'))
  const r2 = await att(() => exch(o.id, sid, b, 900_000, 'STORE_CREDIT'))
  out('REPLAY_SECOND_EXCHANGE_SAME_ITEM', { first: r1.ok ? slim(r1.v) : r1.err, second: r2.ok ? 'OK(!)' : r2.err,
    children: seed.count('SaleInvoice', 'sourceInvoiceId=? AND voidedAt IS NULL', o.id), codes: cr() })
}
if (mode === 'gift-reopen-twice') {
  const a = variant(1_000_000), c = variant(1_000_000)
  const H = await gift(1_000_000, 1_000_000)
  const o = await sale([line(a, 1_000_000)], 0, H, 'h1')
  const r1 = await att(() => ret(o.id, itemId(o.id, a), 'NONE', 0, true))
  const afterR1 = cr()
  const s2 = await att(() => sale([line(c, 1_000_000)], 0, { code: H.code, spend: 1_000_000 }, 'h2'))
  const afterS2 = cr()
  const r2 = s2.ok ? await att(() => ret(s2.v.id, itemId(s2.v.id, c), 'NONE', 0, true)) : null
  const redeemable = seed.rows('SELECT id,code,amount,usedAmount,status FROM "StoreCredit"')
  const live = []; for (const x of redeemable) { const f = await att(() => findRedeemable(db, x.code)); if (f.ok) live.push({ id: x.id, remain: Number(x.amount) - Number(x.usedAmount) }) }
  out('H_REOPEN_TWICE_SUM_CAP', { r1: r1.ok ? slim(r1.v) : r1.err, afterR1, s2: s2.ok ? s2.v.storeCreditApplied : s2.err, afterS2, r2: r2 && (r2.ok ? slim(r2.v) : r2.err), final: cr(), liveSpendable: live })
}
if (mode === 'debt-gift-exchange') {
  const a = variant(500_000), b = variant(500_000), n = variant(500_000)
  const H = await gift(300_000, 300_000)
  const o = await sale([line(a, 500_000), line(b, 500_000)], 200_000, H, 'dg')
  const inv = seed.one('SELECT status,paidTotal,grandTotal FROM "SaleInvoice" WHERE id=?', o.id)
  const r = await att(() => exch(o.id, itemId(o.id, a), n, 500_000, null))
  out('DEBT_PLUS_GIFT_EXCHANGE', { invoice: { status: inv.status, paid: Number(inv.paidTotal), grand: Number(inv.grandTotal) }, exchange: r.ok ? slim(r.v) : r.err, credits: cr() })
}
