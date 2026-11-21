import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request, createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'

// The phone's service worker, served by the real hub over loopback HTTP, runs
// in a vm context standing in for the browser's worker scope. Its network
// calls go over real HTTP to the hub, to a fake tunnel answering with gateway
// errors, or to a closed port. Storage APIs are traps that record any access.
// A real browser, phone, tunnel and HTTPS are not involved.
const ORIGIN = 'https://shop.example'
const reader = { latestBoundaryTotals: async () => null, openShiftsPage: async () => ({ items: [], nextCursor: null }) }
const OFFLINE_TEXT = 'اتصال به سیستم فروشگاه برقرار نیست'

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: 'shop.example', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject); req.end()
  })
}

/** Loads the worker into a fresh scope; `target()` decides where its fetch goes. */
function loadWorker(source, target) {
  const handlers = new Map(), touched = [], fetched = []
  const trap = name => ({ get() { touched.push(name); throw new Error(`${name} is not allowed in the worker`) } })
  const scope = {
    location: new URL(`${ORIGIN}/mobile-sw.js`), clients: { claim: async () => {} }, skipWaiting: () => {},
    addEventListener: (type, fn) => { assert.equal(handlers.has(type), false, `duplicate ${type} handler`); handlers.set(type, fn) },
    Response, URL, Promise, Error, TypeError,
    fetch: async req => {
      fetched.push(req.url)
      const url = new URL(req.url), port = target()
      if (port === null) throw new TypeError('Failed to fetch')
      try {
        const r = await httpGet(port, url.pathname + url.search)
        return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: Object.entries(r.headers).filter(([k]) => k !== 'content-length' && k !== 'transfer-encoding' && k !== 'connection') })
      } catch { throw new TypeError('Failed to fetch') }
    }
  }
  for (const name of ['caches', 'indexedDB', 'localStorage', 'sessionStorage', 'cookieStore']) Object.defineProperty(scope, name, trap(name))
  scope.self = scope
  vm.runInNewContext(source, scope, { filename: 'mobile-sw.js' })
  /** Dispatches a fetch event; resolves to the response given to respondWith, or null if not intercepted. */
  const dispatch = async (path, { mode = 'navigate', method = 'GET', origin = ORIGIN } = {}) => {
    let responded = null
    const event = { request: { url: `${origin}${path}`, mode, method }, respondWith: p => { assert.equal(responded, null, 'respondWith called twice'); responded = Promise.resolve(p) } }
    handlers.get('fetch')(event)
    return responded === null ? null : await responded
  }
  return { handlers, dispatch, touched, fetched }
}

