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
import { mobileHtml, mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'

const NONE = 'الان هیچ پنلی با تأیید گوشی باز نیست.'
const UNAVAILABLE = 'وضعیت مجوزهای باز الان در دسترس نیست؛ اتصال سیستم فروشگاه را بررسی کنید.'
const secondsOf = text => { const m = /(\d+):(\d\d) دیگر بسته می‌شود\.$/.exec(text); assert.ok(m, text); return Number(m[1]) * 60 + Number(m[2]) }
const until = async (check, what, ms = 8000) => { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) assert.fail(what); await new Promise(r => setTimeout(r, 20)) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Decision 14 of the mobile design (live view of open grants) and the desktop
// banner, end to end: the real desktop IPC handlers (request, claim, banner),
// registry, panelSession, supervisor, child HTTP and the real PWA script in a
// simulated DOM with simulated timers. Electron and AuthService are stubbed;
// databases and keys are temporary. Not a browser, phone, React or tunnel.
test('owner phone shows open grants live, desktop banner agrees, a stale copy is "unavailable" (never "none"), close-all empties it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-live-grants-')), childFile = join(dir, 'hub.cjs'), parentFile = join(dir, 'parent.cjs'), hubDir = join(dir, 'hub'), handlers = new Map(); mkdirSync(hubDir)
  const plugin = { name: 'test-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const ipcMain=globalThis.__liveGrants.ipcMain; export const BrowserWindow=globalThis.__liveGrants.BrowserWindow;'
      : "export const readPanelLocks=async()=>({}); export const assertPanelPasswordStrict=async()=>{throw Error('not used')};" }))
  } }
  globalThis.__liveGrants = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null } }
  let api, state, hub, cookie = '', hang = null, release = () => {}
  try {
    await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
    await build({ stdin: { contents: "export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'; export * from './src/main/services/panelSession.ts'; export {startExperimentalHubSupervisor} from './src/main/services/cloud/experimentalHubSupervisor.ts'; export {openCloudStateStore} from './src/main/services/cloud/cloudState.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: parentFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(parentFile)
    state = api.openCloudStateStore(join(dir, 'state'))
    state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
    api.initRemoteGrantRegistry({ notePanelUnlocked: (panel, _scope, owner, allowed) => api.noteRemotePanelUnlocked(panel, owner, allowed), clearPanelScope: api.clearPanelScope, clearPanelSessions: api.clearPanelSessions })
    api.registerRemoteAuthHandlers(undefined, ['products'])
    hub = await api.startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => { if (hang) await hang; return null }, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 5000,
      revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } } })
    const window = id => Object.assign(new EventEmitter(), { id, valid: true, isDestroyed: () => false }), desk = window(42)
    const call = (channel, sender, payload) => handlers.get(channel)({ sender }, payload)
    const banner = async (sender, payload) => { const r = await call('remoteAuth:banner', sender, payload); assert.equal(r.ok, true); return r.data }

    const calls = [], done = []
    const fetch = (path, options = {}) => new Promise((resolve, reject) => {
      calls.push(path)
      const headers = { host: 'store.example', ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
      if (options.method === 'POST') headers.origin = 'https://store.example'
      const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method: options.method || 'GET', headers }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const set = res.headers['set-cookie']?.[0]
          if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0]
          done.push(path)
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) })
        })
      }); req.on('error', reject); req.end(options.body)
    })
    class Element { constructor() { this.hidden = false; this.value = ''; this.checked = false; this.children = []; this.events = {}; this._text = '' } addEventListener(e, f) { this.events[e] = f } appendChild(c) { this.children.push(c) } set textContent(v) { this._text = String(v); this.children = [] } get textContent() { return this._text } fire(e) { return this.events[e]({ preventDefault() {} }) } }
    const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
    for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next', 'panic-close-tools', 'panic-tools', 'approval-acl', 'grants-tools']) el(id).hidden = true
    assert.match(mobileHtml, /<article id="grants-tools" hidden><h3>مجوزهای باز الان<\/h3>/)
    assert.ok(mobileHtml.indexOf('id="grants-tools"') < mobileHtml.indexOf('id="panic-close-tools"'))
    // The page's 1 s timer is simulated so countdown and polling are driven here.
    let liveTick = null, intervals = 0, cleared = 0
    const setInterval = (fn, ms) => { assert.equal(ms, 1000); intervals++; liveTick = fn; return 7 }
    const clearInterval = id => { assert.equal(id, 7); cleared++; liveTick = null }
    vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console, setInterval, clearInterval }, { timeout: 1000 })
    const texts = () => el('grants').children.map(c => c.textContent)
    const count = list => list.filter(p => p === '/api/grants').length
    // Every fifth tick asks the hub again; a poll waits for its own answer.
    const poll = async () => {
      await until(() => count(calls) === count(done), 'no live-view request in flight')
      const before = count(done); for (let i = 0; i < 5; i++) liveTick()
      await until(() => count(done) > before, 'live view polled'); await sleep(30)
    }

    // The owner signs in: the live view is shown at once, empty.
    el('username').value = 'owner'; el('password').value = 'owner-test-password'; await el('login-form').fire('submit')
    await until(() => !el('dashboard').hidden && !el('grants-tools').hidden && count(done) > 0, 'owner live view shown')
    await sleep(30)
    assert.deepEqual(texts(), [NONE]); assert.equal(intervals, 1)

    // A seller requests the products panel on the desktop; the owner approves it on the phone.
    const asked = (await call('remoteAuth:request', desk, { panel: 'products' })).data
    for (let i = 0; i < 40 && el('request-id').children.length === 0; i++) { await el('reload').events.click(); if (!el('request-id').children.length) await sleep(100) }
    assert.equal(el('request-id').children[0]?.value, asked.requestId)
    assert.equal(intervals, 1, 'a reload must not start a second timer')
    el('request-id').value = asked.requestId; el('request-code').value = asked.code; el('approval-pin').value = '746392'
    await el('approval-form').fire('submit')
    assert.match(el('message').textContent, /تأیید ثبت شد/)
    // Approved but not yet opened at the desk: the phone shows the claim deadline; no desktop banner yet.
    // The desktop refreshes the hub's copy every 0.5 s, so wait for one refresh.
    await sleep(700); await poll()
    assert.equal(texts().length, 1)
    assert.match(texts()[0], /^کالاها — تأیید شده ولی هنوز روی سیستم فروشگاه باز نشده؛ (2:5\d|3:00) دیگر بسته می‌شود\.$/)
    assert.deepEqual(await banner(desk, { panel: 'products' }), { active: false })

    // The desk opens the panel through the real claim IPC.
    assert.deepEqual(await call('remoteAuth:claim', desk, { panel: 'products', requestId: asked.requestId, gt: asked.gt }), { ok: true, data: { scope: 'PANEL' } })
    assert.equal(api.isPanelUnlocked('products', 42), true)
    const shown = await banner(desk, { panel: 'products' })
    // 10-minute grant, 3-minute idle limit: the idle deadline applies until the panel is used.
    assert.equal(shown.active, true); assert.ok(shown.seconds >= 175 && shown.seconds <= 180, String(shown.seconds))
    // Only this window and this panel; a status read for anything else is inactive.
    assert.deepEqual(await banner(window(43), { panel: 'products' }), { active: false })
    assert.deepEqual(await banner(desk, { panel: 'settings' }), { active: false })
    assert.deepEqual(await banner(desk, {}), { active: false })
    assert.deepEqual(await banner(desk, { panel: 7 }), { active: false })
    await assert.rejects(call('remoteAuth:banner', Object.assign(new EventEmitter(), { id: 44, valid: false, isDestroyed: () => false }), { panel: 'products' }), /Invalid remote request owner/)
    await sleep(700); await poll()
    assert.equal(texts().length, 1)
    assert.match(texts()[0], /^کالاها — باز روی سیستم فروشگاه؛ اگر استفاده نشود (2:5\d|3:00) دیگر بسته می‌شود\.$/)
    // The countdown runs on the phone between polls.
    const first = secondsOf(texts()[0])
    await sleep(1100); await until(() => count(calls) === count(done), 'idle'); liveTick(); await until(() => count(calls) === count(done), 'idle'); await sleep(30)
    assert.ok(secondsOf(texts()[0]) < first, texts()[0])
    // Reading the live view and the banner never extends the grant's idle time.
    assert.ok((await banner(desk, { panel: 'products' })).seconds < shown.seconds)

    // While the desktop cannot vouch for its state (a long foreground read),
    // the phone says "unavailable", never "nothing is open".
    hang = new Promise(r => { release = r })
    const refreshing = hub.refreshOnce()
    await sleep(3300)
    await poll()
    assert.deepEqual(texts(), [UNAVAILABLE])
    const raw = await fetch('/api/grants'); assert.equal(raw.status, 503)
    hang = null; release(); await refreshing
    await sleep(700); await poll()
    assert.match(texts()[0] ?? '', /^کالاها — باز روی سیستم فروشگاه؛/)
    assert.equal(api.isGrantActiveForWindow('products', 42), true)

    // "Close all" (P1, owner PIN) empties the list at once; the desktop panel and banner close.
    el('panic-close-pin').value = '746392'
    await el('panic-close-form').fire('submit')
    assert.equal(el('message').textContent, 'مجوزها و درخواست‌های باز بسته شدند.')
    assert.deepEqual(texts(), [NONE])
    assert.equal(api.isGrantActiveForWindow('products', 42), false); assert.equal(api.isPanelUnlocked('products', 42), false)
    assert.deepEqual(await banner(desk, { panel: 'products' }), { active: false })
    await sleep(700); await poll()
    assert.deepEqual(texts(), [NONE])

    // Signing out stops the timer and hides the view.
    await el('logout').events.click()
    assert.equal(el('grants-tools').hidden, true); assert.deepEqual(texts(), []); assert.equal(cleared, 1); assert.equal(liveTick, null)
  } finally {
    release()
    if (hub) await hub.stop().catch(() => {})
    if (api) { api.revokeAll(); api.clearPanelSessions(42) }
    if (state) state.close()
    delete globalThis.__liveGrants
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// The hub's HTTP boundary with a real identity database: OWNER only, exact
// fields, and anything the desktop cannot vouch for is 503, not an empty list.
test('hub: only the owner sees open grants; stale or malformed data is 503; extra fields are dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-live-grants-hub-')), db = new DatabaseSync(join(dir, 'hub.db')), origin = 'https://shop.example'
  const identity = createHubIdentity(db, { panels: ['custody', 'shifts', 'products'], approvalPanels: ['products'] })
  assert.equal(identity.bootstrap('owner', 'owner-test-password', '746392'), true)
  const reader = { latestBoundaryTotals: async () => null, openShiftsPage: async () => [] }
  let current = () => [{ panel: 'products', claimed: true, remainingMs: 42000, ownerWindowId: 7, requestId: 'a'.repeat(32) }]
  const live = await startMobileReadOnlyHub({ origin, identity, reader, approval: { panels: ['products'], list: () => [], grants: () => current(), approve: async () => false } })
  const plain = await startMobileReadOnlyHub({ origin, identity, reader, approval: { panels: ['products'], list: () => [], approve: async () => false } })
  const send = (hub, path, { method = 'GET', body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port: hub.port, path, method, headers: { host: 'shop.example', ...(method === 'POST' ? { origin, 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(data ?? undefined)
  })
  const login = async (username, password) => { const r = await send(live, '/api/login', { method: 'POST', body: { username, password } }); assert.equal(r.status, 200); return r.headers['set-cookie'][0].split(';')[0] }
  try {
    const owner = await login('owner', 'owner-test-password')
    assert.equal((await send(live, '/api/capabilities', { cookie: owner })).json().grants, true)
    assert.equal((await send(plain, '/api/capabilities', { cookie: owner })).json().grants, undefined)
    const ok = await send(live, '/api/grants', { cookie: owner })
    assert.equal(ok.status, 200); assert.equal(ok.headers['cache-control'], 'no-store')
    assert.deepEqual(ok.json(), { grants: [{ panel: 'products', claimed: true, remainingMs: 42000 }] })
    assert.equal((await send(live, '/api/grants')).status, 401)
    assert.equal((await send(plain, '/api/grants', { cookie: owner })).status, 404)

    // A manager allowed to approve this very panel still cannot see the live view.
    const invite = await send(live, '/api/invite/create', { method: 'POST', cookie: owner, body: { pin: '746392', role: 'MANAGER', acl: [{ panel: 'products', view: false, approve: true }] } })
    assert.equal(invite.status, 200)
    assert.equal((await send(live, '/api/invite/accept', { method: 'POST', body: { invite: invite.json().invite, username: 'manager', password: 'manager-test-password', pin: '482931' } })).status, 200)
    assert.equal((await send(live, '/api/member/approve', { method: 'POST', cookie: owner, body: { username: 'manager', pin: '746392' } })).status, 200)
    const manager = await login('manager', 'manager-test-password')
    assert.deepEqual((await send(live, '/api/capabilities', { cookie: manager })).json(), { invoices: false })
    assert.equal((await send(live, '/api/grants', { cookie: manager })).status, 403)

    const item = { panel: 'products', claimed: true, remainingMs: 5 }
    for (const bad of [() => { throw new Error('Grant mirror stale') }, () => 'x', () => Array(201).fill(item), () => [null],
      () => [{ ...item, remainingMs: 0 }], () => [{ ...item, remainingMs: 1.5 }], () => [{ ...item, remainingMs: 86_400_001 }],
      () => [{ ...item, panel: 'bad panel' }], () => [{ ...item, claimed: 'yes' }]]) {
      current = bad
      const res = await send(live, '/api/grants', { cookie: owner })
      assert.equal(res.status, 503); assert.equal(res.json().grants, undefined)
    }
    current = () => []
    assert.deepEqual((await send(live, '/api/grants', { cookie: owner })).json(), { grants: [] })
  } finally { await live.close(); await plain.close(); db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// Real renderer banner monitor bundled with simulated IPC and timer; this does
// not mount React or exercise Electron.
test('desktop banner monitor: off while the hub is off, status only, fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-banner-monitor-')), outfile = join(dir, 'box.cjs')
  const plugin = { name: 'fake-banner-dependencies', setup(b) {
    b.onResolve({ filter: /^@shared\/remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/lib\/api$/ }, () => ({ path: 'api', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'channels'
      ? 'export const remoteImplementationReady=()=>globalThis.__banner.ready;export const REMOTE_AUTH_CHANNELS={};'
      : 'export const CH={};export const call=(...a)=>globalThis.__banner.call(...a);' }))
  } }
  const original = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  let tick, cleared = 0
  const calls = [], replies = { 'remoteSetup:status': async () => ({ running: false }), 'remoteAuth:banner': async () => ({ active: false }) }
  globalThis.__banner = { ready: false, call: async (channel, payload) => { calls.push(payload === undefined ? channel : [channel, payload]); return await replies[channel]() } }
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 1000); tick = fn; return 9 }; globalThis.clearInterval = id => { assert.equal(id, 9); cleared++ }
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
  try {
    await build({ entryPoints: ['src/renderer/src/components/RemoteRequestBox.tsx'], outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [plugin], logLevel: 'silent' })
    const { startRemoteBannerMonitor } = createRequire(import.meta.url)(outfile)
    const seen = []
    startRemoteBannerMonitor('products', s => seen.push(s))(); assert.equal(tick, undefined); assert.deepEqual(calls, [])
    globalThis.__banner.ready = true
    // Hub off: only the setup status is read, once per 5 s; the grant channel is never called.
    let stop = startRemoteBannerMonitor('products', s => seen.push(s)); await flush()
    for (let i = 0; i < 4; i++) { tick(); await flush() }
    assert.deepEqual(calls, ['remoteSetup:status']); assert.deepEqual(seen, [null, null, null, null, null])
    // Hub on (seen at the next status read): the banner shows this panel's seconds.
    replies['remoteSetup:status'] = async () => ({ running: true }); replies['remoteAuth:banner'] = async () => ({ active: true, seconds: 125 })
    tick(); await flush()
    assert.deepEqual(calls.slice(1), ['remoteSetup:status', ['remoteAuth:banner', { panel: 'products' }]]); assert.equal(seen.at(-1), 125)
    tick(); await flush(); assert.equal(calls.length, 4); assert.equal(seen.at(-1), 125)
    // Malformed replies and errors hide the banner; an error also re-checks the hub status first.
    for (const reply of [{ active: true, seconds: -1 }, { active: true, seconds: 1.5 }, { active: 'yes', seconds: 5 }, { active: true }, null]) {
      replies['remoteAuth:banner'] = async () => reply; tick(); await flush(); assert.equal(seen.at(-1), null)
    }
    replies['remoteAuth:banner'] = async () => { throw new Error('ipc failed') }; tick(); await flush(); assert.equal(seen.at(-1), null)
    const afterError = calls.length; tick(); await flush(); assert.equal(calls.length, afterError, 'no grant call before the hub status is read again')
    stop(); assert.equal(cleared, 1)
    // A late reply after stop is ignored.
    let resolveLate; replies['remoteSetup:status'] = () => new Promise(r => { resolveLate = r })
    const before = seen.length; stop = startRemoteBannerMonitor('products', s => seen.push(s)); stop(); resolveLate({ running: true }); await flush()
    assert.equal(seen.length, before); assert.equal(cleared, 2)
  } finally { globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval; delete globalThis.__banner; rmSync(dir, { recursive: true, force: true }) }
})

