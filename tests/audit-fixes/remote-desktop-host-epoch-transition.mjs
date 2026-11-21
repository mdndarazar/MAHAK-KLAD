import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createRemoteTransportVault } from '../../src/main/services/cloud/remoteTransportVault.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

// Real desktop host, supervisor, child/HTTP, registry, panelSession and cloud
// state. Electron, Prisma, safeStorage and readiness are simulated. All files
// and keys are temporary; no installed Electron, DPAPI, tunnel, phone or real
// shop database is involved. The restore itself is simulated by replacing the
// temporary database and writing the marker while the host is stopped.
test('desktop host adopts a changed restore marker as a new epoch, re-announces Panic and needs fresh approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-desktop-epoch-')), root = join(dir, 'remote-hub'), hubDir = join(root, 'hub'), stateDir = join(root, 'state')
  const resources = join(dir, 'resources'), remote = join(resources, 'remote'), db = join(dir, 'data', 'shop.db'), child = join(remote, 'remote-hub-child.cjs'), parent = join(dir, 'parent.cjs')
  const markerFile = join(dir, 'backups', 'last-restore.txt')
  for (const path of [hubDir, stateDir, remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  const dbHandle = new DatabaseSync(db); dbHandle.exec('CREATE TABLE test_value (value TEXT)'); dbHandle.close()
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: child, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  writeFileSync(join(dir, 'remote-settings.json'), JSON.stringify({ enabled: true }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, origin: 'https://store.example' }))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const keys = createRemoteTransportVault(root, 'store_test', storage).create(), E1 = '12345678-1234-4123-8123-123456789abc'
  const derive = purpose => Buffer.from(hkdfSync('sha256', keys.commandKey, Buffer.from(`store_test:${E1}`), Buffer.from(`mahak-remote-${purpose}-v1`), 32))
  const state = openCloudStateStore(stateDir); state.save({ version: 1, storeId: 'store_test', epoch: E1, lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  const bootstrap = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile: child, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: keys.auditKey, snapshotMaxAgeMs: 5000,
    reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null,
    revocation: { key: derive('revocation') }, approval: { key: derive('approval'), policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } }, timeoutMs: 10000 })
  await bootstrap.stop(); state.close()
  const handlers = new Map(), events = new EventEmitter()
  globalThis.__desktopHost = { app: { getPath: () => dir, on: (name, handler) => events.on(name, handler), quit: () => {} }, safeStorage: storage, Notification: class { static isSupported() { return true } show() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null } }
  const plugin = { name: 'desktop-host-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const app=globalThis.__desktopHost.app,safeStorage=globalThis.__desktopHost.safeStorage,Notification=globalThis.__desktopHost.Notification,ipcMain=globalThis.__desktopHost.ipcMain,BrowserWindow=globalThis.__desktopHost.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:async()=>[]};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=async p=>{if(p!=='local-manager-test-password')throw Error('wrong password')};"
      : "export const remoteImplementationReady=()=>true;export const REMOTE_GT_PREFIX='gt-';export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',recover:'remoteAuth:recover',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};" }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  const startupErrors = []
  console.error = (...args) => { if (args[0] === '[remote] startup unavailable') startupErrors.push(String(args[1]?.message ?? args[1])); else oldError(...args) }
  const readJson = name => JSON.parse(readFileSync(join(stateDir, name), 'utf8'))
  let api
  try {
    await build({ stdin: { contents: "export * from './src/main/services/CloudSyncService.ts'; export {isPanelUnlocked} from './src/main/services/panelSession.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: parent, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(parent)
    let info
    const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = request({ hostname: '127.0.0.1', port: info.mobilePort, path, method, headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
      })
      req.on('error', reject); req.end(data)
    })
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }, sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
    const call = (channel, payload) => handlers.get(channel)({ sender, senderFrame: frame }, payload)
    const approveAndClaim = async cookie => {
      const p = (await call('remoteAuth:request', { panel: 'products' })).data
      let seen = false
      for (let i = 0; i < 30 && !seen; i++) { const response = await send('GET', '/api/requests', undefined, cookie); seen = response.body.requests?.some(x => x.requestId === p.requestId); if (!seen) await new Promise(r => setTimeout(r, 100)) }
      assert.ok(seen, 'request must be mirrored')
      assert.equal((await send('POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: '746392' }, cookie)).status, 200)
      return (await call('remoteAuth:claim', { panel: 'products', requestId: p.requestId, gt: p.gt })).ok
    }

    // Epoch 1: phone approval opens the panel; Panic closes it and is acknowledged.
    await api.startCloudSync(); info = api.cloudSyncStatus(); assert.equal(info.running, true)
    let login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    assert.equal(await approveAndClaim(login.cookie), true); assert.equal(api.isPanelUnlocked('products', 42), true)
    assert.equal((await send('POST', '/api/panic', { pin: '746392' }, login.cookie)).status, 200); assert.equal(api.isPanelUnlocked('products', 42), false)
    const firstCursor = readJson('revocation-ledger.json').cursor
    assert.equal(firstCursor?.kind, 'ALL')
    await api.stopCloudSync(); assert.equal(api.cloudSyncStatus().running, false)

    // Restore while stopped: replaced database and a new marker.
    const replaced = new DatabaseSync(db); replaced.exec('CREATE TABLE restored_value (value TEXT)'); replaced.close()
    writeFileSync(markerFile, 'restore 1')
    await api.startCloudSync(); info = api.cloudSyncStatus()
    assert.deepEqual(startupErrors, []); assert.equal(info.running, true)
    const E2 = readJson('cloud-state.json').epoch
    assert.notEqual(E2, E1); assert.equal(readJson('cloud-state.json').lastAcked, 0); assert.match(readJson('cloud-state.json').restoreMarker, /^[0-9a-f]{64}$/)
    assert.equal(readJson('grant-replay-ledger.json').epoch, E2)
    // The latched Panic was announced again under the new epoch and applied.
    const secondLedger = readJson('revocation-ledger.json')
    assert.equal(secondLedger.epoch, E2); assert.equal(secondLedger.cursor?.kind, 'ALL'); assert.ok(secondLedger.cursor.id > firstCursor.id)
    assert.equal((await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' })).status, 401)
    assert.equal((await call('remoteAuth:recover', { password: 'local-manager-test-password', pin: '746392' })).ok, true)
    login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    assert.equal(api.isPanelUnlocked('products', 42), false)
    // A fresh approval works with the keys of the new epoch.
    assert.equal(await approveAndClaim(login.cookie), true); assert.equal(api.isPanelUnlocked('products', 42), true)
    await api.stopCloudSync(); assert.equal(api.isPanelUnlocked('products', 42), false)

    // The same marker keeps the epoch on the next start.
    await api.startCloudSync(); info = api.cloudSyncStatus(); assert.equal(info.running, true)
    assert.equal(readJson('cloud-state.json').epoch, E2)
    await api.stopCloudSync()

    // A corrupt ledger is never replaced, even when the marker changes again.
    writeFileSync(join(stateDir, 'revocation-ledger.json'), '{')
    writeFileSync(markerFile, 'restore 2')
    await api.startCloudSync()
    assert.equal(api.cloudSyncStatus().running, false)
    assert.equal(startupErrors.length, 1); assert.match(startupErrors[0], /Invalid revocation ledger/)
    assert.equal(readFileSync(join(stateDir, 'revocation-ledger.json'), 'utf8'), '{')
    // The failed transition released the state lock.
    openCloudStateStore(stateDir).close()
  } finally {
    console.error = oldError
    if (api) await api.stopCloudSync().catch(() => {})
    process.resourcesPath = oldResources; if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__desktopHost
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
