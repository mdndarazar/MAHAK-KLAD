import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer, connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createRemoteSetupFiles } from '../../src/main/services/cloud/remoteSetup.ts'

// "Off means no port and no connection": the implementation gate is open (as
// after the readiness lift) and remote control is fully provisioned, including
// an existing hub database, but the owner opt-in is off. Real host
// (CloudSyncService), setup IPC, registry, panelSession and child; Electron,
// safeStorage and the manager password are simulated; temporary data only.
const require = createRequire(import.meta.url)
const net = require('node:net'), http = require('node:http'), https = require('node:https'), dgram = require('node:dgram'), fs = require('node:fs'), cp = require('node:child_process')
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })
function snapshot(root) {
  const out = {}
  const walk = path => { for (const name of readdirSync(path)) { const full = join(path, name), stat = lstatSync(full); out[full] = stat.isDirectory() ? 'dir' : `${stat.size}:${stat.mtimeMs}`; if (stat.isDirectory()) walk(full) } }
  walk(root); return out
}

test('with readiness open and everything provisioned, the opt-in off opens no port, starts nothing and reads only the setting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-optin-off-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const db = join(dir, 'data', 'shop.db'), settings = join(dir, 'remote-settings.json')
  for (const path of [remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  const client = createClient(db), seed = makeSeeder(client)
  seed.insert('AuditLog', { at: 1735689600000, action: 'SALE_CREATE', entity: 'SaleInvoice' }); await client.$disconnect()
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: join(remote, 'remote-hub-child.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const port = await freePort()
  createRemoteSetupFiles(dir, { origin: 'https://shop.example', port }, storage, null)
  const handlers = new Map(), state = { queries: 0 }
  globalThis.__optOff = { app: { getPath: () => dir, on: () => {}, quit: () => {} }, safeStorage: storage, Notification: class { static isSupported() { return false } show() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { state.queries++; const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
    password: async p => { if (p !== 'local-manager-test-password') throw new Error('رمز مدیر درست نیست.') } }
  const channels = fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url))
  const plugin = { name: 'optin-off-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'export const app=globalThis.__optOff.app,safeStorage=globalThis.__optOff.safeStorage,Notification=globalThis.__optOff.Notification,ipcMain=globalThis.__optOff.ipcMain,BrowserWindow=globalThis.__optOff.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__optOff.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=p=>globalThis.__optOff.password(p);"
      : `export * from ${JSON.stringify(channels)};export const remoteImplementationReady=()=>true;` }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  console.error = (...args) => { if (args[0] !== '[remote] startup unavailable') oldError(...args) }
  let api
  // Each bundle has its own module state, like a separate application start.
  const load = async name => {
    const outfile = join(dir, `${name}.cjs`)
    await build({ stdin: { contents: "export * from './src/main/services/cloud/remoteSetupIpc.ts'; export * from './src/main/services/CloudSyncService.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    handlers.clear(); const loaded = require(outfile); loaded.registerRemoteSetupHandlers(); return loaded
  }
  try {
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }
    const sender = Object.assign(new EventEmitter(), { id: 7, valid: true, mainFrame: frame, isDestroyed: () => false })
    const status = async () => { const r = await handlers.get('remoteSetup:status')({ sender, senderFrame: frame }); assert.equal(r.ok, true); return r.data }

    // Positive control on a first application start: the same files do open
    // the port when on; this run also creates the owner (hub database).
    api = await load('app-0')
    writeFileSync(settings, '{"enabled":true}')
    await api.startCloudSync({ owner: { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' } })
    assert.equal(api.cloudSyncStatus().running, true, api.remoteHostState().error); assert.equal(await refused(port), false)
    await api.stopCloudSync(); assert.equal(await refused(port), true)
    assert.equal(lstatSync(join(dir, 'remote-hub', 'hub', 'remote-hub.sqlite')).isFile(), true, 'fully provisioned, owner exists')

    // A fresh application start with the opt-in off.
    api = await load('app-1')

    const offVariants = [['absent', null], ['false', '{"enabled":false}'], ['malformed', '{"enabled":tru'], ['string', '{"enabled":"true"}'], ['extra key', '{"enabled":true,"x":1}'], ['directory', 'DIR']]
    for (const [label, content] of offVariants) {
      rmSync(settings, { recursive: true, force: true })
      if (content === 'DIR') mkdirSync(settings); else if (content !== null) writeFileSync(settings, content)
      const before = snapshot(dir), queriesBefore = state.queries, handlerCount = handlers.size
      const hits = [], touched = []
      const trap = name => () => { hits.push(name); throw new Error(`unexpected ${name}`) }
      const record = (name, original) => function (path, ...rest) { touched.push(String(path)); return original.call(this, path, ...rest) }
      const original = { listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect, request: http.request, httpsRequest: https.request, createSocket: dgram.createSocket, fetch: globalThis.fetch,
        fork: cp.fork, spawn: cp.spawn, execFile: cp.execFile, write: fs.writeFileSync, mkdir: fs.mkdirSync, rename: fs.renameSync, unlink: fs.unlinkSync, open: fs.openSync, promisesWrite: fs.promises.writeFile,
        timeout: globalThis.setTimeout, interval: globalThis.setInterval, lstat: fs.lstatSync, stat: fs.statSync, read: fs.readFileSync, exists: fs.existsSync, readdir: fs.readdirSync, realpath: fs.realpathSync }
      try {
        net.Server.prototype.listen = trap('listen'); net.Socket.prototype.connect = trap('connect'); http.request = trap('http'); https.request = trap('https')
        dgram.createSocket = trap('udp'); globalThis.fetch = trap('fetch'); cp.fork = trap('fork'); cp.spawn = trap('spawn'); cp.execFile = trap('execFile')
        fs.writeFileSync = trap('write'); fs.mkdirSync = trap('mkdir'); fs.renameSync = trap('rename'); fs.unlinkSync = trap('unlink'); fs.promises.writeFile = trap('promises.writeFile')
        fs.openSync = function (path, flags = 'r', ...rest) { if (typeof flags !== 'string' || flags !== 'r') return trap(`open ${flags}`)(); return original.open.call(this, path, flags, ...rest) }
        globalThis.setTimeout = trap('timeout'); globalThis.setInterval = trap('interval')
        fs.lstatSync = record('lstat', original.lstat); fs.statSync = record('stat', original.stat); fs.readFileSync = record('read', original.read)
        fs.existsSync = record('exists', original.exists); fs.readdirSync = record('readdir', original.readdir); fs.realpathSync = record('realpath', original.realpath)
        await api.startCloudSync(); await api.startCloudSync()
        assert.deepEqual(api.cloudSyncStatus(), { running: false, mobilePort: null }, label)
        assert.deepEqual([...new Set(touched)].filter(path => path !== settings), [], `${label}: only the setting may be read`)
        const page = await status()
        assert.equal(page.enabled, false, label); assert.equal(page.running, false, label); assert.equal(page.configured, true, label)
      } finally {
        net.Server.prototype.listen = original.listen; net.Socket.prototype.connect = original.connect; http.request = original.request; https.request = original.httpsRequest
        dgram.createSocket = original.createSocket; globalThis.fetch = original.fetch; cp.fork = original.fork; cp.spawn = original.spawn; cp.execFile = original.execFile
        fs.writeFileSync = original.write; fs.mkdirSync = original.mkdir; fs.renameSync = original.rename; fs.unlinkSync = original.unlink; fs.openSync = original.open; fs.promises.writeFile = original.promisesWrite
        globalThis.setTimeout = original.timeout; globalThis.setInterval = original.interval
        fs.lstatSync = original.lstat; fs.statSync = original.stat; fs.readFileSync = original.read; fs.existsSync = original.exists; fs.readdirSync = original.readdir; fs.realpathSync = original.realpath
      }
      assert.deepEqual(hits, [], `${label}: no listener, connection, process, timer or write`)
      assert.equal(state.queries, queriesBefore, `${label}: the shop database is not read`)
      assert.equal(handlers.size, handlerCount, `${label}: no new IPC`)
      assert.deepEqual([...handlers.keys()].filter(name => name.startsWith('remoteAuth:')), [], `${label}: no grant IPC`)
      assert.deepEqual(snapshot(dir), before, `${label}: application data unchanged`)
      assert.equal(await refused(port), true, `${label}: the configured port is closed`)
    }

    // Positive control again after all off variants.
    rmSync(settings, { recursive: true, force: true }); writeFileSync(settings, '{"enabled":true}')
    await api.startCloudSync()
    assert.equal(api.cloudSyncStatus().running, true, api.remoteHostState().error); assert.equal(api.cloudSyncStatus().mobilePort, port)
    assert.equal(handlers.has('remoteAuth:request'), true, 'grant IPC exists once the hub has run')
    await api.stopCloudSync(); assert.equal(await refused(port), true)

    // Turned off after running in the same process: the grant IPC that stays
    // registered is inert (admission closed), and nothing restarts.
    writeFileSync(settings, '{"enabled":false}')
    await api.startCloudSync()
    assert.deepEqual(api.cloudSyncStatus(), { running: false, mobilePort: null }); assert.equal(await refused(port), true)
    await assert.rejects(handlers.get('remoteAuth:request')({ sender, senderFrame: frame }, { panel: 'products' }), /Remote admission closed/)
    assert.equal((await handlers.get('remoteAuth:recover')({ sender, senderFrame: frame }, { password: 'local-manager-test-password', pin: '582614' })).ok, false)
    assert.equal((await handlers.get('remoteAuth:claim')({ sender, senderFrame: frame }, { panel: 'products', requestId: 'x', gt: `gt-${'A'.repeat(43)}` })).ok, false)
  } finally {
    try { await api?.stopCloudSync() } catch {}
    process.resourcesPath = oldResources; console.error = oldError
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__optOff
    rmSync(dir, { recursive: true, force: true })
  }
})
