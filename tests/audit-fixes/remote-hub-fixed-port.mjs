import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

// Fixed loopback port for the owner's overlay/tunnel: real child process and
// supervisor on temporary directories. No Electron, tunnel, phone or Windows.
const dir = mkdtempSync(join(tmpdir(), 'mahak-fixed-port-')), childFile = join(dir, 'hub.cjs')
await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })
const key = Buffer.alloc(32, 7)
const config = (directory, extra = {}) => ({ directory, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: key.toString('hex'), snapshotMaxAgeMs: 5000, ...extra })
// Every process and supervisor is cleaned up even when an assertion fails, so a
// regression fails fast instead of leaving a live child behind.
const spawned = [], supervisors = []
function child() {
  const c = fork(childFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), queue = [], waiters = []
  spawned.push(c)
  c.on('message', message => { const w = waiters.shift(); if (w) w(message); else queue.push(message) })
  return { c, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)), exited: () => c.exitCode !== null ? Promise.resolve() : new Promise(resolve => c.once('exit', resolve)) }
}

try {
  await test('the child listens on exactly the requested port and rejects an invalid one before any file is written', async () => {
    for (const mobilePort of [80, 1023, 65536, '47821', 1.5, null]) {
      const hub = mkdtempSync(join(dir, 'bad-')), instance = child()
      instance.c.send({ type: 'start', config: config(hub, { mobilePort }) })
      assert.deepEqual(await instance.next(), { type: 'error', operation: 'start' })
      await instance.exited()
      assert.equal(existsSync(join(hub, 'remote-hub.sqlite')), false); assert.equal(existsSync(join(hub, 'remote-hub.lock')), false)
    }
    const port = await freePort(), hub = mkdtempSync(join(dir, 'good-')), instance = child()
    instance.c.send({ type: 'start', config: config(hub, { mobilePort: port }) })
    const ready = await instance.next()
    assert.equal(ready.type, 'ready'); assert.equal(ready.mobilePort, port); assert.notEqual(ready.auditPort, port)
    assert.equal(await refused(port), false)
    instance.c.send({ type: 'stop' }); assert.deepEqual(await instance.next(), { type: 'stopped' }); await instance.exited()
    assert.equal(await refused(port), true)

    // The port is taken: the child reports a start error and leaves no lock.
    const blocker = createServer(); await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve))
    try {
      const busy = child()
      busy.c.send({ type: 'start', config: { ...config(hub, { mobilePort: port }), owner: null } })
      assert.deepEqual(await busy.next(), { type: 'error', operation: 'start' }); await busy.exited()
      assert.equal(existsSync(join(hub, 'remote-hub.lock')), false)
    } finally { await new Promise(resolve => blocker.close(resolve)) }
  })

  await test('the supervisor validates the port, sends it only when set, and refuses a child reporting another port', async () => {
    const stateDir = join(dir, 'state'); mkdirSync(stateDir)
    const state = openCloudStateStore(stateDir)
    try {
      state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null })
      const reader = { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }
      const record = join(dir, 'start-config.json')
      const probe = join(dir, 'probe.cjs')
      // Reports the requested port (or 3002 without one), and records what it received.
      writeFileSync(probe, `const fs=require('fs');process.on('message',m=>{if(m.type==='start'){fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(m.config));process.send({type:'ready',pid:process.pid,mobilePort:m.config.mobilePort??3002,auditPort:3003})}if(m.type==='stop'){process.send({type:'stopped'});process.disconnect()}})`)
      const liar = join(dir, 'liar.cjs')
      writeFileSync(liar, `process.on('message',m=>{if(m.type==='start')process.send({type:'ready',pid:process.pid,mobilePort:(m.config.mobilePort??3000)+1,auditPort:3003});if(m.type==='stop'){process.send({type:'stopped'});process.disconnect()}})`)
      const options = { nodeExecutable: process.execPath, childFile: probe, directory: join(dir, 'hub-dir'), origin: 'https://store.example', owner: null, auditKey: key, snapshotMaxAgeMs: 5000, reader, state, readRestoreMarker: async () => null, timeoutMs: 1000 }
      mkdirSync(options.directory)
      for (const mobilePort of [0, 80, 1023, 65536, '47821', 1.5]) await assert.rejects(startExperimentalHubSupervisor({ ...options, mobilePort }), /Invalid experimental hub configuration/)
      const start = async extra => { const h = await startExperimentalHubSupervisor({ ...options, ...extra }); supervisors.push(h); return h }
      let hub = await start({})
      assert.equal(hub.mobilePort, 3002); assert.equal(Object.hasOwn(JSON.parse(readFileSync(record, 'utf8')), 'mobilePort'), false)
      await hub.stop()
      hub = await start({ mobilePort: 47999 })
      assert.equal(hub.mobilePort, 47999); assert.equal(JSON.parse(readFileSync(record, 'utf8')).mobilePort, 47999)
      await hub.stop()
      const outcome = await startExperimentalHubSupervisor({ ...options, childFile: liar, mobilePort: 47999 }).then(h => { supervisors.push(h); return h }, error => error)
      assert.ok(outcome instanceof Error, 'a child reporting another port must be refused'); assert.match(outcome.message, /Hub child unavailable/)
      // Without a fixed port, any reported port is accepted (ephemeral mode).
      hub = await start({ childFile: liar })
      assert.equal(hub.mobilePort, 3001)
      await hub.stop()
    } finally { state.close() }
  })
} finally {
  for (const h of supervisors) await h.stop().catch(() => {})
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
}
