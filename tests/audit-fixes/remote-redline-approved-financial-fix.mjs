import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const script = join(root, 'tools/redline-check.mjs')
const salesPath = 'src/main/services/SalesService.ts'

test('redline permits only the two owner-approved financial typecheck edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-financial-redline-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid')
    const file = join(dir, salesPath)
    mkdirSync(dirname(file), { recursive: true })
    const baseline = execFileSync('git', ['show', `2834baf:${salesPath}`], { cwd: root })
    writeFileSync(file, baseline)
    git('add', '.'); git('commit', '-qm', 'isolated baseline')
    const base = git('rev-parse', 'HEAD')
    const run = () => spawnSync(process.execPath, [script, '--base', base], { cwd: dir, encoding: 'utf8' })
    assert.equal(run().status, 0)
    const approved = readFileSync(join(root, salesPath))
    writeFileSync(file, approved)
    let result = run()
    assert.equal(result.status, 0, result.stderr)
    writeFileSync(file, Buffer.concat([approved, Buffer.from('\n// unauthorised extra edit\n')]))
    result = run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Forbidden path: src\/main\/services\/SalesService\.ts/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