test('service worker: real pages pass through; an unreachable shop computer or tunnel gateway error shows the built-in Persian page; nothing is stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-pwa-offline-')), db = new DatabaseSync(join(dir, 'hub.db'))
  const identity = createHubIdentity(db, { panels: ['custody', 'shifts'], approvalPanels: [] })
  assert.equal(identity.bootstrap('owner', 'owner-test-password', '746392'), true)
  let hub = await startMobileReadOnlyHub({ origin: ORIGIN, identity, reader })
  let gatewayStatus = 502
  const tunnel = createServer((req, res) => { res.writeHead(gatewayStatus, { 'content-type': 'text/html' }); res.end(`<h1>tunnel error ${gatewayStatus}</h1>`) })
  await new Promise(r => tunnel.listen(0, '127.0.0.1', r))
  try {
    const served = await httpGet(hub.port, '/mobile-sw.js')
    assert.equal(served.status, 200); assert.match(served.headers['content-type'], /^application\/javascript/)
    const source = served.body.toString('utf8')
    assert.ok(!source.includes('caches.') && !source.includes('/api/'), 'the existing storage guard still holds')
    let target = () => hub.port
    const worker = loadWorker(source, () => target())
    assert.deepEqual([...worker.handlers.keys()].sort(), ['activate', 'fetch', 'install'])

    // Hub reachable: the real page is passed through unchanged.
    const page = await worker.dispatch('/')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /<!doctype html>/i); assert.ok(!html.includes(OFFLINE_TEXT))
    assert.equal(page.headers.get('cache-control'), 'no-store')
    // A wrong-host hub answer (421) is not hidden behind the offline page.
    // Only the worker decides here, so its fetch is pointed at a fake 421.
    gatewayStatus = 421; target = () => tunnel.address().port
    assert.equal((await worker.dispatch('/')).status, 421)

    // Data requests, assets, other paths, other origins and non-GET are never intercepted.
    target = () => null
    const before = worker.fetched.length
    for (const [path, options] of [['/api/session', { mode: 'cors' }], ['/api/snapshot', { mode: 'same-origin' }], ['/mobile.js', { mode: 'no-cors' }],
      ['/mobile.css', { mode: 'no-cors' }], ['/api/session', {}], ['/manifest.webmanifest', {}], ['/?x=1#y', { origin: 'https://evil.example' }], ['/', { method: 'POST' }], ['/', { mode: 'cors' }]]) {
      assert.equal(await worker.dispatch(path, options), null, `${options.origin ?? ''}${path} ${JSON.stringify(options)} must not be intercepted`)
    }
    assert.equal(worker.fetched.length, before, 'the worker made no request for them')

    const expectOffline = async (why, path = '/') => {
      const r = await worker.dispatch(path)
      assert.ok(r, `${why}: intercepted`)
      assert.equal(r.status, 503, why)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.match(r.headers.get('content-type'), /^text\/html/)
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'/)
      const body = await r.text()
      assert.ok(body.includes(OFFLINE_TEXT), why); assert.ok(body.includes('هیچ داده‌ای روی این گوشی ذخیره نمی‌شود'))
      assert.ok(body.includes('<a href="/">'), 'retry link'); assert.ok(!/<script/i.test(body), 'no script in the built-in page')
    }
    // Hub stopped (shop app closed or remote turned off): connection refused.
    target = () => hub.port
    await hub.close()
    await expectOffline('hub stopped')
    await expectOffline('query string on the app page', '/?from=homescreen')
    // No network at all.
    target = () => null
    await expectOffline('no network')
    // Tunnel up, shop computer unreachable: gateway and origin errors.
    target = () => tunnel.address().port
    for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) { gatewayStatus = status; await expectOffline(`tunnel ${status}`) }
    // Other statuses are shown as they are.
    for (const status of [400, 401, 403, 404, 405, 421, 429, 500, 501, 505, 519, 531]) {
      gatewayStatus = status
      const r = await worker.dispatch('/')
      assert.equal(r.status, status); assert.equal(await r.text(), `<h1>tunnel error ${status}</h1>`)
    }
    // Hub back: the real page again, from the network (nothing was cached).
    hub = await startMobileReadOnlyHub({ origin: ORIGIN, identity, reader })
    target = () => hub.port
    const back = await worker.dispatch('/')
    assert.equal(back.status, 200); assert.ok(!(await back.text()).includes(OFFLINE_TEXT))
    assert.deepEqual(worker.touched, [], 'no storage API was touched')
  } finally {
    await new Promise(r => tunnel.close(r))
    try { await hub.close() } catch {}
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('service worker: install and activate only take control; the scope is the hub origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-pwa-offline-sw-')), db = new DatabaseSync(join(dir, 'hub.db'))
  const identity = createHubIdentity(db, { panels: ['custody', 'shifts'], approvalPanels: [] })
  const hub = await startMobileReadOnlyHub({ origin: ORIGIN, identity, reader })
  try {
    const source = (await httpGet(hub.port, '/mobile-sw.js')).body.toString('utf8')
    const worker = loadWorker(source, () => null)
    let skipped = 0, claimed = 0, waited = null
    const scopeEvents = { skipWaiting: () => { skipped++ }, claim: async () => { claimed++ } }
    // Re-run with counting hooks: install calls skipWaiting, activate waits for clients.claim.
    const handlers = new Map()
    const scope = { location: new URL(`${ORIGIN}/mobile-sw.js`), clients: { claim: scopeEvents.claim }, skipWaiting: scopeEvents.skipWaiting, addEventListener: (t, f) => handlers.set(t, f), Response, URL, fetch: async () => { throw new TypeError('offline') } }
    scope.self = scope
    vm.runInNewContext(source, scope)
    handlers.get('install')({ waitUntil: p => { waited = p } })
    assert.equal(skipped, 1)
    handlers.get('activate')({ waitUntil: p => { waited = p } })
    await waited; assert.equal(claimed, 1)
    assert.deepEqual(worker.touched, [])
    // The page registers the worker at the root scope (unchanged registration).
    const js = (await httpGet(hub.port, '/mobile.js')).body.toString('utf8')
    assert.ok(js.includes("navigator.serviceWorker.register('/mobile-sw.js')"))
  } finally { await hub.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
