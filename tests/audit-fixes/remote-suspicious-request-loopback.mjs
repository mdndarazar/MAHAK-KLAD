import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'
import { createExperimentalRemoteCommandIssuer } from '../../src/main/services/cloud/experimentalRemoteCommandIssuer.ts'
import { requestCode, listPendingRequests, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

const childEntry = fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))
const warning = n => `هشدار درخواست مشکوک: «کالاها» در ۱۰ دقیقهٔ اخیر ${n} بار درخواست شده است. پیش از تأیید با فروشگاه تماس بگیرید و کد را با دقت مقایسه کنید.`
const until = async (check, what, ms = 8000) => { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) assert.fail(what); await new Promise(r => setTimeout(r, 20)) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const byPanel = list => [...list].sort((a, b) => a.panel.localeCompare(b.panel) || a.requestId.localeCompare(b.requestId))

// Decision 15 of the mobile design end to end: real desktop IPC request
// handler, registry, supervisor, child HTTP and the real PWA script in a
// simulated DOM. Electron and AuthService are stubbed; data and keys are
// temporary. Not a browser, phone, React or tunnel.
test('a fourth request for one panel within ten minutes is flagged on the phone; approval still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-suspicious-')), childFile = join(dir, 'hub.cjs'), parentFile = join(dir, 'parent.cjs'), hubDir = join(dir, 'hub'), handlers = new Map(); mkdirSync(hubDir)
  const plugin = { name: 'test-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const ipcMain=globalThis.__suspicious.ipcMain; export const BrowserWindow=globalThis.__suspicious.BrowserWindow;'
      : "export const readPanelLocks=async()=>({}); export const assertPanelPasswordStrict=async()=>{throw Error('not used')};" }))
  } }
  globalThis.__suspicious = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null } }
  let api, state, hub, cookie = ''
  try {
    await build({ entryPoints: [childEntry], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
    await build({ stdin: { contents: "export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'; export * from './src/main/services/panelSession.ts'; export {startExperimentalHubSupervisor} from './src/main/services/cloud/experimentalHubSupervisor.ts'; export {openCloudStateStore} from './src/main/services/cloud/cloudState.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: parentFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(parentFile)
    state = api.openCloudStateStore(join(dir, 'state'))
    state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
    api.initRemoteGrantRegistry({ notePanelUnlocked: (panel, _scope, owner, allowed) => api.noteRemotePanelUnlocked(panel, owner, allowed), clearPanelScope: api.clearPanelScope, clearPanelSessions: api.clearPanelSessions })
    api.registerRemoteAuthHandlers(undefined, ['products', 'settings'])
    const policy = { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 }
    hub = await api.startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 5000,
      revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies: { products: policy, settings: policy } } })
    const window = id => Object.assign(new EventEmitter(), { id, valid: true, isDestroyed: () => false })
    const ask = async (id, panel) => { const r = await handlers.get('remoteAuth:request')({ sender: window(id) }, { panel }); assert.equal(r.ok, true); return r.data }
    const fetch = (path, options = {}) => new Promise((resolve, reject) => {
      const headers = { host: 'store.example', ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
      if (options.method === 'POST') headers.origin = 'https://store.example'
      const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method: options.method || 'GET', headers }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const set = res.headers['set-cookie']?.[0]
          if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0]
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) })
        })
      }); req.on('error', reject); req.end(options.body)
    })
    class Element { constructor() { this.hidden = false; this.value = ''; this.checked = false; this.children = []; this.events = {}; this._text = '' } addEventListener(e, f) { this.events[e] = f } appendChild(c) { this.children.push(c) } set textContent(v) { this._text = String(v); this.children = [] } get textContent() { return this._text } fire(e) { return this.events[e]({ preventDefault() {} }) } }
    const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
    for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next', 'panic-close-tools', 'panic-tools', 'approval-acl', 'grants-tools']) el(id).hidden = true
    vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console }, { timeout: 1000 })
    const options = () => el('request-id').children.map(o => [o.value, o.textContent])
    const warnings = () => el('requests').children.map(c => c.textContent)
    const showsOnPhone = async (check, what) => { for (let i = 0; i < 60; i++) { await el('reload').events.click(); await sleep(30); if (check()) return; await sleep(100) } assert.fail(what) }

    el('username').value = 'owner'; el('password').value = 'owner-test-password'; await el('login-form').fire('submit')
    await until(() => !el('dashboard').hidden, 'owner signed in')
    // Three presses of the request button on the desktop: no warning yet.
    await ask(42, 'products'); await ask(42, 'products'); const third = await ask(42, 'products')
    await showsOnPhone(() => options().length === 1 && options()[0][0] === third.requestId, 'third request on the phone')
    assert.deepEqual(options(), [[third.requestId, `کالاها — کد ${third.code}`]]); assert.deepEqual(warnings(), [])
    // The fourth within ten minutes is flagged, on the option and as a warning line.
    const fourth = await ask(42, 'products')
    await showsOnPhone(() => options()[0]?.[0] === fourth.requestId, 'fourth request on the phone')
    assert.deepEqual(options(), [[fourth.requestId, `کالاها — کد ${fourth.code} — هشدار: 4 درخواست در ۱۰ دقیقه`]])
    assert.deepEqual(warnings(), [warning(4)])
    // Counted per panel: a first request for another panel is not flagged.
    const other = await ask(43, 'settings')
    await showsOnPhone(() => options().length === 2, 'both requests on the phone')
    assert.deepEqual(options().find(o => o[0] === other.requestId), [other.requestId, `تنظیمات — کد ${other.code}`])
    assert.deepEqual(warnings(), [warning(4)])
    const raw = await (await fetch('/api/requests')).json()
    assert.deepEqual(byPanel(raw.requests), byPanel([{ requestId: fourth.requestId, panel: 'products', code: fourth.code, recent: 4 }, { requestId: other.requestId, panel: 'settings', code: other.code }]))
    // A warning, not a block: the owner can still approve after checking.
    el('request-id').value = fourth.requestId; el('request-code').value = fourth.code; el('approval-pin').value = '746392'
    await el('approval-form').fire('submit')
    assert.match(el('message').textContent, /تأیید ثبت شد/)
    assert.equal(api.getRequestStatus(42, 'products', fourth.requestId), 'APPROVED')
  } finally {
    if (hub) await hub.stop().catch(() => {})
    if (api) { api.revokeAll(); api.clearPanelSessions(42) }
    if (state) state.close()
    delete globalThis.__suspicious
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// Real identity database, command issuer (member ACL), registry and hub HTTP in
// one process; the registry's monotonic clock is shifted to cross ten minutes.
test('the flag follows the approval ACL, counts per panel and expires after ten minutes; malformed counts are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-suspicious-acl-')), db = new DatabaseSync(join(dir, 'hub.db')), origin = 'https://shop.example'
  const identity = createHubIdentity(db, { panels: ['custody', 'shifts', 'products', 'settings'], approvalPanels: ['products', 'settings'] })
  assert.equal(identity.bootstrap('owner', 'owner-test-password', '746392'), true)
  const policy = { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 }
  const issuer = createExperimentalRemoteCommandIssuer({ key: Buffer.alloc(32, 3), storeId: 'store_1', policies: { products: policy, settings: policy }, identity, pending: listPendingRequests, send: async () => false })
  const reader = { latestBoundaryTotals: async () => null, openShiftsPage: async () => [] }
  const hub = await startMobileReadOnlyHub({ origin, identity, reader, approval: { panels: ['products', 'settings'], list: t => issuer.list(t), approve: (t, r, c, p) => issuer.approve(t, r, c, p) } })
  let fake = () => []
  const strict = await startMobileReadOnlyHub({ origin, identity, reader, approval: { panels: ['products'], list: () => fake(), approve: async () => false } })
  const send = (target, path, { method = 'GET', body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port: target.port, path, method, headers: { host: 'shop.example', ...(method === 'POST' ? { origin, 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(data ?? undefined)
  })
  const login = async (username, password) => { const r = await send(hub, '/api/login', { method: 'POST', body: { username, password } }); assert.equal(r.status, 200); return r.headers['set-cookie'][0].split(';')[0] }
  const member = async (role, acl, username, pin) => {
    const invite = await send(hub, '/api/invite/create', { method: 'POST', cookie: owner, body: { pin: '746392', role, acl } }); assert.equal(invite.status, 200)
    assert.equal((await send(hub, '/api/invite/accept', { method: 'POST', body: { invite: invite.json().invite, username, password: `${username}-test-password`, pin } })).status, 200)
    assert.equal((await send(hub, '/api/member/approve', { method: 'POST', cookie: owner, body: { username, pin: '746392' } })).status, 200)
    return await login(username, `${username}-test-password`)
  }
  const list = async cookie => { const r = await send(hub, '/api/requests', { cookie }); assert.equal(r.status, 200); return r.json().requests }
  const realNow = performance.now
  let shift = 0
  performance.now = () => realNow.call(performance) + shift
  let owner
  try {
    owner = await login('owner', 'owner-test-password')
    const manager = await member('MANAGER', [{ panel: 'products', view: false, approve: true }], 'manager', '482931')
    const viewer = await member('VIEWER', [], 'viewer', '519273')
    // Four windows each ask for the products panel: only the fourth is flagged.
    const asks = [1, 2, 3, 4].map(w => requestCode('products', w))
    const expected = asks.map((a, i) => ({ requestId: a.requestId, panel: 'products', code: a.code, ...(i === 3 ? { recent: 4 } : {}) }))
    assert.deepEqual(byPanel(await list(owner)), byPanel(expected))
    // A manager allowed to approve this panel sees the same flag; a viewer sees nothing.
    assert.deepEqual(byPanel(await list(manager)), byPanel(expected))
    assert.deepEqual(await list(viewer), [])
    // Another panel is counted separately and hidden from this manager by ACL.
    const settings = requestCode('settings', 5)
    assert.deepEqual((await list(owner)).find(r => r.panel === 'settings'), { requestId: settings.requestId, panel: 'settings', code: settings.code })
    assert.equal((await list(manager)).some(r => r.panel === 'settings'), false)
    // A fifth press from window 1 replaces its request and carries the higher count.
    const fifth = requestCode('products', 1)
    assert.deepEqual((await list(owner)).find(r => r.requestId === fifth.requestId), { requestId: fifth.requestId, panel: 'products', code: fifth.code, recent: 5 })
    // Ten minutes later the count starts again.
    shift += 10 * 60_000 + 1000
    assert.deepEqual(await list(owner), [])
    const fresh = [6, 7, 8].map(w => requestCode('products', w))
    assert.equal((await list(owner)).some(r => 'recent' in r), false)
    const again = requestCode('products', 9)
    assert.deepEqual((await list(owner)).filter(r => 'recent' in r), [{ requestId: again.requestId, panel: 'products', code: again.code, recent: 4 }])
    assert.equal(fresh.length, 3)

    // The hub refuses a malformed count as a whole (503), never passes it on.
    const item = { requestId: 'a'.repeat(32), panel: 'products', code: '123456' }
    fake = () => [{ ...item, recent: 4 }]
    assert.deepEqual((await send(strict, '/api/requests', { cookie: owner })).json(), { requests: [{ ...item, recent: 4 }] })
    for (const recent of [3, 0, -1, 1.5, '5', 1001, null]) {
      fake = () => [{ ...item, recent }]
      const r = await send(strict, '/api/requests', { cookie: owner }); assert.equal(r.status, 503, String(recent)); assert.equal(r.json().requests, undefined)
    }
    // The issuer passes a valid count through and refuses malformed ones from its source.
    const token = owner.slice(owner.indexOf('=') + 1)
    const sourced = recent => createExperimentalRemoteCommandIssuer({ key: Buffer.alloc(32, 3), storeId: 'store_1', policies: { products: policy }, identity, pending: () => [{ ...item, ownerWindowId: 1, recent }], send: async () => false }).list(token)
    assert.deepEqual(sourced(4), [{ ...item, recent: 4 }])
    for (const recent of [3, 1.5, 1001]) assert.deepEqual(sourced(recent), [])
  } finally {
    performance.now = realNow
    revokeAll()
    await hub.close(); await strict.close(); db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// The real child receives request copies only over its private IPC channel.
// A malformed count makes it ignore the whole copy.
test('child: a request copy with a malformed count is ignored as a whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-suspicious-child-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  await build({ entryPoints: [childEntry], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const child = fork(childFile, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), messages = []
  child.on('message', m => messages.push(m))
  const exited = new Promise(r => child.once('exit', r))
  let port
  const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'store.example', ...(method === 'POST' ? { origin: 'https://store.example', 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(data ?? undefined)
  })
  try {
    child.send({ type: 'start', config: { directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: '1'.repeat(64), snapshotMaxAgeMs: 5000,
      revocation: { key: '2'.repeat(64), storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', port: 9 },
      approval: { key: '3'.repeat(64), storeId: 'store_test', panels: ['products'], policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } } } })
    await until(() => messages.length > 0, 'child ready')
    assert.equal(messages[0].type, 'ready'); port = messages[0].mobilePort
    const login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    const cookie = login.headers['set-cookie'][0].split(';')[0], requests = async () => { const r = await send('GET', '/api/requests', undefined, cookie); assert.equal(r.status, 200); return r.json().requests }
    const item = (id, extra = {}) => ({ requestId: id.repeat(32), panel: 'products', code: '123456', ownerWindowId: 1, ...extra })
    child.send({ type: 'pendingRequests', seq: 1, items: [item('a', { recent: 5 })] }); await sleep(100)
    assert.deepEqual(await requests(), [{ requestId: 'a'.repeat(32), panel: 'products', code: '123456', recent: 5 }])
    let seq = 1
    for (const extra of [{ recent: 3 }, { recent: 0 }, { recent: 1.5 }, { recent: '5' }, { recent: 1001 }, { recent: null }, { recent: 5, extra: 1 }]) child.send({ type: 'pendingRequests', seq: ++seq, items: [item('b', extra)] })
    await sleep(150)
    assert.deepEqual(await requests(), [{ requestId: 'a'.repeat(32), panel: 'products', code: '123456', recent: 5 }])
    child.send({ type: 'pendingRequests', seq: 50, items: [item('c')] }); await sleep(100)
    assert.deepEqual(await requests(), [{ requestId: 'c'.repeat(32), panel: 'products', code: '123456' }])
    child.send({ type: 'stop' })
    await exited
  } finally { if (child.exitCode === null) child.kill(); await exited; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
