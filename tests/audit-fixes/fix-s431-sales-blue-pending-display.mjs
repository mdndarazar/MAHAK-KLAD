// A missing/partial reference is NOT the sales subtotal and is not an official zero.
// node --import ./test/harness/register.mjs tests/audit-fixes/fix-s431-sales-blue-pending-display.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { availableCustodyReferenceAmount } from '../../src/shared/custodyReference.ts'

const available = (referenceAmount) => ({ status: 'AVAILABLE', referenceAmount })
const pending = (knownSubtotal = 500_000) => ({ status: 'PENDING_RECONCILIATION', referenceAmount: null, knownSubtotal })
assert.equal(availableCustodyReferenceAmount(undefined), null, 'missing report must not fall back to realCash')
assert.equal(availableCustodyReferenceAmount(pending()), null, 'known part of pending report is not official')
assert.equal(availableCustodyReferenceAmount(available(null)), null, 'incomplete AVAILABLE is not a usable reference')
assert.equal(availableCustodyReferenceAmount(available(0)), 0, 'explicit official zero remains a valid zero')
assert.equal(availableCustodyReferenceAmount(available(500_000)), 500_000)
assert.equal(availableCustodyReferenceAmount(available(Number.NaN)), null, 'malformed amount is not official')

const drawer = readFileSync('src/renderer/src/components/cash/DrawerVsPosSplit.tsx', 'utf8')
const inspector = readFileSync('src/renderer/src/components/cash/FinancialInspector.tsx', 'utf8')
const reports = readFileSync('src/renderer/src/pages/SalesReports.tsx', 'utf8')
assert.match(drawer, /availableCustodyReferenceAmount\(custodyReference\)/)
assert.doesNotMatch(drawer, /custodyReference\?\.referenceAmount\s*\?\?\s*realCash/)
assert.match(inspector, /availableCustodyReferenceAmount\(referenceVerdictSnapshot\)/)
assert.match(reports, /availableCustodyReferenceAmount\(report\.custodyReference\)/)
assert.doesNotMatch(reports, /\$\{money\(summary\.realCash\)\} ریال مرجع گزارش/)
console.log('✓ pending/missing report never displays a fallback official blue amount; explicit zero remains valid')
