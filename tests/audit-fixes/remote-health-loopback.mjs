import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build, transform } from 'esbuild'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { fork } from 'node:child_process'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { mobileHtml, mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'

// Health of the remote link. Desktop: a hub that stops by itself after a
// successful start is reported (notification, setup status) and never left
// shown as "on". Phone: the owner's health card (data age, live link to the
// computer, approvals waiting for a revocation ACK). Electron, safeStorage, the
// manager-password check and readiness are simulated; data and keys are
// temporary. No installed Electron, Windows, tunnel, phone or real shop data.
const MANAGER = 'local-manager-test-password'
const ORIGIN = 'https://shop.example'
const OWNER = { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' }
const childEntry = fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))
// The desktop page's explain() for a host error, run on its own (the React page itself is not mounted here).
const pageExplain = async () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/renderer/src/pages/RemoteLink.tsx', import.meta.url)), 'utf8')
  const start = source.indexOf('function explain('), end = start < 0 ? -1 : source.slice(start).search(/\r?\n\}\r?\n/)
  assert.ok(start >= 0 && end > 0, 'explain() in RemoteLink.tsx')
  const { code } = await transform(source.slice(start, start + end) + '\n}\n', { loader: 'ts' })
  return vm.runInNewContext(`${code}; explain`, { REASONS: new Proxy({}, { get: (_, key) => `REASON:${String(key)}` }) })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (check, what, ms = 10000) => { const deadline = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > deadline) assert.fail(what); await sleep(25) } }
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })
function http(port, method, path, body, cookie, host = 'shop.example', origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...(method === 'POST' ? { origin, 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject); req.end(data ?? undefined)
  })
}

