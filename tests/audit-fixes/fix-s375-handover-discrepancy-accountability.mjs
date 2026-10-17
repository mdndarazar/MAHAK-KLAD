/**
 * Blue custody: an independently observed difference is evidence, not an
 * accusation or a reason to freeze sales. Two personal PINs/counts and final
 * confirmation must still be required. Cancellation keeps the attempt.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s375-handover-discrepancy-accountability.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-handover-difference-s375-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const db = harnessClient(); const seed = makeSeeder(db)
let ok = 0
const eq = (label, got, expected) => {
  if (got !== expected) throw new Error(`${label}: expected ${expected}, got ${got}`)
  ok++; console.log(`  ✓ ${label}`)
}
const rejects = async (label, code, action) => {
  try { await action(); throw new Error(`${label}: unexpectedly succeeded`) }
  catch (error) { eq(label, error?.code, code) }
}
const manager = seed.user('مدیر S375')
const giver = seed.user('مسئول پیشین S375')
const receiver = seed.user('تحویل‌گیرنده S375')
await custodyService.setPin({ userId: manager, newPassword: 'Manager375!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager375!' })
for (const [id, temporary, personal] of [[giver, 'Giver375!', 'Giver3754!'], [receiver, 'Receiver375!', 'Receiver3754!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager375!', reason: 'راه‌اندازی آزمون تحویل مستقل' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...await settingsService.shiftConfig(), custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: giver, singleShiftAllowMidDayHandover: true }, managerUserId: manager, managerPassword: 'Manager375!', reason: 'اجازهٔ تحویل برای آزمون پاسخگویی اختلاف' })
const opened = await custodyService.open({ userId: giver, password: 'Giver3754!', operationalTotal: 1000 })
const started = await custodyService.handoverStart({ password: 'Giver3754!', operationalTotal: 1000, blueReference: true, toUserId: receiver, idempotencyKey: 's375:new-two-count-handover' })
eq('تحویل در انتظار شمارش مستقل است، نه freeze', (await custodyService.status()).state, 'HANDOVER_PENDING')
eq('پیش از تأیید، فروش هنوز متعلق به مسئول قبلی است', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
const counted = await custodyService.handoverCountBlue({ handoverId: started.id, password: 'Receiver3754!', operationalTotal: 920 })
eq('شمارش دوم با اختلاف ثبت می‌شود، بدون درخواست دلیل', counted.state, 'RECEIVER_COUNTED')
eq('اختلاف تازهٔ همین دو شاهد مستقل -۸۰ است', counted.freshDifference, -80)
eq('فروش تا تأیید همچنان مجاز است', (await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId)
const out = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'OUT')
const incoming = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', started.id, 'IN')
eq('شاهد خروج بدون بازنویسی نگه داشته شده', Number(out?.humanAmount), 1000)
eq('شاهد ورود بدون بازنویسی نگه داشته شده', Number(incoming?.humanAmount), 920)
eq('هر دو یک مرجع مالی یکسان دارند', out?.sourceHash, incoming?.sourceHash)
eq('شمارش ورودی به شاهد خروج پیوند دارد', incoming?.priorSnapshotId, out?.id)
eq('actor شاهد ورودی شخص PINدار است', incoming?.actorUserId, receiver)
eq('احراز شخصیِ شاهد ورودی ثبت شده است', incoming?.authMethod, 'CUSTODY_PIN')
eq('expected مخفی به شمارش‌گیرنده منتقل نمی‌شود', seed.one('SELECT expectedCash FROM "CustodyCount" WHERE handoverId=? AND kind=?', started.id, 'BLUE_HANDOVER_IN')?.expectedCash, null)
await rejects('تأیید بدون PIN مستقلِ گیرنده رد می‌شود', 'PIN_WRONG', () => custodyService.handoverConfirmBlue({ handoverId: started.id, password: '' }))
const accepted = await custodyService.handoverConfirmBlue({ handoverId: started.id, password: 'Receiver3754!' })
eq('پس از تأیید، گیرنده مسئول واقعی است', (await custodyService.status()).custodian?.id, receiver)
eq('فروش پس از مرز به نشست گیرنده می‌رود', (await custodyService.actorForFinancialOperation()).expectedShiftId, accepted.shiftId)
eq('اختلاف خودکار حکم تقصیر نمی‌سازد', seed.count('CustodyDiscrepancyCase'), 0)
eq('مرجع آبی به کیس aggregate-v2 قدیمی تبدیل نمی‌شود', seed.count('CustodyAggregateBoundary'), 0)
eq('پول کارت‌خوان OPENING_FLOAT نقدی نمی‌شود', seed.count('CashMovement', 'shiftId=? AND type=?', accepted.shiftId, 'OPENING_FLOAT'), 0)
eq('سند تحویل همراه با اختلاف قابل پیگیری است', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', started.id)?.status, 'COMPLETED')
eq('نشست قدیمی بدون انتساب تخلف بسته شد', seed.one('SELECT endKind FROM "CustodyShiftMeta" WHERE shiftId=?', opened.shiftId)?.endKind, 'BLUE_HANDOVER')

const next = await custodyService.handoverStart({ password: 'Receiver3754!', operationalTotal: 920, blueReference: true, toUserId: giver, idempotencyKey: 's375:cancel-second-count' })
await custodyService.handoverCountBlue({ handoverId: next.id, password: 'Giver3754!', operationalTotal: 850 })
eq('اختلاف دوم هم فروش را قفل نمی‌کند', (await custodyService.actorForFinancialOperation()).expectedShiftId, accepted.shiftId)
await custodyService.handoverCancel({ handoverId: next.id, password: 'Receiver3754!' })
eq('لغو، مسئول پیشین را بدون بازاستفاده از شمارش دوم نگه می‌دارد', (await custodyService.status()).custodian?.id, receiver)
eq('دو شاهد تلاش لغوشده همچنان موجودند', seed.count('CustodyBlueSnapshot', 'handoverId=?', next.id), 2)
eq('تلاش لغو، تحویل تکمیل‌شده به شخص تازه نیست', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', next.id)?.status, 'CANCELED')
const ui = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
eq('رابط کاربر شمارش گیرنده و تأیید او را جدا درخواست می‌کند', ui.includes('CH.custodyHandoverCountBlue') && ui.includes('CH.custodyHandoverConfirmBlue'), true)
console.log(`\n✓ ${ok} checks passed`)
