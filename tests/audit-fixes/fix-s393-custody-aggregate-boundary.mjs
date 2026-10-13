/**
 * Aggregate custody arithmetic: employees count one blind total (drawer + POS),
 * while managers retain the theoretical blue-reference total.  This test is
 * intentionally Prisma-free so the money contract is locked before it is
 * attached to custody persistence and IPC.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s393-custody-aggregate-boundary.mjs
 */
import {
  custodyPhysicalMovement,
  reconcileCustodyBoundary
} from '../../src/shared/custodyReconciliation.ts'

let ok = 0
let bad = 0
const eq = (label, got, want) => {
  if (got === want) { ok++; console.log(`  ✓ ${label}`) }
  else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) }
}
const rejects = (label, work) => {
  try { work(); eq(label, true, false) }
  catch { eq(label, true, true) }
}

const net = custodyPhysicalMovement({
  cashReceived: 12_000_000,
  posReceived: 8_000_000,
  cashRefunded: 2_000_000,
  posRefunded: 1_000_000
})
eq('فقط دریافت/بازپرداخت واقعی نقد و پوز، گردش فیزیکی را می‌سازند', net, 17_000_000)

const first = reconcileCustodyBoundary({
  priorAcceptedObservedTotal: 20_000_000,
  priorTheoreticalTotal: 20_000_000,
  movement: { cashReceived: 0, posReceived: 0, cashRefunded: 0, posRefunded: 0 },
  observedTotal: 18_000_000
})
eq('مرز اول انتظار عملیاتی را از baseline پذیرفته‌شده می‌گیرد', first.operationalExpectedTotal, 20_000_000)
eq('مرز اول کسری تازه را ثبت می‌کند', first.newDifference, -2_000_000)
eq('مدیر همان کسری را برابر عدد نظری کل می‌بیند', first.totalTheoreticalDifference, -2_000_000)

const secondNoDuplicate = reconcileCustodyBoundary({
  priorAcceptedObservedTotal: 18_000_000,
  priorTheoreticalTotal: 20_000_000,
  movement: { cashReceived: 6_000_000, posReceived: 4_000_000 },
  observedTotal: 28_000_000
})
eq('پس از کسری قبلی، انتظار عملیاتی شب ۱۸ + ۱۰ است', secondNoDuplicate.operationalExpectedTotal, 28_000_000)
eq('عدد نظری مدیر همچنان ۲۰ + ۱۰ است', secondNoDuplicate.theoreticalExpectedTotal, 30_000_000)
eq('شمارش ۲۸ میلیونی پروندهٔ تکراری برای کسری قدیمی نمی‌سازد', secondNoDuplicate.newDifference, 0)
eq('عدد مرجع نظری مدیر همچنان کسری تاریخی ۲ میلیونی را نشان می‌دهد', secondNoDuplicate.totalTheoreticalDifference, -2_000_000)

const secondNewDifference = reconcileCustodyBoundary({
  priorAcceptedObservedTotal: 18_000_000,
  priorTheoreticalTotal: 20_000_000,
  movement: { cashReceived: 6_000_000, posReceived: 4_000_000 },
  observedTotal: 26_000_000
})
eq('شمارش ۲۶ میلیونی در مرز دوم یک کسری تازهٔ ۲ میلیونی است', secondNewDifference.newDifference, -2_000_000)
eq('مدیر مجموع نظری دو کسری را ۴ میلیون می‌بیند', secondNewDifference.totalTheoreticalDifference, -4_000_000)

const creditOnly = custodyPhysicalMovement({ cashReceived: 0, posReceived: 0, cashRefunded: 0, posRefunded: 0 })
eq('صدور یا مصرف اعتبار فروشگاهی بدون بخش نقد/پوز، حرکت فیزیکی نمی‌سازد', creditOnly, 0)
const mixedCreditSale = custodyPhysicalMovement({ cashReceived: 3_000_000, posReceived: 0 })
eq('فروش ترکیبیِ اعتبار و نقد، فقط سهم نقدی واقعی را می‌افزاید', mixedCreditSale, 3_000_000)
const creditReturn = custodyPhysicalMovement({ cashRefunded: 0, posRefunded: 0 })
eq('برگشت با اعتبار فروشگاهی، پول فیزیکی را کم نمی‌کند', creditReturn, 0)

rejects('شمارش خالی/NaN هرگز صفر فرض نمی‌شود', () => reconcileCustodyBoundary({
  priorAcceptedObservedTotal: 0,
  priorTheoreticalTotal: 0,
  movement: {},
  observedTotal: Number.NaN
}))
rejects('عدد منفی برای شمارش کور پذیرفته نیست', () => reconcileCustodyBoundary({
  priorAcceptedObservedTotal: 0,
  priorTheoreticalTotal: 0,
  movement: {},
  observedTotal: -1
}))

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
