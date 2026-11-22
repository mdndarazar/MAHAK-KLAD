#!/usr/bin/env node
/**
 * نگهبان «طرح تغییرات جدید ۱۴۰۵» (معماری §۱۰-۳). اثبات درستی نیست؛ فقط می‌سنجد
 * که تغییرها در همان فهرست اجازه‌های تأییدشدهٔ مالک (بخش‌های ۶ و ۱۰ سند معماری)
 * مانده‌اند.
 *
 *   node tools/redline-plan-1405.mjs            (مبنا: کامیت شروع ثبت‌شده در زیر)
 *   node tools/redline-plan-1405.mjs --base <SHA>
 *
 * تغییرهای ثبت‌شده، stage‌شده، stage‌نشده و پرونده‌های تازهٔ ردیابی‌نشده را با هم
 * می‌بیند. حذف پرونده، مسیر بیرون از فهرست، بودجهٔ پرشده و دست خوردن پرونده‌های
 * «بی‌تغییر» شکست می‌خورند. ابزار قدیمی `tools/redline-check.mjs` دست نمی‌خورد.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'

/** کامیت شروع کار (پیام «شروع» مالک، ۱۴۰۵/۰۹/۰۱؛ ثبت در docs/REMOTE-TODO.md). */
const START_COMMIT = 'cd09533e35524de359eb63ce3932288e021b2f7b'

