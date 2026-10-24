/**
 * Full-scope blue reference: the 501st legacy CREDIT row must not change the
 * number simply because it is or isn't on the visible report page.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s398-custody-blue-reference-pagination.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-reference-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { officialReferenceForDays } = await import('../../src/main/services/CustodyReferenceService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const { receiptBucketOf } = await import('@shared/accounting')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
let checked = 0
const eq = (name, got, want) => {
  if (got !== want) throw new Error(`${name}: expected ${String(want)}, got ${String(got)}`)
  checked++
  console.log(`  ✓ ${name}`)
}

const now = Date.now()
const day = toJalaliDate(new Date(now))
const cash = seed.insert('PaymentMethod', { key: 'S398_CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 })
const credit = seed.insert('PaymentMethod', { key: 'S398_LEGACY_CREDIT', label: 'اعتباری قدیمی', kind: 'CREDIT', isActive: 0, sortOrder: 5 })
const user = seed.user('مسئول گزارش S398')
const amount = 1_000_000
for (let i = 1; i <= 501; i++) {
  const inv = seed.invoice({ receiptNo: 398_000 + i, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAt=?, issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=? WHERE id=?')
    .run(now + i, day, amount, amount, user, inv.id)
  seed.insert('Payment', {
    invoiceId: inv.id, methodId: i === 501 ? credit : cash, amount, seq: 1,
    kind: 'CASH', destination: i === 501 ? null : 'CASH',
    paidAt: now + i, paidAtJalali: day, createdByUserId: user
  })
}
const args = { fromJalali: day, toJalali: day }
const pages = async () => [
  await salesService.reportRows({ ...args, skip: 0, take: 500 }),
  await salesService.reportRows({ ...args, skip: 500, take: 500 })
]

console.log('\n[1] Legacy CREDIT on page 501: no definitive discrepancy, no page-dependent reference')
{
  const [first, second] = await pages()
  eq('page 1 has 500 rows', first.rows.length, 500)
  eq('page 2 has one row', second.rows.length, 1)
  for (const [i, report] of [first, second].entries()) {
    eq(`page ${i + 1} total cash`, report.totals.cashTotal, 500_000_000)
    eq(`page ${i + 1} full-scope ambiguous credit`, report.totals.creditTotal, amount)
    eq(`page ${i + 1} known received`, report.totals.receivedTotal, 500_000_000)
    eq(`page ${i + 1} pending`, report.custodyReference.status, 'PENDING_RECONCILIATION')
    eq(`page ${i + 1} known subtotal`, report.custodyReference.knownSubtotal, 500_000_000)
    eq(`page ${i + 1} no fictional official amount`, report.custodyReference.referenceAmount, null)
    eq(`page ${i + 1} full-scope warning`, report.custodyReference.ambiguousLegacyCredit, amount)
  }
  eq('changing skip never changes source hash', first.custodyReference.sourceHash, second.custodyReference.sourceHash)
  const official = await officialReferenceForDays({ operationalDay: day })
  eq('Main returns the same pending verdict', official.status, 'PENDING_RECONCILIATION')
  eq('Main returns the same known subtotal', official.knownSubtotal, 500_000_000)
}

console.log('\n[2] An explicit legacy CASH/CARD destination precedes method kind CREDIT')
for (const dest of ['CASH', 'CARD']) {
  sql.prepare('UPDATE "Payment" SET destination=? WHERE invoiceId=(SELECT id FROM "SaleInvoice" WHERE receiptNo=398501)').run(dest)
  eq(`receiptBucketOf accepts explicit ${dest}`, receiptBucketOf({ methodKind: 'CREDIT', destination: dest }), dest.toLowerCase())
  const [first, second] = await pages()
  for (const [i, report] of [first, second].entries()) {
    eq(`${dest} page ${i + 1} available`, report.custodyReference.status, 'AVAILABLE')
    eq(`${dest} page ${i + 1} blue`, report.custodyReference.referenceAmount, 501_000_000)
    eq(`${dest} page ${i + 1} no ambiguous credit`, report.totals.creditTotal, 0)
  }
}

console.log('\n[3] A genuine unpaid credit sale has no payment and adds zero blue money')
sql.prepare('DELETE FROM "Payment" WHERE invoiceId=(SELECT id FROM "SaleInvoice" WHERE receiptNo=398501)').run()
// Keep the invoice visible as a sale with a remaining debt, not a paid receipt.
sql.prepare('UPDATE "SaleInvoice" SET paidTotal=0 WHERE receiptNo=398501').run()
const [first, second] = await pages()
for (const [i, report] of [first, second].entries()) {
  eq(`unpaid page ${i + 1} blue`, report.custodyReference.referenceAmount, 500_000_000)
  eq(`unpaid page ${i + 1} available`, report.custodyReference.status, 'AVAILABLE')
  eq(`unpaid page ${i + 1} sales unaffected`, report.totals.grandTotal, 501_000_000)
}

console.log(`\n✓ ${checked} checks passed`)