test('desktop: a hub that stops by itself is reported once (notification, setup status, port closed); a requested stop is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-health-host-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const db = join(dir, 'data', 'shop.db'), child = join(remote, 'remote-hub-child.cjs')
  for (const path of [remote, join(dir, 'data'), join(dir, 'backups')]) mkdirSync(path, { recursive: true })
  const client = createClient(db), seed = makeSeeder(client)
  for (const [at, action, entity] of [[1735689600000, 'SALE_CREATE', 'SaleInvoice'], [1735776000000, 'PRODUCT_UPDATE', 'Product']]) seed.insert('AuditLog', { at, action, entity })
  await client.$disconnect()
  await build({ entryPoints: [childEntry], outfile: child, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  const secret = randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } }
  const handlers = new Map(), events = new EventEmitter(), notes = []
  globalThis.__health = { app: { getPath: name => { assert.equal(name, 'userData'); return dir }, on: (name, handler) => events.on(name, handler), quit: () => {} }, safeStorage: storage,
    Notification: class { constructor(options) { this.options = options } static isSupported() { return true } show() { notes.push(this.options) } },
    ipcMain: { handle: (name, fn) => { assert.equal(handlers.has(name), false, `duplicate handler ${name}`); handlers.set(name, fn) } },
    BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
    password: async password => { if (password !== MANAGER) throw new Error('رمز مدیر درست نیست.') } }
  const channels = fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url))
  const plugin = { name: 'health-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'export const app=globalThis.__health.app,safeStorage=globalThis.__health.safeStorage,Notification=globalThis.__health.Notification,ipcMain=globalThis.__health.ipcMain,BrowserWindow=globalThis.__health.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__health.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=(p,a)=>globalThis.__health.password(p,a);"
      : `export * from ${JSON.stringify(channels)};export const remoteImplementationReady=()=>true;` }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  const quiet = ['[remote] startup unavailable', '[remote] stop after unexpected hub exit not confirmed']
  console.error = (...args) => { if (!quiet.includes(args[0])) oldError(...args) }
  let api
  try {
    const outfile = join(dir, 'app.cjs')
    await build({ stdin: { contents: "export * from './src/main/services/cloud/remoteSetupIpc.ts'; export * from './src/main/services/CloudSyncService.ts'; export {isPanelUnlocked} from './src/main/services/panelSession.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(outfile)
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }
    const sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
    const call = (channel, payload) => handlers.get(channel)({ sender, senderFrame: frame }, payload)
    const port = await freePort()
    api.registerRemoteSetupHandlers()
    const configured = await call('remoteSetup:configure', { managerPassword: MANAGER, origin: ORIGIN, port, ...OWNER })
    assert.equal(configured.ok, true, configured.error); assert.equal(configured.data.running, true, configured.data.error)

    // A requested stop (and the next start) is not reported.
    assert.equal((await call('remoteSetup:disable', { managerPassword: MANAGER })).ok, true)
    assert.equal((await call('remoteSetup:enable', { managerPassword: MANAGER })).data.running, true)
    await sleep(200)
    assert.deepEqual(notes, []); assert.equal(api.remoteHostState().error, null)

    // An open panel approved on the phone.
    const login = await http(port, 'POST', '/api/login', { username: OWNER.username, password: OWNER.password }); assert.equal(login.status, 200)
    const p = (await call('remoteAuth:request', { panel: 'products' })).data
    await until(async () => (await http(port, 'GET', '/api/requests', undefined, login.cookie)).body.requests?.some(x => x.requestId === p.requestId), 'request mirrored')
    assert.equal((await http(port, 'POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: OWNER.pin }, login.cookie)).status, 200)
    assert.equal((await call('remoteAuth:claim', { panel: 'products', requestId: p.requestId, gt: p.gt })).ok, true)
    assert.equal(api.isPanelUnlocked('products', 42), true)

    // A restore outside the app's coordinated backup path: the hub's own
    // checks fail closed and kill the child. The host must notice by itself.
    writeFileSync(join(dir, 'backups', 'last-restore.txt'), 'restored outside the app')
    await until(() => api.remoteHostState().needsRestart, 'the host reports the stopped hub', 15000)
    const state = api.remoteHostState()
    assert.equal(state.running, false); assert.equal(state.busy, false); assert.equal(state.error, 'Remote hub stopped unexpectedly')
    assert.equal(api.isPanelUnlocked('products', 42), false, 'the open panel is closed')
    assert.equal(await refused(port), true, 'the phone port is closed')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].title, 'کنترل از راه دور')
    assert.equal(notes[0].body, 'کنترل از راه دور برای ایمنی متوقف شد و دسترسی‌های راه دور بسته شدند. جزئیات در صفحهٔ «کنترل از راه دور با گوشی».')
    const shown = (await call('remoteSetup:status')).data
    assert.equal(shown.running, false); assert.equal(shown.needsRestart, true); assert.equal(shown.enabled, true); assert.equal(shown.error, 'Remote hub stopped unexpectedly')
    // The page explains this exact error in plain words, not as a failed start.
    assert.match((await pageExplain())(shown.error), /^هاب کنترل از راه دور خودبه‌خود متوقف شد .*همهٔ دسترسی‌های راه دور برای ایمنی بسته شدند\.$/)
    assert.equal((await call('remoteSetup:enable', { managerPassword: MANAGER })).code, 'RESTART')
    await api.startCloudSync(); assert.equal(api.remoteHostState().running, false)
    await sleep(300)
    assert.equal(notes.length, 1, 'reported once')
  } finally {
    try { await api?.stopCloudSync() } catch {}
    process.resourcesPath = oldResources; console.error = oldError
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__health
    // The retained state lock (unconfirmed cleanup) stays open on Windows.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
})

test('supervisor: onUnavailable fires once for a child that exits on its own; never for a requested stop or a failed start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-health-supervisor-')), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  const okChild = join(dir, 'fake-child.cjs'), failChild = join(dir, 'fake-fail.cjs')
  // Speaks only the start/stop protocol. Exits by itself once a "die" file exists.
  writeFileSync(okChild, `const {existsSync}=require('node:fs'),{join}=require('node:path')
process.on('message',m=>{
  if(m&&m.type==='start'){process.send({type:'ready',mobilePort:40001,auditPort:40002,pid:process.pid});const t=setInterval(()=>{if(existsSync(join(__dirname,'die'))){clearInterval(t);process.exit(3)}},20)}
  if(m&&m.type==='stop'){process.send({type:'stopped'});setTimeout(()=>process.exit(0),10)}
})
process.on('disconnect',()=>process.exit(0))`)
  writeFileSync(failChild, `process.on('message',m=>{if(m&&m.type==='start')process.send({type:'error',operation:'start'})})
process.on('disconnect',()=>process.exit(0))`)
  let calls = 0
  const base = { nodeExecutable: process.execPath, childFile: okChild, directory: hubDir, origin: 'https://store.example', owner: null, auditKey: Buffer.alloc(32, 7), snapshotMaxAgeMs: 5000,
    reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state: { load: () => null, save() {} },
    readRestoreMarker: async () => null, timeoutMs: 3000, startupTimeoutMs: 10000, onUnavailable: () => { calls++; throw new Error('a failing callback changes nothing') } }
  try {
    await assert.rejects(startExperimentalHubSupervisor({ ...base, onUnavailable: 'yes' }), /Invalid/)
    await assert.rejects(startExperimentalHubSupervisor({ ...base, childFile: failChild }))
    await sleep(200); assert.equal(calls, 0, 'a failed start is not reported')
    const first = await startExperimentalHubSupervisor(base)
    await first.stop(); await sleep(200); assert.equal(calls, 0, 'a requested stop is not reported')
    const second = await startExperimentalHubSupervisor(base)
    writeFileSync(join(dir, 'die'), '1')
    await until(() => calls === 1, 'the unexpected exit is reported')
    await sleep(200); assert.equal(calls, 1, 'once')
    await assert.rejects(second.stop(), /cleanup not confirmed/)
    await assert.rejects(second.refreshOnce(), /unavailable/)
    assert.equal(calls, 1)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('hub: /api/health is owner-only, validated and forwards exactly three fields; without a provider there is no route or capability', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-health-hub-')), db = new DatabaseSync(join(dir, 'hub.db'))
  const identity = createHubIdentity(db, { panels: ['custody', 'shifts', 'products'], approvalPanels: ['products'] })
  assert.equal(identity.bootstrap('owner', 'owner-test-password', '746392'), true)
  const ownerToken = identity.login('owner', 'owner-test-password').token
  for (const [role, name, acl] of [['MANAGER', 'manager', [{ panel: 'products', view: false, approve: true }]], ['VIEWER', 'viewer', [{ panel: 'custody', view: true, approve: false }]]]) {
    const invite = identity.createInvite(ownerToken, '746392', role, acl).invite
    assert.equal(identity.acceptInvite(invite, name, `${name}-test-password`, '217384'), true); assert.equal(identity.approveMember(ownerToken, '746392', name), true)
  }
  const reader = { latestBoundaryTotals: async () => null, openShiftsPage: async () => [] }
  let value = { dataAgeMs: 12000, linkAgeMs: 400, revocationPending: false }, provided = 0
  const hub = await startMobileReadOnlyHub({ origin: ORIGIN, identity, reader, health: () => { provided++; if (value instanceof Error) throw value; return value } })
  const bare = await startMobileReadOnlyHub({ origin: ORIGIN, identity, reader })
  try {
    const cookie = async (port, name) => (await http(port, 'POST', '/api/login', { username: name, password: `${name}-test-password` })).cookie
    const owner = await cookie(hub.port, 'owner'), manager = await cookie(hub.port, 'manager'), viewer = await cookie(hub.port, 'viewer')
    assert.ok(owner && manager && viewer)
    assert.deepEqual((await http(hub.port, 'GET', '/api/health', undefined, owner)), { status: 200, body: { dataAgeMs: 12000, linkAgeMs: 400, revocationPending: false }, cookie: undefined })
    assert.equal((await http(hub.port, 'GET', '/api/capabilities', undefined, owner)).body.health, true)
    for (const who of [manager, viewer]) {
      assert.equal((await http(hub.port, 'GET', '/api/health', undefined, who)).status, 403)
      assert.equal(Object.hasOwn((await http(hub.port, 'GET', '/api/capabilities', undefined, who)).body, 'health'), false)
    }
    assert.equal((await http(hub.port, 'GET', '/api/health')).status, 401)
    const calledBefore = provided
    await http(hub.port, 'GET', '/api/health', undefined, manager)
    assert.equal(provided, calledBefore, 'non-owners never reach the provider')
    // Nulls are allowed; extra fields are not forwarded.
    value = { dataAgeMs: null, linkAgeMs: null, revocationPending: true, secret: 'not for the phone' }
    assert.deepEqual((await http(hub.port, 'GET', '/api/health', undefined, owner)).body, { dataAgeMs: null, linkAgeMs: null, revocationPending: true })
    value = { dataAgeMs: 0, linkAgeMs: 2_592_000_000, revocationPending: false }
    assert.equal((await http(hub.port, 'GET', '/api/health', undefined, owner)).status, 200)
    for (const bad of [{ dataAgeMs: -1, linkAgeMs: 0, revocationPending: false }, { dataAgeMs: 1.5, linkAgeMs: 0, revocationPending: false }, { dataAgeMs: '5', linkAgeMs: 0, revocationPending: false },
      { dataAgeMs: 2_592_000_001, linkAgeMs: 0, revocationPending: false }, { linkAgeMs: 0, revocationPending: false }, { dataAgeMs: 0, linkAgeMs: Number.NaN, revocationPending: false },
      { dataAgeMs: 0, linkAgeMs: -5, revocationPending: false }, { dataAgeMs: 0, linkAgeMs: 0, revocationPending: 'false' }, { dataAgeMs: 0, linkAgeMs: 0 }, null, new Error('provider failed')]) {
      value = bad
      assert.equal((await http(hub.port, 'GET', '/api/health', undefined, owner)).status, 503, JSON.stringify(bad))
    }
    const bareOwner = await cookie(bare.port, 'owner')
    assert.equal((await http(bare.port, 'GET', '/api/health', undefined, bareOwner)).status, 404)
    assert.equal(Object.hasOwn((await http(bare.port, 'GET', '/api/capabilities', undefined, bareOwner)).body, 'health'), false)
  } finally { await hub.close(); await bare.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('child: the health view reports real ages on the child clock, keeps the data age after expiry and shows a pending revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-health-child-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  await build({ entryPoints: [childEntry], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const child = fork(childFile, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), messages = []
  child.on('message', m => messages.push(m))
  const exited = new Promise(r => child.once('exit', r))
  const reply = async (id, what) => { await until(() => messages.some(m => m.type === 'snapshot' && m.id === id), what); return messages.find(m => m.type === 'snapshot' && m.id === id) }
  try {
    child.send({ type: 'start', config: { directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: '1'.repeat(64), snapshotMaxAgeMs: 300,
      revocation: { key: '2'.repeat(64), storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', port: 9 },
      approval: { key: '3'.repeat(64), storeId: 'store_test', panels: ['products'], policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } } } })
    await until(() => messages.length > 0, 'child ready')
    assert.equal(messages[0].type, 'ready')
    const port = messages[0].mobilePort, get = (path, cookie) => http(port, 'GET', path, undefined, cookie, 'store.example', 'https://store.example')
    const cookie = (await http(port, 'POST', '/api/login', { username: 'owner', password: 'owner-test-password' }, undefined, 'store.example', 'https://store.example')).cookie
    assert.ok(cookie)
    assert.equal((await get('/api/capabilities', cookie)).body.health, true)
    assert.deepEqual((await get('/api/health', cookie)).body, { dataAgeMs: null, linkAgeMs: null, revocationPending: false })

    // A live request copy from the desktop: its age grows on the child's clock.
    child.send({ type: 'pendingRequests', seq: 1, items: [] })
    await until(async () => (await get('/api/health', cookie)).body.linkAgeMs !== null, 'link age reported')
    assert.ok((await get('/api/health', cookie)).body.linkAgeMs < 1000)
    await sleep(1100)
    assert.ok((await get('/api/health', cookie)).body.linkAgeMs >= 1000, 'an age, not a constant')

    // Dashboard data: fresh, then expired for the dashboard but still aged here.
    child.send({ type: 'beginSnapshot', id: 1, captureId: 1 }); assert.equal((await reply(1, 'capture began')).ok, true)
    child.send({ type: 'snapshot', id: 2, captureId: 1, value: { boundary: null, shifts: [] } }); assert.equal((await reply(2, 'snapshot accepted')).ok, true)
    const fresh = (await get('/api/health', cookie)).body.dataAgeMs
    assert.ok(Number.isSafeInteger(fresh) && fresh >= 0 && fresh < 300, `fresh data age ${fresh}`)
    await sleep(450)
    assert.equal((await get('/api/custody', cookie)).status, 503, 'the dashboard copy expired')
    assert.ok((await get('/api/health', cookie)).body.dataAgeMs >= 450, 'the data age is kept after expiry')
    // The older snapshot message (with its own capture time) counts as data too.
    const sent = performance.now()
    child.send({ type: 'snapshot', id: 3, capturedAtMs: Date.now(), value: { boundary: null, shifts: [] } }); assert.equal((await reply(3, 'older snapshot accepted')).ok, true)
    const renewed = (await get('/api/health', cookie)).body.dataAgeMs
    assert.ok(Number.isSafeInteger(renewed) && renewed <= performance.now() - sent + 50, `the older snapshot message renews the data age (${renewed})`)

    // P1 with no reachable desktop: the revocation stays pending.
    const close = await http(port, 'POST', '/api/panic/close', { pin: '746392' }, cookie, 'store.example', 'https://store.example')
    assert.equal(close.status, 503)
    assert.equal((await get('/api/health', cookie)).body.revocationPending, true)
    child.send({ type: 'stop' })
    await exited
  } finally { if (child.exitCode === null) child.kill(); await exited; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('phone page: the owner health card shows green, yellow and red, "unavailable" on errors, never for other roles, and starts no timer', async () => {
  assert.match(mobileHtml, /<article id="health-tools" hidden><h3>وضعیت سیستم فروشگاه<\/h3><p id="health-light"><\/p><div id="health"><\/div>/)
  assert.ok(mobileHtml.indexOf('id="health-tools"') < mobileHtml.indexOf('id="grants-tools"'))
  class Element { constructor() { this.hidden = false; this.value = ''; this.checked = false; this.children = []; this.events = {}; this._text = ''; this.className = '' } addEventListener(e, f) { this.events[e] = f } appendChild(c) { this.children.push(c) } set textContent(v) { this._text = String(v); this.children = [] } get textContent() { return this._text } fire(e) { return this.events[e]({ preventDefault() {} }) } }
  const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
  for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next', 'panic-close-tools', 'panic-tools', 'approval-acl', 'grants-tools', 'health-tools']) el(id).hidden = true
  let ownerHealth = true, role = 'OWNER', health = { status: 200, body: { dataAgeMs: 12000, linkAgeMs: 400, revocationPending: false } }, hold = null, down = false
  const calls = [], done = []
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const fetch = async (path, options = {}) => {
    calls.push(path)
    try {
      if (down) throw new TypeError('Failed to fetch')
      if (path === '/api/session') return role ? respond(200, { user: { username: role.toLowerCase(), role } }) : respond(401, { error: 'لطفاً وارد شوید' })
      if (path === '/api/capabilities') return respond(200, role === 'OWNER' && ownerHealth ? { invoices: false, health: true } : { invoices: false })
      if (path === '/api/health') { if (hold) await hold; if (health.network) throw new TypeError('Failed to fetch'); return respond(health.status, health.body) }
      if (path === '/api/logout') { role = null; return respond(200, { ok: true }) }
      if (path === '/api/login') return respond(200, { ok: true })
      if (path === '/api/custody') return respond(200, { boundary: null })
      if (path === '/api/shifts') return respond(200, { shifts: [], hasMore: false })
      if (path === '/api/members') return respond(200, { members: [] })
      return respond(404, { error: 'یافت نشد' })
    } finally { done.push(path) }
  }
  let timers = 0
  vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element(), hidden: false }, navigator: {}, fetch, console, setInterval: () => { timers++; return 1 }, clearInterval: () => {} }, { timeout: 1000 })
  const lines = () => el('health').children.map(c => c.textContent)
  const healthDone = () => done.filter(p => p === '/api/health').length
  const reload = async () => { const before = healthDone(); await el('reload').events.click(); await until(() => healthDone() > before, 'health reloaded'); await sleep(20) }
  await until(() => !el('dashboard').hidden && healthDone() > 0, 'owner dashboard with health'); await sleep(20)
  assert.equal(el('health-tools').hidden, false)
  assert.equal(el('health-light').className, 'health-ok'); assert.equal(el('health-light').textContent, '● خوب')
  assert.deepEqual(lines(), ['آخرین داده از سیستم فروشگاه: 12 ثانیه پیش', 'ارتباط زنده با سیستم فروشگاه: برقرار', 'تأیید از راه دور: آماده'])
  const show = async (body, light, text, expected) => {
    health = { status: 200, body }; await reload()
    assert.equal(el('health-light').className, light, JSON.stringify(body)); assert.equal(el('health-light').textContent, text)
    if (expected) assert.deepEqual(lines(), expected)
  }
  await show({ dataAgeMs: 44999, linkAgeMs: 2999, revocationPending: false }, 'health-ok', '● خوب')
  await show({ dataAgeMs: 45000, linkAgeMs: 400, revocationPending: false }, 'health-warn', '● با تأخیر یا در انتظار', ['آخرین داده از سیستم فروشگاه: 45 ثانیه پیش', 'ارتباط زنده با سیستم فروشگاه: برقرار', 'تأیید از راه دور: آماده'])
  await show({ dataAgeMs: 119999, linkAgeMs: 400, revocationPending: false }, 'health-warn', '● با تأخیر یا در انتظار')
  await show({ dataAgeMs: 120000, linkAgeMs: 400, revocationPending: false }, 'health-bad', '● مشکل', ['آخرین داده از سیستم فروشگاه: 2 دقیقه پیش', 'ارتباط زنده با سیستم فروشگاه: برقرار', 'تأیید از راه دور: آماده'])
  await show({ dataAgeMs: null, linkAgeMs: 400, revocationPending: false }, 'health-warn', '● با تأخیر یا در انتظار', ['داده‌های داشبورد هنوز از سیستم فروشگاه نرسیده است (حدود نیم دقیقه پس از روشن شدن هاب می‌رسد).', 'ارتباط زنده با سیستم فروشگاه: برقرار', 'تأیید از راه دور: آماده'])
  await show({ dataAgeMs: 5000, linkAgeMs: 3000, revocationPending: false }, 'health-bad', '● مشکل', ['آخرین داده از سیستم فروشگاه: 5 ثانیه پیش', 'ارتباط زنده با سیستم فروشگاه: قطع است (بیش از ۳ ثانیه بی‌خبر).', 'تأیید از راه دور: تا برقراری ارتباط زنده ممکن نیست.'])
  await show({ dataAgeMs: 5000, linkAgeMs: 400, revocationPending: true }, 'health-warn', '● با تأخیر یا در انتظار', ['آخرین داده از سیستم فروشگاه: 5 ثانیه پیش', 'ارتباط زنده با سیستم فروشگاه: برقرار', 'تأیید از راه دور: موقتاً بسته است تا بستن دسترسی‌ها روی سیستم فروشگاه تأیید شود.'])
  await show({ dataAgeMs: 5000, linkAgeMs: null, revocationPending: true }, 'health-ok', '● خوب', ['آخرین داده از سیستم فروشگاه: 5 ثانیه پیش'])
  const unavailable = ['وضعیت سیستم فروشگاه الان در دسترس نیست؛ اتصال را بررسی کنید.']
  for (const body of [{ dataAgeMs: -1, linkAgeMs: 0, revocationPending: false }, { dataAgeMs: '5', linkAgeMs: 0, revocationPending: false }, { dataAgeMs: 5, linkAgeMs: 1.5, revocationPending: false }, { dataAgeMs: 5, linkAgeMs: 0, revocationPending: 'no' }, null]) {
    await show(body, 'health-bad', '● وضعیت در دسترس نیست', unavailable)
  }
  // A failed request right after a good answer never leaves the old "good" on screen.
  for (const failure of [{ status: 503, body: { error: 'سرویس موقتاً در دسترس نیست' } }, { network: true }]) {
    await show({ dataAgeMs: 5000, linkAgeMs: 400, revocationPending: false }, 'health-ok', '● خوب')
    health = failure; await reload()
    assert.equal(el('health-light').className, 'health-bad', JSON.stringify(failure)); assert.equal(el('health-light').textContent, '● وضعیت در دسترس نیست')
    assert.deepEqual(lines(), unavailable)
  }
  // The shop computer becomes unreachable: every request fails, the capability check included.
  // The card stays and says "unavailable"; it neither disappears nor keeps the old "good".
  const refreshAll = async () => { const before = done.filter(p => p === '/api/capabilities').length; await el('reload').events.click(); await until(() => done.filter(p => p === '/api/capabilities').length > before, 'refreshed'); await sleep(20) }
  await show({ dataAgeMs: 5000, linkAgeMs: 400, revocationPending: false }, 'health-ok', '● خوب')
  down = true; await refreshAll()
  assert.equal(el('health-tools').hidden, false); assert.equal(el('health-light').className, 'health-bad'); assert.equal(el('health-light').textContent, '● وضعیت در دسترس نیست')
  assert.deepEqual(lines(), unavailable)
  down = false; await show({ dataAgeMs: 6000, linkAgeMs: 300, revocationPending: false }, 'health-ok', '● خوب', ['آخرین داده از سیستم فروشگاه: 6 ثانیه پیش', 'ارتباط زنده با سیستم فروشگاه: برقرار', 'تأیید از راه دور: آماده'])

  // An answer that arrives after logout is ignored.
  health = { status: 200, body: { dataAgeMs: 1000, linkAgeMs: 100, revocationPending: false } }
  let release; hold = new Promise(r => { release = r })
  const before = calls.filter(p => p === '/api/health').length
  void el('reload').events.click()
  await until(() => calls.filter(p => p === '/api/health').length > before, 'slow health request sent')
  await el('logout').events.click()
  await until(() => el('dashboard').hidden, 'logged out')
  assert.equal(el('health-tools').hidden, true); assert.deepEqual(lines(), []); assert.equal(el('health-light').textContent, '')
  release(); hold = null; await sleep(50)
  assert.equal(el('health-tools').hidden, true); assert.deepEqual(lines(), [])

  // A manager never sees it and never asks for it.
  role = 'MANAGER'; const asked = calls.filter(p => p === '/api/health').length, capabilities = done.filter(p => p === '/api/capabilities').length
  el('username').value = 'manager'; el('password').value = 'manager-test-password'
  await el('login-form').fire('submit')
  await until(() => !el('dashboard').hidden && done.filter(p => p === '/api/capabilities').length > capabilities, 'manager dashboard'); await sleep(50)
  assert.equal(el('health-tools').hidden, true)
  assert.equal(calls.filter(p => p === '/api/health').length, asked)
  // An owner whose hub offers no health view does not see it or ask for it either.
  await el('logout').events.click(); await until(() => el('dashboard').hidden, 'manager logged out')
  role = 'OWNER'; ownerHealth = false; const ownerCaps = done.filter(p => p === '/api/capabilities').length
  el('username').value = 'owner'; el('password').value = 'owner-test-password'
  await el('login-form').fire('submit')
  await until(() => !el('dashboard').hidden && done.filter(p => p === '/api/capabilities').length > ownerCaps, 'owner dashboard without health'); await sleep(50)
  assert.equal(el('owner-tools').hidden, false); assert.equal(el('health-tools').hidden, true)
  // Even when that hub becomes unreachable.
  down = true; await refreshAll(); down = false
  assert.equal(el('health-tools').hidden, true); assert.deepEqual(lines(), [])
  assert.equal(calls.filter(p => p === '/api/health').length, asked)
  assert.equal(timers, 0, 'the health card starts no timer')
})
