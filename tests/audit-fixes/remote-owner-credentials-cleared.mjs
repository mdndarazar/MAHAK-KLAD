import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'

// The owner's phone credentials are needed only by the hub's first start
// message. The desktop host must not keep them in the supervisor options for
// the hub's lifetime, after a successful start or a failed one. Real setup
// IPC, host, supervisor, child/HTTP and a temporary shop database; Electron,
// safeStorage and the manager-password check are simulated. JavaScript strings
// cannot be wiped, so this checks only that the reference is dropped.
const MANAGER = 'local-manager-test-password', ORIGIN = 'https://shop.example'
const OWNER = { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' }
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

test('the supervisor options drop the owner credentials once the first start has been sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-owner-cleared-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const db = join(dir, 'data', 'shop.db'), child = join(remote, 'remote-hub-child.cjs')
  for (const path of [remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  await createClient(db).$disconnect()
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: child, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const handlers = new Map(), seen = []
  globalThis.__ownerCleared = { seen, app: { getPath: () => dir, on: () => {}, quit: () => {} }, safeStorage: storage,
    Notification: class { static isSupported() { return false } show() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
    password: async password => { if (password !== MANAGER) throw new Error('رمز مدیر درست نیست.') } }
  const channels = fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url))
  const supervisor = fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubSupervisor.ts', import.meta.url))
  const plugin = { name: 'owner-cleared-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    // Records the options object the host hands to the real supervisor and a
    // copy of the owner taken at call time.
    b.onResolve({ filter: /^\.\/cloud\/experimentalHubSupervisor$/ }, () => ({ path: 'supervisor', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'export const app=globalThis.__ownerCleared.app,safeStorage=globalThis.__ownerCleared.safeStorage,Notification=globalThis.__ownerCleared.Notification,ipcMain=globalThis.__ownerCleared.ipcMain,BrowserWindow=globalThis.__ownerCleared.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__ownerCleared.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=(p,a)=>globalThis.__ownerCleared.password(p,a);"
      : args.path === 'supervisor' ? `import { startExperimentalHubSupervisor as real } from ${JSON.stringify(supervisor)};export async function startExperimentalHubSupervisor(options){globalThis.__ownerCleared.seen.push({options,owner:options.owner ? {...options.owner} : null});return await real(options)}`
      : `export * from ${JSON.stringify(channels)};export const remoteImplementationReady=()=>true;` }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  console.error = (...args) => { if (args[0] !== '[remote] startup unavailable') oldError(...args) }
  let api, occupied
  try {
    const outfile = join(dir, 'app.cjs')
    await build({ stdin: { contents: "export * from './src/main/services/cloud/remoteSetupIpc.ts'; export * from './src/main/services/CloudSyncService.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(outfile)
    api.registerRemoteSetupHandlers()
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }
    const sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
    const call = (channel, payload) => handlers.get(channel)({ sender, senderFrame: frame }, payload)
    const port = await freePort()
    const login = username => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ username, password: OWNER.password }))
      const req = request({ hostname: '127.0.0.1', port, path: '/api/login', method: 'POST', headers: { host: 'shop.example', origin: ORIGIN, 'x-mahak-request': '1', 'content-type': 'application/json', 'content-length': data.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject); req.end(data)
    })

    // 1. A successful first start bootstraps the owner, then the reference is gone.
    const started = await call('remoteSetup:configure', { managerPassword: MANAGER, origin: ORIGIN, port, ...OWNER })
    assert.equal(started.ok, true); assert.equal(started.data.running, true, started.data.error)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].owner, OWNER, 'the first start message received the credentials')
    assert.equal(seen[0].options.owner, null, 'no owner credentials remain in the running supervisor options')
    assert.equal(await login(OWNER.username), 200, 'the owner was bootstrapped from them')
    assert.equal(api.remoteHostState().running, true)

    // 2. An ordinary restart (the hub database exists) never carries credentials.
    await api.stopCloudSync()
    const enabled = await call('remoteSetup:enable', { managerPassword: MANAGER })
    assert.equal(enabled.ok, true); assert.equal(enabled.data.running, true, enabled.data.error)
    assert.equal(seen.length, 2); assert.equal(seen[1].owner, null); assert.equal(seen[1].options.owner, null)
    assert.equal(await login(OWNER.username), 200)

    // 3. A taken port is refused before the supervisor is reached: no credentials are passed.
    assert.equal((await call('remoteSetup:reset', { managerPassword: MANAGER })).ok, true)
    occupied = createServer(); await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve))
    const taken = await call('remoteSetup:configure', { managerPassword: MANAGER, origin: ORIGIN, port, ...OWNER, username: 'second.owner' })
    assert.equal(taken.ok, true); assert.equal(taken.data.running, false); assert.match(taken.data.error, /Remote port in use/)
    assert.equal(seen.length, 2)
    await new Promise(resolve => occupied.close(resolve)); occupied = undefined

    // 4. A first start that fails inside the supervisor (the child exits at
    //    once) drops them as well. The host then stays closed until the app
    //    restarts (existing fail-closed rule for an uncertain shutdown).
    writeFileSync(child, 'process.exit(3)\n')
    const failed = await call('remoteSetup:complete', { managerPassword: MANAGER, ...OWNER, username: 'second.owner' })
    assert.equal(failed.ok, true); assert.equal(failed.data.running, false)
    assert.equal(seen.length, 3)
    assert.deepEqual(seen[2].owner, { ...OWNER, username: 'second.owner' })
    assert.equal(seen[2].options.owner, null, 'no owner credentials remain after a failed start')
    assert.equal(api.remoteHostState().needsRestart, true)
  } finally {
    if (occupied) await new Promise(resolve => occupied.close(resolve))
    try { await api?.stopCloudSync() } catch {}
    process.resourcesPath = oldResources; console.error = oldError
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__ownerCleared
    // The failed start keeps its state lock open until the app restarts (by
    // design), so Windows cannot remove that file while this process runs.
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { if (process.platform !== 'win32') throw error }
  }
})
