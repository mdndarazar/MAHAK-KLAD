/**
 * Master Override is a named MANAGER's own custody PIN + fresh real combined
 * count, never a shared password or a freeze. Sales between reading the full
 * blue reference and committing force a fresh count, without transferring
 * ownership or inventing old-person liability.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s378-master-override-accountability.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-master-personal-s378-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const manager = seed.user('مدیر شخصی S378')
const absent = seed.user('مسئول غایب S378')
const cashier = seed.user('غیرمدیر S378')
sql.prepare('UPDATE "User" SET role=? WHERE id IN (?,?)').run('CASHIER', absent, cashier)
await custodyService.setPin({ userId: manager, newPassword: 'Manager378!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager378!' })
for (const [id, temp, personal] of [[absent, 'Absent378!', 'Absent3784!'], [cashier, 'Cashier378!', 'Cashier3784!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager378!', reason: 'آزمون مسئولیت شخصی مدیر' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: personal })
}
let checks = 0
function eq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function rejects(label, code, work) {
  try { await work() } catch (error) { eq(label, error?.code, code); return }
  throw new Error(`${label}: unexpectedly accepted`)
}
const opened = await custodyService.open({ userId: absent, password: 'Absent3784!', operationalTotal: 1_000 })
const reason = 'مسئول پیشین غایب است و مدیر با شمارش واقعی مسئولیت را می‌گیرد.'
await rejects('nonmanager cannot claim master authority even with personal PIN', 'MASTER_OVERRIDE_MANAGER_INVALID',
  () => custodyService.masterOverride({ managerUserId: cashier, managerPassword: 'Cashier3784!', operationalTotal: 900, reason }))
await rejects('shared password cannot replace named manager PIN', 'PIN_WRONG',
  () => custodyService.masterOverride({ managerUserId: manager, managerPassword: '1111', operationalTotal: 900, reason }))
await rejects('a reason is still mandatory', 'MASTER_OVERRIDE_REASON_REQUIRED',
  () => custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager378!', operationalTotal: 900, reason: 'کوتاه' }))
await rejects('a new physical count is mandatory', 'CUSTODY_AGGREGATE_COUNT_REQUIRED',
  () => custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager378!', reason }))
eq('rejected override keeps previous owner', (await custodyService.status()).custodian?.id, absent)

// Hold the full financial reference read. A sale before commit must remain
// writable by the old custodian and invalidate the attempted transfer.
let enterRead
const reading = new Promise((resolve) => { enterRead = resolve })
let releaseRead
const resume = new Promise((resolve) => { releaseRead = resolve })
const originalReportRows = salesService.reportRows
salesService.reportRows = async (...args) => { enterRead(); await resume; return originalReportRows(...args) }
let inFlight
try {
  inFlight = custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager378!', operationalTotal: 900, reason })
  await reading
  const writer = await custodyService.actorForFinancialOperation()
  eq('sale can still begin under prior real owner during manager read', writer.expectedShiftId, opened.shiftId)
  const revisionBefore = seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN').financialRevision
  const invoice = seed.invoice({ grandTotal: 123, status: 'CREDIT' })
  sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=?, paidTotal=? WHERE id=?').run(absent, opened.shiftId, 0, invoice.id)
  eq('sale advances financial revision even when no cash received', seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN').financialRevision > revisionBefore, true)
  releaseRead()
  await rejects('new sale invalidates old snapshot rather than freezing sales', 'CUSTODY_STALE', () => inFlight)
} finally {
  releaseRead?.()
  salesService.reportRows = originalReportRows
}
eq('failed attempt produced no handover/count', seed.count('CustodyHandover'), 0)
eq('old owner still owns sales after stale attempt', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
eq('sale on credit with no receipt does not add to blue reference', (await custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager378!', operationalTotal: 900, reason })).referenceAmount, 0)
const transferred = await custodyService.status()
eq('selected manager is actual new custodian', transferred.custodian?.id, manager)
eq('sales available immediately to manager', (await custodyService.actorForFinancialOperation()).expectedShiftId, transferred.activeShiftId)
const moved = seed.one('SELECT * FROM "CustodyHandover" ORDER BY id DESC LIMIT 1')
eq('master is separately marked completed', moved.resolutionKind, 'BLUE_MASTER_OVERRIDE')
eq('manager id is durable approver and receiver', moved.managerApproverUserId, manager)
const oldSide = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', moved.id, 'OUT')
const managerSide = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', moved.id, 'IN')
eq('missing custodian has system-only absence origin', oldSide.countOrigin, 'SYSTEM_ABSENCE_ZERO')
eq('no invented PIN from missing worker', oldSide.authMethod, 'SYSTEM_ABSENCE_ZERO')
eq('missing worker has no human amount', oldSide.humanAmount, null)
eq('manager has own real count', Number(managerSide.humanAmount), 900)
eq('manager personal PIN is the audit method', managerSide.authMethod, 'MANAGER_CUSTODY_PIN')
eq('manager raw positive 900 against zero reference', Number(managerSide.rawDifference), 900)
eq('there is no automatic fresh attribution from absence', managerSide.freshDifference, null)
eq('no invented POS cash float for manager count', seed.count('CashMovement', 'shiftId=? AND type=?', transferred.activeShiftId, 'OPENING_FLOAT'), 0)
eq('no automatic blame case produced', seed.count('CustodyDiscrepancyCase'), 0)
const event = seed.one('SELECT type, actorUserId, authMethod FROM "CustodyEvent" WHERE handoverId=? ORDER BY id DESC LIMIT 1', moved.id)
eq('Master Override event is distinguishable', event.type, 'BLUE_MASTER_OVERRIDE_COMMITTED')
eq('event actor is named manager', event.actorUserId, manager)
eq('event PIN provenance belongs to manager', event.authMethod, 'MANAGER_CUSTODY_PIN')
const chip = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
eq('UI asks for selected manager personal PIN, not shared secret', chip.includes('PIN شخصی مدیر انتخاب‌شده') && !chip.includes('رمز مشترک مدیر'), true)
eq('IPC strips old countedCash freeze input', ipc.includes('countedCash: _old') && ipc.includes('custodyService.masterOverride(safe)'), true)
console.log(`\n✓ ${checks} checks passed`)