// The real child process receives the desktop's copy only over its private
// IPC channel. Anything malformed or out of order is ignored (the previous copy
// stays and then ages out); time left is reduced by the copy's age.
test('child: malformed or out-of-order open-grant messages are ignored; the copy ages and expires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-live-grants-child-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const child = fork(childFile, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), messages = []
  child.on('message', m => messages.push(m))
  const exited = new Promise(r => child.once('exit', r))
  const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'store.example', ...(method === 'POST' ? { origin: 'https://store.example', 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(data ?? undefined)
  })
  let port
  try {
    child.send({ type: 'start', config: { directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: '1'.repeat(64), snapshotMaxAgeMs: 5000,
      revocation: { key: '2'.repeat(64), storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', port: 9 },
      approval: { key: '3'.repeat(64), storeId: 'store_test', panels: ['products', 'settings'], policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 }, settings: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } } } })
    await until(() => messages.length > 0, 'child ready')
    assert.equal(messages[0].type, 'ready'); port = messages[0].mobilePort
    const login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    const cookie = login.headers['set-cookie'][0].split(';')[0], grants = () => send('GET', '/api/grants', undefined, cookie)
    // No copy from the desktop yet: unavailable.
    assert.equal((await grants()).status, 503)
    const item = { panel: 'products', claimed: true, remainingMs: 90000 }
    child.send({ type: 'openGrants', seq: 1, items: [item] }); const sentAt = Date.now()
    await sleep(100)
    // Every malformed or out-of-order message below is ignored as a whole.
    const bad = { panel: 'settings', claimed: false, remainingMs: 5000 }
    for (const message of [
      { type: 'openGrants', seq: 2, items: [{ ...bad, requestId: 'a'.repeat(32) }] },
      { type: 'openGrants', seq: 3, items: [{ panel: 'settings', claimed: false }] },
      { type: 'openGrants', seq: 4, items: [{ ...bad, claimed: 'no' }] },
      { type: 'openGrants', seq: 5, items: [{ ...bad, remainingMs: 0 }] },
      { type: 'openGrants', seq: 6, items: [{ ...bad, remainingMs: 1.5 }] },
      { type: 'openGrants', seq: 7, items: [{ ...bad, remainingMs: 86_400_001 }] },
      { type: 'openGrants', seq: 8, items: [{ ...bad, panel: 'a b' }] },
      { type: 'openGrants', seq: 9, items: Array(201).fill(bad) },
      { type: 'openGrants', seq: 10, items: 'none' },
      { type: 'openGrants', seq: 11, items: [], extra: 1 },
      { type: 'openGrants', seq: 0, items: [] },
      { type: 'openGrants', seq: 1, items: [] }
    ]) child.send(message)
    await sleep(1000)
    const aged = await grants()
    assert.equal(aged.status, 200)
    const [only, ...rest] = aged.json().grants
    assert.deepEqual(rest, []); assert.equal(only.panel, 'products'); assert.equal(only.claimed, true)
    // Time left is reduced by the copy's age (about one second here).
    assert.ok(only.remainingMs <= 90000 - (Date.now() - sentAt) + 50 && only.remainingMs > 80000, String(only.remainingMs))
    // A newer valid copy replaces it; an older one after that is ignored.
    child.send({ type: 'openGrants', seq: 100, items: [] }); await sleep(100)
    assert.deepEqual((await grants()).json(), { grants: [] })
    child.send({ type: 'openGrants', seq: 50, items: [item] }); await sleep(100)
    assert.deepEqual((await grants()).json(), { grants: [] })
    // Without fresh copies the view becomes unavailable, not empty.
    await sleep(3000)
    assert.equal((await grants()).status, 503)
    child.send({ type: 'stop' })
    await exited
  } finally { if (child.exitCode === null) child.kill(); await exited; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
