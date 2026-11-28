/**
 * طرح ۱۴۰۵ · مرحلهٔ ۶ — کدهای بازیابی «توقف اضطراری کامل» (مورد ۳؛ معماری §۴-۸؛ §۸-۲ بند ۱۲).
 *
 * الف) پایگاه دادهٔ هاب (واقعی، روی پوشهٔ موقت): ۵ کد ۱۲ نویسه‌ای از الفبای بی‌ابهام، فقط hash؛ جدول‌ها فقط با
 *      نخستین ساخت (طرح پایگاه هاب پیش از آن عیناً همان)؛ بازیابی فقط با P2 فعال؛ هر کد یک بار؛ شمارندهٔ جدا
 *      (۵ اشتباه ⇒ ۱۵ دقیقه) که مسیر «رمز مدیر + PIN» را قفل نمی‌کند؛ «باطل کردن همه»؛ رمز و PIN تازهٔ مالک همه را
 *      باطل می‌کند؛ پیام یک‌باره در ورود بعدی گوشی مالک.
 * ب) میزبان واقعی رایانه (CloudSyncService، ناظر و فرزند هاب، رجیستری و panelSession؛ Electron و Prisma ساختگی):
 *      ساخت با IPC فقط از پنجرهٔ اصلی و با رمز تایپی مدیر؛ P2 از گوشی؛ بازیابی با کد به‌تنهایی روی همان کانال
 *      `remoteAuth:recover`؛ اعلان ویندوز و ردیف `RECOVERY_CODE_USED`؛ پیام در ورود بعدی گوشی؛ «تأیید راه دور
 *      متوقف است» برای دکمه‌های ربات تا بازیابی؛ P2 «بستن همه» را با لغو آینده صدا می‌زند و P1 بی آن.
 * هیچ Electron نصب‌شده، DPAPI، تونل، گوشی یا پایگاه دادهٔ واقعی فروشگاه درگیر نیست.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-recovery-codes.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createRemoteTransportVault } from '../../src/main/services/cloud/remoteTransportVault.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

const EPOCH = '12345678-1234-4123-8123-123456789abc'
const CODE_SHAPE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/

test('hub identity: five one-time recovery codes, separate lockout, invalidation and the owner notice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan1405-recovery-id-')), path = join(dir, 'hub.db')
  let now = 1_800_000_000_000
  const db = new DatabaseSync(path)
  try {
    const identity = createHubIdentity(db, { panels: ['custody', 'shifts', 'products'], approvalPanels: ['products'], now: () => now })
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'remote_recovery%'").all().map((r) => r.name)
    assert.equal(identity.bootstrap('owner', 'long-password-test', '746392'), true)
    assert.deepEqual(tables(), [], 'no schema change before the owner creates codes')
    assert.deepEqual(identity.recoveryCodesStatus(), { total: 0, remaining: 0, lockedUntil: 0 })
    const codes = identity.createRecoveryCodesLocally()
    assert.equal(codes.length, 5); assert.ok(codes.every((c) => CODE_SHAPE.test(c))); assert.equal(new Set(codes).size, 5)
    assert.deepEqual(tables().sort(), ['remote_recovery_codes', 'remote_recovery_meta'])
    const stored = JSON.stringify(db.prepare('SELECT * FROM remote_recovery_codes').all())
    assert.ok(!codes.some((c) => stored.includes(c.replace(/-/g, ''))), 'only salted hashes are stored')
    assert.deepEqual(identity.recoveryCodesStatus(), { total: 5, remaining: 5, lockedUntil: 0 })

    // No P2 latched ⇒ nothing to recover; a code attempt is neither counted nor consumed.
    assert.equal(identity.recoverPanicWithCodeLocally(codes[0], EPOCH, 1), 0)
    assert.equal(identity.recoveryCodesStatus().remaining, 5)

    const owner = identity.login('owner', 'long-password-test'); assert.equal(owner.ok, true)
    assert.equal(identity.networkRevocationCursor(EPOCH), 0)
    assert.equal(identity.panic(owner.token, '746392'), true)
    const [pending] = identity.pendingRevocations(1)
    assert.equal(identity.acknowledgeNetworkRevocation(EPOCH, 0, pending.id), true)
    assert.equal(identity.approvalsStopped(), true)

    // Wrong codes: a separate counter; the fifth locks code recovery for 15 minutes.
    for (let i = 0; i < 4; i++) assert.equal(identity.recoverPanicWithCodeLocally('ABCD-EFGH-JKMN', EPOCH, pending.id), 0)
    assert.equal(identity.recoverPanicWithCodeLocally('not a code', EPOCH, pending.id), 0)
    assert.ok(identity.recoveryCodesStatus().lockedUntil > now)
    assert.equal(identity.recoverPanicWithCodeLocally(codes[0], EPOCH, pending.id), 0, 'locked: even a right code is refused')
    const member = db.prepare("SELECT pin_fails,pin_locked_until FROM remote_members WHERE role='OWNER'").get()
    assert.deepEqual({ ...member }, { pin_fails: 0, pin_locked_until: 0 }, 'wrong codes never touch the PIN path')
    assert.equal(identity.recoverPanicWithCodeLocally(codes[0], 'other-epoch', pending.id), 0)
    now += 15 * 60_000 + 1
    // Lower case, spaces and no dashes are accepted (case-insensitive, grouping ignored).
    assert.equal(identity.recoverPanicWithCodeLocally(` ${codes[1].replace(/-/g, ' ').toLowerCase()} `, EPOCH, pending.id), 2)
    assert.equal(identity.approvalsStopped(), false)
    assert.equal(identity.recoveryCodesStatus().remaining, 4)

    // The owner's next phone login sees the notice once; a manager never.
    assert.equal(identity.takeRecoveryNotice('x'.repeat(43)), null)
    const back = identity.login('owner', 'long-password-test'); assert.equal(back.ok, true)
    assert.deepEqual(identity.takeRecoveryNotice(back.token), { at: now, n: 2 })
    assert.equal(identity.takeRecoveryNotice(back.token), null)

    // Each code once: after a second P2 the same code is refused, another one works.
    assert.equal(identity.panic(back.token, '746392'), true)
    const [second] = identity.pendingRevocations(1)
    assert.equal(identity.acknowledgeNetworkRevocation(EPOCH, pending.id, second.id), true)
    assert.equal(identity.recoverPanicWithCodeLocally(codes[1], EPOCH, second.id), 0)
    assert.equal(identity.recoverPanicWithCodeLocally(codes[4], EPOCH, second.id), 5)

    // «Revoke all» and a new owner password + PIN invalidate the codes.
    assert.equal(identity.revokeRecoveryCodesLocally(), true)
    assert.deepEqual(identity.recoveryCodesStatus(), { total: 0, remaining: 0, lockedUntil: 0 })
    const again = identity.createRecoveryCodesLocally()
    assert.equal(identity.recoveryCodesStatus().remaining, 5)
    assert.equal(identity.replaceOwnerLocally('owner', 'another-long-password', '394817'), true)
    assert.equal(identity.recoveryCodesStatus().total, 0)
    assert.notDeepEqual(again, codes)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('desktop host: recovery codes by IPC with the typed manager password; P2 lifted with one code alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan1405-recovery-host-')), root = join(dir, 'remote-hub'), hubDir = join(root, 'hub'), stateDir = join(root, 'state')
  const resources = join(dir, 'resources'), remote = join(resources, 'remote'), db = join(dir, 'data', 'shop.db'), child = join(remote, 'remote-hub-child.cjs'), parent = join(dir, 'parent.cjs')
  for (const p of [hubDir, stateDir, remote, join(dir, 'data')]) mkdirSync(p, { recursive: true })
  const dbHandle = new DatabaseSync(db); dbHandle.exec('CREATE TABLE test_value (value TEXT)'); dbHandle.close()
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: child, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  copyFileSync(process.execPath, join(remote, 'node.exe'))
  writeFileSync(join(dir, 'remote-settings.json'), JSON.stringify({ enabled: true }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, origin: 'https://store.example' }))
  const secret = randomBytes(32), storage = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
  }
  const keys = createRemoteTransportVault(root, 'store_test', storage).create()
  const { hkdfSync } = await import('node:crypto')
  const derive = (purpose) => Buffer.from(hkdfSync('sha256', keys.commandKey, Buffer.from(`store_test:${EPOCH}`), Buffer.from(`mahak-remote-${purpose}-v1`), 32))
  const state = openCloudStateStore(stateDir); state.save({ version: 1, storeId: 'store_test', epoch: EPOCH, lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  const bootstrap = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile: child, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: keys.auditKey, snapshotMaxAgeMs: 5000, reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, revocation: { key: derive('revocation') }, approval: { key: derive('approval'), policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 600000 } } }, timeoutMs: 10000 })
  await bootstrap.stop(); state.close()
  const handlers = new Map(), events = new EventEmitter(), notifications = []
  globalThis.__desktopHost = {
    app: { getPath: () => dir, on: (name, handler) => events.on(name, handler), quit: () => {} }, safeStorage: storage,
    Notification: class { constructor(o) { this.o = o } static isSupported() { return true } show() { notifications.push(this.o.body) } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: (s) => s.valid ? { isDestroyed: () => false } : null }
  }
  const SHARED = fileURLToPath(new URL('../../src/shared/', import.meta.url))
  const plugin = { name: 'desktop-host-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/db\/client$/ }, () => ({ path: 'db', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\/AuthService$|^\.\.\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onResolve({ filter: /^@shared\// }, (args) => ({ path: join(SHARED, args.path.slice('@shared/'.length) + '.ts') }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const app=globalThis.__desktopHost.app,safeStorage=globalThis.__desktopHost.safeStorage,Notification=globalThis.__desktopHost.Notification,ipcMain=globalThis.__desktopHost.ipcMain,BrowserWindow=globalThis.__desktopHost.BrowserWindow;'
      : args.path === 'db' ? 'export const prisma={$queryRawUnsafe:async()=>[]};'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};export const assertManagerPassword=async p=>{if(p!=='local-manager-test-password')throw Error('رمز مدیر درست نیست.')};"
      : "export const remoteImplementationReady=()=>true;export const REMOTE_GT_PREFIX='gt-';export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',recover:'remoteAuth:recover',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};" }))
  } }
  const oldResources = process.resourcesPath, oldUrl = process.env.DATABASE_URL
  process.resourcesPath = resources; process.env.DATABASE_URL = `file:${db}`
  let api
  try {
    await build({ stdin: { contents: [
      "export * from './src/main/services/CloudSyncService.ts'",
      "export { registerRecoveryCodeHandlers } from './src/main/services/cloud/recoveryCodesIpc.ts'",
      "export { setAccessEventWriter } from './src/main/services/locks/accessEvents.ts'",
      "export { setCloseAllUnlocksHook, remoteApprovalsStopped } from './src/main/services/locks/unlockHooks.ts'"
    ].join(';'), resolveDir: process.cwd(), loader: 'ts' }, outfile: parent, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
    api = createRequire(import.meta.url)(parent)
    const access = [], closes = []
    api.setAccessEventWriter((after) => { access.push(after) })
    api.setCloseAllUnlocksHook((options) => { closes.push(options) })
    api.registerRecoveryCodeHandlers()
    await api.startCloudSync()
    const info = api.cloudSyncStatus(); assert.equal(info.running, true)
    const send = (method, path, body, cookie) => new Promise((resolve, reject) => { const data = body === undefined ? null : Buffer.from(JSON.stringify(body)), req = request({ hostname: '127.0.0.1', port: info.mobilePort, path, method, headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] })) }); req.on('error', reject); req.end(data) })
    const frame = { url: pathToFileURL(join(dir, '../renderer/index.html')).href }
    const sender = Object.assign(new EventEmitter(), { id: 42, valid: true, mainFrame: frame, isDestroyed: () => false })
    const call = (channel, payload, senderFrame = frame) => handlers.get(channel)({ sender, senderFrame }, payload)
    const until = async (check, what) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)) } assert.fail(what) }

    // Creation: main window only, typed manager password only; status shows counts only.
    assert.deepEqual((await call('remote-recovery-codes:status', {})).data, { running: true, total: 0, remaining: 0, lockedUntil: 0 })
    assert.equal((await call('remote-recovery-codes:create', { managerPassword: 'local-manager-test-password' }, { url: 'https://evil.example/' })).ok, false)
    assert.equal((await call('remote-recovery-codes:create', { managerPassword: 'wrong' })).ok, false)
    assert.equal((await call('remote-recovery-codes:create', {})).ok, false)
    const made = await call('remote-recovery-codes:create', { managerPassword: 'local-manager-test-password' })
    assert.equal(made.ok, true); const codes = made.data.codes
    assert.equal(codes.length, 5); assert.ok(codes.every((c) => CODE_SHAPE.test(c)))
    assert.deepEqual((await call('remote-recovery-codes:status', {})).data, { running: true, total: 5, remaining: 5, lockedUntil: 0 })
    assert.ok(access.some((e) => e.kind === 'RECOVERY_CODES_CREATED' && e.count === 5) && !JSON.stringify(access).includes(codes[0]))
    assert.equal(await api.remoteApprovalsLive(), true)

    // P1 closes everything without cancelling future scheduled grants; P2 also cancels them.
    const login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    assert.equal((await send('POST', '/api/panic/close', { pin: '746392' }, login.cookie)).status, 200)
    await until(() => closes.length >= 1, 'P1 close-all hook')
    assert.deepEqual(closes[0].cancelFuture, undefined)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(closes.some((c) => c.cancelFuture === true), false, 'P1 cancels no future grant')
    assert.equal(await api.remoteApprovalsLive(), true)
    assert.equal((await send('POST', '/api/panic', { pin: '746392' }, login.cookie)).status, 200)
    await until(() => closes.some((c) => c.cancelFuture === true), 'P2 cancels future scheduled grants')
    assert.equal(api.remoteApprovalsStopped(), true)
    assert.equal(await api.remoteApprovalsLive(), false, 'bot approvals stay closed while P2 is latched')
    assert.equal((await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' })).status, 401)

    // Recovery with one code alone on the same channel; wrong/foreign frames refused; each code once.
    assert.equal((await call('remoteAuth:recover', { code: codes[0] }, {})).ok, false)
    assert.equal((await call('remoteAuth:recover', { code: 'ABCD-EFGH-JKMN' })).ok, false)
    assert.equal((await call('remoteAuth:recover', { code: codes[0], pin: '746392' })).ok, false, 'a code is not mixed with the PIN payload')
    assert.equal((await call('remoteAuth:recover', { code: codes[2] })).ok, true)
    assert.equal((await call('remoteAuth:recover', { code: codes[2] })).ok, false)
    assert.ok(notifications.some((b) => b.includes('کد بازیابی شمارهٔ ۳') || b.includes('کد بازیابی شمارهٔ 3')))
    assert.ok(access.some((e) => e.kind === 'RECOVERY_CODE_USED' && e.number === 3))
    assert.equal(api.remoteApprovalsStopped(), false)
    assert.equal(await api.remoteApprovalsLive(), true)
    assert.deepEqual((await call('remote-recovery-codes:status', {})).data.remaining, 4)

    // The owner's next phone login sees the notice once.
    const back = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(back.status, 200)
    const caps = await send('GET', '/api/capabilities', undefined, back.cookie)
    assert.equal(caps.body.recoveryNotice?.n, 3)
    assert.equal((await send('GET', '/api/capabilities', undefined, back.cookie)).body.recoveryNotice, undefined)

    // Revoke all (typed password) ⇒ no code left.
    assert.equal((await call('remote-recovery-codes:revoke', { managerPassword: 'wrong' })).ok, false)
    assert.equal((await call('remote-recovery-codes:revoke', { managerPassword: 'local-manager-test-password' })).data.total, 0)
    await api.stopCloudSync()
    assert.deepEqual((await call('remote-recovery-codes:status', {})).data.running, false)
  } finally {
    if (api) await api.stopCloudSync()
    process.resourcesPath = oldResources; if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl
    delete globalThis.__desktopHost
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
