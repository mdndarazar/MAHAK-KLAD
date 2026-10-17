/** Main freezes a full-day blue snapshot at outgoing blind count, while sales
 * stay owned by the old custodian. Cancellation cannot erase that evidence. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-handover-start-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
import { grantMiddayFixture } from './grant-midday-fixture.mjs'
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const day = toJalaliDate(new Date())
const manager = seed.user('مدیر S405')
const giver = seed.user('مسئول اول S405')
const receiver = seed.user('مسئول دوم S405')
await custodyService.setPin({ userId: manager, newPassword: 'Manager405!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager405!' })
await grantMiddayFixture({ manager, password: 'Manager405!', custodian: giver })
for (const [id, tmp, permanent] of [[giver, 'Giver405!', 'Giver4054!'], [receiver, 'Receiver405!', 'Receiver4054!']]) {
  await custodyService.setPin({ userId: id, newPassword: tmp, managerUserId: manager, managerPassword: 'Manager405!', reason: 'ساخت رمز تست حضانت جدید' })
  await custodyService.setPin({ userId: id, currentPassword: tmp, newPassword: permanent })
}
const opened = await custodyService.open({ userId: giver, password: 'Giver4054!', operationalTotal: 501_000_000 })
const methodCash = seed.insert('PaymentMethod', { key: 'S405_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
const methodOld = seed.insert('PaymentMethod', { key: 'S405_CREDIT_OLD', label: 'legacy credit', kind: 'CREDIT', isActive: 0 })
function sale(receiptNo, amount, methodId, destination) {
  const inv = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, giver, opened.shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId, amount, seq: 1, kind: 'CASH', destination, paidAt: Date.now(), paidAtJalali: day, createdByUserId: giver, createdShiftId: opened.shiftId })
}
sale(405001, 500_000_000, methodCash, 'CASH')
sale(405002, 1_000_000, methodOld, null)
let checked = 0
const eq = (label, got, expected) => {
  if (got !== expected) throw new Error(`${label}: expected ${expected}, got ${got}`)
  checked++; console.log(`  ✓ ${label}`)
}
const started = await custodyService.handoverStart({ password: 'Giver4054!', operationalTotal: 501_000_000,
  toUserId: receiver, idempotencyKey: 's405:handover:out:1', blueReference: true })
eq('handover pending', started.state, 'HANDOVER_PENDING')
const out = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'OUT')
eq('snapshot tied to original handover', out.handoverId, started.id)
eq('snapshot known 500M', Number(out.knownSubtotal), 500_000_000)
eq('snapshot ambiguous 1M', Number(out.ambiguousLegacyCredit), 1_000_000)
eq('snapshot pending', out.referenceStatus, 'PENDING_RECONCILIATION')
eq('snapshot official reference null', out.referenceAmount, null)
eq('snapshot raw difference null', out.rawDifference, null)
eq('scope today', out.referenceToDay, day)
eq('fingerprint from whole period exists', typeof out.sourceHash, 'string')
eq('transaction revision frozen', out.financialRevision, seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN').financialRevision)
const fence = await custodyService.actorForFinancialOperation()
eq('pending sale still belongs to outgoing shift', fence.expectedShiftId, opened.shiftId)
sale(405003, 100_000, methodCash, 'CASH')
eq('sales advanced financial revision while pending', seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN').financialRevision > out.financialRevision, true)
await custodyService.handoverCancel({ handoverId: started.id, password: 'Giver4054!' })
eq('cancellation restores original custodian', (await custodyService.status()).custodian?.id, giver)
eq('canceled original snapshot survives', seed.count('CustodyBlueSnapshot', 'id=?', out.id), 1)

const renewed = await custodyService.handoverStart({ password: 'Giver4054!', operationalTotal: 501_100_000,
  toUserId: receiver, idempotencyKey: 's405:handover:out:2', blueReference: true })
const acceptedCount = await custodyService.handoverCountBlue({ handoverId: renewed.id, password: 'Receiver4054!', operationalTotal: 501_100_000 })
eq('receiver independent count persisted before confirmation', acceptedCount.state, 'RECEIVER_COUNTED')
eq('pending blue does not invent raw difference', acceptedCount.rawDifference, null)
eq('pending blue reports known 500.1M', acceptedCount.knownSubtotal, 500_100_000)
eq('both count snapshots retained', seed.count('CustodyBlueSnapshot', 'handoverId=?', renewed.id), 2)
eq('receiver had personal PIN proof', seed.one('SELECT authMethod FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', renewed.id, 'IN').authMethod, 'CUSTODY_PIN')
eq('sales remain permitted after receiver counts and before confirmation', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
sale(405004, 100_000, methodCash, 'CASH')
await custodyService.handoverCancel({ handoverId: renewed.id, password: 'Giver4054!' })
eq('giver can cancel counted attempt without blocking sales', (await custodyService.status()).state, 'ACTIVE')
eq('canceled receiver snapshot is not deleted', seed.count('CustodyBlueSnapshot', 'handoverId=?', renewed.id), 2)

const stale = await custodyService.handoverStart({ password: 'Giver4054!', operationalTotal: 501_200_000,
  toUserId: receiver, idempotencyKey: 's405:handover:out:3', blueReference: true })
sale(405005, 100_000, methodCash, 'CASH')
try { await custodyService.handoverCountBlue({ handoverId: stale.id, password: 'Receiver4054!', operationalTotal: 501_300_000 }); throw new Error('old count accepted') }
catch (error) { eq('sale between counts forces new attempt', error.code, 'BLUE_RECOUNT_REQUIRED') }
eq('stale count never transfers owner', (await custodyService.status()).custodian?.id, giver)
eq('stale attempt is recorded, not erased', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', stale.id).status, 'STALE')
eq('no receiver count reused for stale attempt', seed.count('CustodyBlueSnapshot', 'handoverId=? AND role=?', stale.id, 'IN'), 0)
console.log(`\n✓ ${checked} checks passed`)
