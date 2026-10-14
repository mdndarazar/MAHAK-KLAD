/**
 * New blue custody exceptional/overnight boundaries must not fabricate old
 * aggregate-v2 cases or move a prior difference onto the morning worker.
 * Keep the old ledger intact: all NEW evidence is blue and append-only.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s395-custody-aggregate-final-and-emergency.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-exceptional-s395-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const { toJalaliDate } = await import('../../src/shared/jalali.ts')
const seed = makeSeeder(harnessClient())
let checks = 0
const eq = (label, got, expected) => {
  if (got !== expected) throw new Error(`${label}: expected ${expected}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
const absent = (label, obj, key) => eq(label, Object.hasOwn(obj, key), false)
const manager = seed.user('مدیر S395')
const night = seed.user('مسئول شب S395')
const morning = seed.user('مسئول صبح S395')
const cover = seed.user('پوشش اضطراری S395')
await custodyService.setPin({ userId: manager, newPassword: 'Manager395!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager395!' })
for (const [id, temp, personal] of [[night, 'Night395!', 'Night3954!'], [morning, 'Morning395!', 'Morning3954!'], [cover, 'Cover395!', 'Cover3954!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager395!', reason: 'آزمون مرزهای مستقل حضانت' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: personal })
}
const opened = await custodyService.open({ userId: night, password: 'Night3954!', operationalTotal: 20_000_000 })
const closed = await custodyService.finalClose({ password: 'Night3954!', operationalTotal: 18_000_000 })
eq('بستن نهایی به نشست قدیمیِ واقعی پایان می‌دهد', closed.state, 'NO_SESSION')
const final = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'FINAL_CLOSE', opened.shiftId)
eq('بستن نهایی با شمارش مستقل ثابت مانده است', Number(final?.humanAmount), 18_000_000)
eq('اختلاف تازهٔ بستن فقط تغییر نسبت به نخستین شمارش واقعی همان شیفت است', Number(final?.freshDifference), -2_000_000)
eq('اختلاف خامِ بستن فقط از مرجع روزانه می‌آید', Number(final?.rawDifference), 18_000_000)
eq('سند بستن نهایی به اولین شاهد انسانی وصل می‌شود', seed.one('SELECT role FROM "CustodyBlueSnapshot" WHERE id=?', final?.priorSnapshotId)?.role, 'OPENING')
eq('شمارش کارت‌خوان به پول نقدِ ساختگی تبدیل نمی‌شود', seed.count('CashMovement', 'shiftId=?', opened.shiftId), 0)
eq('نه بستن و نه افتتاح جدید، مرز aggregate-v2 قدیمی اضافه نمی‌کند', seed.count('CustodyAggregateBoundary'), 0)
eq('اختلاف شمارش به‌تنهایی اتهام یا کیس خودکار نمی‌سازد', seed.count('CustodyDiscrepancyCase'), 0)

const openedMorning = await custodyService.open({ userId: morning, password: 'Morning3954!', operationalTotal: 18_000_000 })
const independent = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'OPENING', openedMorning.shiftId)
eq('شمارش افتتاح صبح متعلق به مسئول واقعی جدید است', independent?.actorUserId, morning)
eq('شمارش ۱۸ میلیون صبح سند تازه می‌ماند', Number(independent?.humanAmount), 18_000_000)
eq('مرجع امروز محاسبه می‌شود، نه تفاوت دو افتتاح', Number(independent?.referenceAmount), 0)
eq('اختلاف خام صبح قابل مشاهده است، نه حکم کسری', Number(independent?.rawDifference), 18_000_000)
eq('بدون مبنای هم‌دامنه، اختلاف تازه به نفر جدید منتسب نمی‌شود', independent?.freshDifference, null)
eq('افتتاح صبح کسری شب را دوباره پرونده نمی‌کند', seed.count('CustodyDiscrepancyCase'), 0)

const emergency = await custodyService.emergencyCover({ userId: cover, password: 'Cover3954!', operationalTotal: 16_000_000, reason: 'مسئول صبح ناگهان محل کار را ترک کرده و پوشش فوری لازم است.' })
absent('پوشش اضطراری مبلغ انتظار را به کارمند برنمی‌گرداند', emergency, 'expectedCash')
absent('پوشش اضطراری اختلاف را به کارمند برنمی‌گرداند', emergency, 'differenceCash')
eq('مسئولیت بی‌نیاز از انتظار مدیر به پوشش‌دهنده منتقل شد', (await custodyService.status()).custodian?.id, cover)
const outgoing = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', emergency.handoverId, 'OUT')
const incoming = seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', emergency.handoverId, 'IN')
eq('خروج غایب صفرِ سیستمی است، نه شاهد خودش', outgoing?.countOrigin, 'SYSTEM_ABSENCE_ZERO')
eq('خروج غایب شاهد انسانی جعلی ندارد', outgoing?.humanAmount, null)
eq('ورود پوشش‌دهنده شمارش انسانی دارد', Number(incoming?.humanAmount), 16_000_000)
eq('ورود به صفر سیستمی برای اختلاف تازهٔ انتساب‌پذیر تکیه نمی‌کند', incoming?.freshDifference, null)
eq('مرجع و اختلاف خام به مدیر قابل گزارش‌اند', Number(incoming?.rawDifference), 16_000_000)
eq('پوشش اضطراری Case خودکار یا مبلغ نقدیِ ساختگی نمی‌سازد', seed.count('CustodyDiscrepancyCase') + seed.count('CashMovement', 'shiftId=?', emergency.shiftId), 0)

notePanelUnlocked('test', 'MANAGER')
const today = toJalaliDate(new Date())
const cases = await custodyService.discrepancyReport({ managerSession: true, from: today, to: today, status: 'OPEN', take: 50 })
eq('پنل کیس قدیمی از شاهد آبی، اتهام تازه نمی‌سازد', cases.summary.openCases, 0)
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager395!' })
eq('گزارش مدیر بستن شب را جدا نشان می‌دهد', report.blueBoundaries.some((row) => row.snapshotId === final.id && row.role === 'FINAL_CLOSE'), true)
eq('گزارش مدیر شمارش افتتاح صبح را جدا نشان می‌دهد', report.blueBoundaries.some((row) => row.snapshotId === independent.id && row.role === 'OPENING'), true)
const transfer = report.handovers.find((row) => row.id === emergency.handoverId)
eq('گزارش مدیر خروج غایب و شمارش پوشش‌دهنده را با منشأ مستقل ثبت می‌کند', transfer?.blue?.outgoing?.id === outgoing.id && transfer?.blue?.outgoing?.countOrigin === 'SYSTEM_ABSENCE_ZERO' && transfer?.blue?.incoming?.id === incoming.id, true)
console.log(`\n✓ ${checks} checks passed`)
