/**
 * End-to-end custody aggregate handover contract.
 *
 * The employee submits one blind total (drawer + POS).  Main stores the
 * aggregate boundary/case, never writes that total into a cash opening float,
 * and must not re-report a known difference at the next clean handover.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s394-custody-aggregate-normal-handover.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-custody-aggregate-s394-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')

const db = harnessClient()
const seed = makeSeeder(db)
let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) }
}
const absent = (label, obj, key) => eq(label, Object.prototype.hasOwnProperty.call(obj, key), false)

const manager = seed.user('مدیر S394')
const giver = seed.user('مسئول نخست S394')
const receiver = seed.user('مسئول دوم S394')
await custodyService.setPin({ userId: manager, newPassword: 'Manager394!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager394!' })
for (const [id, temporary, permanent] of [[giver, 'Giver394!', 'Giver3944!'], [receiver, 'Receiver394!', 'Receiver3944!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager394!', reason: 'راه‌اندازی آزمون حضانت تجمیعی' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}

const opened = await custodyService.open({ userId: giver, password: 'Giver3944!', operationalTotal: 20_000_000 })
eq('افتتاح تجمیعی مسئولیت را باز می‌کند', opened.countStatus, 'COUNTED')
eq('افتتاح تجمیعی به OPENING_FLOAT نقدی تبدیل نمی‌شود', Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE shiftId=? AND type=?', opened.shiftId, 'OPENING_FLOAT')?.n ?? 0), 0)
eq('افتتاح آبی baseline قدیمی aggregate را جعل نمی‌کند؛ پذیرش legacy بعدی آن را می‌سازد', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyAggregateBoundary" WHERE boundaryKind=?', 'OPENING')?.n ?? 0), 0)
eq('افتتاح آبی snapshot مستقل شمارش واقعی دارد', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'OPENING', opened.shiftId)?.n ?? 0), 1)

const started = await custodyService.handoverStart({ password: 'Giver3944!', operationalTotal: 20_000_000, toUserId: receiver, idempotencyKey: 's394-first' })
absent('شروع تحویل مبلغ انتظار را برنمی‌گرداند', started, 'expectedCash')
absent('شروع تحویل اختلاف را برنمی‌گرداند', started, 'differenceCash')
const first = await custodyService.handoverAccept({ handoverId: started.id, password: 'Receiver3944!', operationalTotal: 18_000_000 })
absent('پذیرش تحویل مبلغ انتظار را برنمی‌گرداند', first, 'expectedCash')
absent('پذیرش تحویل اختلاف را برنمی‌گرداند', first, 'differenceCash')

const firstBoundary = seed.one('SELECT operationalExpectedTotal, theoreticalExpectedTotal, observedOperationalTotal, newDifference, totalTheoreticalDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1', 'HANDOVER')
eq('انتظار عملیاتی تحویل اول ۲۰ میلیون است', Number(firstBoundary?.operationalExpectedTotal), 20_000_000)
eq('شمارش کور تحویل‌گیرنده عیناً نگهداری می‌شود', Number(firstBoundary?.observedOperationalTotal), 18_000_000)
eq('کسری تازهٔ مرز اول ۲ میلیون است', Number(firstBoundary?.newDifference), -2_000_000)
eq('اختلاف نظری مدیر در مرز اول ۲ میلیون است', Number(firstBoundary?.totalTheoreticalDifference), -2_000_000)
eq('برای کسری اول دقیقاً یک پرونده ایجاد می‌شود', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"')?.n ?? 0), 1)
eq('تحویل aggregate، مبلغ POS را OPENING_FLOAT نقدی نمی‌کند', Number(seed.one('SELECT COUNT(*) AS n FROM "CashMovement" WHERE shiftId=? AND type=?', first.shiftId, 'OPENING_FLOAT')?.n ?? 0), 0)

const secondStart = await custodyService.handoverStart({ password: 'Receiver3944!', operationalTotal: 18_000_000, toUserId: giver, idempotencyKey: 's394-second' })
const second = await custodyService.handoverAccept({ handoverId: secondStart.id, password: 'Giver3944!', operationalTotal: 18_000_000 })
const secondBoundary = seed.one('SELECT operationalExpectedTotal, observedOperationalTotal, newDifference, totalTheoreticalDifference FROM "CustodyAggregateBoundary" WHERE boundaryKind=? ORDER BY id DESC LIMIT 1', 'HANDOVER')
eq('baseline واقعی پذیرفته‌شده، کسری قدیمی را در انتظار عملیاتی نگه نمی‌دارد', Number(secondBoundary?.operationalExpectedTotal), 18_000_000)
eq('شمارش ۱۸ میلیونی دوباره همان کسری را ثبت نمی‌کند', Number(secondBoundary?.newDifference), 0)
eq('عدد نظری مدیر همچنان کسری تاریخی را نگه می‌دارد', Number(secondBoundary?.totalTheoreticalDifference), -2_000_000)
eq('پروندهٔ قدیمی در تحویل تمیز بعدی تکرار نمی‌شود', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyDiscrepancyCase"')?.n ?? 0), 1)
eq('تحویل دوم مسئولیت را منتقل می‌کند', (await custodyService.status()).custodian?.id, giver)

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
