import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated SQLite from the repository migrations; Electron is the test stub.
const dir = mkdtempSync(join(tmpdir(), 'mahak-remote-disabled-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { ipcMain } = await import('electron')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { remoteSettingEnabled } = await import('../../src/main/services/cloud/remoteSettings.ts')
const { startCloudSync, stopCloudSync } = await import('../../src/main/services/CloudSyncService.ts')
const { registerRemoteAuthHandlers } = await import('../../src/main/ipc/remoteAuth.ts')
const db = harnessClient()
const statePath = join(dir, 'cloud-state.json')
let handles = 0, timeouts = 0, intervals = 0, auditReads = 0
const originalHandle = ipcMain.handle
const originalTimeout = globalThis.setTimeout
const originalInterval = globalThis.setInterval
const originalFindFirst = db.auditLog.findFirst
const originalFindMany = db.auditLog.findMany
ipcMain.handle = () => { handles++ }
globalThis.setTimeout = () => { timeouts++; return 1 }
globalThis.setInterval = () => { intervals++; return 1 }
db.auditLog.findFirst = async (...args) => { auditReads++; return originalFindFirst(...args) }
db.auditLog.findMany = async (...args) => { auditReads++; return originalFindMany(...args) }
try {
  await test('unfinished remote sync has no startup state file, timers, reads or IPC', () => {
    assert.equal(remoteSettingEnabled(dir), false)
    startCloudSync(); startCloudSync(); stopCloudSync()
    assert.equal(existsSync(statePath), false)
    assert.equal(handles, 0); assert.equal(timeouts, 0); assert.equal(intervals, 0); assert.equal(auditReads, 0)
  })
  await test('direct remote IPC registration is also blocked', () => {
    registerRemoteAuthHandlers()
    assert.equal(handles, 0)
  })
  await test('a preexisting state file and environment variables cannot enable unfinished code', () => {
    const original = JSON.stringify({enabled:true,epoch:'old-epoch',mode:'HUB_LOCAL',cursor:123,chainHash:'old'})
    writeFileSync(statePath,original)
    process.env.REMOTE_ENABLED='true'
    startCloudSync(); registerRemoteAuthHandlers()
    assert.equal(readFileSync(statePath,'utf8'),original)
    assert.equal(handles,0);assert.equal(timeouts,0);assert.equal(intervals,0);assert.equal(auditReads,0)
  })
  await test('remote button uses the readiness gate, while normal login remains rendered', () => {
    // Structural check only, not a visual or Electron UI test.
    const source = readFileSync(new URL('../../src/renderer/src/components/ManagerGate.tsx', import.meta.url),'utf8')
    assert.match(source, /remoteImplementationReady\(\)\s*&&\s*<RemoteRequestBox/)
    assert.match(source, /onClick=\{\(\) => void submit\(\)\}/)
  })
} finally {
  ipcMain.handle = originalHandle
  globalThis.setTimeout = originalTimeout
  globalThis.setInterval = originalInterval
  db.auditLog.findFirst = originalFindFirst
  db.auditLog.findMany = originalFindMany
  delete process.env.REMOTE_ENABLED
  await db.$disconnect()
}
