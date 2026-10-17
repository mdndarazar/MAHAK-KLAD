/**
 * Route split and Main IPC security contract for Cash Closing history.
 * These source/IPC checks complement the real Electron/Prisma UI benchmark;
 * SSR/harness alone cannot prove that an in-flight old Shell poll is canceled.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s455-cash-closing-history-navigation.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-cash-history-nav-s455-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { runWithPanelSessionOwner, notePanelUnlocked, isPanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const { IPC } = await import('@shared/ipc')
const { PANEL_KEYS } = await import('@shared/panels')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient(), seed = makeSeeder(db)
let checks = 0
const eq = (label, got, want) => { assert.deepEqual(got, want, label); checks++; console.log(`  ✓ ${label}`) }
const source = (name) => readFileSync(new URL(`../../src/renderer/src/${name}`, import.meta.url), 'utf8')
const main = source('main.tsx')
const landing = source('pages/CashClosingLanding.tsx')
const history = source('pages/CashCloseHistory.tsx')
const gate = source('components/ManagerGate.tsx')
const shell = source('components/Shell.tsx')
const provider = source('hooks/useManagerSession.tsx')

// Route selection happens before mounting the Shell, status chip, shift chip,
// printer host or writer-capable manager settings bootstrap.
eq('top-level router is outside ManagerSessionProvider', /<React\.StrictMode>\s*\{\/\*[^]*?\*\/\}\s*<RouterProvider router=\{router\} \/>/.test(main), true)
eq('operational Shell has provider only inside its own branch', main.includes('element: <ManagerSessionProvider><Shell /></ManagerSessionProvider>'), true)
eq('F10 module landing is a separate route sibling', main.includes("{ path: '/cash-close', element: <CashClosingLanding /> }"), true)
eq('read-only history route is a separate route sibling', main.includes("{ path: '/cash-close/history', element: <CashCloseHistory /> }"), true)
eq('only /operate mounts original ManagerGate and CashClose', /path: 'cash-close\/operate',[\s\S]*?<ManagerGate panel=\{PANEL_KEYS\.cashClose\}[\s\S]*?<CashClose \/>/.test(main), true)
eq('legacy /cash-close no longer mounts operations', /path: 'cash-close',\s*element:\s*\(\s*<ManagerGate/.test(main), false)
eq('no operational module or provider imported into safe landing/history', /(?:import|from).*\b(?:CashClose\b|Shell\b|ManagerSessionProvider\b|CustodyChip\b|ShiftSessionChip\b|PrinterPickerHost\b)/.test(landing + history), false)
eq('safe branches do not call writer-capable operational IPC', /CH\.(?:custodyStatus|shiftCurrent|cashboxExpected|cashboxMovementAdd|cashClose|custodyFinalClose|settingsBundle)/.test(landing + history), false)
eq('Shell still mounts the existing operational custody/shift chips', shell.includes('<CustodyChip showSetup={false} />') && shell.includes('<ShiftSessionChip />'), true)
eq('Shell continues its existing status behavior only on operational routes', main.includes('element: <ManagerSessionProvider><Shell /></ManagerSessionProvider>') && shell.includes('<StocktakeReminderChip />'), true)
eq('operational gate still supports second password and lock-off', gate.includes('unlockPanel(panel, value)') && gate.includes('const open = canOpen(panel) || lockOff'), true)
eq('operations provider still owns settingsBundle, not the history branch', provider.includes('CH.settingsBundle') && !history.includes('useManagerSession'), true)
eq('history visible Back always targets safe landing', history.includes("nav('/cash-close')"), true)
eq('direct-open browser Back cannot mount an operational/unrelated route', history.includes("historyAction === 'POP'") && history.includes("blocker.reset()") && history.includes("nav('/cash-close', { replace: true })"), true)
eq('both landing choices point within Cash Closing module', landing.includes("nav('/cash-close/history')") && landing.includes("nav('/cash-close/operate')"), true)
eq('F10 still targets Cash Closing landing', source('lib/shortcuts.ts').includes("F10: '/cash-close'"), true)
for (const name of ['components/Shell.tsx', 'pages/Dashboard.tsx', 'pages/Settings.tsx', 'pages/Consolidation.tsx', 'pages/SalesReports.tsx']) {
  eq(`${name}: existing module entry still points at landing`, source(name).includes("'/cash-close'"), true)
}

const electron = await import('electron'), handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = (id) => ({ id, isDestroyed: () => false, once: () => {} })
const invoke = (id, channel, input) => handlers.get(channel)({ sender: sender(id) }, input)
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
registerIpcHandlers()
const day = toJalaliDate(new Date()), range = { fromJalali: day, toJalali: day }
const before = {
  audit: seed.count('AuditLog'), settings: seed.count('Setting'), custody: seed.count('CustodyEvent'),
  shifts: seed.count('Shift'), sessions: seed.count('CashSession')
}
runWithPanelSessionOwner(456, () => notePanelUnlocked(PANEL_KEYS.cashClose, 'PANEL'))
eq('existing Cash Closing panel scope remains valid for operations', isPanelUnlocked(PANEL_KEYS.cashClose, 456), true)
const denied = await invoke(456, IPC.cashClosingHistory, range)
eq('Cash Closing panel password does not grant manager-only history', [denied.ok, denied.code], [false, 'REPORT_MANAGER_REQUIRED'])
eq('losing manager access hides the old report on the next IPC denial', history.includes("err?.code === 'REPORT_MANAGER_REQUIRED') onAuthorizationLost()") && history.includes("onAuthorizationLost={() => setAccess('denied')}"), true)
eq('panel scope denied without settings/custody writes', [seed.count('Setting'), seed.count('CustodyEvent')], [before.settings, before.custody])
runWithPanelSessionOwner(455, () => notePanelUnlocked('__manager__', 'MANAGER'))
const okay = await invoke(455, IPC.cashClosingHistory, range)
eq('manager IPC can read history', okay.ok, true)
eq('empty report has complete zero counts', [okay.data.rows.length, okay.data.totals.handovers, okay.data.totals.finalClosings], [0, 0, 0])
const newRows = await invoke(455, IPC.cashClosingHistory, { ...range, rows: [{ referenceAmount: 999 }] })
eq('forged renderer rows rejected by real IPC', newRows.ok, false)
eq('invalid payload returns structured error code', newRows.code, 'REPORT_INVALID')
const otherWindow = await invoke(457, IPC.cashClosingHistory, { ...range, snapshotToken: okay.data.snapshotToken })
eq('different window cannot read owner report', otherWindow.ok, false)
const wrongExport = await invoke(455, IPC.cashClosingHistoryExport, { snapshotToken: okay.data.snapshotToken, format: 'csv', totals: { closes: 9 } })
eq('renderer cannot forge export totals through Main IPC', [wrongExport.ok, wrongExport.code], [false, 'REPORT_INVALID'])
const filePath = join(dir, 'history.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
const exported = await invoke(455, IPC.cashClosingHistoryExport, { snapshotToken: okay.data.snapshotToken, format: 'csv' })
eq('Main-only frozen-token CSV export works', [exported.ok, exported.data?.format], [true, 'csv'])
eq('CSV contains source and range, no fabricated row', readFileSync(filePath, 'utf8').includes(day) && exported.data.rows === 0, true)
eq('opening, viewing and CSV export do not write settings/audit/custody/cash', {
  audit: seed.count('AuditLog'), settings: seed.count('Setting'), custody: seed.count('CustodyEvent'),
  shifts: seed.count('Shift'), sessions: seed.count('CashSession')
}, before)
await invoke(455, IPC.managerLogout)
const afterLogout = await invoke(455, IPC.cashClosingHistoryExport, { snapshotToken: okay.data.snapshotToken, format: 'csv' })
eq('logout revokes export access', afterLogout.ok, false)
console.log(`\n✓ ${checks} Cash Closing navigation / IPC contract checks passed`)
