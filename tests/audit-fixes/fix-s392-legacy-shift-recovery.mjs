/**
 * P0 characterization for legacy-open Shift recovery.
 *
 * P1 prevents an orphan legacy Shift from being hidden by disabling custody
 * or from reaching the old close path. It also proves the financial meaning of
 * a normal custody opening: exactly one OPENING_FLOAT is recorded on the new
 * Shift and is the base of that Shift's expected cash.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s392-legacy-shift-recovery.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const DIR = mkdtempSync(join(tmpdir(), 'mahak-legacy-recovery-s392-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { shiftService } = await import('../../src/main/services/ShiftService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')

const db = harnessClient()
const seed = makeSeeder(db)
let ok = 0; let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) }
}
const rejects = async (label, code, work) => {
  try { await work(); eq(label, 'NO_ERROR', code) }
  catch (error) { eq(label, error?.code, code) }
}

const manager = seed.user('مدیر بازیابی S392')
const cashier = seed.user('کارمند صبح S392')
db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', cashier)

await custodyService.setPin({ userId: manager, newPassword: 'Manager392!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager392!' })
await custodyService.setPin({ userId: cashier, newPassword: 'Temporary392!', managerUserId: manager, managerPassword: 'Manager392!', reason: 'راه‌اندازی آزمون recovery' })
await custodyService.setPin({ userId: cashier, currentPassword: 'Temporary392!', newPassword: 'Cashier392!' })

const legacyShift = seed.insert('Shift', {
  name: 'شیفت قدیمی رهاشده', number: 1, dayJalali: '1405/07/20', sessionSeq: 1,
  userId: cashier, staffConfirmed: true, openedVia: 'MANUAL', openedAt: new Date(Date.now() - 86_400_000)
})
eq('Shift قدیمی عمداً CustodyShiftMeta ندارد', seed.count('CustodyShiftMeta', 'shiftId=?', legacyShift), 0)
eq('حضانت فعال است و Shift قدیمی مسیر عادی را governed می‌کند', await custodyService.isGoverned(), true)
await rejects('افتتاح عادی کنار Shift قدیمی با کد recovery مشخص fail-closed است', 'CUSTODY_LEGACY_OPEN_SHIFT', () => custodyService.open({ userId: cashier, password: 'Cashier392!', countedCash: 0 }))

/** P1: a legacy block remains governed even if a caller tries the old Settings
 * escape hatch, and every legacy writer surface remains closed. */
await rejects('خاموش‌کردن حضانت، Shift legacy را پنهان نمی‌کند', 'CUSTODY_LEGACY_RECOVERY_REQUIRED', () => custodyService.setConfig({ config: { enabled: false }, managerUserId: manager, managerPassword: 'Manager392!' }))
eq('پس از رد تنظیمات، حضانت همچنان فعال است', (await custodyService.config()).enabled, true)
eq('Shift legacy پس از تلاش برای خاموش‌سازی همچنان governed است', await custodyService.isGoverned(), true)
await rejects('مسیر قدیمی بستن Shift در Legacy block بسته است', 'CUSTODY_LEGACY_PATH', () => shiftService.close({ shiftId: legacyShift, userId: cashier, note: 'نباید ثبت شود' }))
await rejects('Master Override نیز Legacy block را bypass نمی‌کند', 'CUSTODY_LEGACY_OPEN_SHIFT', () => custodyService.masterOverride({ managerUserId: manager, managerPassword: 'Manager392!', operationalTotal: 0, reason: 'نباید برای نشست قدیمی از مسیر استثنایی استفاده شود.' }))
const legacyStatus = await custodyService.status()
eq('status صریحاً وجود Legacy block را اعلام می‌کند', legacyStatus.legacyBlock?.count, 1)

