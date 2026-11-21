import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { fork } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'

// OWNER recovery at the computer (design §4, physical presence): the setup
// page replaces the phone owner's username, password and PIN after the desktop
// manager password. Electron, safeStorage, the manager-password check and
// readiness are simulated; data and keys are temporary. No installed Electron,
// DPAPI, Windows, tunnel, phone or real shop data is involved.
const MANAGER = 'local-manager-test-password'
const ORIGIN = 'https://shop.example'
const OWNER = { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' }
const NEW = { username: 'owner.new', password: 'new-phone-pass-2', pin: '394817' }
const NEWER = { username: 'owner.new', password: 'newer-phone-pass-3', pin: '617283' }
const childEntry = fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const refused = port => new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(false) }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (check, what, ms = 10000) => { const deadline = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > deadline) assert.fail(what); await sleep(50) } }

test('setup page: the owner gets new phone credentials at the computer; members stay, sessions, invites and owner grants end; P2 stays latched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-owner-recovery-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
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
  const handlers = new Map(), events = new EventEmitter(), passwordChecks = []
  globalThis.__ownerRecovery = { app: { getPath: name => { assert.equal(name, 'userData'); return dir }, on: (name, handler) => events.on(name, handler), quit: () => {} }, safeStorage: storage,
    Notification: class { static isSupported() { return true } show() {} }, ipcMain: { handle: (name, fn) => { assert.equal(handlers.has(name), false, `duplicate handler ${name}`); handlers.set(name, fn) } },
    BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null },
    query: async (sql, ...values) => { const h = new DatabaseSync(db, { readOnly: true }); try { return h.prepare(sql).all(...values) } finally { h.close() } },
    password: async (password, action) => { passwordChecks.push(action); if (password !== MANAGER) throw new Error('رمز مدیر درست نیست.') } }
  const channels = fileURLToPath(new URL('../../src/shared/remoteAuthChannels.ts', import.meta.url))
  const plugin = { name: 'owner-recovery-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.?\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: args.path === 'electron'
      ? 'export const app=globalThis.__ownerRecovery.app,safeStorage=globalThis.__ownerRecovery.safeStorage,Notification=globalThis.__ownerRecovery.Notification,ipcMain=globalThis.__ownerRecovery.ipcMain,BrowserWindow=globalThis.__ownerRecovery.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:(sql,...values)=>globalThis.__ownerRecovery.query(sql,...values)};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=(p,a)=>globalThis.__ownerRecovery.password(p,a);"
      : `export * from ${JSON.stringify(channels)};export const remoteImplementationReady=()=>true;` }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL, oldError = console.error
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  console.error = (...args) => { if (args[0] !== '[remote] startup unavailable') oldError(...args) }
  let api
  try {
    const outfile = join(dir, 'app.cjs')
    await build({ stdin: { contents: "export * from './src/main/services/cloud/remoteSetupIpc.ts'; export * from './src/main/services/CloudSyncService.ts'; export {isPanelUnlocked} from './src/main/services/panelSession.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(outfile)
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }
    const sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
    const call = (channel, payload, event = { sender, senderFrame: frame }) => handlers.get(channel)(event, payload)
    const port = await freePort()
    const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'shop.example', origin: ORIGIN, 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
      })
      req.on('error', reject); req.end(data)
    })
    const login = async who => { const r = await send('POST', '/api/login', { username: who.username, password: who.password }); return r.status === 200 ? r.cookie : null }
    const approveAndClaim = async (who, panel = 'products') => {
      const cookie = await login(who); assert.ok(cookie, `${who.username} signs in`)
      const p = (await call('remoteAuth:request', { panel })).data
      let seen = false
      for (let i = 0; i < 80 && !seen; i++) { const r = await send('GET', '/api/requests', undefined, cookie); seen = r.body.requests?.some(x => x.requestId === p.requestId); if (!seen) await sleep(100) }
      assert.ok(seen, 'request must be mirrored to the phone')
      return { cookie, p, approve: pin => send('POST', '/api/approve', { requestId: p.requestId, code: p.code, pin }, cookie), claim: async () => (await call('remoteAuth:claim', { panel, requestId: p.requestId, gt: p.gt })).ok }
    }
    const replace = (who, extra = {}) => call('remoteSetup:complete', { managerPassword: MANAGER, replace: true, ...who, ...extra })

    api.registerRemoteSetupHandlers()
    const configured = await call('remoteSetup:configure', { managerPassword: MANAGER, origin: ORIGIN, port, ...OWNER })
    assert.equal(configured.ok, true, configured.error); assert.equal(configured.data.running, true, configured.data.error)

    // A manager who may approve products, a pending invite, and an open panel
    // approved by the owner.
    const ownerCookie = await login(OWNER); assert.ok(ownerCookie)
    const invite = async role => { const r = await send('POST', '/api/invite/create', { pin: OWNER.pin, role, acl: role === 'MANAGER' ? [{ panel: 'products', view: false, approve: true }] : [] }, ownerCookie); assert.equal(r.status, 200); return r.body.invite }
    const managerInvite = await invite('MANAGER')
    assert.equal((await send('POST', '/api/invite/accept', { invite: managerInvite, username: 'manager', password: 'manager-pass-01', pin: '482931' })).status, 200)
    assert.equal((await send('POST', '/api/member/approve', { username: 'manager', pin: OWNER.pin }, ownerCookie)).status, 200)
    const managerCookie = await login({ username: 'manager', password: 'manager-pass-01' }); assert.ok(managerCookie)
    const pendingInvite = await invite('VIEWER')
    const first = await approveAndClaim(OWNER)
    assert.equal((await first.approve(OWNER.pin)).status, 200); assert.equal(await first.claim(), true)
    assert.equal(api.isPanelUnlocked('products', 42), true)

    // Invalid input is refused before the manager password is checked.
    const checksBefore = passwordChecks.length
    assert.equal((await replace(NEW, { replace: 'yes' })).code, 'INVALID_INPUT')
    assert.equal((await replace({ ...NEW, password: 'short' })).code, 'OWNER_PASSWORD')
    assert.equal((await replace({ ...NEW, pin: '12ab56' })).code, 'PIN')
    assert.equal((await replace({ ...NEW, username: 'x' })).code, 'USERNAME')
    assert.equal(passwordChecks.length, checksBefore)
    // Without `replace`, an existing owner is still refused as before.
    assert.equal((await call('remoteSetup:complete', { managerPassword: MANAGER, ...NEW })).code, 'OWNER_EXISTS')
    // A wrong manager password, or another member's username, changes nothing.
    const wrong = await replace(NEW, { managerPassword: 'wrong-password' })
    assert.equal(wrong.code, 'MANAGER_PASSWORD'); assert.equal(wrong.error, 'رمز مدیر درست نیست.')
    assert.equal((await replace({ ...NEW, username: 'manager' })).code, 'OWNER_REPLACE')
    assert.equal((await send('GET', '/api/session', undefined, ownerCookie)).status, 200)
    assert.ok(await login(OWNER)); assert.equal(api.isPanelUnlocked('products', 42), true)

    // Replacement.
    const replaced = await replace(NEW)
    assert.equal(replaced.ok, true, replaced.error); assert.equal(replaced.data.running, true)
    assert.equal(passwordChecks.at(-1), 'عوض کردن اطلاعات ورود مالک گوشی')
    assert.equal((await send('GET', '/api/session', undefined, ownerCookie)).status, 401, 'old owner sessions end')
    assert.equal(await login(OWNER), null, 'old owner credentials no longer work')
    assert.ok(await login(NEW), 'new owner credentials work')
    await until(() => !api.isPanelUnlocked('products', 42), 'the panel the owner approved closes on the desktop')
    assert.notEqual((await send('POST', '/api/invite/accept', { invite: pendingInvite, username: 'viewer', password: 'viewer-pass-01', pin: '519273' })).status, 200, 'unused invites expire')
    assert.equal((await send('GET', '/api/session', undefined, managerCookie)).status, 200, 'members and their sessions stay')
    // The old PIN no longer approves; the new one does.
    const second = await approveAndClaim(NEW)
    assert.notEqual((await second.approve(OWNER.pin)).status, 200)
    assert.equal((await second.approve(NEW.pin)).status, 200); assert.equal(await second.claim(), true)
    assert.equal(api.isPanelUnlocked('products', 42), true)

    // P2: a replacement keeps the latch; local recovery then needs the new PIN.
    assert.equal((await send('POST', '/api/panic', { pin: NEW.pin }, second.cookie)).status, 200)
    await until(() => !api.isPanelUnlocked('products', 42), 'P2 closes the panel')
    assert.equal(await login(NEW), null)
    const again = await replace(NEWER)
    assert.equal(again.ok, true, again.error)
    assert.equal(await login(NEWER), null, 'P2 stays latched after a replacement')
    assert.equal((await call('remoteAuth:recover', { password: MANAGER, pin: NEW.pin })).ok, false, 'the replaced PIN cannot recover P2')
    await until(async () => (await call('remoteAuth:recover', { password: MANAGER, pin: NEWER.pin })).ok, 'local P2 recovery with the new PIN')
    assert.ok(await login(NEWER)); assert.equal(await login(NEW), null)
    assert.ok(await login({ username: 'manager', password: 'manager-pass-01' }), 'the manager signs in again after P2 recovery')

    // Only while the hub runs.
    assert.equal((await call('remoteSetup:disable', { managerPassword: MANAGER })).ok, true)
    assert.equal((await replace({ ...NEWER, password: 'after-off-pass-4' })).code, 'NOT_RUNNING')
    assert.equal(await refused(port), true)
  } finally {
    try { await api?.stopCloudSync() } catch {}
    process.resourcesPath = oldResources; console.error = oldError
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__ownerRecovery
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('identity store: replaceOwnerLocally replaces only the active owner, atomically, with lockouts cleared and an audit row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-owner-recovery-id-')), db = new DatabaseSync(join(dir, 'hub.db'))
  let clock = 1_800_000_000_000
  try {
    const identity = createHubIdentity(db, { panels: ['custody', 'products'], approvalPanels: ['products'], now: () => clock })
    assert.equal(identity.replaceOwnerLocally(NEW.username, NEW.password, NEW.pin), false, 'no owner yet')
    assert.equal(identity.bootstrap(OWNER.username, OWNER.password, OWNER.pin), true)
    const ownerToken = identity.login(OWNER.username, OWNER.password).token
    const invite = identity.createInvite(ownerToken, OWNER.pin, 'MANAGER', [{ panel: 'products', view: true, approve: true }]).invite
    assert.equal(identity.acceptInvite(invite, 'manager', 'manager-pass-01', '482931'), true)
    assert.equal(identity.approveMember(ownerToken, OWNER.pin, 'manager'), true)
    const managerToken = identity.login('manager', 'manager-pass-01').token
    const gone = identity.createInvite(ownerToken, OWNER.pin, 'VIEWER', []).invite
    assert.equal(identity.acceptInvite(gone, 'removed.user', 'removed-pass-01', '102938'), true)
    assert.equal(identity.removeMember(ownerToken, OWNER.pin, 'removed.user').ok, true)
    const pending = identity.createInvite(ownerToken, OWNER.pin, 'VIEWER', []).invite
    // Lock the owner out of login and PIN.
    for (let i = 0; i < 5; i++) assert.equal(identity.login(OWNER.username, 'wrong-password-x').ok, false)
    assert.equal(identity.login(OWNER.username, OWNER.password).ok, false, 'login locked')
    assert.equal(identity.createInvite(ownerToken, '000000', 'VIEWER', []).ok, false, 'a wrong PIN counts')
    const row = () => db.prepare("SELECT * FROM remote_members WHERE role='OWNER'").get()
    assert.equal(row().pin_fails, 1); assert.ok(row().login_locked_until > clock)
    const ownerId = row().id, before = JSON.stringify(row())
    const revocations = () => db.prepare('SELECT kind,member_id FROM remote_identity_revocations WHERE acknowledged_at IS NULL ORDER BY id').all().map(r => ({ ...r }))
    const pendingBefore = revocations()

    // Invalid values, a member's or a removed member's username: nothing changes.
    for (const [name, password, pin] of [[NEW.username, 'short', NEW.pin], [NEW.username, NEW.password, '12345'], [NEW.username, '1234567890', '1234567890'],
      ['x', NEW.password, NEW.pin], [NEW.username, NEW.password, NEW.password], ['manager', NEW.password, NEW.pin], ['removed.user', NEW.password, NEW.pin], ['MANAGER', NEW.password, NEW.pin]]) {
      assert.equal(identity.replaceOwnerLocally(name, password, pin), false, `${name}/${password}/${pin}`)
    }
    assert.equal(JSON.stringify(row()), before); assert.deepEqual(revocations(), pendingBefore)
    assert.equal(identity.whoAmI(ownerToken)?.role, 'OWNER')

    clock += 1000
    assert.equal(identity.replaceOwnerLocally('  Owner.New ', NEW.password, NEW.pin), true)
    const after = row()
    assert.equal(after.id, ownerId); assert.equal(after.username, 'owner.new'); assert.equal(after.status, 'ACTIVE')
    assert.deepEqual([after.login_fails, after.login_locked_until, after.pin_fails, after.pin_locked_until], [0, 0, 0, 0])
    assert.equal(identity.whoAmI(ownerToken), null, 'owner sessions end')
    assert.equal(identity.whoAmI(managerToken)?.username, 'manager', 'other sessions stay')
    assert.equal(identity.login(OWNER.username, OWNER.password).ok, false)
    const fresh = identity.login(NEW.username, NEW.password); assert.equal(fresh.ok, true, 'lockout cleared, new credentials work')
    assert.deepEqual(revocations(), [...pendingBefore, { kind: 'MEMBER', member_id: ownerId }])
    assert.equal(identity.acceptInvite(pending, 'viewer', 'viewer-pass-01', '519273'), false, 'pending invites expire')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM remote_invites WHERE status='PENDING'").get().n, 0)
    assert.deepEqual(identity.listMembers(fresh.token).map(m => [m.username, m.role, m.status]), [['manager', 'MANAGER', 'ACTIVE'], ['owner.new', 'OWNER', 'ACTIVE']])
    // Audit: one row for the replacement, chained to the previous row.
    const audit = db.prepare('SELECT * FROM remote_identity_audit ORDER BY id').all()
    const mine = audit.filter(a => a.kind === 'OWNER_REPLACED_LOCALLY')
    assert.equal(mine.length, 1); assert.equal(mine[0].member_id, ownerId); assert.equal(mine[0].detail, '')
    for (let i = 0; i < audit.length; i++) {
      const prev = i ? audit[i - 1].hash : ''
      assert.equal(audit[i].prev_hash, prev)
      assert.equal(audit[i].hash, createHash('sha256').update(JSON.stringify([prev, audit[i].at, audit[i].member_id, audit[i].kind, audit[i].detail]), 'utf8').digest('hex'))
    }
    // The same username may be kept; a P2 latch stays latched.
    assert.equal(identity.panic(fresh.token, NEW.pin), true)
    assert.equal(identity.replaceOwnerLocally(NEW.username, NEWER.password, NEWER.pin), true)
    assert.equal(db.prepare('SELECT latched FROM remote_identity_panic WHERE id=1').get().latched, 1)
    assert.equal(identity.isPaused(), true)
    assert.equal(identity.login(NEW.username, NEWER.password).ok, false, 'login stays blocked while P2 is latched')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

// The real child accepts a replacement only as a well-formed private IPC message.
test('child: malformed replaceOwner messages get no reply and change nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-owner-recovery-child-')), childFile = join(dir, 'hub.cjs'), hubDir = join(dir, 'hub'); mkdirSync(hubDir)
  await build({ entryPoints: [childEntry], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const child = fork(childFile, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), messages = []
  child.on('message', m => messages.push(m))
  const exited = new Promise(r => child.once('exit', r))
  let port
  const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'store.example', ...(method === 'POST' ? { origin: 'https://store.example', 'x-mahak-request': '1' } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode }))
    }); req.on('error', reject); req.end(data ?? undefined)
  })
  try {
    child.send({ type: 'start', config: { directory: hubDir, origin: 'https://store.example', owner: OWNER, auditKey: '1'.repeat(64), snapshotMaxAgeMs: 5000,
      revocation: { key: '2'.repeat(64), storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', port: 9 },
      approval: { key: '3'.repeat(64), storeId: 'store_test', panels: ['products'], policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } } } })
    await until(() => messages.length > 0, 'child ready')
    assert.equal(messages[0].type, 'ready'); port = messages[0].mobilePort
    const replies = () => messages.filter(m => m.type === 'ownerReplaced')
    const valid = { type: 'replaceOwner', id: 1, ...NEW }
    for (const bad of [{ ...valid, extra: 1 }, { type: 'replaceOwner', id: 1, username: NEW.username, password: NEW.password }, { ...valid, pin: 394817 },
      { ...valid, password: null }, { ...valid, username: ['owner.new'] }, { ...valid, id: 0 }, { ...valid, id: 1.5 }]) child.send(bad)
    await sleep(300)
    assert.deepEqual(replies(), [])
    assert.equal((await send('POST', '/api/login', { username: OWNER.username, password: OWNER.password })).status, 200)
    // Values the identity store refuses get ok:false.
    child.send({ ...valid, id: 2, pin: NEW.password }); await until(() => replies().length === 1, 'refusal reply')
    assert.deepEqual(replies()[0], { type: 'ownerReplaced', id: 2, ok: false })
    child.send({ ...valid, id: 3 }); await until(() => replies().length === 2, 'replacement reply')
    assert.deepEqual(replies()[1], { type: 'ownerReplaced', id: 3, ok: true })
    assert.equal((await send('POST', '/api/login', { username: OWNER.username, password: OWNER.password })).status, 401)
    assert.equal((await send('POST', '/api/login', { username: NEW.username, password: NEW.password })).status, 200)
    child.send({ type: 'stop' })
    await exited
  } finally { if (child.exitCode === null) child.kill(); await exited; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
