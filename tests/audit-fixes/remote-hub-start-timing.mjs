import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { cpus, freemem, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

// Diagnostic only: how long a hub child takes to start on this machine (bare
// Node start, fresh hub with owner bootstrap, restart of an existing hub). The
// numbers are printed as a GitHub notice so they are readable through the
// annotations API even when the step passes (CI log downloads are not). The
// only assertion is a generous bound: this is evidence, not a speed test.
const dir = mkdtempSync(join(tmpdir(), 'mahak-hub-timing-')), childFile = join(dir, 'hub.cjs'), bare = join(dir, 'bare.cjs')
await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
writeFileSync(bare, "process.send({type:'ready'});process.on('message',()=>{process.disconnect()})")
const ROUNDS = 4
const config = (directory, owner) => ({ directory, origin: 'https://store.example', owner, auditKey: '33'.repeat(32), snapshotMaxAgeMs: 5000 })
function timed(file, start) {
  return new Promise((resolve, reject) => {
    const began = performance.now(), c = fork(file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=128'] })
    c.once('error', reject)
    c.once('message', message => {
      const ms = Math.round(performance.now() - began)
      if (message.type !== 'ready') { c.kill(); reject(new Error(`start failed: ${JSON.stringify(message)}`)); return }
      if (file === bare) { c.send({}); c.once('exit', () => resolve(ms)); return }
      c.send({ type: 'stop' }); c.once('message', () => c.once('exit', () => resolve(ms)))
    })
    if (start) c.send({ type: 'start', config: start })
  })
}

test('hub child start timing on this machine (diagnostic)', async () => {
  try {
    const result = { node: [], fresh: [], restart: [] }
    for (let i = 0; i < ROUNDS; i++) {
      result.node.push(await timed(bare))
      const hub = mkdtempSync(join(dir, 'hub-'))
      result.fresh.push(await timed(childFile, config(hub, { username: 'owner', password: 'owner-test-password', pin: '746392' })))
      result.restart.push(await timed(childFile, config(hub, null)))
    }
    const line = `at=${new Date().toISOString()} platform=${process.platform} node=${process.version} cpus=${cpus().length} freeMB=${Math.round(freemem() / 1048576)}/${Math.round(totalmem() / 1048576)} ` +
      `bareNodeMs=${result.node.join(',')} freshHubMs=${result.fresh.join(',')} restartHubMs=${result.restart.join(',')}`
    console.log(`::notice title=hub child start timing::${line}`)
    for (const value of [...result.node, ...result.fresh, ...result.restart]) assert.ok(value < 30_000, line)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