const args = process.argv.slice(2)
let baseArg = START_COMMIT
if (args.length) {
  if (args.length !== 2 || args[0] !== '--base' || !/^[0-9a-f]{7,40}$/i.test(args[1])) {
    console.error('Usage: node tools/redline-plan-1405.mjs [--base <commit-SHA>]')
    process.exit(2)
  }
  baseArg = args[1]
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
let base
try {
  process.chdir(git('rev-parse', '--show-toplevel').trim())
  base = git('rev-parse', '--verify', `${baseArg}^{commit}`).trim()
  if (spawnSync('git', ['merge-base', '--is-ancestor', base, 'HEAD']).status !== 0) throw new Error('Base must be an ancestor of HEAD')
} catch (error) {
  console.error(`Invalid baseline: ${error.message}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// دامنه: هر چه این‌جا هست سنجیده می‌شود. docs/، reports/ و deliverables/ بیرون‌اند.
// ---------------------------------------------------------------------------
const SCOPE = ['src', 'prisma', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'tools', 'tests', 'test',
  '.github', 'resources', 'branding', 'THIRD-PARTY-LICENSES.txt', 'INSTALL-WINDOWS-CMD.md', 'INSTALL-WINDOWS-CMD.txt',
  'BUILD-WINDOWS.cmd', 'SETUP-WINDOWS.cmd', 'RUN-WINDOWS.cmd', 'tsconfig.json', 'tsconfig.typecheck.json']

// §۱۰-۱ — پرونده‌های موجودی که اجازهٔ تغییر دارند (با بودجهٔ خط، اگر تعیین شده).
const S = 'src/main/services/'
const C = 'src/renderer/src/components/'
const PG = 'src/renderer/src/pages/'
const ALLOWED_EXISTING = new Map(Object.entries({
  // الف) پرونده‌های حساس مالی — فقط با دامنهٔ بخش ۵
  [`${S}SalesService.ts`]: 40, [`${S}ShiftService.ts`]: 8, [`${S}CustodyService.ts`]: 24,
  [`${S}StoreCreditService.ts`]: 24, [`${PG}SalesReturn.tsx`]: 16, [`${PG}Pos.tsx`]: 1,
  // ب) اجازه و قفل
  [`${S}AuthService.ts`]: 60, [`${S}panelSession.ts`]: 36, 'src/shared/enums.ts': 14,
  'src/shared/panels.ts': null, 'src/shared/ipc.ts': null, 'src/shared/receipt.ts': null, 'src/shared/creditUi.ts': null,
  [`${S}AuditService.ts`]: null, 'src/main/ipc/index.ts': null, 'src/main/ipc/remoteAuth.ts': null,
  [`${S}BackupService.ts`]: null, [`${S}SettingsService.ts`]: null, [`${S}StaffService.ts`]: null,
  [`${S}CustodyPlanService.ts`]: null, [`${S}PeriodLockService.ts`]: null, [`${S}MaintenanceService.ts`]: null,
  [`${S}sms/SmsCredentials.ts`]: null, [`${S}WooSyncService.ts`]: null,
  // ج) کنترل از راه دور
  [`${S}RemoteGrantRegistry.ts`]: null, [`${S}CloudSyncService.ts`]: null,
  [`${S}cloud/experimentalHubSupervisor.ts`]: null, [`${S}cloud/experimentalHubChild.ts`]: null,
  [`${S}cloud/experimentalRemoteCommandIssuer.ts`]: null, [`${S}cloud/grantApprovalCoordinator.ts`]: null,
  [`${S}cloud/experimentalApprovalBridge.ts`]: null, [`${S}cloud/hubIdentity.ts`]: null,
  [`${S}cloud/mobileReadOnlyHub.ts`]: null, [`${S}cloud/mobilePwaAssets.ts`]: null, [`${S}cloud/mobilePwaIcons.ts`]: null,
  [`${S}cloud/cloudReader.ts`]: null, [`${S}cloud/desktopBackupCoordination.ts`]: null,
  // د) چاپ
  [`${S}PrintService.ts`]: null, 'src/main/print/templates.ts': null, 'src/main/print/printer.ts': null,
  // هـ) رابط
  [`${C}PasswordField.tsx`]: 45, [`${C}ManagerGate.tsx`]: 30, 'src/renderer/src/hooks/useManagerSession.tsx': 20,
  [`${C}RemoteRequestBox.tsx`]: null, [`${PG}RemoteLink.tsx`]: null, [`${C}Shell.tsx`]: null,
  'src/renderer/src/lib/api.ts': null, [`${PG}Settings.tsx`]: null, [`${PG}Dashboard.tsx`]: null,
  [`${PG}CreditManagement.tsx`]: null, [`${C}returns/ReturnCreditHandoffActions.tsx`]: null,
  [`${C}PrintSettingsCards.tsx`]: null, [`${C}InvoicePaymentsModal.tsx`]: null, [`${C}OverpayFlowDialogs.tsx`]: null,
  [`${C}ShiftSessionModal.tsx`]: null, [`${C}StockSourceModal.tsx`]: null, [`${PG}ManagementReports.tsx`]: null,
  [`${PG}SalesReports.tsx`]: null, [`${PG}WooSync.tsx`]: null,
  // و) بسته‌بندی و راهنما
  'package.json': 8, 'src/renderer/index.html': 2, 'INSTALL-WINDOWS-CMD.md': null, 'INSTALL-WINDOWS-CMD.txt': null,
  // ۱۰-۴ — آزمون‌های موجودی که با دامنهٔ دقیق تغییر می‌کنند
  'tests/audit-fixes/fix-s181-backup-apply-gate.mjs': 4, 'tests/audit-fixes/fix-s183-credit-remainder-and-passwords.mjs': 2,
  'tests/audit-fixes/fix-s187-settings-second-third-password.mjs': 12, 'tests/audit-fixes/fix-cred-med-03-credit-settings-strict-gate.mjs': 28,
  'tests/audit-fixes/fix-s151b-sale-price-override-discount-range.mjs': 4, 'tests/audit-fixes/remote-grant-registry-security.mjs': 4,
  'tests/audit-fixes/remote-approval-coordinator.mjs': 2, 'tests/audit-fixes/remote-panic-p2-pwa-loopback.mjs': 20,
  'tests/audit-fixes/remote-panels-desktop.mjs': 10, 'tests/audit-fixes/remote-manager-approval-pwa-loopback.mjs': 6,
  'tests/audit-fixes/fix-credit-recovery-reprint-no-double-use.mjs': 76, 'tests/audit-fixes/fix-credit-return-exchange-void-after-print.mjs': 24,
  'tests/audit-fixes/fix-return-exchange-credit-handoff.mjs': 10, 'tests/audit-fixes/fix-financial-global-credit-return-integration.mjs': 10,
  'tests/audit-fixes/fix-credit-invoice-recovery-lookup.mjs': 2, 'tests/audit-fixes/fix-s347-manager-session-main-first.mjs': 4,
  'tests/audit-fixes/fix-s128-maintenance-archive-gate.mjs': 2
}))

// §۶ — پرونده‌های تازهٔ مجاز (الگو).
const NEW_ALLOWED = [
  /^src\/shared\/gateCatalog\.ts$/,
  /^src\/main\/services\/locks\/[^/]+\.ts$/,
  /^src\/main\/services\/reset\/[^/]+\.ts$/,
  /^src\/main\/services\/cloud\/messenger\/[^/]+\.ts$/,
  /^src\/main\/services\/cloud\/[^/]+\.ts$/,
  /^src\/main\/services\/storeCreditSellerReprint\.ts$/,
  /^src\/renderer\/src\/components\/(?:[^/]+\/)?[^/]+\.tsx?$/,
  /^src\/renderer\/src\/assets\/branding\/[^/]+\.(?:png|svg)$/,
  /^branding\/[^/]+$/,
  /^THIRD-PARTY-LICENSES\.txt$/,
  /^tools\/redline-plan-1405\.mjs$/,
  /^tests\/audit-fixes\/plan1405-[^/]+\.mjs$/,
  /^tests\/plan-1405\/[^/]+$/
]

// §۱۰-۲ — پرونده‌هایی که باید بی‌تغییر بمانند (پین؛ هر تغییری شکست است).
const UNCHANGED = [
  'prisma/schema.prisma', 'package-lock.json', 'electron.vite.config.ts', 'src/main/index.ts', 'src/preload/index.ts',
  'src/renderer/src/main.tsx', `${S}MergeService.ts`, `${PG}SalesInvoice.tsx`, `${PG}CashClose.tsx`,
  `${S}cloud/remoteSettings.ts`, 'tools/redline-check.mjs', 'tools/run-regression.sh', 'test/harness/'
]
const UNCHANGED_PREFIX = ['prisma/migrations/', `${S}Cashbox`, `${S}CashMovement`, `${S}CardTransfer`, 'test/harness/', '.github/']
const UNCHANGED_GLOB = [/(^|\/)custodyReconciliation\.ts$/, /(^|\/)cashExplainer\.ts$/]

/**
 * پین‌های پس از هر مرحله: پرونده‌ای که دامنه‌اش بسته شد، از آن پس باید دقیقاً همین
 * محتوا را داشته باشد (sha256). مرحلهٔ ۲ برای `package.json` این‌جا پر می‌شود.
 */
const PINS = new Map(Object.entries({}))

// ---------------------------------------------------------------------------
const inScope = (p) => SCOPE.some((s) => p === s || p.startsWith(s + '/'))
const isUnchanged = (p) => UNCHANGED.includes(p) || UNCHANGED_PREFIX.some((x) => p.startsWith(x)) || UNCHANGED_GLOB.some((r) => r.test(p))
const changes = new Map() // path -> {status, added, deleted}
for (const line of git('diff', '--name-status', '--no-renames', base, '--', ...SCOPE).split('\n')) {
  if (!line.trim()) continue
  const [status, path] = line.split('\t')
  changes.set(path, { status, added: 0, deleted: 0 })
}
for (const line of git('diff', '--numstat', '--no-renames', base, '--', ...SCOPE).split('\n')) {
  if (!line.trim()) continue
  const [a, d, path] = line.split('\t')
  const c = changes.get(path) ?? { status: 'M', added: 0, deleted: 0 }
  c.added = a === '-' ? 0 : Number(a); c.deleted = d === '-' ? 0 : Number(d)
  changes.set(path, c)
}
for (const path of git('ls-files', '--others', '--exclude-standard', '--', ...SCOPE).split('\n')) {
  if (!path.trim() || !inScope(path)) continue
  changes.set(path, { status: 'A?', added: 0, deleted: 0 })
}

const problems = []
const rows = []
for (const [path, c] of [...changes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const total = c.added + c.deleted
  if (c.status === 'D') { problems.push(`${path}: deleted (fail-closed)`); continue }
  if (isUnchanged(path)) { problems.push(`${path}: must stay unchanged (§10-2)`); continue }
  if (c.status.startsWith('A')) {
    if (!NEW_ALLOWED.some((r) => r.test(path))) problems.push(`${path}: new file outside §6`)
    else rows.push(`  + ${path}`)
    continue
  }
  if (!ALLOWED_EXISTING.has(path)) { problems.push(`${path}: existing file outside §10-1 (+${c.added}/-${c.deleted})`); continue }
  const budget = ALLOWED_EXISTING.get(path)
  if (budget != null && total > budget) problems.push(`${path}: ${total} changed lines > budget ${budget}`)
  rows.push(`  ~ ${path}: +${c.added}/-${c.deleted}${budget != null ? ` (budget ${budget})` : ''}`)
}
for (const [path, sha] of PINS) {
  const actual = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing'
  if (actual !== sha) problems.push(`${path}: pinned content changed (sha256 ${actual.slice(0, 12)} != ${sha.slice(0, 12)})`)
}

console.log(`redline-plan-1405 · base ${base.slice(0, 12)} · HEAD ${git('rev-parse', 'HEAD').trim().slice(0, 12)}`)
console.log(rows.length ? rows.join('\n') : '  (no changes in scope)')
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  • ${p}`)
  process.exit(1)
}
console.log('\n✓ all changes are inside the approved plan-1405 list')
