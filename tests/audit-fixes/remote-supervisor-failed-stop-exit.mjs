import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Real supervisor and child with temporary files only. fork is wrapped solely
// to observe the spawned process; nothing is mocked in the supervisor. No
// Electron, installed app, Windows device, tunnel or phone is involved.
const children = []
const originalFork = childProcess.fork
childProcess.fork = (...args) => { const child = originalFork(...args); children.push(child); return child }
syncBuiltinESMExports()
const { startExperimentalHubSupervisor } = await import('../../src/main/services/cloud/experimentalHubSupervisor.ts')
const { openCloudStateStore } = await import('../../src/main/services/cloud/cloudState.ts')
const { initRemoteGrantRegistry, revokeAll } = await import('../../src/main/services/RemoteGrantRegistry.ts')
const exited = child => child.exitCode !== null || child.signalCode !== null

test('a failed hub stop settles only after the child process has exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-failed-stop-')), childFile = join(dir, 'hub.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  initRemoteGrantRegistry({ notePanelUnlocked: () => {}, clearPanelScope: () => {}, clearPanelSessions: () => {} })
  // A failed stop keeps the admission lease closed in this process, so only the
  // last hub uses the revocation path; stop() is the same code for both.
  const start = async (name, owner, revocation) => {
    const hubDir = join(dir, name); mkdirSync(hubDir)
    const state = openCloudStateStore(join(dir, `${name}-state`))
    state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null })
    state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
    const before = children.length
    const hub = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 1500,
      ...(revocation ? { revocation: { key: Buffer.alloc(32, 2) } } : {}) })
    assert.equal(children.length, before + 1)
    return { hub, state, child: children[before] }
  }
  const opened = []
  try {
    // IPC lost while the process is still running: stop() must not report
    // before the process is gone.
    const first = await start('disconnected', { username: 'owner', password: 'owner-test-password', pin: '746392' }, false); opened.push(first)
    const lost = once(first.child, 'disconnect'); first.child.disconnect(); await lost
    let settledAfterExit
    await assert.rejects(first.hub.stop().finally(() => { settledAfterExit = exited(first.child) }), /cleanup not confirmed/)
    assert.equal(settledAfterExit, true)

    // A child that never acknowledges stop is killed; the timeout is reported
    // only after its exit was observed.
    const second = await start('unresponsive', { username: 'owner', password: 'owner-test-password', pin: '746392' }, true); opened.push(second)
    const send = second.child.send.bind(second.child)
    second.child.send = (message, ...rest) => message?.type === 'stop' ? true : send(message, ...rest)
    const began = Date.now()
    await assert.rejects(second.hub.stop().finally(() => { settledAfterExit = exited(second.child) }), /Hub stop timed out/)
    assert.equal(settledAfterExit, true)
    assert.ok(Date.now() - began >= 1400, 'the acknowledgement timeout still applies')
  } finally {
    for (const { hub, child } of opened) { await hub.stop().catch(() => {}); if (!exited(child)) child.kill() }
    revokeAll()
    for (const { state } of opened) state.close()
    childProcess.fork = originalFork; syncBuiltinESMExports()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
