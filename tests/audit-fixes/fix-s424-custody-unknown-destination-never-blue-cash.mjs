/**
 * A cleared historical cheque with no proven destination is NOT cash/card at
 * the store. Keep known money separate, make the official blue reference and
 * variance unknown, allow handover/sales, and never let a CREDIT-only decision
 * silently clear a second, different ambiguity in the same frozen snapshot.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s424-custody-unknown-destination-never-blue-cash.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-unknown-s424-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { calculateCustodyReference } = await import('../../src/shared/custodyReference.ts')
const { officialReferenceForDays } = await import('../../src/main/services/CustodyReferenceService.ts')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
let checks = 0
function eq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function rejects(label, work, code) {
  try { await work() }
  catch (e) { eq(label, e?.code, code); return }
  throw new Error(`${label}: unexpectedly allowed`)
}
const known = calculateCustodyReference({ cashReceived: 100, cardReceived: 0, otherReceived: 0,
  destinationUnknownReceived: 50, ambiguousLegacyCredit: 0, refundCash: 0, refundCard: 0 })
eq('unknown destination is not an available official reference', known.status, 'PENDING_RECONCILIATION')
eq('cash/card-known subtotal never includes unknown receipt', known.knownSubtotal, 100)
eq('no fictitious 150 reference', known.referenceAmount, null)
eq('unknown destination is a separately named amount', known.destinationUnknownReceived, 50)
eq('unknown destination is not a legacy CREDIT ambiguity', known.ambiguousLegacyCredit, 0)

const manager = seed.user('مدیر S424')
const giver = seed.user('مسئول اول S424')
const receiver = seed.user('مسئول دوم S424')
await custodyService.setPin({ userId: manager, newPassword: 'Manager424!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager424!' })
for (const [id, temporary, personal] of [[giver, 'GiverTemp424!', 'GiverFinal424!'], [receiver, 'ReceiverTemp424!', 'ReceiverFinal424!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager,
    managerPassword: 'Manager424!', reason: 'تست تاریخی مقصد نامشخص' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
const opened = await custodyService.open({ userId: giver, password: 'GiverFinal424!', operationalTotal: 100 })
const cash = seed.insert('PaymentMethod', { key: 'S424_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const cheque = seed.insert('PaymentMethod', { key: 'S424_CHEQUE', label: 'چک', kind: 'CUSTOM', isActive: 1 })
const credit = seed.insert('PaymentMethod', { key: 'S424_CREDIT_OLD', label: 'نسیهٔ قدیمی', kind: 'CREDIT', isActive: 0 })
function settled(receiptNo, amount, methodId, { kind = 'CASH', destination = 'CASH', chequeStatus = null } = {}) {
  const invoice = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=?, shiftId=? WHERE id=?')
    .run(today, amount, amount, giver, opened.shiftId, invoice.id)
  seed.insert('Payment', { invoiceId: invoice.id, methodId, amount, seq: 1, kind, destination, chequeStatus,
    paidAt: Date.now(), paidAtJalali: today, createdShiftId: opened.shiftId,
    clearedAt: kind === 'CHEQUE' ? Date.now() : null,
    clearedAtJalali: kind === 'CHEQUE' ? today : null,
    clearedShiftId: kind === 'CHEQUE' ? opened.shiftId : null })
}
settled(424001, 100, cash)
settled(424002, 50, cheque, { kind: 'CHEQUE', destination: null, chequeStatus: 'CLEARED' })
const report = await salesService.reportRows({ fromJalali: today, toJalali: today, take: 1 })
eq('existing general accounting still lists the unknown 50', report.accounting.cash.destinationUnknownReceived, 50)
eq('general realCash does not count unknown receipt', report.accounting.bridge.rows.find((r) => r.key === 'realCash').amount, 100)
eq('blue reference uses complete scope, not one displayed row', report.custodyReference.status, 'PENDING_RECONCILIATION')
eq('report blue known amount is 100', report.custodyReference.knownSubtotal, 100)
eq('report blue separates the unknown 50', report.custodyReference.destinationUnknownReceived, 50)
eq('report blue does not claim zero variance', report.custodyReference.referenceAmount, null)
const official = await officialReferenceForDays({ operationalDay: today })
eq('Main agrees with full report status', official.status, report.custodyReference.status)
eq('Main agrees with full report known amount', official.knownSubtotal, report.custodyReference.knownSubtotal)
const start = await custodyService.handoverStart({ password: 'GiverFinal424!', operationalTotal: 100,
  toUserId: receiver, blueReference: true, idempotencyKey: 's424:unknown-only:out' })
const incoming = await custodyService.handoverCountBlue({ handoverId: start.id, password: 'ReceiverFinal424!', operationalTotal: 100 })
eq('uncertain reference makes RAW variance unknown, never zero', incoming.rawDifference, null)
eq('uncertain reference makes NEW variance unknown', incoming.freshDifference, null)
const completed = await custodyService.handoverConfirmBlue({ handoverId: start.id, password: 'ReceiverFinal424!' })
eq('receiver assumes custody without manager waiting', (await custodyService.status()).custodian?.id, receiver)
eq('financial operations remain available', (await custodyService.actorForFinancialOperation()).expectedShiftId, completed.shiftId)
const frozen = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', start.id, 'IN')
eq('frozen known subtotal is preserved', Number(frozen.knownSubtotal), 100)
eq('frozen unknown destination is preserved separately', Number(frozen.destinationUnknownReceived), 50)
eq('original snapshot never claims a reference', frozen.referenceAmount, null)

settled(424003, 20, credit, { destination: null })
const mixed = await custodyService.handoverStart({ password: 'ReceiverFinal424!', operationalTotal: 100,
  toUserId: giver, blueReference: true, idempotencyKey: 's424:mixed:out' })
await custodyService.handoverCountBlue({ handoverId: mixed.id, password: 'GiverFinal424!', operationalTotal: 100 })
await custodyService.handoverConfirmBlue({ handoverId: mixed.id, password: 'GiverFinal424!' })
const mixedSnap = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', mixed.id, 'IN')
eq('mixed snapshot keeps credit distinct', Number(mixedSnap.ambiguousLegacyCredit), 20)
eq('mixed snapshot keeps destination unknown distinct', Number(mixedSnap.destinationUnknownReceived), 50)
await rejects('credit-only manager proof cannot mark mixed case RESOLVED', () => custodyBlueResolutionService.resolve({
  snapshotId: mixedSnap.id, managerUserId: manager, password: 'Manager424!', decisionKind: 'RECEIVED_CASH',
  evidenceDay: today, evidenceReference: 'رسید نقدیِ مربوط به ۲۰ ریال',
  reason: 'مدرک کافی برای ۵۰ ریال چکِ بی‌مقصد وجود ندارد', idempotencyKey: 's424:mixed:manager:denied'
}), 'BLUE_OTHER_UNRESOLVED')
eq('no false manager decision persisted', seed.count('CustodyBlueResolution', 'snapshotId=?', mixedSnap.id), 0)
eq('sales stay assigned to accepted owner even while unresolved', (await custodyService.status()).custodian?.id, giver)
console.log(`\n✓ ${checks} checks passed`)
