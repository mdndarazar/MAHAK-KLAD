/**
 * A historical invoice without independent POS operator evidence must not
 * acquire a guessed operator from its financial drawer owner or shift. The
 * manager view/export must make that coverage limit explicit, not rewrite it.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s429-custody-legacy-invoice-operator-unknown.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-legacy-operator-s429-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const seed = makeSeeder(harnessClient())
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
const manager = seed.user('مدیر S429')
const owner = seed.user('مسئول کشو S429')
const shiftId = seed.insert('Shift', { userId: owner })
const unknown = seed.invoice({ receiptNo: 429001, grandTotal: 100, status: 'SETTLED' })
const financialOwner = seed.invoice({ receiptNo: 429002, grandTotal: 200, status: 'SETTLED' })
const sql = harnessClient().$harness.db
sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=? WHERE id=?').run(null, shiftId, unknown.id)
sql.prepare('UPDATE "SaleInvoice" SET userId=?, shiftId=? WHERE id=?').run(owner, shiftId, financialOwner.id)
await custodyService.setPin({ userId: manager, newPassword: 'Manager429!', currentPassword: '1111' })
const report = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager429!' })
eq('no independent operator evidence is fabricated for historical invoices', report.saleOperators.length, 0)
eq('financial owner does not become an invented POS operator', report.summary.operatorSales, 0)
eq('old invoice with unknown financial owner remains unchanged', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', unknown.id).userId, null)
eq('old invoice financial owner stays separately recorded', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', financialOwner.id).userId, owner)
eq('no retrospective operator rows are written', seed.count('CustodySaleEvidence'), 0)
const ui = readFileSync(new URL('../../src/renderer/src/pages/CashClose.tsx', import.meta.url), 'utf8')
const source = readFileSync(new URL('../../src/main/services/CustodyService.ts', import.meta.url), 'utf8')
eq('manager timeline admits that old invoices without proof are omitted', ui.includes('فاکتورهای قدیمی فاقد سند اپراتور'), true)
eq('export states that an old operator cannot be proven from financial ownership', source.includes('اپراتور فاکتورهای قدیمی فاقد سند مستقل قابل اثبات نیست'), true)
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const electron = await import('electron')
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const path = join(dir, 'legacy-operator.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
notePanelUnlocked('test', 'MANAGER')
const result = await custodyService.exportReport({ managerSession: true, from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })
eq('manager receives CSV rather than a guessed operator', result.format, 'csv')
const csv = readFileSync(path, 'utf8')
eq('manager CSV includes the operator coverage disclaimer even with zero operator rows', csv.includes('اپراتور فاکتورهای قدیمی فاقد سند مستقل قابل اثبات نیست'), true)
eq('export still does not backfill historical POS evidence', seed.count('CustodySaleEvidence'), 0)
console.log(`\n✓ ${checks} checks passed`)
