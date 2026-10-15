/**
 * Blue handover continuity contract:
 * - pending handover keeps the outgoing authenticated custodian as the writer;
 * - a cash movement is kept on the outgoing Shift; it does not change the blue sales reference;
 * - both persons count under their own PINs; a physical difference does not accuse anyone.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s363-pending-handover-recount.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-handover-recount-s363-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { cashMovementService } = await import('../../src/main/services/CashMovementService.ts')
const { CashMovementType } = await import('@shared/enums')

const db = harnessClient()
const seed = makeSeeder(db)
let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) }
}
const rejects = async (label, code, work) => {
  try { await work(); eq(label, true, false) }
  catch (error) { eq(label, error?.code, code) }
}

const manager = seed.user('مدیر S363')
const giver = seed.user('تحویل‌دهنده S363')
const receiver = seed.user('تحویل‌گیرنده S363')
await custodyService.setPin({ userId: manager, newPassword: 'مدیر123!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'مدیر123!' })
for (const [id, temporary, permanent] of [[giver, 'Giver363!', 'Giver3634!'], [receiver, 'Recv363!', 'Recv3634!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'مدیر123!', reason: 'راه‌اندازی آزمون شمارش' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
const opened = await custodyService.open({ userId: giver, password: 'Giver3634!', operationalTotal: 0 })
const handover = await custodyService.handoverStart({ password: 'Giver3634!', operationalTotal: 0, blueReference: true, toUserId: receiver, idempotencyKey: 's363-handover' })
eq('تحویل وارد وضعیت pending شد', handover.state, 'HANDOVER_PENDING')

const fence = await custodyService.actorForFinancialOperation()
eq('pending همچنان fence مسئول قبلی را می‌دهد', fence?.expectedActorUserId, giver)
eq('pending همان نشست خروجی را نگه می‌دارد', fence?.expectedShiftId, opened.shiftId)
await cashMovementService.add({ type: CashMovementType.DEPOSIT, amount: 100, description: 'فروش/گردش هنگام انتظار تحویل', userId: giver, custodyFence: fence })
eq('گردش مالی در انتظار تحویل روی نشست خروجی ثبت شد', seed.one('SELECT shiftId FROM "CashMovement" ORDER BY id DESC LIMIT 1')?.shiftId, opened.shiftId)

const incoming = await custodyService.handoverCountBlue({ handoverId: handover.id, password: 'Recv3634!', operationalTotal: 100 })
eq('گیرنده پس از گردش نقدی شمارش مستقل خود را ثبت می‌کند', incoming.state, 'RECEIVER_COUNTED')
eq('تفاوت دو شمارش بدون حدس دربارهٔ تقصیر ثبت می‌شود', incoming.freshDifference, 100)
eq('شمارش گیرنده فروشِ مسئول قبلی را قفل نمی‌کند', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
eq('دو شاهد فیزیکی مستقل و append-only هستند', seed.count('CustodyBlueSnapshot', 'handoverId=?', handover.id), 2)
await rejects('تأیید نهایی PIN مستقل گیرنده را لازم دارد', 'PIN_WRONG',
  () => custodyService.handoverConfirmBlue({ handoverId: handover.id, password: '' }))
const accepted = await custodyService.handoverConfirmBlue({ handoverId: handover.id, password: 'Recv3634!' })
eq('پس از PIN و تأیید، گیرنده صاحب نشست مستقل است', (await custodyService.status()).custodian?.id, receiver)
eq('گردش قبلی به گیرنده بازنویسی نمی‌شود', seed.one('SELECT shiftId FROM "CashMovement" ORDER BY id DESC LIMIT 1')?.shiftId, opened.shiftId)
eq('شمارش گیرنده در سابقه محفوظ است', seed.one('SELECT kind FROM "CustodyCount" WHERE handoverId=? ORDER BY id DESC LIMIT 1', handover.id)?.kind, 'BLUE_HANDOVER_IN')
eq('نشست گیرنده تازه است', accepted.shiftId !== opened.shiftId, true)
eq('اختلاف به خودی خود پروندهٔ تقصیر نمی‌سازد', seed.count('CustodyDiscrepancyCase'), 0)

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
