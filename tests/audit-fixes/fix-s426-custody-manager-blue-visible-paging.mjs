/**
 * Manager's two everyday report surfaces must actually render the server's
 * paged blue boundary and handover evidence, including manager identity. No
 * hidden slice of 8/30 may override the report's honest hasMore indicators.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s426-custody-manager-blue-visible-paging.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
const close = readFileSync(new URL('../../src/renderer/src/pages/CashClose.tsx', import.meta.url), 'utf8')
const admin = readFileSync(new URL('../../src/renderer/src/components/CustodyAdminChip.tsx', import.meta.url), 'utf8')
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
const sharedPath = new URL('../../src/renderer/src/components/CustodyBlueEvidence.tsx', import.meta.url)
eq('shared manager evidence component exists', existsSync(sharedPath), true)
const shared = readFileSync(sharedPath, 'utf8')
for (const [label, page] of [['CashClose', close], ['CustodyAdminChip', admin]]) {
  eq(`${label} renders common original/decision evidence`, page.includes('<CustodyBlueEvidence '), true)
  eq(`${label} renders standalone blue boundaries`, page.includes('blueBoundaries={'), true)
  eq(`${label} renders handover OUT/IN snapshots`, page.includes('handovers={'), true)
  eq(`${label} does not conceal latest 30 blue rows`, page.includes('blueBoundaries?.slice(0, 30)'), false)
}
eq('CashClose has honest independent page warning', close.includes('hasMoreAny'), true)
eq('CashClose does not silently hide first page handovers', close.includes('all.slice(0, 8)'), false)
eq('Admin shows paging and whole-page coverage', admin.includes('report.coverage.hasMoreAny') && admin.includes('report.coverage.skip'), true)
eq('Admin retains exact report time bounds for next page', admin.includes('from: report.from') && admin.includes('to: report.to'), true)
for (const term of ['originalReferenceAmount', 'originalRawDifference', 'originalFreshDifference', 'knownSubtotal', 'destinationUnknownReceived', 'ambiguousLegacyCredit', 'managerName']) {
  eq(`shared manager evidence exposes ${term}`, shared.includes(term), true)
}
console.log(`\n✓ ${checks} checks passed`)
