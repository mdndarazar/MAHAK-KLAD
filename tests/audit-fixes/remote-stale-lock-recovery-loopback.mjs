import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, lstatSync, linkSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'

// Stage 12: stale cloud-state.lock / remote-hub.lock after an unclean end
// (crash, power loss, Windows shutdown with the app open, or a quit after an
// unconfirmed hub stop). Real setup IPC, desktop host (CloudSyncService),
// supervisor, forked hub child and HTTP on a temporary shop database. The
// "crashed" desktop runs in a separate helper process that is killed; on
// Windows the kill also ends its hub child (kill-on-close job), elsewhere the
// child removes its own lock on IPC disconnect, so the test then rewrites the
// pre-crash token to reproduce the power-loss state. Electron (including the
// single-instance lock), safeStorage and the manager-password check are
// simulated; no installed Electron, DPAPI, Windows desktop, tunnel, phone or
// real shop data is involved.
const MANAGER = 'local-manager-test-password'
const ORIGIN = 'https://shop.example'
const OWNER = { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' }
const RECOVERED = '[remote] stale locks from an unclean shutdown removed'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hex = () => randomBytes(32).toString('hex')
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })
const until = async (check, label, ms = 15000) => {
  const end = Date.now() + ms
  while (!(await check())) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(50) }
}
// Type, link count and content of a path (null when absent): a refused
// recovery must leave every lock exactly as it was.
const describe = path => {
  let s
  try { s = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  return { type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', nlink: s.nlink, content: s.isFile() ? readFileSync(path, 'utf8') : null }
}

const ctx = {}
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-remote-stale-lock-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const db = join(dir, 'data', 'shop.db')
  for (const path of [remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  const client = createClient(db), seed = makeSeeder(client)
  for (const [at, action, entity] of [[1735689600000, 'SALE_CREATE', 'SaleInvoice'], [1735776000000, 'PRODUCT_UPDATE', 'Product']]) seed.insert('AuditLog', { at, action, entity })
  await client.$disconnect()
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: join(remote, 'remote-hub-child.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const handlers = new Map(), app = { getPath: name => { assert.equal(name, 'userData'); return dir }, on: () => {}, quit: () => {} }
  globalThis.__staleLockHost = { app, safeStorage: storage,
    Notification: class { static isSupported() { return true } show() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
    password: async password => { if (password !== MANAGER) throw new Error('رمز مدیر درست نیست.') } }
  const channels = fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url))
  const plugin = { name: 'stale-lock-host-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'const h=globalThis.__staleLockHost;export const app=h.app,safeStorage=h.safeStorage,Notification=h.Notification,ipcMain=h.ipcMain,BrowserWindow=h.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__staleLockHost.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=(p)=>globalThis.__staleLockHost.password(p);"
      : `export * from ${JSON.stringify(channels)};export const remoteImplementationReady=()=>true;` }))
  } }
  const bundle = async name => {
    const outfile = join(dir, `${name}.cjs`)
    await build({ stdin: { contents: "export * from './src/main/services/cloud/remoteSetupIpc.ts'; export * from './src/main/services/CloudSyncService.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    return outfile
  }
  ctx.old = { resources: process.resourcesPath, url: process.env.DATABASE_URL, error: console.error, warn: console.warn }
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  ctx.warnings = []; ctx.startErrors = []
  console.error = (...args) => { if (args[0] === '[remote] startup unavailable') ctx.startErrors.push(String(args[1]?.message ?? args[1])); else ctx.old.error(...args) }
  console.warn = (...args) => { if (args[0] === RECOVERED) ctx.warnings.push(args[0]); else ctx.old.warn(...args) }
  const port = await freePort()
  Object.assign(ctx, { dir, db, port, app, handlers, secret, resources, bundle,
    load: async name => createRequire(import.meta.url)(await bundle(name)),
    stateLock: join(dir, 'remote-hub', 'state', 'cloud-state.lock'), hubLock: join(dir, 'remote-hub', 'hub', 'remote-hub.lock'),
    config: join(dir, 'remote-hub', 'config.json'), stateFile: join(dir, 'remote-hub', 'state', 'cloud-state.json'), helpers: [] })
  ctx.send = (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'shop.example', origin: ORIGIN, 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', reject); req.end(data)
  })
  ctx.login = () => ctx.send('POST', '/api/login', { username: OWNER.username, password: OWNER.password })
  ctx.identity = () => { const s = JSON.parse(readFileSync(ctx.stateFile, 'utf8')); return { storeId: s.storeId, epoch: s.epoch } }
  ctx.single = value => { if (value === undefined) delete app.hasSingleInstanceLock; else app.hasSingleInstanceLock = value }
  ctx.attempt = async api => { await api.startCloudSync(); return api.remoteHostState() }

  // Owner setup through the real setup IPC, then a requested stop: no lock left.
  const setup = await ctx.load('app-setup')
  setup.registerRemoteSetupHandlers()
  const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }, sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
  const configured = await handlers.get('remoteSetup:configure')({ sender, senderFrame: frame }, { managerPassword: MANAGER, origin: ORIGIN, port, ...OWNER })
  assert.equal(configured.ok, true, configured.error); assert.equal(configured.data.running, true, configured.data.error)
  assert.equal((await ctx.login()).status, 200)
  await setup.stopCloudSync()
  assert.equal(await refused(port), true)
  assert.equal(describe(ctx.stateLock), null); assert.equal(describe(ctx.hubLock), null)
  ctx.configBytes = readFileSync(ctx.config)

  // The "desktop" of an earlier run in its own process (killed to simulate the
  // crash). It prints its host state on every change.
  ctx.helperBundle = await bundle('helper-host')
  ctx.helperFile = join(dir, 'helper-desktop.cjs')
  writeFileSync(ctx.helperFile, `
const { DatabaseSync } = require('node:sqlite')
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const cfg = JSON.parse(process.env.MAHAK_STALE_LOCK_HELPER), secret = Buffer.from(cfg.secret, 'hex')
process.resourcesPath = cfg.resources; process.env.DATABASE_URL = 'file:' + cfg.db
globalThis.__staleLockHost = {
  app: { getPath: () => cfg.dir, on: () => {}, quit: () => {}, hasSingleInstanceLock: () => true },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } },
  Notification: class { static isSupported() { return true } show() {} }, ipcMain: { handle: () => {} }, BrowserWindow: { fromWebContents: () => null },
  query: async (sql, ...values) => { const h = new DatabaseSync(cfg.db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
  password: async () => { throw new Error('not used') } }
console.error = () => {}
const api = require(cfg.bundle)
let last = ''
const report = () => { const s = JSON.stringify(api.remoteHostState()); if (s !== last) { last = s; process.stdout.write('STATE ' + s + '\\n') } }
api.startCloudSync().finally(() => { report(); setInterval(report, 50) })
`)
  ctx.spawnDesktop = () => {
    const env = { ...process.env, MAHAK_STALE_LOCK_HELPER: JSON.stringify({ dir, db, resources, secret: secret.toString('hex'), bundle: ctx.helperBundle }) }
    const child = spawn(process.execPath, [ctx.helperFile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const desktop = { child, state: null, stderr: '' }
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) { const line = buffer.slice(0, i); if (line.startsWith('STATE ')) desktop.state = JSON.parse(line.slice(6)) }
    })
    child.stderr.on('data', chunk => { desktop.stderr = (desktop.stderr + chunk).slice(-4000) })
    desktop.waitFor = (check, label, ms = 60000) => until(() => { if (child.exitCode !== null) throw new Error(`desktop exited early: ${desktop.stderr}`); return desktop.state && check(desktop.state) }, label, ms)
    desktop.kill = async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited } }
    ctx.helpers.push(desktop)
    return desktop
  }
})

