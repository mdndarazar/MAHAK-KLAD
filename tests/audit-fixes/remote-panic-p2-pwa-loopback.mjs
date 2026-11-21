import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mobileHtml, mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry, requestCode, createGrant, consumeOneShot, isGrantActiveForWindow, getRequestStatus, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Owner's phone path end to end: the real PWA script (simulated DOM) approves a
// desktop request, then triggers the full Panic (P2) from its own button. Real
// child HTTP, supervisor, desktop registry, panelSession and manager-password
// gate; temporary databases and keys. Not a browser, phone, Electron or tunnel.
test('PWA approval, then the PWA P2 button closes the panel, latches login and is recovered only at the desktop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-pwa-p2-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop-isolated.db')
  const session = await import('../../src/main/services/panelSession.ts')
  const { assertManagerPassword } = await import('../../src/main/services/AuthService.ts')
  const { prisma } = await import('../../src/main/db/client.ts')
  const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const state = openCloudStateStore(join(dir, 'state'))
  state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  initRemoteGrantRegistry({ notePanelUnlocked: session.notePanelUnlocked, clearPanelScope: session.clearPanelScope, clearPanelSessions: session.clearPanelSessions })
  const notices = []
  let hub, cookie = ''
  try {
    hub = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 5000,
      verifyLocalRecoveryPassword: password => assertManagerPassword(password, 'بازیابی توقف اضطراری'),
      revocation: { key: Buffer.alloc(32, 2), onRevocation: entry => { notices.push(entry.kind); return undefined } },
      approval: { key: Buffer.alloc(32, 3), policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 } } } })
    const calls = []
    const fetch = (path, options = {}) => new Promise((resolve, reject) => {
      calls.push(path)
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
    for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next', 'panic-close-tools', 'panic-tools', 'approval-acl']) el(id).hidden = true
    assert.match(mobileHtml, /id="panic-tools" hidden/); assert.match(mobileHtml, /id="panic-confirm" type="checkbox"/)
    assert.match(mobileHtml, /پس از «توقف اضطراری کامل»، ورود با گوشی تا بازیابی پشت سیستم فروشگاه ممکن نیست/)
    vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console }, { timeout: 1000 })
    const until = async (check, what) => { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) assert.fail(what); await new Promise(r => setTimeout(r, 25)) } }
    const login = async () => { el('username').value = 'owner'; el('password').value = 'owner-test-password'; await el('login-form').fire('submit') }

    // Owner signs in on the phone; the full Panic button is shown to the owner only.
    await login()
    await until(() => !el('dashboard').hidden && !el('panic-tools').hidden, 'owner dashboard with P2 button')
    assert.equal(el('panic-close-tools').hidden, false)

    // A desktop request appears on the phone under its Persian title and is approved there.
    const asked = requestCode('products', 42)
    await until(() => (calls.includes('/api/requests')), 'requests loaded')
    for (let i = 0; i < 40 && el('request-id').children.length === 0; i++) { await el('reload').events.click(); if (!el('request-id').children.length) await new Promise(r => setTimeout(r, 100)) }
    assert.equal(el('request-id').children.length, 1)
    assert.equal(el('request-id').children[0].value, asked.requestId)
    assert.equal(el('request-id').children[0].textContent, `کالاها — کد ${asked.code}`)
    el('request-id').value = asked.requestId; el('request-code').value = asked.code; el('approval-pin').value = '746392'
    await el('approval-form').fire('submit')
    assert.match(el('message').textContent, /تأیید ثبت شد/)
    assert.equal(getRequestStatus(42, 'products', asked.requestId), 'APPROVED')
    assert.equal(consumeOneShot(42, 'products', asked.gt.slice(3)), true)
    assert.equal(isGrantActiveForWindow('products', 42), true); assert.equal(session.isPanelUnlocked('products', 42), true)
    const pending = requestCode('products', 43)

    // Without the confirmation tick nothing is sent.
    el('panic-pin').value = '746392'
    await el('panic-form').fire('submit')
    assert.match(el('message').textContent, /گزینهٔ تأیید را علامت بزنید/); assert.equal(calls.includes('/api/panic'), false)
    // A wrong PIN is refused: the owner stays signed in and the panel stays open.
    el('panic-pin').value = '000000'; el('panic-confirm').checked = true
    await el('panic-form').fire('submit')
    assert.equal(calls.includes('/api/panic'), true)
    assert.match(el('message').textContent, /توقف اضطراری تأیید نشد/)
    assert.equal(el('dashboard').hidden, false); assert.equal(el('panic-pin').value, ''); assert.equal(el('panic-confirm').checked, false)
    assert.equal(isGrantActiveForWindow('products', 42), true); assert.equal(session.isPanelUnlocked('products', 42), true)
    assert.deepEqual(notices, [])
    // The real P2: desktop panel and pending request closed, acknowledged, desktop notified, phone signed out.
    el('panic-pin').value = '746392'; el('panic-confirm').checked = true
    await el('panic-form').fire('submit')
    assert.equal(isGrantActiveForWindow('products', 42), false); assert.equal(session.isPanelUnlocked('products', 42), false)
    assert.equal(getRequestStatus(43, 'products', pending.requestId), 'UNAVAILABLE')
    assert.equal(state.openRevocationLedger().load().id, 1)
    assert.deepEqual(notices, ['ALL'])
    assert.equal(el('dashboard').hidden, true); assert.equal(el('login').hidden, false); assert.equal(el('panic-tools').hidden, true)
    assert.match(el('message').textContent, /توقف اضطراری کامل ثبت شد/); assert.match(el('message').textContent, /بازیابی توقف اضطراری راه دور/)
    assert.equal(cookie, '')

    // The latch survives on the hub: signing in again is refused and nothing new can be approved.
    await login()
    assert.equal(el('dashboard').hidden, true); assert.match(el('message').textContent, /معتبر نیست/)
    // Recovery happens only at the desktop, with the real manager password and the owner PIN.
    assert.equal(await hub.recoverPanic('wrong-manager-password', '746392'), false)
    assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD, '000000'), false)
    assert.equal(await hub.recoverPanic(DEFAULT_MANAGER_PASSWORD, '746392'), true)
    await login()
    await until(() => !el('dashboard').hidden, 'owner signs in again after desktop recovery')
    assert.equal(isGrantActiveForWindow('products', 42), false)
  } finally { if (hub) await hub.stop(); revokeAll(); state.close(); await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }) }
})

