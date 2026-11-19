import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { request } from 'node:http'
import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Real IPC handler, registry, panelSession, cloud reader, supervisor, child
// process and loopback HTTP. Every scenario bundles its own module instances,
// because a fail-closed supervisor deliberately keeps the process-wide
// admission lease closed; a simulated restart loads another fresh bundle.
// Electron, readiness and AuthService are stubbed. Temporary SQLite files
// only: no shop data, Electron, Windows, tunnel or phone.
const E1 = '12345678-1234-4123-8123-123456789abc'
const OWNER = { username: 'owner', password: 'owner-test-password', pin: '746392' }
const childSource = fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))
const PARENT_SOURCE = "export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'; export * from './src/main/services/panelSession.ts'; export {startExperimentalHubSupervisor} from './src/main/services/cloud/experimentalHubSupervisor.ts'; export {openCloudStateStore} from './src/main/services/cloud/cloudState.ts'; export {createCloudReader} from './src/main/services/cloud/cloudReader.ts'; export {createExperimentalRestoreBarrier} from './src/main/services/cloud/experimentalRestoreBarrier.ts'"
const counter = path => readFileSync(path).readUInt32BE(24)
const inode = path => lstatSync(path, { bigint: true }).ino

async function scenario(name, run) {
  const dir = mkdtempSync(join(tmpdir(), `mahak-fp-${name}-`)), hubDir = join(dir, 'hub'), stateDir = join(dir, 'state'), childFile = join(dir, 'hub.cjs')
  const shop = join(dir, 'shop.db'), older = join(dir, 'older.db'), foreign = join(dir, 'foreign.db'), handlers = new Map()
  mkdirSync(hubDir)
  // Short-lived connections like separate application transactions; a copy
  // over an open SQLite handle is not possible on Windows anyway.
  const write = (sql, ...values) => { const db = new DatabaseSync(shop); try { db.prepare(sql).run(...values) } finally { db.close() } }
  const schema = 'CREATE TABLE AuditLog(id INTEGER PRIMARY KEY, at TEXT, action TEXT, entity TEXT); CREATE TABLE note(v TEXT)'
  const live = new DatabaseSync(shop); live.exec(schema)
  for (let i = 1; i <= 3; i++) live.prepare('INSERT INTO AuditLog VALUES(?,?,?,?)').run(i, `2025-01-0${i}`, 'SALE_CREATE', 'SaleInvoice')
  live.close()
  copyFileSync(shop, older) // an ordinary earlier backup of this store
  write('INSERT INTO AuditLog VALUES(?,?,?,?)', 4, '2025-01-04', 'SALE_CREATE', 'SaleInvoice')
  write("INSERT INTO note VALUES('write without an audit row')")
  // Another database with a different history and many more commits.
  const other = new DatabaseSync(foreign); other.exec(schema)
  for (let i = 1; i <= 80; i++) other.prepare('INSERT INTO AuditLog VALUES(?,?,?,?)').run(i, '2024-06-01', 'PRODUCT_UPDATE', 'Product')
  other.close()
  const plugin = { name: 'test-adapters', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\/AuthService$/ }, () => ({ path: 'auth', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const ipcMain=globalThis.__fpIpc.ipcMain; export const BrowserWindow=globalThis.__fpIpc.BrowserWindow;'
      : args.path === 'auth' ? "export const readPanelLocks=async()=>({}); export const assertPanelPasswordStrict=async()=>{throw Error('not used')};"
      : "export const remoteImplementationReady=()=>true; export const REMOTE_GT_PREFIX='gt-'; export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};" }))
  } }
  globalThis.__fpIpc = { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, BrowserWindow: { fromWebContents: s => s.valid ? { isDestroyed: () => false } : null } }
  let api, state, hub, login, swap = null, bundles = 0
  const persisted = []
  try {
    await build({ entryPoints: [childSource], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
    const loadBundle = async () => {
      const parentFile = join(dir, `parent-${++bundles}.cjs`)
      await build({ stdin: { contents: PARENT_SOURCE, resolveDir: process.cwd(), loader: 'ts' }, outfile: parentFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [plugin], logLevel: 'silent' })
      api = createRequire(import.meta.url)(parentFile)
      api.initRemoteGrantRegistry({ notePanelUnlocked: (panel, _scope, owner, allowed) => api.noteRemotePanelUnlocked(panel, owner, allowed), clearPanelScope: api.clearPanelScope, clearPanelSessions: api.clearPanelSessions })
      api.registerRemoteAuthHandlers()
    }
    // The production reader over the temporary file. The wrapper only lets a
    // scenario replace the file at an exact point of a guarded operation.
    const prisma = { $queryRawUnsafe: async (sql, ...values) => { const db = new DatabaseSync(shop, { readOnly: true }); try { return db.prepare(sql).all(...values) } finally { db.close() } } }
    const swapNow = () => { const { file } = swap; swap = null; copyFileSync(file, shop) }
    const makeReader = () => {
      const real = api.createCloudReader(prisma, 4000)
      return {
        latestBoundaryTotals: () => real.latestBoundaryTotals(), openShiftsPage: (a, l) => real.openShiftsPage(a, l), waitForIdle: () => real.waitForIdle(),
        tryAuditPage: (a, l) => real.tryAuditPage(a, l), tryAuditTail: id => real.tryAuditTail(id),
        // Non-try reads are issued only by approval, claim, refresh, startup and sync.
        auditPage: async (a, l) => { const rows = await real.auditPage(a, l); if (swap?.at === 'sync-batch' && l === 200) swapNow(); return rows },
        auditTail: async id => {
          if (swap?.at === 'before-high-water') swapNow()
          const rows = await real.auditTail(id)
          if (swap?.at === 'after-high-water') swapNow()
          return rows
        }
      }
    }
    const startHub = (owner, allowEpochRotation) => api.startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner,
      auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000, reader: makeReader(), state, databaseFile: shop, restoreBarrier: api.createExperimentalRestoreBarrier(),
      readRestoreMarker: async () => null, timeoutMs: 5000, persistFingerprint: value => persisted.push(value),
      revocation: { key: Buffer.alloc(32, 2), ...(allowEpochRotation ? { allowEpochRotation: true } : {}) },
      approval: { key: Buffer.alloc(32, 3), policies: { shifts: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 }, settings: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 } } } })
    const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method, headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
      })
      req.on('error', reject); req.end(data)
    })
    const signIn = async () => { login = await send('POST', '/api/login', { username: OWNER.username, password: OWNER.password }); assert.equal(login.status, 200) }
    await loadBundle()
    state = api.openCloudStateStore(stateDir)
    state.save({ version: 1, storeId: 'store_test', epoch: E1, lastAcked: 0, anchorHash: '', restoreMarker: null })
    state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
    hub = await startHub(OWNER, false)
    await signIn()
    const windows = new Map()
    const sender = id => { if (!windows.has(id)) windows.set(id, Object.assign(new EventEmitter(), { id, valid: true, isDestroyed: () => false })); return windows.get(id) }
    const call = (channel, id, payload) => handlers.get(channel)({ sender: sender(id) }, payload)
    const requestPanel = async (id, panel = 'shifts') => {
      const response = await call('remoteAuth:request', id, { panel }); assert.equal(response.ok, true)
      const p = response.data
      let seen = false
      for (let i = 0; i < 50 && !seen; i++) { const listed = await send('GET', '/api/requests', undefined, login.cookie); seen = listed.body.requests?.some(x => x.requestId === p.requestId); if (!seen) await new Promise(r => setTimeout(r, 100)) }
      assert.ok(seen, 'request must be mirrored to the phone')
      return { ...p, panel }
    }
    const approve = p => send('POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: OWNER.pin }, login.cookie)
    const claim = async (id, p) => (await call('remoteAuth:claim', id, { panel: p.panel, requestId: p.requestId, gt: p.gt })).ok
    const failedClosed = async ({ grants }) => {
      for (const [id, p] of grants) {
        assert.equal(api.isPanelUnlocked(p.panel, id), false, `panel of window ${id} must be closed`)
        assert.equal(api.getRequestStatus(id, p.panel, p.requestId), 'UNAVAILABLE')
      }
      assert.throws(() => api.requestCode('settings', 99), /admission closed/)
      const fenced = state.load()
      assert.notEqual(fenced.epoch, E1, 'epoch must be fenced'); assert.equal(fenced.lastAcked, 0); assert.equal(fenced.anchorHash, '')
      await assert.rejects(hub.syncOnce(), /unavailable|closed/)
    }
    // Simulated application restart after a fail-closed stop: fresh module
    // instances, the desktop host's explicit stopped-hub epoch transition
    // (openCloudStateStore with the restore marker) and a new hub child.
    const restart = async () => {
      await hub.stop().catch(() => {})
      state.close(); state = undefined
      await loadBundle()
      state = api.openCloudStateStore(stateDir, { restoreMarker: null })
      hub = await startHub(null, true)
      await signIn()
    }
    const context = { shop, older, foreign, write, send, requestPanel, approve, claim, failedClosed, restart, persisted, hubDir, stateDir, dir,
      arm: value => { swap = value }, swapPending: () => swap !== null,
      get hub() { return hub }, get api() { return api }, get state() { return state } }
    await run(context)
  } finally {
    if (hub) await hub.stop().catch(() => {})
    if (api) { api.revokeAll(); for (const id of [41, 42, 43, 44, 45]) api.clearPanelSessions(id) }
    if (state) state.close()
    delete globalThis.__fpIpc
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('ordinary writes, an open write transaction and VACUUM do not trip the fingerprint', async () => {
  await scenario('ordinary', async ({ shop, write, requestPanel, approve, claim, hub, api, state, persisted }) => {
    for (const id of [41, 42]) {
      write('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)', `2025-02-0${id - 40}`, 'SALE_CREATE', 'SaleInvoice')
      write("UPDATE note SET v='changed by an ordinary write'")
      const p = await requestPanel(id)
      assert.equal((await approve(p)).status, 200)
      assert.equal(await claim(id, p), true); assert.equal(api.isPanelUnlocked('shifts', id), true)
    }
    // A write transaction stays open (its journal exists) during approval and claim.
    const open = new DatabaseSync(shop)
    open.exec('BEGIN IMMEDIATE'); open.prepare('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)').run('2025-02-03', 'SALE_CREATE', 'SaleInvoice')
    const during = await requestPanel(43)
    assert.equal((await approve(during)).status, 200)
    assert.equal(await claim(43, during), true)
    open.exec('COMMIT'); open.close()
    write('VACUUM')
    const afterVacuum = await requestPanel(44, 'settings')
    assert.equal((await approve(afterVacuum)).status, 200)
    assert.equal(await claim(44, afterVacuum), true)
    // Audit rows are sent only after the same composite check.
    assert.deepEqual(await hub.syncOnce(), { sent: 7, lastAcked: 7 })
    write('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)', '2025-02-04', 'SALE_CREATE', 'SaleInvoice')
    assert.deepEqual(await hub.syncOnce(), { sent: 1, lastAcked: 8 })
    for (const id of [41, 42, 43]) assert.equal(api.isPanelUnlocked('shifts', id), true)
    assert.equal(state.load().epoch, E1)
    await hub.stop()
    // The baseline persisted at the confirmed stop matches the live file.
    const last = persisted.at(-1)
    assert.equal(last.epoch, E1); assert.equal(last.highWaterId, 8); assert.match(last.highWaterHash, /^[0-9a-f]{64}$/)
    assert.equal(last.counter, counter(shop))
  })
})

test('an older copy written in place during approval fails it and revokes every grant and request', async () => {
  await scenario('approval', async ({ shop, older, requestPanel, approve, claim, failedClosed, arm, swapPending, api }) => {
    const live = await requestPanel(42)
    assert.equal((await approve(live)).status, 200); assert.equal(await claim(42, live), true)
    assert.equal(api.isPanelUnlocked('shifts', 42), true)
    const approved = await requestPanel(43)
    assert.equal((await approve(approved)).status, 200)
    const pending = await requestPanel(44)
    const before = inode(shop), liveCounter = counter(shop)
    assert.ok(counter(older) < liveCounter)
    // Nothing is acknowledged yet (no audit anchor), the marker is unchanged
    // and, on POSIX, the inode stays the same: only the header counter shows
    // the replacement, made after this approval's audit read.
    arm({ at: 'after-high-water', file: older })
    // The phone sees a refusal or, because the child is terminated while the
    // request is open, a reset connection; never a successful approval.
    const outcome = await approve(pending).then(response => response.status, error => error.code)
    assert.ok(outcome !== 200, `approval must not succeed (got ${outcome})`)
    assert.equal(swapPending(), false, 'the replacement happened inside the approval check')
    if (process.platform !== 'win32') assert.equal(inode(shop), before)
    await failedClosed({ grants: [[42, live], [43, approved], [44, pending]] })
  })
})

test('a different database with more commits written in place before a claim is caught by the audit high-water row', async () => {
  await scenario('claim', async ({ shop, foreign, requestPanel, approve, claim, failedClosed, arm, swapPending, api }) => {
    const live = await requestPanel(42)
    assert.equal((await approve(live)).status, 200); assert.equal(await claim(42, live), true)
    const next = await requestPanel(43)
    assert.equal((await approve(next)).status, 200)
    // The replacement has a higher change counter, so the counter alone
    // cannot show it; the recorded newest audit row differs.
    assert.ok(counter(foreign) > counter(shop))
    arm({ at: 'before-high-water', file: foreign })
    assert.equal(await claim(43, next), false)
    assert.equal(swapPending(), false, 'the replacement happened inside the claim check')
    assert.equal(api.isPanelUnlocked('shifts', 43), false)
    await failedClosed({ grants: [[42, live], [43, next]] })
  })
})

test('an older copy written in place in the middle of an audit sync stops it before anything is sent', async () => {
  await scenario('sync', async ({ older, requestPanel, approve, claim, failedClosed, arm, swapPending, hub, hubDir }) => {
    const live = await requestPanel(42)
    assert.equal((await approve(live)).status, 200); assert.equal(await claim(42, live), true)
    arm({ at: 'sync-batch', file: older })
    await assert.rejects(hub.syncOnce(), /Database change counter decreased|Database identity changed/)
    assert.equal(swapPending(), false)
    await failedClosed({ grants: [[42, live]] })
    await hub.stop().catch(() => {})
    // The fail-closed kill can interrupt a hub write (TerminateProcess on
    // Windows, CI run 44484304921) and leave a hot rollback journal that a
    // read-only connection cannot read. A read-write connection rolls it back
    // to the last committed state, which is the durable state counted here.
    const inspect = new DatabaseSync(join(hubDir, 'remote-hub.sqlite'))
    try { assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM remote_audit_events').get().n, 0) } finally { inspect.close() }
  })
})

test('a different database written in place after the sync batch was read is caught before the batch is sent', async () => {
  await scenario('sync-foreign', async ({ shop, foreign, requestPanel, approve, claim, failedClosed, arm, swapPending, hub, hubDir }) => {
    const live = await requestPanel(42)
    assert.equal((await approve(live)).status, 200); assert.equal(await claim(42, live), true)
    assert.ok(counter(foreign) > counter(shop))
    // The batch itself was read from the live file; the sync cycle's own marker
    // check passes (higher counter, unchanged marker, same inode on POSIX). The
    // final composite check right before sending must still refuse. If the copy
    // gets a new file identity (possible on Windows), that check refuses first.
    arm({ at: 'sync-batch', file: foreign })
    await assert.rejects(hub.syncOnce(), process.platform === 'win32' ? /Audit high-water row changed|Database identity changed/ : /Audit high-water row changed/)
    assert.equal(swapPending(), false)
    await failedClosed({ grants: [[42, live]] })
    await hub.stop().catch(() => {})
    // The fail-closed kill can interrupt a hub write (TerminateProcess on
    // Windows, CI run 44484304921) and leave a hot rollback journal that a
    // read-only connection cannot read. A read-write connection rolls it back
    // to the last committed state, which is the durable state counted here.
    const inspect = new DatabaseSync(join(hubDir, 'remote-hub.sqlite'))
    try { assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM remote_audit_events').get().n, 0) } finally { inspect.close() }
  })
})

test('after a fail-closed mismatch a restart adopts the fenced epoch and resynchronizes from the current database', async () => {
  await scenario('resync', async ctx => {
    const { older, requestPanel, approve, claim, failedClosed, arm, hubDir, stateDir, restart } = ctx
    const live = await requestPanel(42)
    assert.equal((await approve(live)).status, 200); assert.equal(await claim(42, live), true)
    arm({ at: 'sync-batch', file: older })
    await assert.rejects(ctx.hub.syncOnce(), /Database change counter decreased|Database identity changed/)
    await failedClosed({ grants: [[42, live]] })
    const fenced = ctx.state.load().epoch
    await ctx.hub.stop().catch(() => {})
    // The killed child could not release its own lock file; the supervisor
    // removes it only after observing that very child's exit.
    assert.equal(existsSync(join(hubDir, 'remote-hub.lock')), false, 'stale hub lock left behind after a fail-closed stop')
    await restart()
    // The stopped-hub transition moved both ledgers to the fenced epoch.
    assert.equal(ctx.state.load().epoch, fenced)
    for (const name of ['revocation-ledger.json', 'grant-replay-ledger.json']) assert.equal(JSON.parse(readFileSync(join(stateDir, name), 'utf8')).epoch, fenced)
    // The full audit history of the database now in place is sent again.
    assert.deepEqual(await ctx.hub.syncOnce(), { sent: 3, lastAcked: 3 })
    const fresh = await requestPanel(43)
    assert.equal((await approve(fresh)).status, 200); assert.equal(await claim(43, fresh), true)
    assert.equal(ctx.api.isPanelUnlocked('shifts', 43), true)
    await ctx.hub.stop()
    const inspect = new DatabaseSync(join(hubDir, 'remote-hub.sqlite'), { readOnly: true })
    try {
      const counts = Object.fromEntries(inspect.prepare('SELECT epoch, COUNT(*) AS n FROM remote_audit_events GROUP BY epoch').all().map(row => [row.epoch, row.n]))
      assert.deepEqual(counts, { [fenced]: 3 })
    } finally { inspect.close() }
  })
})

test('a hub lock that no longer holds the exited child token is never removed', async () => {
  await scenario('foreign-lock', async ctx => {
    const { older, requestPanel, approve, claim, failedClosed, arm, hubDir } = ctx
    const live = await requestPanel(42)
    assert.equal((await approve(live)).status, 200); assert.equal(await claim(42, live), true)
    // Another owner's token (for example a hub started by hand): not ours to remove.
    const lockPath = join(hubDir, 'remote-hub.lock'), other = 'f'.repeat(64)
    writeFileSync(lockPath, other)
    arm({ at: 'sync-batch', file: older })
    await assert.rejects(ctx.hub.syncOnce(), /Database change counter decreased|Database identity changed/)
    await failedClosed({ grants: [[42, live]] })
    await ctx.hub.stop().catch(() => {})
    assert.equal(readFileSync(lockPath, 'utf8'), other)
  })
})
