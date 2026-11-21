import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalRestoreBarrier } from '../../src/main/services/cloud/experimentalRestoreBarrier.ts'
import { initRemoteGrantRegistry, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Diagnostic only. Windows run 44494043775 failed in the existing
// remote-restore-epoch-fence-loopback test after 8.6 s (about 0.2 s on Linux)
// with EPERM from its final rmSync, which can hide an earlier error. This
// replays the same restore -> stop flow and reports each step's time, the stop
// result and how long the folder stayed undeletable, as a GitHub notice. It
// asserts only the setup; the existing test keeps every assertion.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
test('restore then stop timing on this machine (diagnostic)', async () => {
  const began = performance.now(), marks = {}, mark = name => { marks[name] = Math.round(performance.now() - began) }
  const dir = mkdtempSync(join(tmpdir(), 'mahak-restore-timing-')), hubDir = join(dir, 'hub'), stateDir = join(dir, 'state'), childFile = join(dir, 'child.cjs'); mkdirSync(hubDir)
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  mark('build')
  const dbFile = join(dir, 'shop.db'), source = join(dir, 'backup.db')
  for (const [path, value] of [[dbFile, 1], [source, 2]]) { const db = new DatabaseSync(path); db.exec(`CREATE TABLE x (value INTEGER); INSERT INTO x VALUES (${value})`); db.close() }
  let state = openCloudStateStore(stateDir), hub, stopError = null, flowError = null
  state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  initRemoteGrantRegistry({ notePanelUnlocked: () => {}, clearPanelScope: () => {}, clearPanelSessions: () => {} })
  const options = { nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
    reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [], waitForIdle: async () => {} }, state, restoreBarrier: createExperimentalRestoreBarrier(), readRestoreMarker: async () => null, timeoutMs: 5000,
    revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies: { shifts: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 } } } }
  try {
    hub = await startExperimentalHubSupervisor(options); mark('start')
    try {
      await hub.restoreExclusive(async () => { copyFileSync(source, dbFile) }); mark('restore')
      await hub.syncOnce().catch(() => {}); await hub.refreshOnce().catch(() => {}); mark('rejects')
    } catch (error) { flowError = String(error?.message ?? error) }
    try { await hub.stop() } catch (error) { stopError = String(error?.message ?? error) }
    mark('stop'); hub = null
  } finally {
    if (hub) await hub.stop().catch(() => {})
    revokeAll(); state.close(); mark('stateClose')
    let attempts = 0, firstRmError = null
    for (;;) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch (error) {
        attempts++; firstRmError ??= error.code
        if (attempts >= 100) break
        await sleep(100)
      }
    }
    mark('cleanup')
    console.log(`::notice title=restore stop timing::at=${new Date().toISOString()} platform=${process.platform} node=${process.version} cpus=${cpus().length} ` +
      `marksMs=${JSON.stringify(marks)} flowError=${flowError} stopError=${stopError} rmFailedAttempts=${attempts} firstRmError=${firstRmError}`)
  }
  assert.ok(marks.start !== undefined, 'the hub started')
})
