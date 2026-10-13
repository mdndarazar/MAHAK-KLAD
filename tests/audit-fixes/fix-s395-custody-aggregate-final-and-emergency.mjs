/**
 * Aggregate custody at exceptional and overnight boundaries.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s395-custody-aggregate-final-and-emergency.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-custody-aggregate-s395-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')

const db = harnessClient()
const seed = makeSeeder(db)
let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) }
}
const absent = (label, obj, key) => eq(label, Object.prototype.hasOwnProperty.call(obj, key), false)

const manager = seed.user('مدیر S395')
const night = seed.user('مسئول شب S395')
const morning = seed.user('مسئول صبح S395')
const cover = seed.user('پوشش اضطراری S395')
await custodyService.setPin({ userId: manager, newPassword: 'Manager395!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager395!' })
for (const [id, temporary, permanent] of [[night, 'Night395!', 'Night3954!'], [morning, 'Morning395!', 'Morning3954!'], [cover, 'Cover395!', 'Cover3954!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager395!', reason: 'راه‌اندازی آزمون مرز تجمیعی' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}

const opened = await custodyService.open({ userId: night, password: 'Night3954!', operationalTotal: 20_000_000 })
const closed = await custodyService.finalClose({ password: 'Night3954!', operationalTotal: 18_000_000 })
eq('بستن نهایی تجمیعی نشست فعال را می‌بندد', closed.state, 'NO_SESSION')
eq('بستن نهایی aggregate، OPENING_FLOAT نقدی نمی‌سازد', Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE shiftId=?', opened.shiftId)?.n ?? 0), 0)
const finalBoundary = seed.one('SELECT boundaryKind, newDifference, totalTheoreticalDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1', 'FINAL_CLOSE')
eq('مرز نهایی شب ثبت می‌شود', finalBoundary?.boundaryKind, 'FINAL_CLOSE')
eq('کسری شب در مرز نهایی ثبت می‌شود', Number(finalBoundary?.newDifference), -2_000_000)
eq('یک پرونده برای کسری شب ایجاد می‌شود', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"')?.n ?? 0), 1)

const openedMorning = await custodyService.open({ userId: morning, password: 'Morning3954!', operationalTotal: 18_000_000 })
eq('افتتاح صبح با همان مبلغ واقعی انجام می‌شود', openedMorning.countStatus, 'COUNTED')
const morningBoundary = seed.one('SELECT boundaryKind, newDifference, totalTheoreticalDifference FROM "CustodyAggregateBoundary" ORDER BY id DESC LIMIT 1')
eq('افتتاح صبح همان کسری شب را دوباره پرونده نمی‌کند', Number(morningBoundary?.newDifference), 0)
eq('افتتاح صبح اختلاف نظری تاریخی را برای مدیر نگه می‌دارد', Number(morningBoundary?.totalTheoreticalDifference), -2_000_000)
eq('پس از افتتاح صبح هنوز فقط یک پرونده وجود دارد', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"')?.n ?? 0), 1)

const emergency = await custodyService.emergencyCover({ userId: cover, password: 'Cover3954!', operationalTotal: 16_000_000, reason: 'مسئول صبح ناگهان محل کار را ترک کرده و پوشش فوری لازم است.' })
absent('پوشش اضطراری مبلغ انتظار را به کارمند برنمی‌گرداند', emergency, 'expectedCash')
absent('پوشش اضطراری اختلاف را به کارمند برنمی‌گرداند', emergency, 'differenceCash')
const emergencyBoundary = seed.one('SELECT boundaryKind, newDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1', 'EMERGENCY_COVER')
eq('مرز پوشش اضطراری aggregate ثبت می‌شود', emergencyBoundary?.boundaryKind, 'EMERGENCY_COVER')
eq('کسری تازه در پوشش اضطراری جدا ثبت می‌شود', Number(emergencyBoundary?.newDifference), -2_000_000)
eq('پوشش اضطراری aggregate هم به OPENING_FLOAT نقدی تبدیل نمی‌شود', Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE shiftId=?', emergency.shiftId)?.n ?? 0), 0)
eq('کسری تازهٔ اضطراری پروندهٔ دوم مستقل می‌سازد', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"')?.n ?? 0), 2)

notePanelUnlocked('test', 'MANAGER')
const today = toJalaliDate(new Date())
const report = await custodyService.discrepancyReport({ managerSession: true, from: today, to: today, status: 'OPEN', take: 50 })
eq('گزارش مدیر با بازهٔ جلالی، دو پروندهٔ باز را برمی‌گرداند', report.summary.openCases, 2)
eq('گزارش مدیر کسری‌های بازه را جمع می‌زند', report.summary.shortages, -4_000_000)
eq('گزارش مدیر فقط پروندهٔ باز را با فیلتر OPEN برمی‌گرداند', report.cases.every((row) => row.status === 'OPEN'), true)
const reviewed = report.cases[0]
const close = await custodyService.reviewDiscrepancyCase({ managerSession: true, caseId: reviewed.id, action: 'CLOSE', result: 'شمارش و اسناد بررسی شد', note: 'اسناد فروش و شمارش فیزیکی این مرز توسط مدیر بررسی و نتیجه ثبت شد.', idempotencyKey: 's395-close-case' })
eq('مدیر می‌تواند پرونده را با یادداشت و نتیجه ببندد', close.status, 'CLOSED')
eq('بستن پرونده، مدرک اختلاف اولیه را تغییر نمی‌دهد', Number(seed.one('SELECT differenceAmount FROM "CustodyDiscrepancyCase" WHERE id=?', reviewed.id)?.differenceAmount), Number(reviewed.differenceAmount))
const reopen = await custodyService.reviewDiscrepancyCase({ managerSession: true, caseId: reviewed.id, action: 'REOPEN', note: 'برای بررسی سند تازه، پرونده باید دوباره باز شود و سابقهٔ قبلی محفوظ بماند.', idempotencyKey: 's395-reopen-case' })
eq('مدیر می‌تواند پرونده بسته را با دلیل بازگشایی کند', reopen.status, 'OPEN')
eq('بستن و بازگشایی دو رویداد بازبینی افزایشی می‌سازند', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyReview" WHERE caseId=?', reviewed.id)?.n ?? 0), 2)

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
