/**
 * An ADOPTION_BASELINE has no earlier comparable reference, no discrepancy
 * case, and no blame. Its original count must still appear in the manager
 * report/CSV, with independent paging and no fabricated expected/difference.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s428-custody-adoption-boundary-export.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-adoption-export-s428-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const { toJalaliDate } = await import('@shared/jalali')
const electron = await import('electron')
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const seed = makeSeeder(harnessClient())
const today = toJalaliDate(new Date())
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); checks++; console.log(`  ✓ ${label}`) }
const user = seed.user('مدیر S428')
const shiftId = seed.insert('Shift', { userId: user })
const ids = []
for (let i = 0; i < 3; i++) {
  ids.push(seed.insert('CustodyAggregateBoundary', {
    boundaryKind: 'ADOPTION_BASELINE', fromShiftId: null, toShiftId: shiftId,
    previousBoundaryId: null, priorAcceptedObservedTotal: 1000 + i,
    priorTheoreticalTotal: 1000 + i, physicalMovement: 0,
    operationalExpectedTotal: 1000 + i, theoreticalExpectedTotal: 1000 + i,
    observedOperationalTotal: 1000 + i, newDifference: 0, totalTheoreticalDifference: 0,
    countedByUserId: user, authMethod: 'CUSTODY_PIN',
    calculationVersion: 'aggregate-v2', idempotencyKey: `s428:adoption:${i}`,
    operationalDay: today, baselineSource: 'ADOPTION', sourceMovementOffset: 0,
    at: new Date(Date.now() - i * 1000)
  }))
}
const snapshotBefore = seed.rows('SELECT * FROM "CustodyAggregateBoundary" ORDER BY id')
notePanelUnlocked('test', 'MANAGER')
const page = await custodyService.discrepancyReport({ managerSession: true, from: today, to: today, take: 1 })
eq('neutral adoptions did not fabricate a discrepancy case', page.summary.allCases, 0)
eq('manager gets adoption boundaries as separate evidence', page.bootstrapBoundaries.rows.length, 3)
const filePath = join(dir, 'adoptions.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
const exported = await custodyService.exportDiscrepancyReport({ managerSession: true, from: today, to: today, take: 1 })
eq('export writes a real CSV', exported.format, 'csv')
const csv = readFileSync(filePath, 'utf8').replace(/^\ufeff/, '')
eq('export includes an ADOPTION row despite there being no case', csv.includes(`افتتاح خنثی #${ids[0]}`), true)
eq('export does not confuse first observation with a new discrepancy', csv.includes('بدون مبنای قبلی؛ اختلاف تازه نامعلوم'), true)
const first = await custodyService.discrepancyReport({ managerSession: true, from: today, to: today, status: 'OPEN', take: 1, bootstrapTake: 1, bootstrapSkip: 0 })
eq('neutral evidence has its own bounded page', first.bootstrapBoundaries.rows.length, 1)
eq('bootstrap paging does not manufacture an OPEN case', first.summary.openCases, 0)
eq('more neutral evidence is flagged without pretending cases exist', first.bootstrapBoundaries.page.hasMore, true)
const second = await custodyService.discrepancyReport({ managerSession: true, from: today, to: today, status: 'OPEN', take: 1, bootstrapTake: 1, bootstrapSkip: 1 })
eq('next neutral page uses its independent offset', second.bootstrapBoundaries.rows[0]?.id, ids[1])
const secondPath = join(dir, 'adoptions-page2.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: secondPath })
await custodyService.exportDiscrepancyReport({ managerSession: true, from: today, to: today, status: 'OPEN', take: 1, bootstrapTake: 1, bootstrapSkip: 1 })
const secondCsv = readFileSync(secondPath, 'utf8')
eq('export of second neutral page includes its evidence', secondCsv.includes(`افتتاح خنثی #${ids[1]}`), true)
eq('export of second neutral page does not silently dump first page', secondCsv.includes(`افتتاح خنثی #${ids[0]}`), false)
const adminUi = readFileSync(new URL('../../src/renderer/src/components/CustodyAdminChip.tsx', import.meta.url), 'utf8')
eq('manager UI renders neutral observations separately', adminUi.includes('bootstrapBoundaries.rows.map'), true)
eq('manager UI exposes independent adoption page controls', adminUi.includes('bootstrapBoundaries.page.hasMore'), true)
eq('export leaves database evidence unchanged', JSON.stringify(seed.rows('SELECT * FROM "CustodyAggregateBoundary" ORDER BY id')), JSON.stringify(snapshotBefore))
console.log(`\n✓ ${checks} checks passed`)
