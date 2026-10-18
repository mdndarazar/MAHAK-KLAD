// Paper model (NOT product code). Integer rials. Uses the same cumulative floor split as allocateCreditReturn.
const split = (gift, cash, amt) => { const F = gift + cash; if (!F) return [0, 0]; const g = Number(BigInt(gift) * BigInt(amt) / BigInt(F)); return [g, amt - g] }
function exchange({ V, debt = 0, gift, cash, P, giftEligible = true, giftExpired = false }, policy) {
  const debtCut = Math.min(V, debt), F = V - debtCut
  const [g0, c0] = split(gift, cash, F)                // line provenance (existing proportional rule)
  const k = Math.min(P, F)
  let gc, cc
  const gMax = giftEligible ? g0 : 0
  if (policy === 'gift-first') { gc = Math.min(gMax, k); cc = Math.min(c0, k - gc) }
  else if (policy === 'cash-first') { cc = Math.min(c0, k); gc = Math.min(gMax, k - cc) }
  else { gc = giftEligible ? Number(BigInt(g0) * BigInt(k) / BigInt(F)) : 0; cc = Math.min(c0, k - gc) ; if (gc + cc < k && giftEligible) gc = k - cc }
  const rest = P - gc - cc
  const childDebt = Math.min(rest, debtCut), newMoney = rest - childDebt
  const B = g0 - gc, Nn = c0 - cc
  const debtAfter = debt - debtCut + childDebt
  // invariants
  if (cc + Nn > c0 || gc + B > g0 || gc + cc + rest !== P) throw new Error('INVARIANT ' + policy)
  return { policy, giftCarry: gc, cashCarry: cc, childDebt, newMoney, debtAfter, B_gift: giftExpired ? 0 : B, B_expired: giftExpired ? B : 0, N_cash: Nn }
}
function childReturn(e, r) { // cumulative proportional on child funding, debt-first
  const dc = Math.min(r, e.childDebt), f = r - dc
  const [g, c] = split(e.giftCarry, e.cashCarry, f); return { r, debtCut: dc, B: g, cashRight: c }
}
const cases = {
  'C1 owner: A=2M valid, cash 13.98M, ->15M': { V: 15_980_000, gift: 2_000_000, cash: 13_980_000, P: 15_000_000 },
  'C2 same, A expired at exchange': { V: 15_980_000, gift: 2_000_000, cash: 13_980_000, P: 15_000_000, giftExpired: true },
  'C3 ->1.5M (cheaper than gift share)': { V: 15_980_000, gift: 2_000_000, cash: 13_980_000, P: 1_500_000 },
  'C4 ->15M but item outside A scope': { V: 15_980_000, gift: 2_000_000, cash: 13_980_000, P: 15_000_000, giftEligible: false },
  'C5 5M cash + 8.98M debt, ->15M': { V: 15_980_000, debt: 8_980_000, gift: 2_000_000, cash: 5_000_000, P: 15_000_000 },
  'C6 13.98M pending cheque (=debt), ->15M': { V: 15_980_000, debt: 13_980_000, gift: 2_000_000, cash: 0, P: 15_000_000 },
  'C7 two lines 8M+7.98M; exchange 7.98M line ->7M': { V: 7_980_000, gift: Math.floor(2_000_000 * 7_980_000 / 15_980_000) === 0 ? 0 : 2_000_000, cash: 13_980_000, P: 7_000_000, _note: 'gift/cash passed as invoice totals; split() applies cumulative share' },
}
// C7: line provenance must use invoice-level funded total, emulate by scaling
for (const [name, c] of Object.entries(cases)) {
  const input = { ...c }
  if (name.startsWith('C7')) { const [g, k] = split(2_000_000, 13_980_000, 7_980_000); Object.assign(input, { gift: g, cash: k }) }
  console.log('\n## ' + name)
  for (const p of ['gift-first', 'cash-first', 'proportional']) {
    const e = exchange(input, p)
    const full = childReturn(e, e.giftCarry + e.cashCarry + e.childDebt), part = childReturn(e, Math.round(input.P / 15))
    const cashRightsTotal = e.N_cash + full.cashRight
    console.log(JSON.stringify({ ...e, childFull: full, child1of15: part, totalCashRightsAfterFullChildReturn: cashRightsTotal }))
  }
}
