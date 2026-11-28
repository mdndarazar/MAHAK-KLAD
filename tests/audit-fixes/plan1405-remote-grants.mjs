/**
 * طرح ۱۴۰۵ — مجوز از راه دور برای همهٔ قفل‌ها (معماری §۳-۱۲، §۳-۱۴؛ §۸-۲ بندهای ۹ و ۱۱).
 *
 * واحد (ساعت یکنواخت ساختگی): سقف ۶۰ دقیقه برای هر دو رده؛ انتظار درخواست ۱۰ دقیقه؛ بی‌کاری «یک‌پنجم مدت، ۳ تا
 * ۱۰ دقیقه»؛ مدت واقعی = کمترینِ سقف سیاست و پروندهٔ مدت‌ها؛ مجوز یک‌بار فقط برای شناسهٔ کار و نتیجه‌اش یک بلیت
 * (پیش از پاک کردن مجوز؛ شکست ساخت بلیت ⇒ مجوز مصرف نمی‌شود)؛ نشست نگهبان‌دار از بی‌کاری عمومی پنل پیروی
 * نمی‌کند و سقف سخت ۶۰ دقیقه دارد.
 * یکپارچه (loopback، فرزند واقعی هاب): هاب با ۹۷ سیاست کاتالوگ و با ۱۲۸ بالا می‌آید و ۱۲۹ را رد می‌کند؛ تأیید
 * مالک روی یک شناسهٔ کار پس از فعال‌سازی یک بار دروازه را باز می‌کند و بار دوم نه. همه روی پوشهٔ موقت.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-remote-grants.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance as perfHooksPerformance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'plan1405-remote-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const reg = await import('../../src/main/services/RemoteGrantRegistry.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { gateAction } = await import('../../src/main/services/locks/gate.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { REMOTE_PANELS } = await import('../../src/shared/enums.ts')
const { GATE_ACTION_IDS, GATE_CATALOG } = await import('../../src/shared/gateCatalog.ts')
const { startExperimentalHubSupervisor } = await import('../../src/main/services/cloud/experimentalHubSupervisor.ts')
const { openCloudStateStore } = await import('../../src/main/services/cloud/cloudState.ts')
const { prisma } = await import('../../src/main/db/client.ts')

const MIN = 60_000
const realNow = performance.now.bind(performance), realDateNow = Date.now
let shift = 0, dateShift = 0
performance.now = () => realNow() + shift
Date.now = () => realDateNow() + dateShift
let ticketFails = false, durationMs = 10 * MIN
reg.initRemoteGrantRegistry({
  notePanelUnlocked: (panel, _scope, owner, allowed) => sessions.noteRemotePanelUnlocked(panel, owner, allowed),
  clearPanelScope: sessions.clearPanelScope, clearPanelSessions: sessions.clearPanelSessions,
  addOneShotTicket: (id, owner, ttl, memberId) => (ticketFails ? false : tickets.addGateTicket(owner, id, ttl, 'REMOTE_GRANT', { memberId })),
  clearOneShotTickets: (memberId) => tickets.clearGateTickets(memberId === undefined ? {} : { memberId }),
  grantDurationMs: () => durationMs
})
const token = (p) => p.gt.slice(3)
const grant = (p, panel, owner, tier, ttlMs = 60 * MIN) =>
  reg.createGrant({ panel, ownerWindowId: owner, tier, mode: tier === 'NORMAL' ? 'PANEL' : 'ONE_SHOT', memberId: 'member1', requestId: p.requestId, ttlMs })
const gatePasses = (owner, id) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, () => gateAction(id, () => auth.assertManagerPassword('', GATE_CATALOG[id].titleFa))))
  .then(() => true, (err) => (err?.code === `GATE_REQUIRED:${id}` ? false : Promise.reject(err)))

test('unit: caps, pending, idle, real duration, one-shot ticket, guarded-session idle and hard cap', async () => {
  assert.equal(perfHooksPerformance, globalThis.performance, 'perf_hooks.performance is the global object')
  const lease = reg.acquireRemoteAdmissionLease()
  lease.installClaimGuard(async (claim) => claim())
  lease.open()
  try {
    // سقف ۶۰ دقیقه برای هر دو رده (شش اعتبارسنج؛ این‌جا دفتر محلی)
    for (const tier of ['NORMAL', 'SENSITIVE_MONEY']) {
      const panel = tier === 'NORMAL' ? 'products' : 'credit.void'
      const p = reg.requestCode(panel, 11)
      assert.equal(grant(p, panel, 11, tier, 60 * MIN + 1), null, `${tier} > 60 min refused`)
      assert.ok(grant(p, panel, 11, tier, 60 * MIN), `${tier} = 60 min accepted`)
      reg.cancelForWindow(11)
    }
    // انتظار درخواست ۱۰ دقیقه
    reg.requestCode('settings', 12)
    shift += 10 * MIN - 1000; assert.ok(reg.getPending(12, 'settings'), 'still pending at 9:59')
    shift += 1000; assert.equal(reg.getPending(12, 'settings'), null, 'gone at 10:00')
    // مدت واقعی و بی‌کاری یک‌پنجم (۳ تا ۱۰ دقیقه)
    for (const [minutes, idle] of [[60, 10], [25, 5], [10, 3], [6, 3], [1, 3]]) {
      durationMs = minutes * MIN
      const p = reg.requestCode('products', 13)
      assert.ok(grant(p, 'products', 13, 'NORMAL'))
      assert.equal(await reg.claimRemotePanel(13, 'products', p.requestId, token(p)), true)
      const left = reg.remotePanelSecondsLeft(13, 'products')
      assert.equal(left, Math.min(minutes, idle) * 60, `${minutes} min ⇒ idle ${idle} min (left ${left}s)`)
      reg.cancelForWindow(13)
    }
    // مجوز یک‌بار روی کلید قسمت رد؛ روی شناسهٔ کار ⇒ بلیت یک‌بار، نه نشست پنل
    durationMs = 10 * MIN
    const ps = reg.requestCode('settings', 14)
    assert.ok(grant(ps, 'settings', 14, 'SENSITIVE_MONEY'))
    assert.equal(await reg.claimRemotePanel(14, 'settings', ps.requestId, token(ps)), false, 'one-shot on a part key stays refused')
    reg.cancelForWindow(14)
    const pa = reg.requestCode('reports.sales-purge', 15)
    assert.ok(grant(pa, 'reports.sales-purge', 15, 'SENSITIVE_MONEY'))
    ticketFails = true
    assert.equal(await reg.claimRemotePanel(15, 'reports.sales-purge', pa.requestId, token(pa)), false, 'ticket failure ⇒ activation fails')
    assert.equal(reg.getRequestStatus(15, 'reports.sales-purge', pa.requestId), 'APPROVED', 'grant not consumed')
    ticketFails = false
    assert.equal(await reg.claimRemotePanel(15, 'reports.sales-purge', pa.requestId, token(pa)), true)
    assert.equal(reg.getRequestStatus(15, 'reports.sales-purge', pa.requestId), 'UNAVAILABLE', 'one-shot grant removed after the ticket')
    assert.equal(sessions.isPanelUnlocked('reports.sales-purge', 15), false, 'no panel session')
    assert.ok(tickets.gateTicketSecondsLeft(15, 'reports.sales-purge') <= 600)
    assert.equal(await gatePasses(16, 'reports.sales-purge'), false, 'other window cannot use it')
    assert.equal(await gatePasses(15, 'reports.sales-purge'), true, 'gate opens once')
    assert.equal(await gatePasses(15, 'reports.sales-purge'), false, 'second call refused')
    // «بستن همه» (revokeAll) بلیت‌ها را هم می‌بندد
    tickets.addGateTicket(15, 'woo.decision', 60_000, 'REMOTE_GRANT', { memberId: 'member1' })
    reg.revokeAll()
    assert.equal(tickets.gateTicketCount(), 0)
    // نشست نگهبان‌دار: بی‌کاری عمومی پنل (۲ و ۵ دقیقه) آن را نمی‌بندد؛ سقف سخت ۶۰ دقیقه
    for (const idleMin of [2, 5]) {
      sessions.applyPanelSessionTtlMs(idleMin * MIN)
      sessions.noteRemotePanelUnlocked('products', 17, () => true)
      dateShift += 10 * MIN; shift += 10 * MIN
      assert.equal(sessions.isPanelUnlocked('products', 17), true, `guarded session survives 10 min with idleLock ${idleMin}`)
      shift += 51 * MIN
      assert.equal(sessions.isPanelUnlocked('products', 17), false, 'always-open guard closed after 61 minutes')
      sessions.clearPanelSessions(17)
    }
    sessions.notePanelUnlocked('products', 'PANEL', 18)
    dateShift += 6 * MIN
    assert.equal(sessions.isPanelUnlocked('products', 18), false, 'an ordinary panel session still follows the general idle lock')
    // مجوز ۶۰ دقیقه‌ای: بی‌کاری ۱۰ دقیقه (نه ۵ دقیقهٔ عمومی پنل)؛ خواندن بی‌اثر روی بی‌کاری با isGrantActiveForWindow
    durationMs = 60 * MIN
    const pg = reg.requestCode('products', 19)
    assert.ok(grant(pg, 'products', 19, 'NORMAL'))
    assert.equal(await reg.claimRemotePanel(19, 'products', pg.requestId, token(pg)), true)
    dateShift += 9 * MIN; shift += 9 * MIN
    assert.equal(reg.isGrantActiveForWindow('products', 19), true, 'still open after 9 idle minutes')
    shift += 61_000; dateShift += 61_000
    assert.equal(reg.isGrantActiveForWindow('products', 19), false, 'closed after 10 idle minutes')
    assert.equal(sessions.isPanelUnlocked('products', 19), false, 'and the desktop panel session closes with it')
  } finally {
    sessions.applyPanelSessionTtlMs(5 * MIN)
    reg.revokeAll()
    lease.release()
    performance.now = realNow; Date.now = realDateNow; shift = 0; dateShift = 0
  }
})

test('loopback: hub starts with the 97 catalog policies and 128, refuses 129; owner approval of an action = one gate ticket', async () => {
  const childFile = join(dir, 'hub.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const catalogPolicies = Object.fromEntries(REMOTE_PANELS.map((panel) => [panel, GATE_ACTION_IDS.includes(panel)
    ? { tier: 'SENSITIVE_MONEY', mode: 'ONE_SHOT', ttlMs: 3_600_000 } : { tier: 'NORMAL', mode: 'PANEL', ttlMs: 3_600_000 }]))
  assert.equal(Object.keys(catalogPolicies).length, 97)
  const start = async (policies, label) => {
    const hubDir = join(dir, `hub-${label}`), stateDir = join(dir, `state-${label}`); mkdirSync(hubDir)
    const state = openCloudStateStore(stateDir)
    state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
    try {
      const hub = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
        reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 8000,
        revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies } })
      return { hub, state }
    } catch (error) { state.close(); throw error }
  }
  const send = (hub, method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method, headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject); req.end(data)
  })
  let running = null
  try {
    running = await start(catalogPolicies, '97')
    const { hub } = running
    const login = await send(hub, 'POST', '/api/login', { username: 'owner', password: 'owner-test-password' })
    assert.equal(login.status, 200)
    const caps = await send(hub, 'GET', '/api/capabilities', undefined, login.cookie)
    assert.equal(caps.body.approvalPanels.length, 97, 'owner sees all 97 approval names')
    const p = reg.requestCode('credit.void', 42)
    let seen = false
    for (let i = 0; i < 40 && !seen; i++) {
      const r = await send(hub, 'GET', '/api/requests', undefined, login.cookie)
      seen = r.body.requests?.some((x) => x.requestId === p.requestId)
      if (!seen) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(seen, 'the action request reached the phone')
    assert.equal((await send(hub, 'POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: '746392' }, login.cookie)).status, 200)
    assert.equal(reg.getRequestStatus(42, 'credit.void', p.requestId), 'APPROVED')
    assert.equal(await reg.claimRemotePanel(42, 'credit.void', p.requestId, token(p)), true, 'one-shot activation')
    assert.equal(sessions.isPanelUnlocked('credit-void', 42), false, 'the module key is not opened by an action grant')
    const voidOnce = () => sessions.runWithPanelSessionOwner(42, () => runInGateCall(42, () => gateAction('credit.void', () => auth.assertPanelPasswordStrict('credit-void', '', 'ابطال اعتبار'))))
      .then(() => true, (err) => (err?.code === 'GATE_REQUIRED:credit.void' ? false : Promise.reject(err)))
    assert.equal(await voidOnce(), true, 'gate opens once with the ticket')
    assert.equal(await voidOnce(), false, 'and not twice')
    await hub.stop(); running.state.close(); running = null
    const extra = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`extra-panel-${i}`, { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600_000 }]))
    running = await start({ ...catalogPolicies, ...extra }, '128')
    await running.hub.stop(); running.state.close(); running = null
    await assert.rejects(() => start({ ...catalogPolicies, ...extra, 'extra-panel-x': { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600_000 } }, '129'))
  } finally {
    if (running) { await running.hub.stop().catch(() => undefined); running.state.close() }
    reg.revokeAll()
    tickets.clearGateTickets()
    await prisma.$disconnect().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
