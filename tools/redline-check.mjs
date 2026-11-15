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
  'src/main/index.ts': 2, 'src/main/services/AuthService.ts': 10,
  'src/main/services/panelSession.ts': 6, 'src/shared/enums.ts': 3,
  'src/preload/index.ts': 3, 'src/renderer/src/components/ManagerGate.tsx': 15,
  'src/renderer/src/components/PasswordField.tsx': 8,
  'src/renderer/src/hooks/useManagerSession.tsx': 4, 'src/renderer/src/main.tsx': 2,
  'src/renderer/src/components/CreditForms.tsx': 4, 'package.json': 1, 'electron.vite.config.ts': 1
}))
const permitted = (path) => allowed.has(path) || path.startsWith('src/main/services/cloud/')
const problems = []
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
