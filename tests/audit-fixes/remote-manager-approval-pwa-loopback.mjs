import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry, requestCode, consumeOneShot, isGrantActiveForWindow, getRequestStatus, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Two phones, both running the real PWA script (simulated DOM, separate
// cookies): the owner invites a manager with approval permission for one panel
// only, the manager approves that panel's desktop request, and removing the
// manager closes the desktop panel after the revocation is acknowledged. Real
// child HTTP, supervisor, registry and panelSession; temporary data only.
test('owner grants a manager approval for one panel from the phone; removal closes that grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-pwa-manager-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop-isolated.db')
  const session = await import('../../src/main/services/panelSession.ts')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const state = openCloudStateStore(join(dir, 'state'))
  state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  initRemoteGrantRegistry({ notePanelUnlocked: session.notePanelUnlocked, clearPanelScope: session.clearPanelScope, clearPanelSessions: session.clearPanelSessions })
  const policy = { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 }
  let hub
  try {
    hub = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
      reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 5000,
      revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies: { products: policy, settings: policy } } })
    class Element { constructor() { this.hidden = false; this.value = ''; this.checked = false; this.children = []; this.events = {}; this._text = '' } addEventListener(e, f) { this.events[e] = f } appendChild(c) { this.children.push(c) } set textContent(v) { this._text = String(v); this.children = [] } get textContent() { return this._text } fire(e) { return this.events[e]({ preventDefault() {} }) } }
    const phone = () => {
      let cookie = ''
      const done = []
      const fetch = (path, options = {}) => new Promise((resolve, reject) => {
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
      const elements = new Map(), el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
      for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next', 'panic-close-tools', 'panic-tools', 'approval-acl']) el(id).hidden = true
      vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console }, { timeout: 1000 })
      el.capabilities = async () => await (await fetch('/api/capabilities')).json()
      el.done = done
      return el
    }
    const until = async (check, what) => { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) assert.fail(what); await new Promise(r => setTimeout(r, 25)) } }
    const signIn = async (el, username, password) => { el('username').value = username; el('password').value = password; await el('login-form').fire('submit'); await until(() => !el('dashboard').hidden, `${username} signed in`) }
    const owner = phone(), manager = phone()

    // The owner's invite form offers one approval checkbox per approval panel, with Persian titles.
    await signIn(owner, 'owner', 'owner-test-password')
    await until(() => !owner('approval-acl').hidden, 'approval permissions shown to the owner')
    const choices = owner('approval-acl-list').children.map(label => ({ input: label.children[0], text: label.children[1].textContent }))
    assert.deepEqual(choices.map(c => c.text), [' تأیید کالاها', ' تأیید تنظیمات'])
    choices[0].input.checked = true
    // A viewer never receives approval permission, even with a box ticked
    // (the hub would refuse such an invitation).
    owner('invite-role').value = 'VIEWER'; owner('invite-pin').value = '746392'
    await owner('invite-form').fire('submit')
    const viewerInvite = owner('invite-result').textContent
    assert.match(viewerInvite, /^[A-Za-z0-9_-]{20,43}$/, owner('message').textContent)
    owner('invite-role').value = 'MANAGER'; owner('invite-pin').value = '746392'
    await owner('invite-form').fire('submit')
    const invite = owner('invite-result').textContent
    assert.match(invite, /^[A-Za-z0-9_-]{20,43}$/, owner('message').textContent); assert.notEqual(invite, viewerInvite)

    // The manager joins from a second phone; the owner approves the membership.
    manager('invite').value = invite; manager('new-username').value = 'manager1'; manager('new-password').value = 'manager-test-password'; manager('new-pin').value = '135790'
    await manager('accept-form').fire('submit')
    assert.match(manager('message').textContent, /منتظر تأیید مالک/)
    owner('member-name').value = 'manager1'; owner('member-pin').value = '746392'
    await owner('member-form').fire('submit')
    assert.match(owner('message').textContent, /عضو تأیید شد/)
    await signIn(manager, 'manager1', 'manager-test-password')
    // Wait until the PWA has applied its own capabilities response.
    await until(() => manager.done.includes('/api/capabilities'), 'manager capabilities loaded'); await new Promise(r => setTimeout(r, 50))
    assert.equal(manager('owner-tools').hidden, true); assert.equal(manager('panic-tools').hidden, true); assert.equal(manager('approval-acl').hidden, true)
    // The approval-panel list is given to the owner only (the hub's approval policies, sorted).
    assert.deepEqual((await owner.capabilities()).approvalPanels, ['products', 'settings'])
    assert.deepEqual(await manager.capabilities(), { invoices: false })

    // Two desktop requests; the manager sees and approves only the permitted panel.
    const allowed = requestCode('products', 42), other = requestCode('settings', 43)
    for (let i = 0; i < 40 && manager('request-id').children.length === 0; i++) { await manager('reload').events.click(); if (!manager('request-id').children.length) await new Promise(r => setTimeout(r, 100)) }
    assert.deepEqual(manager('request-id').children.map(o => [o.value, o.textContent]), [[allowed.requestId, `کالاها — کد ${allowed.code}`]])
    manager('request-id').value = allowed.requestId; manager('request-code').value = allowed.code; manager('approval-pin').value = '135790'
    await manager('approval-form').fire('submit')
    assert.match(manager('message').textContent, /تأیید ثبت شد/)
    assert.equal(getRequestStatus(42, 'products', allowed.requestId), 'APPROVED'); assert.equal(getRequestStatus(43, 'settings', other.requestId), 'PENDING')
    assert.equal(consumeOneShot(42, 'products', allowed.gt.slice(3)), true)
    assert.equal(isGrantActiveForWindow('products', 42), true); assert.equal(session.isPanelUnlocked('products', 42), true)

    // Removing the manager on the owner's phone closes the grant that manager issued (acknowledged).
    owner('member-name').value = 'manager1'; owner('member-pin').value = '746392'
    await owner('remove-member').events.click()
    assert.match(owner('message').textContent, /عضو حذف شد/)
    assert.equal(isGrantActiveForWindow('products', 42), false); assert.equal(session.isPanelUnlocked('products', 42), false)
    assert.equal(state.openRevocationLedger().load().id, 1)
    assert.equal(getRequestStatus(43, 'settings', other.requestId), 'PENDING')
    // The removed manager's phone session no longer works.
    await manager('reload').events.click()
    assert.equal(manager('request-id').children.length, 0)
  } finally { if (hub) await hub.stop(); revokeAll(); state.close(); rmSync(dir, { recursive: true, force: true }) }
})