const recoveryInput = {
  userId: cashier,
  password: 'Cashier392!',
  countedCash: 700,
  note: 'تحویل عادی سیستم قدیم انجام نشده و مبلغ واقعی کشو شمارش شد.',
  ackTextVersion: 'LEGACY_RECOVERY_V1',
  idempotencyKey: 'legacy-recovery-s392-0001',
  seenEpoch: legacyStatus.epoch,
  seenShiftIds: legacyStatus.legacyBlock.shiftIds
}
const recovery = await custodyService.recoverLegacyOpenShifts(recoveryInput)
eq('recovery برای Shift legacy ثبت می‌شود', recovery.replayed, false)
eq('recovery تک‌Shift اختلاف را فقط به‌صورت evidence نگه می‌دارد', recovery.differenceScope, 'SINGLE_SHIFT')
eq('recovery تنها mutation روی Shift قدیمی closedAt است', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', legacyShift)?.closedAt != null, true)
eq('برای Shift قدیمی CashMovement تازه ساخته نمی‌شود', seed.count('CashMovement', 'shiftId=?', legacyShift), 0)
eq('bundle بازیابی یک‌بار ثبت شده است', seed.count('LegacyShiftRecovery'), 1)
eq('برای Shift قدیمی یک item مستقل ثبت شده است', seed.count('LegacyShiftRecoveryItem', 'shiftId=?', legacyShift), 1)
const replay = await custodyService.recoverLegacyOpenShifts(recoveryInput)
eq('replay همان کلید همان recovery را برمی‌گرداند', replay.recoveryId, recovery.recoveryId)
eq('replay هیچ bundle دیگری نمی‌سازد', seed.count('LegacyShiftRecovery'), 1)
const afterRecovery = await custodyService.status()
eq('پس از recovery، legacy block پاک می‌شود', afterRecovery.legacyBlock, null)
eq('پس از recovery، فروش هنوز تا افتتاح جدید قفل می‌ماند', afterRecovery.state, 'NO_SESSION')
eq('status فقط وجود مرز افتتاح را نشان می‌دهد، نه مبلغ بازیابی را', afterRecovery.legacyOpeningRequired, true)

/** Recovery itself adds no movement. A separately authenticated new opening
 * is the only financial OPENING_FLOAT. Its count is deliberately different in
 * this characterization, so Main must collect an immutable short reason but
 * must never demand manager approval or keep the drawer blocked afterwards. */
await rejects('افتتاح با شمارش متفاوت بدون دلیل مرزی پذیرفته نمی‌شود', 'BOUNDARY_REASON_REQUIRED', () => custodyService.open({ userId: cashier, password: 'Cashier392!', countedCash: 750 }))
eq('رد دلیل مرزی Shift یا CashMovement تازه نمی‌سازد', seed.count('CashMovement'), 0)
const opened = await custodyService.open({ userId: cashier, password: 'Cashier392!', countedCash: 750, boundaryReason: 'شمارش افتتاح صبح پس از جابه‌جایی صندوق دوباره انجام شد.' })
eq('افتتاح پس از دلیل مرزی، فروش را بدون تأیید مدیر باز می‌کند', (await custodyService.status()).state, 'ACTIVE')
const boundary = seed.one('SELECT recoveryId, openingShiftId, openingCountId, recoveryCountedCash, openingCountedCash, gapCash, reason FROM "LegacyRecoveryOpeningLink"')
eq('پیوند recovery به افتتاح مستقل یک‌بار ثبت می‌شود', Number(boundary?.recoveryId), recovery.recoveryId)
eq('پیوند immutable به Shift تازه اشاره می‌کند', Number(boundary?.openingShiftId), opened.shiftId)
eq('پیوند هر دو شمارش را نگه می‌دارد', `${Number(boundary?.recoveryCountedCash)}:${Number(boundary?.openingCountedCash)}`, '700:750')
eq('اختلاف مرز مستقل ثبت می‌شود', Number(boundary?.gapCash), 50)
eq('دلیل کوتاه اختلاف مرز ثبت می‌شود', String(boundary?.reason).length >= 10, true)
eq('پس از لینک، مرز افتتاح معوق از status ناپدید می‌شود', (await custodyService.status()).legacyOpeningRequired, false)
const floats = seed.rows('SELECT amount, type, shiftId FROM "CashMovement" WHERE shiftId=? ORDER BY id', opened.shiftId)
eq('افتتاح معتبر دقیقاً یک OPENING_FLOAT می‌سازد', floats.length, 1)
eq('نوع اثر مالی افتتاح معتبر OPENING_FLOAT است', floats[0]?.type, 'OPENING_FLOAT')
eq('مبلغ OPENING_FLOAT دقیقاً شمارش افتتاح است', Number(floats[0]?.amount), 750)
const expected = await cashboxService.expected({ shiftId: opened.shiftId })
eq('expected صندوق جدید با OPENING_FLOAT شروع می‌شود', Number(expected.expectedCash), 750)

/** P7: manager report/review paths expose recovery evidence without turning the
 * witness into a historical owner or changing any legacy money record. */
let report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager392!' })
const reportedRecovery = report.legacyRecoveries.find((row) => row.id === recovery.recoveryId)
eq('گزارش مدیر recovery را به‌عنوان سند مستقل نشان می‌دهد', reportedRecovery?.itemCount, 1)
eq('گزارش مدیر پیوند افتتاح و دلیل اختلاف را نشان می‌دهد', reportedRecovery?.opening?.reason?.length >= 10, true)
eq('گزارش مدیر شاهد را مسئول فروش‌های قدیمی معرفی نمی‌کند', reportedRecovery?.items?.[0]?.legacyUserName, 'کارمند صبح S392')
const reviewInput = { recoveryId: recovery.recoveryId, reason: 'مدیر شواهد بازیابی و مرز افتتاح مستقل را بازبینی کرد.', idempotencyKey: 'legacy-review-s392-0001', managerUserId: manager, managerPassword: 'Manager392!' }
const review = await custodyService.reviewLegacyRecovery(reviewInput)
eq('بازبینی مدیر فقط یک یادداشت افزایشی ایجاد می‌کند', review.replayed, false)
const reviewReplay = await custodyService.reviewLegacyRecovery(reviewInput)
eq('بازبینی با همان کلید replay امن دارد', reviewReplay.reviewId, review.reviewId)
eq('بازبینی هیچ CashMovement دیگری نمی‌سازد', seed.count('CashMovement'), 1)
report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager392!' })
eq('گزارش، یادداشت بازبینی append-only را نشان می‌دهد', report.legacyRecoveryReviews.some((row) => row.id === review.reviewId && row.recoveryId === recovery.recoveryId), true)
eq('رویداد ممیزی بازیابی به همان bundle وصل است', report.events.some((row) => row.type === 'LEGACY_RECOVERY_REVIEWED' && row.legacyRecoveryId === recovery.recoveryId), true)

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