test('an undelivered P2 is never reported as success: the phone is signed out and the retry completes delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-pwa-p2-fail-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  const session = await import('../../src/main/services/panelSession.ts')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const state = openCloudStateStore(join(dir, 'state'))
  state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  let failCleanup = true, cleared = 0
  initRemoteGrantRegistry({ notePanelUnlocked: session.notePanelUnlocked, clearPanelSessions: session.clearPanelSessions,
    clearPanelScope: (...args) => { cleared++; if (failCleanup) throw new Error('injected failure'); return session.clearPanelScope(...args) } })
  let hub, cookie = ''
  try {
    hub = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 5000,
      revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 } } } })
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
    for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next', 'panic-close-tools', 'panic-tools', 'approval-acl']) el(id).hidden = true
    vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console }, { timeout: 1000 })
    const until = async (check, what) => { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) assert.fail(what); await new Promise(r => setTimeout(r, 25)) } }
    el('username').value = 'owner'; el('password').value = 'owner-test-password'; await el('login-form').fire('submit')
    await until(() => !el('dashboard').hidden && !el('panic-tools').hidden, 'owner dashboard with P2 button')
    const asked = requestCode('products', 42)
    assert.ok(createGrant({ panel: 'products', ownerWindowId: 42, tier: 'NORMAL', mode: 'PANEL', memberId: 'owner', requestId: asked.requestId, ttlMs: 60000 }))
    assert.equal(consumeOneShot(42, 'products', asked.gt.slice(3)), true); assert.equal(session.isPanelUnlocked('products', 42), true)

    el('panic-pin').value = '746392'; el('panic-confirm').checked = true
    await el('panic-form').fire('submit')
    // 503 with the session cleared: signed out, told to check at the desktop, never told it succeeded.
    assert.match(el('message').textContent, /تحویل ابطال هنوز کامل نیست/)
    assert.match(el('message').textContent, /ورود شما بسته شد؛ وضعیت را پشت سیستم فروشگاه بررسی کنید/)
    assert.doesNotMatch(el('message').textContent, /توقف اضطراری کامل ثبت شد/)
    assert.equal(el('dashboard').hidden, true); assert.equal(el('login').hidden, false); assert.equal(cookie, '')
    assert.equal(isGrantActiveForWindow('products', 42), false)
    assert.equal(state.openRevocationLedger().load(), null, 'not acknowledged while the desktop cleanup fails')
    // The desktop cleanup recovers; the retried delivery closes the panel and is acknowledged.
    failCleanup = false
    await until(() => state.openRevocationLedger().load()?.id === 1, 'retried delivery acknowledged')
    assert.equal(session.isPanelUnlocked('products', 42), false); assert.ok(cleared >= 2)
    // The latch holds: signing in again is refused.
    el('username').value = 'owner'; el('password').value = 'owner-test-password'; await el('login-form').fire('submit')
    assert.equal(el('dashboard').hidden, true)
  } finally { failCleanup = false; if (hub) await hub.stop(); revokeAll(); state.close(); rmSync(dir, { recursive: true, force: true }) }
})
