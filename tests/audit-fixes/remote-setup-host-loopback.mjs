import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'

// Owner setup through the real setup IPC, desktop host (CloudSyncService),
// supervisor, child/HTTP, registry and panelSession, on a temporary shop
// database built from the repository migrations. Electron, safeStorage, the
// manager-password check and readiness are simulated; no installed Electron,
// DPAPI, Windows, tunnel, phone or real shop data is involved.
const MANAGER = 'local-manager-test-password'
const ORIGIN = 'https://shop.example'
const OWNER = { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' }
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })

test('owner setup over IPC: fixed port, owner bootstrap, approval, off = no port, restart, reset and an owner-required retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-remote-setup-host-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const db = join(dir, 'data', 'shop.db'), child = join(remote, 'remote-hub-child.cjs')
  for (const path of [remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  const client = createClient(db), seed = makeSeeder(client)
  for (const [at, action, entity] of [[1735689600000, 'SALE_CREATE', 'SaleInvoice'], [1735776000000, 'PRODUCT_UPDATE', 'Product']]) seed.insert('AuditLog', { at, action, entity })
  await client.$disconnect()
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: child, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const handlers = new Map(), events = new EventEmitter(), passwordChecks = []
  globalThis.__setupHost = { app: { getPath: name => { assert.equal(name, 'userData'); return dir }, on: (name, handler) => events.on(name, handler), quit: () => {} }, safeStorage: storage,
    Notification: class { static isSupported() { return true } show() {} }, ipcMain: { handle: (name, fn) => { assert.equal(handlers.has(name), false, `duplicate handler ${name}`); handlers.set(name, fn) } },
    BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
    password: async (password, action) => { passwordChecks.push(action); if (password !== MANAGER) throw new Error('رمز مدیر درست نیست.') } }
  const channels = fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url))
  const plugin = { name: 'setup-host-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'export const app=globalThis.__setupHost.app,safeStorage=globalThis.__setupHost.safeStorage,Notification=globalThis.__setupHost.Notification,ipcMain=globalThis.__setupHost.ipcMain,BrowserWindow=globalThis.__setupHost.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__setupHost.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=(p,a)=>globalThis.__setupHost.password(p,a);"
      // The real channel names and types, with only the readiness gate opened.
      : `export * from ${JSON.stringify(channels)};export const remoteImplementationReady=()=>true;` }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  console.error = (...args) => { if (args[0] !== '[remote] startup unavailable') oldError(...args) }
  const load = async name => {
    const outfile = join(dir, `${name}.cjs`)
    await build({ stdin: { contents: "export * from './src/main/services/cloud/remoteSetupIpc.ts'; export * from './src/main/services/CloudSyncService.ts'; export {isPanelUnlocked} from './src/main/services/panelSession.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    return createRequire(import.meta.url)(outfile)
  }
  let api, occupied
  try {
    api = await load('app-1')
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }
    const sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
    const call = (channel, payload, event = { sender, senderFrame: frame }) => handlers.get(channel)(event, payload)
    const port = await freePort()
    const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'shop.example', origin: ORIGIN, 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
      })
      req.on('error', reject); req.end(data)
    })
    const login = () => send('POST', '/api/login', { username: OWNER.username, password: OWNER.password })
    const setting = () => existsSync(join(dir, 'remote-settings.json')) ? readFileSync(join(dir, 'remote-settings.json'), 'utf8') : null

    // 1. Readiness open, but no opt-in: the boot path opens nothing.
    api.registerRemoteSetupHandlers(); api.registerRemoteSetupHandlers()
    assert.deepEqual([...handlers.keys()].sort(), ['remoteSetup:complete', 'remoteSetup:configure', 'remoteSetup:disable', 'remoteSetup:enable', 'remoteSetup:reset', 'remoteSetup:status'])
    await api.startCloudSync()
    let status = (await call('remoteSetup:status')).data
    assert.deepEqual({ ...status, defaultPort: undefined }, { ready: true, configured: false, partial: false, ownerRequired: false, enabled: false, running: false, busy: false,
      needsRestart: false, origin: null, port: null, mobilePort: null, defaultPort: undefined, error: null })
    assert.equal(status.defaultPort, 47821)
    assert.equal(await refused(port), true)

    // 2. Only the app's own top-level window may call setup IPC.
    const subframe = { url: frame.url }
    assert.equal((await call('remoteSetup:status', undefined, { sender, senderFrame: subframe })).code, 'FORBIDDEN')
    const foreign = { url: 'https://evil.example/' }
    assert.equal((await call('remoteSetup:configure', { managerPassword: MANAGER }, { sender: Object.assign(new EventEmitter(), { id: 43, valid: true, mainFrame: foreign, isDestroyed: () => false }), senderFrame: foreign })).code, 'FORBIDDEN')

    // 3. Rejected setups create no file; invalid input is rejected before the
    //    manager password is checked (no lockout attempt is used).
    const valid = { managerPassword: MANAGER, origin: ORIGIN, port, ...OWNER }
    assert.equal((await call('remoteSetup:configure', { ...valid, origin: 'http://shop.example' })).code, 'ORIGIN')
    assert.equal((await call('remoteSetup:configure', { ...valid, password: 'short' })).code, 'OWNER_PASSWORD')
    assert.equal((await call('remoteSetup:configure', { ...valid, pin: '12ab56' })).code, 'PIN')
    assert.equal((await call('remoteSetup:configure', { ...valid, port: 80 })).code, 'PORT')
    assert.deepEqual(passwordChecks, [])
    const wrong = await call('remoteSetup:configure', { ...valid, managerPassword: 'wrong-password' })
    assert.equal(wrong.code, 'MANAGER_PASSWORD'); assert.equal(wrong.error, 'رمز مدیر درست نیست.')
    assert.equal(existsSync(join(dir, 'remote-hub')), false); assert.equal(setting(), null); assert.equal(handlers.has('remoteAuth:request'), false)

    // 4. Setup: files, opt-in, first start with the owner, fixed port.
    const configured = await call('remoteSetup:configure', valid)
    assert.equal(configured.ok, true, configured.error)
    assert.equal(configured.data.running, true, configured.data.error); assert.equal(configured.data.mobilePort, port); assert.equal(configured.data.port, port)
    assert.equal(configured.data.configured, true); assert.equal(configured.data.ownerRequired, false); assert.equal(configured.data.origin, ORIGIN)
    assert.equal(setting(), '{"enabled":true}')
    assert.equal(existsSync(join(dir, 'remote-hub', 'hub', 'remote-hub.sqlite')), true)
    assert.equal(readFileSync(join(dir, 'remote-hub', 'config.json'), 'utf8').includes(OWNER.password), false)
    assert.equal((await call('remoteSetup:configure', valid)).code, 'ALREADY_CONFIGURED')
    assert.equal((await call('remoteSetup:complete', valid)).code, 'OWNER_EXISTS')

    // 5. The provisioned identity and keys work end to end: phone login,
    //    request mirror, approval with the owner PIN and a desktop claim.
    const approveAndClaim = async () => {
      const session = await login(); assert.equal(session.status, 200)
      const p = (await call('remoteAuth:request', { panel: 'products' })).data
      let seen = false
      for (let i = 0; i < 40 && !seen; i++) { const response = await send('GET', '/api/requests', undefined, session.cookie); seen = response.body.requests?.some(x => x.requestId === p.requestId); if (!seen) await new Promise(r => setTimeout(r, 100)) }
      assert.ok(seen, 'request must be mirrored to the phone')
      assert.equal((await send('POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: OWNER.pin }, session.cookie)).status, 200)
      return (await call('remoteAuth:claim', { panel: 'products', requestId: p.requestId, gt: p.gt })).ok
    }
    assert.equal(await approveAndClaim(), true); assert.equal(api.isPanelUnlocked('products', 42), true)

    // 6. Off: the opt-in is cleared, the grant ends and the port is closed; the
    //    boot path then stays off.
    assert.equal((await call('remoteSetup:disable', { managerPassword: 'wrong-password' })).code, 'MANAGER_PASSWORD')
    assert.equal(api.remoteHostState().running, true)
    const off = await call('remoteSetup:disable', { managerPassword: MANAGER })
    assert.equal(off.ok, true); assert.equal(off.data.running, false); assert.equal(off.data.enabled, false)
    assert.equal(setting(), '{"enabled":false}'); assert.equal(api.isPanelUnlocked('products', 42), false)
    assert.equal(await refused(port), true)
    await api.startCloudSync()
    assert.equal(api.remoteHostState().running, false); assert.equal(await refused(port), true)

    // 7. On again: the existing owner is reused (no credentials are needed).
    const on = await call('remoteSetup:enable', { managerPassword: MANAGER })
    assert.equal(on.ok, true); assert.equal(on.data.running, true, on.data.error); assert.equal(on.data.mobilePort, port)
    assert.equal((await login()).status, 200)
    await api.stopCloudSync(); assert.equal(await refused(port), true)

    // 8. Application restart (fresh modules, same files): the boot path starts
    //    the hub on the same fixed port from the persisted opt-in alone.
    handlers.clear()
    api = await load('app-2')
    api.registerRemoteSetupHandlers()
    await api.startCloudSync()
    assert.equal(api.remoteHostState().running, true, api.remoteHostState().error); assert.equal(api.cloudSyncStatus().mobilePort, port)
    assert.equal((await login()).status, 200)
    assert.equal(await approveAndClaim(), true)

    // 9. Reset: stop, clear the opt-in and retire (rename) the remote folder.
    assert.equal((await call('remoteSetup:reset', { managerPassword: 'wrong-password' })).code, 'MANAGER_PASSWORD')
    assert.equal(api.remoteHostState().running, true)
    const reset = await call('remoteSetup:reset', { managerPassword: MANAGER })
    assert.equal(reset.ok, true); assert.equal(reset.data.configured, false); assert.equal(reset.data.running, false)
    assert.equal(existsSync(join(dir, 'remote-hub')), false); assert.equal(readdirSync(dir).filter(n => n.startsWith('remote-hub-removed-')).length, 1)
    assert.equal(setting(), '{"enabled":false}'); assert.equal(await refused(port), true)

    // 10. A start that cannot listen (port taken) leaves no hub database: the
    //     page offers "complete", which bootstraps the owner once the port is free.
    occupied = createServer(); await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve))
    const blocked = await call('remoteSetup:configure', { ...valid, username: 'second.owner' })
    assert.equal(blocked.ok, true); assert.equal(blocked.data.running, false); assert.match(blocked.data.error, /Remote port in use/)
    assert.equal(blocked.data.configured, true); assert.equal(blocked.data.ownerRequired, true); assert.equal(blocked.data.enabled, true)
    assert.equal(existsSync(join(dir, 'remote-hub', 'state', 'cloud-state.lock')), false, 'no state lock is held after the failed start')
    assert.equal((await call('remoteSetup:enable', { managerPassword: MANAGER })).code, 'OWNER_REQUIRED')
    await new Promise(resolve => occupied.close(resolve)); occupied = undefined
    const completed = await call('remoteSetup:complete', { managerPassword: MANAGER, ...OWNER, username: 'second.owner' })
    assert.equal(completed.ok, true); assert.equal(completed.data.running, true, completed.data.error); assert.equal(completed.data.error, null)
    assert.equal((await send('POST', '/api/login', { username: 'second.owner', password: OWNER.password })).status, 200)
    assert.equal((await login()).status, 401, 'the retired store and its owner are gone')
    await api.stopCloudSync()
    assert.equal(await refused(port), true)
  } finally {
    if (occupied) await new Promise(resolve => occupied.close(resolve))
    try { await api?.stopCloudSync() } catch {}
    process.resourcesPath = oldResources; console.error = oldError
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__setupHost
    rmSync(dir, { recursive: true, force: true })
  }
})
