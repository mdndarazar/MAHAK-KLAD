/**
 * Morning's first blue comparison includes yesterday and today's receipts;
 * later handovers compare today alone. Manager withdrawal never rewrites blue.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s400-custody-blue-daily-scope.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-daily-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { officialReferenceForDays } = await import('../../src/main/services/CustodyReferenceService.ts')
const { jalaliStartOfDay, toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const today = toJalaliDate(new Date())
const todayStart = jalaliStartOfDay(today).getTime()
const yesterdayDate = new Date(todayStart - 60_000)
const yesterday = toJalaliDate(yesterdayDate)
const methodId = seed.insert('PaymentMethod', { key: 'S400_CASH', label: 'نقد', kind: 'CASH', isActive: 1, sortOrder: 1 })
const userId = seed.user('مسئول واقعی S400')
const writeSale = (amount, time, day) => {
  const inv = seed.invoice({ grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAt=?, issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=? WHERE id=?')
    .run(time, day, amount, amount, userId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId, amount, seq: 1, kind: 'CASH', destination: 'CASH', paidAt: time, paidAtJalali: day, createdByUserId: userId })
}
writeSale(5_000_000, yesterdayDate.getTime(), yesterday)
writeSale(500_000, todayStart + 30_000, today)

let checked = 0
const eq = (label, got, want) => {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
  checked++
  console.log(`  ✓ ${label}`)
}
const morning = () => officialReferenceForDays({ operationalDay: today, previousDayForFirstMorning: yesterday })
const afternoon = () => officialReferenceForDays({ operationalDay: today })
const first = await morning()
const later = await afternoon()
eq('first morning sees previous-day 5M plus today\'s 0.5M', first.referenceAmount, 5_500_000)
eq('afternoon sees today alone', later.referenceAmount, 500_000)
eq('morning is a real available reference', first.status, 'AVAILABLE')
eq('afternoon is not a shift-only report', later.status, 'AVAILABLE')
// The general cash statement may account for withdrawal, but the report's blue
// contract is independent of CashMovement. Actual counting later records any
// raw discrepancy; a manager explains it without mutating the sales figure.
seed.insert('CashMovement', { type: 'WITHDRAWAL', amount: 5_000_000, userId, occurredAt: todayStart + 40_000 })
eq('manager withdrawal does not subtract yesterday from morning blue', (await morning()).referenceAmount, 5_500_000)
eq('manager withdrawal does not change today blue', (await afternoon()).referenceAmount, 500_000)
console.log(`\n✓ ${checked} checks passed`)
