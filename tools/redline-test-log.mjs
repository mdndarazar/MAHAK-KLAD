#!/usr/bin/env node
/**
 * نگهبان «معماری پیاده‌سازی نهایی دفتر آزمون» (معماری بخش ۹-۱). اثبات درستی نیست؛
 * فقط می‌سنجد که تغییرها از کامیت «برو»ی مالک تا درخت کار، در فهرست اجازه‌های همان
 * دسته‌ها (`tools/test-log-allowlist.json`) مانده‌اند.
 *
 *   node tools/redline-test-log.mjs --batch N          (اجازه‌های دسته‌های ۱ تا N روی هم)
 *   node tools/redline-test-log.mjs --batch N --base <SHA>
 *
 * تغییرهای ثبت‌شده، stage‌شده، stage‌نشده و پرونده‌های تازهٔ ردیابی‌نشده را با هم می‌بیند.
 * حذف پرونده، مسیر بیرون از فهرست، بودجهٔ پرشده، پین‌ها و پرونده‌های «ثابت ۱۴۰۵» بیرون از
 * دستهٔ خودشان شکست می‌خورند. ابزار قبلی `tools/redline-plan-1405.mjs` دست نمی‌خورد.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const allow = JSON.parse(readFileSync(new URL('./test-log-allowlist.json', import.meta.url), 'utf8'))

const args = process.argv.slice(2)
let batch = null
let baseArg = allow.startCommit
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--batch' && /^[0-9]+$/.test(args[i + 1] ?? '')) batch = Number(args[++i])
  else if (args[i] === '--base' && /^[0-9a-f]{7,40}$/i.test(args[i + 1] ?? '')) baseArg = args[++i]
  else {
    console.error('Usage: node tools/redline-test-log.mjs --batch <1-9> [--base <commit-SHA>]')
    process.exit(2)
  }
}
if (batch == null || batch < 1 || batch > 9) {
  console.error('Usage: node tools/redline-test-log.mjs --batch <1-9> [--base <commit-SHA>]')
  process.exit(2)
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

const SCOPE = allow.scope
const inScope = (p) => SCOPE.some((s) => p === s || p.startsWith(s + '/'))

/** فهرست مجاز دسته‌های ۱ تا N: مسیر ⇐ بودجهٔ خط (جمع دسته‌ها) یا null (بی بودجه). */
const allowed = new Map()
const batchesOf = new Map()
for (let n = 1; n <= batch; n++) {
  const files = allow.batches[String(n)]?.files ?? {}
  for (const [path, budget] of Object.entries(files)) {
    const prev = allowed.has(path) ? allowed.get(path) : undefined
    if (prev === undefined) allowed.set(path, budget)
    else if (prev === null || budget === null) allowed.set(path, null)
    else allowed.set(path, prev + budget)
    batchesOf.set(path, [...(batchesOf.get(path) ?? []), n])
  }
}
for (const p of allow.sharedAllBatches) if (!allowed.has(p)) allowed.set(p, null)
for (const [p, b] of Object.entries(allow.setupFiles)) if (!allowed.has(p)) allowed.set(p, b)

const isPinned = (p) =>
  allow.pins.includes(p) || allow.pinPrefixes.some((x) => p.startsWith(x)) || (batch <= 9 && allow.pinsBatches1to9.includes(p))
const isFrozen = (p) => allow.frozen1405.includes(p) || allow.frozen1405Prefixes.some((x) => p.startsWith(x))
const isNever = (p) => allow.neverChange.some((name) => p === name || p.endsWith('/' + name))
const newOk = allow.newFiles.map((r) => new RegExp(r))

const changes = new Map()
for (const line of git('diff', '--name-status', '--no-renames', base, '--', ...SCOPE).split('\n')) {
  if (!line.trim()) continue
  const [status, path] = line.split('\t')
  changes.set(path, { status, added: 0, deleted: 0 })
}
for (const line of git('diff', '--numstat', '--no-renames', base, '--', ...SCOPE).split('\n')) {
  if (!line.trim()) continue
  const [a, d, path] = line.split('\t')
  const c = changes.get(path) ?? { status: 'M', added: 0, deleted: 0 }
  c.added = a === '-' ? 0 : Number(a)
  c.deleted = d === '-' ? 0 : Number(d)
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
  if (isPinned(path)) { problems.push(`${path}: pinned (§9-1)`); continue }
  if (isNever(path)) { problems.push(`${path}: must never change (§9-1)`); continue }
  if (c.status.startsWith('A')) {
    if (!newOk.some((r) => r.test(path))) problems.push(`${path}: new file outside §9-3`)
    else rows.push(`  + ${path}`)
    continue
  }
  if (!allowed.has(path)) {
    problems.push(`${path}: existing file outside the batch 1..${batch} lists (+${c.added}/-${c.deleted})`)
    continue
  }
  if (isFrozen(path) && !batchesOf.has(path)) { problems.push(`${path}: frozen-1405 file outside its batch`); continue }
  const budget = allowed.get(path)
  if (budget != null && total > budget) problems.push(`${path}: ${total} changed lines > budget ${budget} (batches ${batchesOf.get(path)?.join(',') ?? 'setup'})`)
  rows.push(`  ~ ${path}: +${c.added}/-${c.deleted}${budget != null ? ` (budget ${budget})` : ''}`)
}

console.log(`redline-test-log · batch 1..${batch} · base ${base.slice(0, 12)} · HEAD ${git('rev-parse', 'HEAD').trim().slice(0, 12)}`)
console.log(rows.length ? rows.join('\n') : '  (no changes in scope)')
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  • ${p}`)
  process.exit(1)
}
console.log(`\n✓ all changes are inside the batch 1..${batch} allowlist`)
