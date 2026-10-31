/**
 * A large historical range fails BEFORE it can return a partial counter or
 * materialize thousands of rows. A token's TTL is bounded and does not get
 * refreshed by paging. This harness is NOT a production Prisma writer-latency
 * benchmark: its transactions use BEGIN IMMEDIATE.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s456-cash-closing-history-limits.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-cash-history-limits-s456-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { runWithPanelSessionOwner, notePanelUnlocked, currentManagerSessionIdentity } = await import('../../src/main/services/panelSession.ts')
const { cashClosingHistoryService, CASH_HISTORY_MAX_EVIDENCE } = await import('../../src/main/services/CashClosingHistoryService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db)
const range = { fromJalali: toJalaliDate(new Date()), toJalali: toJalaliDate(new Date()) }
let checks = 0
const eq = (name, got, want) => { assert.equal(got, want, name); console.log(`  ✓ ${name}`); checks++ }
const under = (fn) => runWithPanelSessionOwner(456, fn)
under(() => notePanelUnlocked('__manager__', 'MANAGER'))
const firstQuery = under(() => cashClosingHistoryService.query(range))
await assert.rejects(under(() => cashClosingHistoryService.query(range)), (err) => err?.code === 'REPORT_BUSY')
checks++
await firstQuery
eq('overlapping report queries are rejected, never queued behind a reader', seed.count('CustodyEvent'), 0)
const realNow = Date.now
let clock = realNow()
try {
  Date.now = () => clock
  const snap = await under(() => cashClosingHistoryService.query(range))
  clock += 4 * 60_000
  under(() => currentManagerSessionIdentity('تمدید نشست موجود')) // manager still valid; only its memory TTL advances
  clock += 2 * 60_000
  await assert.rejects(under(() => cashClosingHistoryService.query({ ...range, snapshotToken: snap.snapshotToken })), (err) => err?.code === 'REPORT_SNAPSHOT_EXPIRED')
  checks++
  eq('an expired snapshot cannot be rebuilt under the same token', seed.count('CustodyEvent'), 0)
} finally { Date.now = realNow }
// A bounded index count rejects a large range before fetching related rows.
// Use the existing seeder to fill required schema columns, no migration/edit.
const now = new Date()
const sql = db.$harness.db
sql.exec('BEGIN')
try {
  for (let i = 0; i <= CASH_HISTORY_MAX_EVIDENCE; i++) {
    seed.insert('CustodyEvent', { type: 'HANDOVER_ACCEPT', at: now, actorKind: 'RECEIVER',
      payloadJson: '{}', operationalDay: range.fromJalali })
  }
  sql.exec('COMMIT')
} catch (e) { sql.exec('ROLLBACK'); throw e }
const before = {
  events: seed.count('CustodyEvent'), settings: seed.count('Setting'), audits: seed.count('AuditLog'),
  shifts: seed.count('Shift'), sessions: seed.count('CashSession')
}
await assert.rejects(under(() => cashClosingHistoryService.query(range)), (err) => err?.code === 'REPORT_TOO_LARGE')
checks++
eq('too-large range creates no report-side event', seed.count('CustodyEvent'), before.events)
eq('too-large range writes no settings/audit/session/shift', [seed.count('Setting'), seed.count('AuditLog'), seed.count('CashSession'), seed.count('Shift')].join(','),
  [before.settings, before.audits, before.sessions, before.shifts].join(','))
console.log(`\n✓ ${checks} bounded history checks passed`)