after(async () => {
  for (const desktop of ctx.helpers ?? []) await desktop.kill().catch(() => {})
  for (const api of ctx.apis ?? []) { try { await api.stopCloudSync() } catch {} }
  process.resourcesPath = ctx.old.resources; console.error = ctx.old.error; console.warn = ctx.old.warn
  if (ctx.old.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = ctx.old.url
  delete globalThis.__staleLockHost
  for (let i = 0; i < 20; i++) { try { rmSync(ctx.dir, { recursive: true, force: true }); break } catch { await sleep(250) } }
})

test('crash with the app open: a running hub keeps its locks; afterwards only the single-instance holder recovers both, with a free port', async t => {
  const { port, stateLock, hubLock } = ctx
  const before = ctx.identity()
  const desktop = ctx.spawnDesktop()
  await desktop.waitFor(s => s.running === true || s.error !== null, 'earlier desktop started')
  assert.equal(desktop.state.running, true, desktop.state.error)
  const tokens = { state: describe(stateLock)?.content, hub: describe(hubLock)?.content }
  assert.match(tokens.state, /^[0-9a-f]{64}$/); assert.match(tokens.hub, /^[0-9a-f]{64}$/)
  assert.equal((await ctx.login()).status, 200)

  // A second desktop module while that hub runs (even claiming the single-
  // instance lock): the busy port is reported and no lock is touched.
  const api = await ctx.load('app-after-crash'); ctx.apis = [api]
  ctx.single(() => true)
  let state = await ctx.attempt(api)
  assert.equal(state.running, false); assert.equal(state.error, 'Remote port in use')
  assert.deepEqual({ state: describe(stateLock)?.content, hub: describe(hubLock)?.content }, tokens, 'a running hub keeps both locks')
  assert.equal((await ctx.login()).status, 200, 'the running hub still serves')

  // The crash: the earlier desktop is killed without any cleanup.
  await desktop.kill()
  await until(() => refused(port), 'hub port closed after the crash')
  if (process.platform !== 'win32') await until(() => describe(hubLock) === null, 'orphaned child exits on IPC disconnect').catch(() => {})
  await sleep(500)
  const childCleaned = describe(hubLock) === null
  t.diagnostic(`hub child removed its own lock before exiting: ${childCleaned} (${process.platform})`)
  if (childCleaned) writeFileSync(hubLock, tokens.hub, { flag: 'wx', mode: 0o600 })
  assert.deepEqual({ state: describe(stateLock), hub: describe(hubLock) }, { state: { type: 'file', nlink: 1, content: tokens.state }, hub: { type: 'file', nlink: 1, content: tokens.hub } })

  // Without the single-instance lock (absent, false, or merely truthy) the
  // earlier behaviour stays: blocked, both locks untouched.
  for (const value of [undefined, () => false, () => 1]) {
    ctx.single(value)
    state = await ctx.attempt(api)
    assert.equal(state.running, false); assert.equal(state.error, 'Remote hub lock present')
    assert.deepEqual({ state: describe(stateLock)?.content, hub: describe(hubLock)?.content }, tokens)
  }
  assert.deepEqual(ctx.warnings, [])

  // Single-instance holder, free port, both locks plain 64-hex files: removed,
  // the hub starts with fresh locks and the same store identity and epoch.
  ctx.single(() => true)
  state = await ctx.attempt(api)
  assert.equal(state.running, true, state.error); assert.equal(state.error, null); assert.equal(api.cloudSyncStatus().mobilePort, port)
  assert.deepEqual(ctx.warnings, [RECOVERED])
  const fresh = { state: describe(stateLock)?.content, hub: describe(hubLock)?.content }
  assert.match(fresh.state, /^[0-9a-f]{64}$/); assert.match(fresh.hub, /^[0-9a-f]{64}$/)
  assert.notEqual(fresh.state, tokens.state); assert.notEqual(fresh.hub, tokens.hub)
  assert.deepEqual(ctx.identity(), before)
  assert.equal((await ctx.login()).status, 200, 'the owner and hub database survived the crash')

  // A requested stop still removes both locks.
  await api.stopCloudSync()
  assert.equal(await refused(port), true)
  assert.equal(describe(stateLock), null); assert.equal(describe(hubLock), null)
})

test('unexpected hub stop keeps the state lock; the restart recovers it only with the single-instance lock', async () => {
  const { port, stateLock, hubLock } = ctx
  const before = ctx.identity()
  const desktop = ctx.spawnDesktop()
  await desktop.waitFor(s => s.running === true || s.error !== null, 'desktop started')
  assert.equal(desktop.state.running, true, desktop.state.error)
  // A restore outside the coordinated backup path (as in the stage-11 test):
  // the hub fails closed and the host asks for an application restart.
  writeFileSync(join(ctx.dir, 'backups', 'last-restore.txt'), 'restored outside the app')
  await desktop.waitFor(s => s.needsRestart === true, 'desktop reports the stopped hub', 20000)
  assert.equal(desktop.state.running, false); assert.equal(desktop.state.error, 'Remote hub stopped unexpectedly')
  assert.equal(await refused(port), true)
  const retained = describe(stateLock)
  assert.equal(retained?.type, 'file'); assert.match(retained.content, /^[0-9a-f]{64}$/)
  assert.equal(describe(hubLock), null, 'the supervisor removed the exited child lock')
  // The user closes the application: the unconfirmed state is never closed.
  await desktop.kill()
  assert.deepEqual(describe(stateLock), retained)

  const api = await ctx.load('app-restart'); ctx.apis.push(api)
  const warned = ctx.warnings.length
  ctx.single(undefined)
  let state = await ctx.attempt(api)
  assert.equal(state.running, false); assert.match(state.error, /EEXIST/, 'before stage 12 the restart stayed blocked')
  assert.deepEqual(describe(stateLock), retained)

  ctx.single(() => true)
  state = await ctx.attempt(api)
  assert.equal(state.running, true, state.error); assert.equal(state.error, null)
  assert.equal(ctx.warnings.length, warned + 1)
  assert.notEqual(describe(stateLock)?.content, retained.content)
  const after = ctx.identity()
  assert.equal(after.storeId, before.storeId); assert.notEqual(after.epoch, before.epoch, 'the outside restore still starts a new epoch')
  assert.equal((await ctx.login()).status, 200)
  await api.stopCloudSync()
  assert.equal(await refused(port), true)
  assert.equal(describe(stateLock), null); assert.equal(describe(hubLock), null)
})

test('fail closed: wrong content, hard link, directory, symlink, busy port, no fixed port or one bad lock keep every lock', async t => {
  const { port, stateLock, hubLock, dir } = ctx
  const api = ctx.apis.at(-1)
  ctx.single(() => true)
  const warned = ctx.warnings.length
  const target = join(dir, 'token-target'), linkName = 'l'.repeat(64), linkTarget = join(dir, 'remote-hub', 'hub', linkName)
  const clean = () => {
    for (const path of [stateLock, hubLock, target, linkTarget]) {
      const d = describe(path)
      if (d?.type === 'dir') rmdirSync(path); else if (d) unlinkSync(path)
    }
    writeFileSync(ctx.config, ctx.configBytes)
  }
  let symlinks = true
  try { writeFileSync(linkTarget, hex()); symlinkSync(linkName, hubLock, 'file'); clean() } catch (error) { symlinks = false; t.diagnostic(`symlink case skipped: ${error.code}`); clean() }
  const cases = [
    ['hub lock with 63 hex', () => writeFileSync(hubLock, hex().slice(1)), 'Remote hub lock present'],
    ['hub lock with uppercase hex', () => writeFileSync(hubLock, hex().toUpperCase()), 'Remote hub lock present'],
    ['hub lock with a trailing newline', () => writeFileSync(hubLock, `${hex()}\n`), 'Remote hub lock present'],
    ['empty state lock (power loss while it was created)', () => writeFileSync(stateLock, ''), /EEXIST/],
    ['valid state lock with a bad hub lock', () => { writeFileSync(stateLock, hex()); writeFileSync(hubLock, hex().slice(2)) }, 'Remote hub lock present'],
    ['hub lock that is a second hard link', () => { writeFileSync(target, hex()); linkSync(target, hubLock) }, 'Remote hub lock present'],
    ['hub lock that is a directory', () => mkdirSync(hubLock), 'Remote hub lock present'],
    ...(symlinks ? [['hub lock that is a symlink (64-byte target name)', () => { writeFileSync(linkTarget, hex()); symlinkSync(linkName, hubLock, 'file') }, 'Remote hub lock present']] : []),
    ['valid locks with the port taken', () => { writeFileSync(stateLock, hex()); writeFileSync(hubLock, hex()) }, 'Remote port in use', true],
    ['valid locks without a fixed port (older configuration)', () => { writeFileSync(stateLock, hex()); writeFileSync(hubLock, hex()); writeFileSync(ctx.config, JSON.stringify({ version: 1, origin: ORIGIN })) }, 'Remote hub lock present']
  ]
  for (const [name, make, error, occupy] of cases) {
    clean(); make()
    const files = [stateLock, hubLock, target, linkTarget].map(describe)
    let occupied
    if (occupy) { occupied = createServer(); await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve)) }
    try {
      const state = await ctx.attempt(api)
      assert.equal(state.running, false, name)
      if (typeof error === 'string') assert.equal(state.error, error, name); else assert.match(state.error, error, name)
      assert.deepEqual([stateLock, hubLock, target, linkTarget].map(describe), files, `${name}: nothing removed`)
    } finally { if (occupied) await new Promise(resolve => occupied.close(resolve)) }
  }
  assert.equal(ctx.warnings.length, warned, 'no refused case reports a recovery')

  // A lone stale hub lock (child killed, desktop closed normally) is recovered.
  clean(); writeFileSync(hubLock, hex(), { mode: 0o600 })
  const state = await ctx.attempt(api)
  assert.equal(state.running, true, state.error); assert.equal(ctx.warnings.length, warned + 1)
  assert.equal((await ctx.login()).status, 200)
  await api.stopCloudSync()
  assert.equal(describe(stateLock), null); assert.equal(describe(hubLock), null); assert.equal(await refused(port), true)
  clean()
})

test('index.ts: the single-instance lock is taken before ready; a second instance runs nothing and only focuses a live window', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)), 'utf8')
  assert.equal(source.split('requestSingleInstanceLock').length, 2, 'exactly one lock request')
  const lock = source.search(/\r?\nif \(!app\.requestSingleInstanceLock\(\)\) app\.quit\(\)/)
  const ready = source.indexOf('app.whenReady().then(async () => {')
  assert.ok(lock > 0 && ready > lock, 'top-level lock request before the ready handler')
  // Electron emits ready even after app.quit(): the handler itself must return
  // before the database, schedulers, remote host or window are touched.
  assert.match(source, /app\.whenReady\(\)\.then\(async \(\) => \{\r?\n  if \(!app\.hasSingleInstanceLock\(\)\) return\b/)
  assert.match(source, /\r?\nelse app\.on\('second-instance', \(\) => \{ if \(mainWindow && !mainWindow\.isDestroyed\(\)\) \{ if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\); mainWindow\.focus\(\) \} \}\)\r?\n/)
  const body = source.slice(ready)
  assert.ok(body.indexOf('hasSingleInstanceLock') < body.indexOf('prepareDatabase()') && body.indexOf('prepareDatabase()') < body.indexOf('startCloudSync()'))
})
