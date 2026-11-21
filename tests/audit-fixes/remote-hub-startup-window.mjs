import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer, connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createRemoteSetupFiles } from '../../src/main/services/cloud/remoteSetup.ts'

// A first start on a slow PC (antivirus scanning the bundled node.exe) can take
// longer than an ordinary operation, and a timed-out start keeps the state lock
// until the application restarts. Temporary data only; Electron, safeStorage
// and readiness are simulated; no Windows, antivirus, phone or tunnel.
const require = createRequire(import.meta.url)
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })
// Loads the real child only after `ms`, re-delivering messages that arrived meanwhile.
const delayedChild = (real, ms) => `const queued=[],early=m=>queued.push(m);process.on('message',early);setTimeout(()=>{process.off('message',early);require(${JSON.stringify(real)});for(const m of queued)process.emit('message',m)},${ms})`

test('the supervisor waits a separate startup window, defaulting to the operation timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-startup-window-'))
  const state = openCloudStateStore(join(dir, 'state'))
  const supervisors = []
  try {
    state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null })
    const slow = join(dir, 'slow.cjs')
    writeFileSync(slow, "process.on('message',m=>{if(m.type==='start')setTimeout(()=>process.send({type:'ready',pid:process.pid,mobilePort:3002,auditPort:3003}),1500);if(m.type==='stop'){process.send({type:'stopped'});process.disconnect()}})")
    mkdirSync(join(dir, 'hub'))
    const options = { nodeExecutable: process.execPath, childFile: slow, directory: join(dir, 'hub'), origin: 'https://store.example', owner: null, auditKey: Buffer.alloc(32, 9), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 1000 }
    for (const startupTimeoutMs of [50, 120_001, '5000', 1.5]) await assert.rejects(startExperimentalHubSupervisor({ ...options, startupTimeoutMs }), /Invalid hub timeout/)
    const early = await startExperimentalHubSupervisor(options).then(h => { supervisors.push(h); return h }, error => error)
    assert.ok(early instanceof Error, 'without a startup window the operation timeout applies'); assert.match(early.message, /Hub child unavailable/)
    const hub = await startExperimentalHubSupervisor({ ...options, startupTimeoutMs: 4000 }); supervisors.push(hub)
    assert.equal(hub.mobilePort, 3002)
    await hub.stop()
  } finally {
    for (const h of supervisors) await h.stop().catch(() => {})
    state.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('the desktop host starts a hub child that needs longer than the 5 s operation timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-startup-host-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const db = join(dir, 'data', 'shop.db')
  for (const path of [remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  const client = createClient(db), seed = makeSeeder(client)
  seed.insert('AuditLog', { at: 1735689600000, action: 'SALE_CREATE', entity: 'SaleInvoice' }); await client.$disconnect()
  const real = join(remote, 'real-child.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: real, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  writeFileSync(join(remote, 'remote-hub-child.cjs'), delayedChild(real, 6000))
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const port = await freePort()
  createRemoteSetupFiles(dir, { origin: 'https://shop.example', port }, storage, null)
  writeFileSync(join(dir, 'remote-settings.json'), '{"enabled":true}')
  globalThis.__startupHost = { app: { getPath: () => dir, on: () => {}, quit: () => {} }, safeStorage: storage, Notification: class { static isSupported() { return false } show() {} },
    ipcMain: { handle: () => {} }, BrowserWindow: { fromWebContents: () => null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } } }
  const plugin = { name: 'startup-host-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'export const app=globalThis.__startupHost.app,safeStorage=globalThis.__startupHost.safeStorage,Notification=globalThis.__startupHost.Notification,ipcMain=globalThis.__startupHost.ipcMain,BrowserWindow=globalThis.__startupHost.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__startupHost.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=async()=>{throw Error('not used')};"
      : `export * from ${JSON.stringify(fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url)))};export const remoteImplementationReady=()=>true;` }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  console.error = (...args) => { if (args[0] !== '[remote] startup unavailable') oldError(...args) }
  let api
  try {
    const outfile = join(dir, 'host.cjs')
    await build({ entryPoints: ['src/main/services/CloudSyncService.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = require(outfile)
    const began = Date.now()
    await api.startCloudSync({ owner: { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' } })
    const host = api.remoteHostState()
    assert.equal(host.running, true, host.error); assert.equal(host.needsRestart, false); assert.equal(host.mobilePort, port)
    assert.ok(Date.now() - began >= 6000, 'the child really needed longer than the operation timeout')
    assert.equal(await refused(port), false)
    await api.stopCloudSync()
    assert.equal(await refused(port), true); assert.equal(api.remoteHostState().needsRestart, false)
  } finally {
    try { await api?.stopCloudSync() } catch {}
    process.resourcesPath = oldResources; console.error = oldError
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__startupHost
    rmSync(dir, { recursive: true, force: true })
  }
})
