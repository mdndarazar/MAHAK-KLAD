/**
 * One person may attest both sides of a boundary without closing the Shift;
 * a later sale after the receiver counted invalidates confirmation and leaves
 * both count documents intact. Pre-existing aggregate handovers remain usable.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s408-custody-blue-self-and-stale.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-self-'))
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
const manager = seed.user('مدیر S408')
const giver = seed.user('تنها مسئول S408')
const receiver = seed.user('مسئول جدید S408')
await custodyService.setPin({ userId: manager, newPassword: 'Manager408!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager408!' })
await grantMiddayFixture({ manager, password: 'Manager408!', custodian: giver })
for (const [id, temp, own] of [[giver, 'Giver408!', 'Giver4084!'], [receiver, 'Receiver408!', 'Receiver4084!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager408!', reason: 'صدور PIN برای آزمون مرز خودتحویلی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: own })
}
const cash = seed.insert('PaymentMethod', { key: 'S408_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
function sale(receipt, amount, shiftId, userId) {
  const invoice = seed.invoice({ receiptNo: receipt, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, userId, shiftId, invoice.id)
  seed.insert('Payment', { invoiceId: invoice.id, methodId: cash, amount, seq: 1, kind: 'CASH', destination: 'CASH',
    paidAt: Date.now(), paidAtJalali: day, createdByUserId: userId, createdShiftId: shiftId })
  return invoice.id
}
let checks = 0
function eq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
async function reject(label, code, fn) {
  try { await fn() } catch (error) { eq(label, error?.code, code); return }
  throw new Error(`${label}: unexpectedly accepted`)
}
const opened = await custodyService.open({ userId: giver, password: 'Giver4084!', operationalTotal: 1000 })
sale(408001, 1000, opened.shiftId, giver)
const self = await custodyService.handoverStart({ password: 'Giver4084!', operationalTotal: 1000,
  toUserId: giver, idempotencyKey: 's408:self:out', blueReference: true })
await reject('old one-step accept cannot bypass the blue second count', 'BLUE_HANDOVER_REQUIRED',
  () => custodyService.handoverAccept({ handoverId: self.id, password: 'Giver4084!', operationalTotal: 1000 }))
await reject('receiver cannot attest with empty PIN', 'PIN_WRONG',
  () => custodyService.handoverCountBlue({ handoverId: self.id, password: '', operationalTotal: 1000 }))
const ownCount = await custodyService.handoverCountBlue({ handoverId: self.id, password: 'Giver4084!', operationalTotal: 1000 })
eq('second count requires its own PIN and records separately', ownCount.state, 'RECEIVER_COUNTED')
await reject('confirmation requires PIN again', 'PIN_WRONG',
  () => custodyService.handoverConfirmBlue({ handoverId: self.id, password: '' }))
const ownFinish = await custodyService.handoverConfirmBlue({ handoverId: self.id, password: 'Giver4084!' })
eq('self boundary keeps the original Shift', ownFinish.shiftId, opened.shiftId)
eq('self boundary retains same responsible person', (await custodyService.status()).custodian?.id, giver)
eq('self boundary does not close original Shift', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId).closedAt, null)
eq('self boundary documents TWO count snapshots', seed.count('CustodyBlueSnapshot', 'handoverId=?', self.id), 2)
eq('self boundary does not create fake Shift', seed.count('Shift'), 1)
eq('self boundary has explicit kind', seed.one('SELECT resolutionKind FROM "CustodyHandover" WHERE id=?', self.id).resolutionKind, 'BLUE_SELF_COUNT_BOUNDARY')

const late = await custodyService.handoverStart({ password: 'Giver4084!', operationalTotal: 1000,
  toUserId: receiver, idempotencyKey: 's408:late:out', blueReference: true })
await custodyService.handoverCountBlue({ handoverId: late.id, password: 'Receiver4084!', operationalTotal: 1000 })
const lateInvoice = sale(408002, 100, opened.shiftId, giver)
eq('sale between IN count and confirmation belongs to old Shift', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', lateInvoice).shiftId, opened.shiftId)
eq('sale between IN count and confirmation advances revision', seed.one('SELECT financialRevision FROM "CustodyState" WHERE key=?', 'MAIN').financialRevision > seed.one('SELECT financialRevision FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', late.id, 'IN').financialRevision, true)
await reject('late sale forces both persons to count afresh', 'BLUE_RECOUNT_REQUIRED',
  () => custodyService.handoverConfirmBlue({ handoverId: late.id, password: 'Receiver4084!' }))
eq('late attempt evidence survives', seed.count('CustodyBlueSnapshot', 'handoverId=?', late.id), 2)
eq('late attempt marked stale not deleted', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', late.id).status, 'STALE')
eq('late sale does not transfer ownership', (await custodyService.status()).custodian?.id, giver)
const next = await custodyService.handoverStart({ password: 'Giver4084!', operationalTotal: 1100,
  toUserId: receiver, idempotencyKey: 's408:next:out', blueReference: true })
await custodyService.handoverCountBlue({ handoverId: next.id, password: 'Receiver4084!', operationalTotal: 1100 })
const accepted = await custodyService.handoverConfirmBlue({ handoverId: next.id, password: 'Receiver4084!' })
eq('fresh counts transfer to receiver', (await custodyService.status()).custodian?.id, receiver)
eq('new Shift created only upon completed change of custodian', accepted.shiftId !== opened.shiftId, true)

const old = await custodyService.handoverStart({ password: 'Receiver4084!', operationalTotal: 1100,
  toUserId: giver, idempotencyKey: 's408:existing:handover' })
eq('pre-existing handover has no blue snapshot', seed.count('CustodyBlueSnapshot', 'handoverId=?', old.id), 0)
const oldAccepted = await custodyService.handoverAccept({ handoverId: old.id, password: 'Giver4084!', operationalTotal: 1100 })
eq('pre-existing attempt can still complete', (await custodyService.status()).custodian?.id, giver)
eq('old handover does not silently create blue evidence', seed.count('CustodyBlueSnapshot', 'handoverId=?', old.id), 0)
eq('old handover uses the old aggregate route', oldAccepted.shiftId !== accepted.shiftId, true)
console.log(`\n✓ ${checks} checks passed`)
