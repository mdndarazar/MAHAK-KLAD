/**
 * End-to-end old destination-less CREDIT: nobody is forced to wait for the
 * manager, nor can the provisional 0 in the legacy handover row become a
 * reported official blue reference. The manager's later decision is a NEW row
 * on the original handover, never an edit to the frozen evidence.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s407-custody-blue-live-ambiguity.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-ambiguous-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const day = toJalaliDate(new Date())
const manager = seed.user('مدیر S407')
const giver = seed.user('مسئول قبلی S407')
const receiver = seed.user('مسئول بعدی S407')
await custodyService.setPin({ userId: manager, newPassword: 'Manager407!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager407!' })
for (const [id, temporary, personal] of [[giver, 'Giver407!', 'Giver4074!'], [receiver, 'Receiver407!', 'Receiver4074!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager407!', reason: 'صدور PIN برای آزمون تحویل زنده' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
const opened = await custodyService.open({ userId: giver, password: 'Giver4074!', operationalTotal: 501_000_000 })
const cash = seed.insert('PaymentMethod', { key: 'S407_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
const legacyCredit = seed.insert('PaymentMethod', { key: 'S407_LEGACY_CREDIT', label: 'legacy', kind: 'CREDIT', isActive: 0 })
for (const [receiptNo, amount, methodId, destination] of [[407001, 500_000_000, cash, 'CASH'], [407002, 1_000_000, legacyCredit, null]]) {
  const inv = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, giver, opened.shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId, amount, seq: 1, kind: 'CASH', destination,
    paidAt: Date.now(), paidAtJalali: day, createdByUserId: giver, createdShiftId: opened.shiftId })
}
let checks = 0
const eq = (label, actual, expected) => {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  checks++; console.log(`  ✓ ${label}`)
}
const started = await custodyService.handoverStart({ password: 'Giver4074!', operationalTotal: 501_000_000,
  toUserId: receiver, idempotencyKey: 's407:ambiguous:out', blueReference: true })
const count = await custodyService.handoverCountBlue({ handoverId: started.id, password: 'Receiver4074!', operationalTotal: 501_000_000 })
eq('known subtotal without credit', count.knownSubtotal, 500_000_000)
eq('ambiguous historical credit', count.ambiguousLegacyCredit, 1_000_000)
eq('live official reference unknown', count.referenceAmount, null)
eq('live raw unknown rather than zero', count.rawDifference, null)
eq('live fresh unknown rather than zero', count.freshDifference, null)
const finished = await custodyService.handoverConfirmBlue({ handoverId: started.id, password: 'Receiver4074!' })
eq('receiver becomes owner before managerial decision', (await custodyService.status()).custodian?.id, receiver)
eq('sale remains available to real receiver', (await custodyService.actorForFinancialOperation()).expectedShiftId, finished.shiftId)
const original = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'IN')
eq('original snapshot reference still null', original.referenceAmount, null)
eq('original snapshot raw still null', original.rawDifference, null)
const before = await custodyBlueResolutionService.pendingList()
const listedBefore = before.rows.find((row) => row.handoverId === started.id)
eq('original handover appears in manager pending view', listedBefore?.status, 'PENDING_RECONCILIATION')
eq('manager pending view does not infer difference', listedBefore?.rawDifference, null)
const reportBefore = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager407!' })
const beforeHandover = reportBefore.handovers.find((row) => row.id === started.id)
eq('manager report does not claim zero expected from legacy placeholder', beforeHandover?.expectedAtStart, null)
eq('manager report does not claim zero difference from legacy placeholder', beforeHandover?.differenceCash, null)
eq('manager report counts unresolved blue handovers', reportBefore.summary.blueHandoversAwaitingReference, 1)
const decision = await custodyBlueResolutionService.resolve({ snapshotId: original.id, managerUserId: manager, password: 'Manager407!',
  decisionKind: 'NOT_RECEIVED', evidenceDay: day, evidenceReference: 'دفتر تسویه همین روز فیش 407002',
  reason: 'بررسی تأیید کرد که وجه اعتباری اصلاً دریافت نشده است', idempotencyKey: 's407:resolve:not-received:abc' })
eq('decision excludes unreceived credit', decision.referenceAmount, 500_000_000)
eq('positive one million raw is not a guilty verdict', decision.rawDifference, 1_000_000)
eq('fresh stays unknown when original start was ambiguous', decision.freshDifference, null)
eq('still only one immutable original snapshot', seed.count('CustodyBlueSnapshot', 'id=? AND referenceAmount IS NULL', original.id), 1)
eq('decision tied to original observation', seed.one('SELECT snapshotId FROM "CustodyBlueResolution" WHERE id=?', decision.id).snapshotId, original.id)
const after = (await custodyBlueResolutionService.pendingList()).rows.find((row) => row.snapshotId === original.id)
eq('manager shows resolved status', after?.status, 'RESOLVED')
eq('manager shows resolved raw plus one million', after?.rawDifference, 1_000_000)
eq('manager still shows null original reference', after?.originalReferenceAmount, null)
const reportAfter = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager407!' })
const afterHandover = reportAfter.handovers.find((row) => row.id === started.id)
eq('report shows manager decision separately, not a rewritten original', afterHandover?.blue?.status, 'RESOLVED')
eq('report still labels original reference unknown', afterHandover?.expectedAtStart, null)
eq('report links resolved amount to original handover', afterHandover?.blue?.referenceAmount, 500_000_000)
eq('resolved handover leaves pending counter', reportAfter.summary.blueHandoversAwaitingReference, 0)
console.log(`\n✓ ${checks} checks passed`)
