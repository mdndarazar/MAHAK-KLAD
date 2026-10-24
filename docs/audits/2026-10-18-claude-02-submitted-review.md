# Claude-02 independent review (MAHAK-KLAD, SQLite temp harness only, no product/customer DB touched)

Scope note: product code was NOT changed. Three probe/acceptance files were added only in a sandbox copy (see /probes).

## Verified by running real services
| Item | Observed | Verdict |
|---|---|---|
| Owner example sale 15.98M = 2M gift + 13.98M cash | commits, gift USED | PASS |
| Owner example exchange to 15M (mixed gift/cash) | rejected by guard "requires manager reconciliation" | FAIL (confirmed) |
| All-cash control 15.98M -> 15M | child OK, N=980K minted, drawer oracle matches | control PASS |
| ONCE 10M, spent 5M, FULL one-step return | A back ACTIVE 10M, used 0 | confirmed |
| ONCE 10M, spent 5M, two 2.5M returns | A USED; B1 2.5M DRAFT; B2 7.5M DRAFT (5M supplementUnspent); nominal 10M | Claude-01 "5M total" claim is WRONG |
| B1 delivered, 1M of it spent, then second return | nominal stays 10M (2.5 spendable + 7.5 pending); returning the 1M purchase restores to B1 | conserved |
| Mistaken branched return: void/reconcile | all paths refused ("branch exists") | DEAD END: no undo path exists for a mistaken two-step return |
| Root expires between two returns (real clock) | second share becomes EXPIRED (2.5M dead); B1 delivery refused | confirmed |
| Root expired, one-step full return | 5M marked EXPIRED, nothing reactivated | confirmed |
| Real-money EXCHANGE code 10M, spent 5M, two returns | two 2.5M branches; root keeps 5M spendable; total 10M | conserved |
| Mixed 3M gift + 2M cash in 5M purchase, two returns | guard forces seller-entered cash; B1 1.5M + B2 8.5M; cash out 2M | conserved |
| Exchange after a branch exists | refused | confirmed |
| Cheque pending, exchange cheaper (-200K) | exchange accepted; cheque 700K stays PENDING on invoice; remaining 500K; review flag set | new finding |
| Cheque auto-void after debt=0, then return delete | cheque restored to PENDING | confirmed; NO physical-handover field exists (only chequeNo/bank/status) |
| Cash refund reconciled next day | CASH_IN 600K in shift 2, UNRECOVERED 400K; expected drawer moves only with cash | confirmed |
| Card recovered 1M via reconcile | effect row only, no destination (manager account vs store terminal not separated) | confirmed gap |
| Orphan: purge parent with live child, child return | 1M code minted and spent in next sale | confirmed |
| Two real processes, same exchange | one succeeded (1 child, 1 return, 1 code); other got "database is locked" | safe, but not an idempotent retry |
| tests/audit-fixes/fix-s163-c-integrated-ext.mjs | 123 pass, 0 fail | confirmed |

## Acceptance (tools/audit-probes/ACCEPTANCE-claude02-S1-E1-R1.mjs)
Real assertions, no assert.fail placeholders. Today: S1 PASS, E1 FAIL (guard), E2 not run.
Control run (ACC_CONTROL=allcash): E1, E2, E5, R1a, R1b PASS. E4 FAILS on expiry: the all-cash N code gets the 7-day EXCHANGE default expiry (expires 2026-10-25), so "N without expiry" is a current-behaviour gap. E3 needs a ledger table that does not exist yet (ExchangeFundingAllocation). E6 needs a DRAFT delivery row, which the all-cash N does not have.

## Policy model (paper, integer rials, proportional split as in allocateCreditReturn)
Owner example (gift 2M + cash 13.98M, new item 15M):
- gift-first: carry 2M gift + 13M cash, N=980K real cash right (matches baseline). Full child return: 2M gift + 13M cash.
- cash-first: carry 1.02M gift + 13.98M cash, 980K becomes a GIFT branch (B), N=0. If the root has expired, that 980K is dead money. Counterexample to "cash-first is harmless".
- proportional: 1,877,346 gift + 13,122,654 cash, B=122,654 gift, N=857,346 cash. Two rights, not one.
- Cheaper new item 1.5M: gift-first gives 1.5M gift carry, 0.5M of gift branch, N=13.98M cash (the whole cash right stays real). Cash-first gives cash carry 1.5M and 2M gift branch.
- Debt case (8.98M debt + 5M cash, new 15M): debt is cut first, 8M of child is debt, so no N is minted; cash right after full child return = 5M.

## Still open (not run)
Physical cheque handover/bank evidence (no data model); manager-account card return bucket (no field); BackupService and restore; IPC/UI; day-boundary 05:00 and MIDDAY shift; a real idempotency key test; a fix for mistaken branched returns (no void path exists).

## Owner questions that are genuinely policy
1. Gift-first vs cash-first vs proportional for cheaper replacements (see model).
2. Should a real-cash right (N) ever expire? Current code: 7 days.
3. ONCE 10M/spent 5M: after a full two-step return, is the 5M supplement (B2 7.5M) acceptable, or should only the spent share come back?
4. Card-to-card / manager-account returns: which account, and is a separate tile needed?
5. Should a mistaken branched return have a manager-only reversal path? Currently none.
