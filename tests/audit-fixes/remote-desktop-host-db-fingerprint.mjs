import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createRemoteTransportVault } from '../../src/main/services/cloud/remoteTransportVault.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

// Real desktop host (CloudSyncService), supervisor, child/HTTP, registry,
// panelSession, cloud reader and cloud state. The shop database is a temporary
// file built from the repository's migrations; Prisma is replaced by read-only
// node:sqlite queries on that file. Electron, safeStorage and readiness are
// simulated. No installed Electron, DPAPI, Windows, tunnel, phone or real shop
// data is involved. Replacements happen while the host is stopped and never
// touch the restore marker.
const E1 = '12345678-1234-4123-8123-123456789abc'
const counter = path => readFileSync(path).readUInt32BE(24)
const makeShopDb = (path, rows) => {
  const client = createClient(path), seed = makeSeeder(client)
  for (const [at, action, entity] of rows) seed.insert('AuditLog', { at, action, entity })
  return client.$disconnect()
}

test('desktop host starts a new epoch when the database was replaced while stopped, with an unchanged marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-desktop-fp-')), root = join(dir, 'remote-hub'), hubDir = join(root, 'hub'), stateDir = join(root, 'state')
  const resources = join(dir, 'resources'), remote = join(resources, 'remote'), db = join(dir, 'data', 'shop.db'), child = join(remote, 'remote-hub-child.cjs'), parent = join(dir, 'parent.cjs')
  const older = join(dir, 'older.db'), foreign = join(dir, 'foreign.db'), fingerprintFile = join(stateDir, 'database-fingerprint.json')
  for (const path of [hubDir, stateDir, remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  await makeShopDb(db, [[1735689600000, 'SALE_CREATE', 'SaleInvoice'], [1735776000000, 'SALE_CREATE', 'SaleInvoice'], [1735862400000, 'PRODUCT_UPDATE', 'Product']])
  copyFileSync(db, older)
  const write = (sql, ...values) => { const h = new DatabaseSync(db); try { h.prepare(sql).run(...values) } finally { h.close() } }
  write('INSERT INTO "AuditLog"("at","action","entity") VALUES(?,?,?)', 1735948800000, 'SALE_CREATE', 'SaleInvoice')
  write('INSERT INTO "AuditLog"("at","action","entity") VALUES(?,?,?)', 1736035200000, 'SALE_CREATE', 'SaleInvoice')
  await makeShopDb(foreign, Array.from({ length: 120 }, (_, i) => [1700000000000 + i, 'CUSTOMER_UPDATE', 'Customer']))
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: child, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  writeFileSync(join(dir, 'remote-settings.json'), JSON.stringify({ enabled: true }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, origin: 'https://store.example' }))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const keys = createRemoteTransportVault(root, 'store_test', storage).create()
  const derive = purpose => Buffer.from(hkdfSync('sha256', keys.commandKey, Buffer.from(`store_test:${E1}`), Buffer.from(`mahak-remote-${purpose}-v1`), 32))
  const state = openCloudStateStore(stateDir); state.save({ version: 1, storeId: 'store_test', epoch: E1, lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  const bootstrap = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile: child, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: keys.auditKey, snapshotMaxAgeMs: 5000,
    reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null,
    revocation: { key: derive('revocation') }, approval: { key: derive('approval'), policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } }, timeoutMs: 10000 })
  await bootstrap.stop(); state.close()
  const handlers = new Map(), events = new EventEmitter()
  globalThis.__desktopHost = { app: { getPath: () => dir, on: (name, handler) => events.on(name, handler), quit: () => {} }, safeStorage: storage, Notification: class { static isSupported() { return true } show() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } } }
  const plugin = { name: 'desktop-host-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const app=globalThis.__desktopHost.app,safeStorage=globalThis.__desktopHost.safeStorage,Notification=globalThis.__desktopHost.Notification,ipcMain=globalThis.__desktopHost.ipcMain,BrowserWindow=globalThis.__desktopHost.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__desktopHost.query(sql,...values)};'
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
    const approveAndClaim = async () => {
      const login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
      const p = (await call('remoteAuth:request', { panel: 'products' })).data
      let seen = false
      for (let i = 0; i < 30 && !seen; i++) { const response = await send('GET', '/api/requests', undefined, login.cookie); seen = response.body.requests?.some(x => x.requestId === p.requestId); if (!seen) await new Promise(r => setTimeout(r, 100)) }
      assert.ok(seen, 'request must be mirrored')
      assert.equal((await send('POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: '746392' }, login.cookie)).status, 200)
      return (await call('remoteAuth:claim', { panel: 'products', requestId: p.requestId, gt: p.gt })).ok
    }
    const startRunning = async () => { await api.startCloudSync(); info = api.cloudSyncStatus(); assert.deepEqual(startupErrors, []); assert.equal(info.running, true) }

    // Run 1: a fresh approval works; the confirmed stop persists the baseline.
    assert.equal(existsSync(fingerprintFile), false)
    await startRunning()
    assert.equal(await approveAndClaim(), true); assert.equal(api.isPanelUnlocked('products', 42), true)
    await api.stopCloudSync(); assert.equal(api.isPanelUnlocked('products', 42), false)
    const first = readJson('database-fingerprint.json')
    assert.equal(first.epoch, E1); assert.equal(first.storeId, 'store_test'); assert.equal(first.highWaterId, 5); assert.equal(first.counter, counter(db))

    // Ordinary writes while stopped are not a replacement: same epoch.
    write('INSERT INTO "AuditLog"("at","action","entity") VALUES(?,?,?)', 1736121600000, 'SALE_CREATE', 'SaleInvoice')
    await startRunning()
    assert.equal(readJson('cloud-state.json').epoch, E1)
    assert.equal(await approveAndClaim(), true)
    await api.stopCloudSync()
    assert.equal(readJson('database-fingerprint.json').highWaterId, 6)

    // An older copy written over the same file while stopped, marker untouched.
    copyFileSync(older, db)
    assert.equal(existsSync(join(dir, 'backups', 'last-restore.txt')), false)
    await startRunning()
    const second = readJson('cloud-state.json')
    assert.notEqual(second.epoch, E1); assert.equal(second.lastAcked, 0); assert.equal(second.anchorHash, ''); assert.equal(second.restoreMarker, null)
    assert.equal(readJson('grant-replay-ledger.json').epoch, second.epoch); assert.equal(readJson('revocation-ledger.json').epoch, second.epoch)
    // A fresh approval works with the keys of the new epoch.
    assert.equal(await approveAndClaim(), true); assert.equal(api.isPanelUnlocked('products', 42), true)
    await api.stopCloudSync()
    const afterOlder = readJson('database-fingerprint.json')
    assert.equal(afterOlder.epoch, second.epoch); assert.equal(afterOlder.highWaterId, 3)

    // Another database with more commits: the counter alone would accept it,
    // the recorded newest audit row does not.
    assert.ok(counter(foreign) > afterOlder.counter)
    copyFileSync(foreign, db)
    await startRunning()
    const third = readJson('cloud-state.json')
    assert.ok(third.epoch !== second.epoch && third.epoch !== E1); assert.equal(third.lastAcked, 0)
    await api.stopCloudSync()

    // A corrupt baseline is never ignored or rewritten: startup stays closed.
    writeFileSync(fingerprintFile, '{')
    await api.startCloudSync()
    assert.equal(api.cloudSyncStatus().running, false)
    assert.equal(startupErrors.length, 1); assert.match(startupErrors[0], /Invalid database fingerprint/)
    assert.equal(readFileSync(fingerprintFile, 'utf8'), '{')
    assert.equal(readJson('cloud-state.json').epoch, third.epoch)
    // The failed startup left the state lock free.
    openCloudStateStore(stateDir).close()
  } finally {
    console.error = oldError
    if (api) await api.stopCloudSync().catch(() => {})
    process.resourcesPath = oldResources; if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__desktopHost
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
