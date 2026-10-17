/**
 * Peer warning is independent of an unresolvable blue reference. A later sale
 * makes the readback stale (never a backdoor to old counts); PIN lockout stays
 * effective, cancellation stays optional, and absence is NOT an OUT count.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s448-custody-peer-pending-stale-and-absence.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-peer-pending-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
import { grantMiddayFixture } from './grant-midday-fixture.mjs'
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { compareCustodyPeerCounts } = await import('../../src/shared/custodyPeerCount.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
const day = toJalaliDate(new Date())
let checks = 0
function eq(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
async function reject(label, code, op) {
  try { await op() } catch (err) { eq(label, err?.code, code); return }
  throw new Error(`${label}: unexpectedly succeeded`)
}
const manager = seed.user('مدیر S448'), giver = seed.user('اول S448'), receiver = seed.user('دوم S448'), cover = seed.user('جایگزین S448')
for (const id of [giver, receiver, cover]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: '1111', newPassword: 'Manager448!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager448!' })
await grantMiddayFixture({ manager, password: 'Manager448!', custodian: giver })
for (const [id, temp, pin] of [[giver, 'GiverTmp448!', 'GiverOwn448!'], [receiver, 'ReceiverTmp448!', 'ReceiverOwn448!'], [cover, 'CoverTmp448!', 'CoverOwn448!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager448!', reason: 'PIN شخصی آزمون مرجع نامعلوم و غیبت' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
const opened = await custodyService.open({ userId: giver, password: 'GiverOwn448!', operationalTotal: 501_000_000 })
const cash = seed.insert('PaymentMethod', { key: 'S448_CASH', label: 'نقدی', kind: 'CASH', isActive: 1 })
const ambiguous = seed.insert('PaymentMethod', { key: 'S448_LEGACY_CREDIT', label: 'اعتبار قدیمی', kind: 'CREDIT', isActive: 0 })
function sale(receipt, amount, methodId, destination, userId, shiftId) {
  const inv = seed.invoice({ receiptNo: receipt, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, userId, shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId, amount, seq: 1, kind: 'CASH', destination,
    paidAt: Date.now(), paidAtJalali: day, createdByUserId: userId, createdShiftId: shiftId })
}
sale(448001, 500_000_000, cash, 'CASH', giver, opened.shiftId)
sale(448002, 1_000_000, ambiguous, null, giver, opened.shiftId)
const first = await custodyService.handoverStart({ password: 'GiverOwn448!', operationalTotal: 501_000_000,
  toUserId: receiver, idempotencyKey: 's448:unknown-out', blueReference: true })
const out = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', first.id, 'OUT')
eq('unresolved reference never becomes a made-up zero', out.referenceAmount, null)
eq('unresolved reference marked pending', out.referenceStatus, 'PENDING_RECONCILIATION')
const unknownIn = await custodyService.handoverCountBlue({ handoverId: first.id, password: 'ReceiverOwn448!', operationalTotal: 506_000_000 })
eq('raw variance stays unknown', unknownIn.rawDifference, null)
eq('fresh variance stays pending', unknownIn.freshDifference, null)
eq('physical peer difference still warns accurately', unknownIn.peerComparison,
  { status: 'DIFFERENT', direction: 'MORE', absoluteDifferenceRial: '5000000', selfCount: false })
const review = await custodyService.handoverBlueReview({ handoverId: first.id, password: 'ReceiverOwn448!' })
eq('unknown reference still allows receiver-PIN review', review.peerComparison, unknownIn.peerComparison)
const approved = await custodyService.handoverConfirmBlue({ handoverId: first.id, password: 'ReceiverOwn448!' })
eq('unknown reference plus peer mismatch cannot block approval', (await custodyService.status()).custodian.id, receiver)
eq('uncertain original IN remains pending without a numerical accusation', seed.one('SELECT rawDifference FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', first.id, 'IN').rawDifference, null)
eq('no automatic blame report', seed.count('CustodyDiscrepancyCase'), 0)

const pendingSale = await custodyService.handoverStart({ password: 'ReceiverOwn448!', operationalTotal: 506_000_000,
  toUserId: giver, idempotencyKey: 's448:stale-out', blueReference: true })
const counted = await custodyService.handoverCountBlue({ handoverId: pendingSale.id, password: 'GiverOwn448!', operationalTotal: 505_900_000 })
eq('second attempt warns even with reference pending', counted.peerComparison.direction, 'LESS')
eq('sales during pending still belong to second responsible worker', (await custodyService.actorForFinancialOperation()).expectedShiftId, approved.shiftId)
sale(448003, 100_000, cash, 'CASH', receiver, approved.shiftId)
const evidenceBefore = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', pendingSale.id, 'IN')
const versionBefore = seed.one('SELECT version FROM "CustodyHandover" WHERE id=?', pendingSale.id).version
await reject('readback refuses outdated financial revision without changing state', 'BLUE_RECOUNT_REQUIRED',
  () => custodyService.handoverBlueReview({ handoverId: pendingSale.id, password: 'GiverOwn448!' }))
eq('readback does not mark attempt stale or rewrite handover', seed.one('SELECT version FROM "CustodyHandover" WHERE id=?', pendingSale.id).version, versionBefore)
eq('readback leaves frozen IN intact', seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', pendingSale.id, 'IN'), evidenceBefore)
await reject('actual confirmation applies existing stale guard', 'BLUE_RECOUNT_REQUIRED',
  () => custodyService.handoverConfirmBlue({ handoverId: pendingSale.id, password: 'GiverOwn448!' }))
eq('stale history is retained', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', pendingSale.id).status, 'STALE')
eq('sale survives failed transfer under correct prior owner', seed.one('SELECT userId FROM "SaleInvoice" WHERE receiptNo=?', 448003).userId, receiver)
await reject('stale attempt readback unavailable', 'BLUE_NOT_COUNTED',
  () => custodyService.handoverBlueReview({ handoverId: pendingSale.id, password: 'GiverOwn448!' }))

const lockedAttempt = await custodyService.handoverStart({ password: 'ReceiverOwn448!', operationalTotal: 506_100_000,
  toUserId: giver, idempotencyKey: 's448:pin-locked-out', blueReference: true })
await custodyService.handoverCountBlue({ handoverId: lockedAttempt.id, password: 'GiverOwn448!', operationalTotal: 506_100_000 })
for (let i = 1; i <= 5; i++) await reject(`bad readback PIN attempt ${i} is throttled`, i === 5 ? 'PIN_LOCKED' : 'PIN_WRONG',
  () => custodyService.handoverBlueReview({ handoverId: lockedAttempt.id, password: 'Incorrect448!' }))
await reject('even genuine PIN cannot bypass five-failure lockout', 'PIN_LOCKED',
  () => custodyService.handoverBlueReview({ handoverId: lockedAttempt.id, password: 'GiverOwn448!' }))
eq('locked readback did not change two-count evidence', seed.count('CustodyBlueSnapshot', 'handoverId=?', lockedAttempt.id), 2)
await custodyService.handoverCancel({ handoverId: lockedAttempt.id, password: 'ReceiverOwn448!' })
eq('optional old-owner cancellation remains possible', (await custodyService.status()).custodian.id, receiver)

// A genuinely absent previous worker cannot attest OUT; emergency cover is
// independently approved by the present worker, not by the locked recipient.
const absent = await custodyService.emergencyCover({ userId: cover, password: 'CoverOwn448!',
  operationalTotal: 506_100_000, reason: 'مسئول قبلی حاضر نیست؛ فقط جایگزین موجودی آغاز خود را شمرده است.' })
const absentOut = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', absent.handoverId, 'OUT')
const absentIn = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', absent.handoverId, 'IN')
eq('absent old worker has no human OUT amount', absentOut.humanAmount, null)
eq('absence origin cannot turn into synthetic zero', absentOut.countOrigin, 'ABSENT_UNCOUNTED')
eq('new worker alone counted IN', absentIn.actorUserId, cover)
eq('absence has no two-person warning', compareCustodyPeerCounts(absentOut, absentIn).status, 'NOT_APPLICABLE')
await reject('ordinary review refuses exceptional absence handover', 'BLUE_NOT_COUNTED',
  () => custodyService.handoverBlueReview({ handoverId: absent.handoverId, password: 'CoverOwn448!' }))
eq('present worker owns drawer, no prior PIN necessary', (await custodyService.status()).custodian.id, cover)
eq('present worker can sell after absence', (await custodyService.actorForFinancialOperation()).expectedShiftId, absent.shiftId)
console.log(`\n✓ ${checks} pending-reference, stale, lockout and absence checks passed`)
