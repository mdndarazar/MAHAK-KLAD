#!/usr/bin/env node
/**
 * Guard for the remote-app work, NOT a proof of correctness or a comparison to
 * an automatically chosen historical baseline. Supply the actual, reviewed
 * pre-work commit explicitly: node tools/redline-check.mjs --base <commit>.
 *
 * Includes committed, staged, unstaged and untracked changes in src/ and prisma/,
 * plus package.json, package-lock.json and electron.vite.config.ts. Deletions,
 * unapproved paths and over-budget existing files fail closed. Earlier unrelated
 * changes since the chosen baseline will also be reported rather than excused.
 */
import { execFileSync, spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--base' || !/^[0-9a-f]{7,40}$/i.test(args[1])) {
  console.error('Usage: node tools/redline-check.mjs --base <reviewed-commit-SHA>')
  process.exit(2)
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
let base
try {
  const root = git('rev-parse', '--show-toplevel').trim()
  process.chdir(root)
  base = git('rev-parse', '--verify', `${args[1]}^{commit}`).trim()
  if (spawnSync('git', ['merge-base', '--is-ancestor', base, 'HEAD']).status !== 0) {
    throw new Error('Base must be an ancestor of HEAD')
  }
} catch (error) {
  console.error(`Invalid baseline: ${error.message}`)
  process.exit(2)
}
const scope = ['src', 'prisma', 'package.json', 'package-lock.json', 'electron.vite.config.ts']
const allowed = new Set([
  'src/main/index.ts', 'src/main/services/CloudSyncService.ts',
  'src/main/services/RemoteGrantRegistry.ts', 'src/main/services/RemoteHubServer.ts',
  'src/main/services/RemoteHubStore.ts', 'src/main/services/panelSession.ts',
  'src/main/services/AuthService.ts', 'src/main/ipc/remoteAuth.ts',
  'src/shared/remoteAuthChannels.ts', 'src/shared/enums.ts', 'src/preload/index.ts',
  'src/renderer/src/components/ManagerGate.tsx', 'src/renderer/src/components/RemoteRequestBox.tsx',
  'src/renderer/src/components/PasswordField.tsx', 'src/renderer/src/hooks/useManagerSession.tsx',
  'src/renderer/src/main.tsx', 'src/renderer/src/pages/RemoteLink.tsx',
  'src/renderer/src/components/CreditForms.tsx', 'package.json', 'package-lock.json',
  'electron.vite.config.ts'
])
// Budgets are additions plus deletions in tracked existing files, relative to base.
const budgets = new Map(Object.entries({
  // Owner approved app.requestSingleInstanceLock() for stale remote-lock
  // recovery (stage 12): +3 lines (lock, second-instance focus, ready guard).
  'src/main/index.ts': 5, 'src/main/services/AuthService.ts': 10,
  // Owner approved the narrow increase for remote grant expiry enforcement.
  'src/main/services/panelSession.ts': 24, 'src/shared/enums.ts': 3,
  'src/preload/index.ts': 3, 'src/renderer/src/components/ManagerGate.tsx': 15,
  'src/renderer/src/components/PasswordField.tsx': 8,
  'src/renderer/src/hooks/useManagerSession.tsx': 4, 'src/renderer/src/main.tsx': 2,
  // Owner approved one additional package line solely for Windows hub packaging,
  // and (2026-11-20, after the first real install failed with "Cannot find module
  // '.prisma/client/default'") one build.files FileSet that ships the generated
  // Prisma client in app.asar: +2/-1 lines, budget 2 -> 5.
  'src/renderer/src/components/CreditForms.tsx': 4, 'package.json': 5, 'electron.vite.config.ts': 1
}))
// Owner approved exactly two historical typecheck corrections in SalesService.
// Pin both complete blobs, not a line budget: any additional edit remains forbidden.
const salesPath = 'src/main/services/SalesService.ts'
let approvedSalesFix = false
try {
  approvedSalesFix = git('rev-parse', `${base}:${salesPath}`).trim() === '64f56dcfb4cb2e4169d6e37e7ca86ec86cba1cbc' &&
    git('hash-object', `--path=${salesPath}`, salesPath).trim() === '122a366fcff54ce5756bd09f42eae3e686748e59'
} catch {} // Missing or unreadable file is never approved.
// Owner authorized only the backup IPC coordination hook, not general IPC edits.
const backupIpcPath = 'src/main/ipc/index.ts'
let approvedBackupIpc = false
try {
  approvedBackupIpc = git('rev-parse', `${base}:${backupIpcPath}`).trim() === '932e01005eed9722f4e06d31752e25a6e79f071c' &&
    git('hash-object', `--path=${backupIpcPath}`, backupIpcPath).trim() === '819520a968e75f9814af28e95192d9c28703696b'
} catch {}
// Owner authorized a coordination wrapper around merge entry only; pin the
// entire pre/post blob so the financial merge implementation cannot change.
const mergePath = 'src/main/services/MergeService.ts'
let approvedMergeWrapper = false
try {
  approvedMergeWrapper = git('rev-parse', `${base}:${mergePath}`).trim() === 'e6dfe9f37f926c4ebb6134eeeadaa2764f84e66f' &&
    git('hash-object', `--path=${mergePath}`, mergePath).trim() === '29e19ba29136992c49bd37bd4ab48a998344deff'
} catch {}
const permitted = (path) => allowed.has(path) || path.startsWith('src/main/services/cloud/') || (path === salesPath && approvedSalesFix) || (path === backupIpcPath && approvedBackupIpc) || (path === mergePath && approvedMergeWrapper)
const problems = []
// The owner approved only the packaging-related additions (hub runtime, then the
// Prisma client FileSet). Pin the exact reviewed blobs as well as the budget so
// other package edits are not permitted.
try {
  if (git('rev-parse', `${base}:package.json`).trim() !== 'c1f24920c6750f3a891b250d825cb7f10eeb2a3d' ||
      git('hash-object', '--path=package.json', 'package.json').trim() !== '6714bb14eb5f6d261151deb5fd764fd36229a2f4')
    problems.push('package.json differs from the owner-approved packaging configuration')
} catch { problems.push('Cannot verify approved package.json') }
const statusFields = git('diff', '--name-status', '--no-renames', '-z', base, '--', ...scope).split('\0')
for (let i = 0; i < statusFields.length - 1; i += 2) {
  const [status, path] = [statusFields[i], statusFields[i + 1]]
  if (!permitted(path)) problems.push(`Forbidden path: ${path}`)
  if (status === 'D') problems.push(`Deleted file: ${path}`)
}
for (const path of git('ls-files', '--others', '--exclude-standard', '-z', '--', ...scope).split('\0').filter(Boolean)) {
  if (!permitted(path)) problems.push(`Forbidden untracked path: ${path}`)
}
const stats = git('diff', '--numstat', '--no-renames', '-z', base, '--', ...scope).split('\0').filter(Boolean)
for (const entry of stats) {
  const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry)
  if (!m) { problems.push('Cannot parse change statistics'); continue }
  const [, added, deleted, path] = m
  if (budgets.has(path)) {
    if (added === '-' || deleted === '-') problems.push(`Binary change in budgeted file: ${path}`)
    else if (Number(added) + Number(deleted) > budgets.get(path)) {
      problems.push(`Line budget exceeded: ${path} (${Number(added) + Number(deleted)} > ${budgets.get(path)})`)
    }
  }
}
if (problems.length) {
  console.error(`REDLINE FAILED against ${base}:\n${problems.map((p) => `- ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`REDLINE OK against ${base} (scoped paths only; not a correctness or security test)`)
