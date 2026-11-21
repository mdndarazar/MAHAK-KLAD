import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { createExperimentalRestoreBarrier } from '../../src/main/services/cloud/experimentalRestoreBarrier.ts'
import { openCloudStateStore, prepareRemoteEpoch } from '../../src/main/services/cloud/cloudState.ts'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { initRemoteGrantRegistry, requestCode, consumeOneShot, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'

// Real supervisor, child process, loopback HTTP, revocation transport, durable
// cloud state and temporary SQLite files. Electron, safeStorage/DPAPI, Windows,
// the installed app, a tunnel and a phone are not involved.
const E1 = '12345678-1234-4123-8123-123456789abc'
const makeDb = (path, rows) => {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE AuditLog(id INTEGER PRIMARY KEY, at TEXT, action TEXT, entity TEXT)')
    for (const row of rows) db.prepare('INSERT INTO AuditLog VALUES(?,?,?,?)').run(...row)
  } finally { db.close() }
}

test('restore epoch is resynchronized only through the explicit stopped-hub transition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-epoch-resync-')), hubDir = join(dir, 'hub'), stateDir = join(dir, 'state'), childFile = join(dir, 'hub.cjs')
  const shop = join(dir, 'shop.db'), replacement = join(dir, 'replacement.db'), markerFile = join(dir, 'last-restore.txt')
  mkdirSync(hubDir)
  makeDb(shop, [[1, '2025-01-01', 'CREATE', 'Product'], [2, '2025-01-02', 'UPDATE', 'Product'], [3, '2025-01-03', 'CREATE', 'Sale']])
  makeDb(replacement, [[1, '2024-12-01', 'CREATE', 'Product'], [2, '2024-12-02', 'CREATE', 'Customer']])
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const commandKey = randomBytes(32), auditKey = randomBytes(32)
  const derive = (epoch, purpose) => Buffer.from(hkdfSync('sha256', commandKey, Buffer.from(`store_test:${epoch}`), Buffer.from(`mahak-remote-${purpose}-v1`), 32))
  const marker = () => {
    try { return createHash('sha256').update(readFileSync(markerFile)).digest('hex') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const prisma = { $queryRawUnsafe: async (sql, ...values) => { const db = new DatabaseSync(shop, { readOnly: true }); try { return db.prepare(sql).all(...values) } finally { db.close() } } }
  let state = openCloudStateStore(stateDir)
  state.save({ version: 1, storeId: 'store_test', epoch: E1, lastAcked: 0, anchorHash: '', restoreMarker: null })
  state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
  initRemoteGrantRegistry({ notePanelUnlocked: () => {}, clearPanelScope: () => {}, clearPanelSessions: () => {} })
  const start = owner => {
    const epoch = state.load().epoch
    return startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner, auditKey,
      snapshotMaxAgeMs: 5000, reader: createCloudReader(prisma, 4000), state, databaseFile: shop, restoreBarrier: createExperimentalRestoreBarrier(),
      readRestoreMarker: async () => marker(), timeoutMs: 5000,
      revocation: { key: derive(epoch, 'revocation'), allowEpochRotation: true },
      approval: { key: derive(epoch, 'approval'), policies: { shifts: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60000 } } },
      verifyLocalRecoveryPassword: async password => { if (password !== 'local-manager-test') throw new Error('denied') } })
  }
  let hub
  const send = (method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method, headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject); req.end(data)
  })
  const approveFromPhone = async (p, cookie) => {
    let seen = false
    for (let i = 0; i < 50 && !seen; i++) {
      const listed = await send('GET', '/api/requests', undefined, cookie)
      seen = listed.body.requests?.some(x => x.requestId === p.requestId)
      if (!seen) await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(seen, 'request must be mirrored')
    return (await send('POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: '746392' }, cookie)).status
  }
  const ledgerEpoch = name => JSON.parse(readFileSync(join(stateDir, name), 'utf8')).epoch
  try {
    // Epoch 1: audit history synchronized, a phone-approved grant claimed, then Panic.
    hub = await start({ username: 'owner', password: 'owner-test-password', pin: '746392' })
    assert.deepEqual(await hub.syncOnce(), { sent: 3, lastAcked: 3 })
    let login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    const first = requestCode('shifts', 42)
    assert.equal(await approveFromPhone(first, login.cookie), 200)
    assert.equal(consumeOneShot(42, 'shifts', first.gt.slice(3)), true)
    assert.equal((await send('POST', '/api/panic', { pin: '746392' }, login.cookie)).status, 200)
    const deadline = Date.now() + 6000
    while (!state.openRevocationLedger().load() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    const epochOneCursor = state.openRevocationLedger().load()
    assert.equal(epochOneCursor?.kind, 'ALL')

    // Coordinated restore: epoch fence first, then replacement and a new marker.
    await hub.restoreExclusive(async () => { copyFileSync(replacement, shop); writeFileSync(markerFile, 'restored by test') })
    const E2 = state.load().epoch
    assert.notEqual(E2, E1); assert.equal(state.load().lastAcked, 0)
    await hub.stop(); hub = null
    state.close()
    // An ordinary open performs no transition: earlier-epoch ledgers stay unusable.
    state = openCloudStateStore(stateDir)
    assert.throws(() => state.openRevocationLedger(), /Invalid revocation ledger/)
    assert.equal(ledgerEpoch('revocation-ledger.json'), E1)
    state.close()
    assert.throws(() => openCloudStateStore(stateDir, { restoreMarker: 'not-a-marker' }), /Invalid state options/)

    // Desktop-host open path: the changed marker starts another epoch under the
    // freshly acquired lock and the earlier ledgers are replaced.
    state = openCloudStateStore(stateDir, { restoreMarker: marker() })
    const E3 = state.load().epoch
    assert.ok(E3 !== E1 && E3 !== E2)
    assert.equal(state.load().restoreMarker, marker()); assert.equal(state.load().lastAcked, 0)
    assert.equal(ledgerEpoch('revocation-ledger.json'), E3); assert.equal(ledgerEpoch('grant-replay-ledger.json'), E3)
    assert.equal(state.openRevocationLedger().load(), null)
    // Repeating the transition with the same marker changes nothing.
    assert.deepEqual(prepareRemoteEpoch(state, marker()), { epoch: E3, markerChanged: false, rotated: false })
    state.close(); state = openCloudStateStore(stateDir, { restoreMarker: marker() })
    assert.equal(state.load().epoch, E3)

    // Epoch 3: the child moves its delivery cursor, announces the latched Panic
    // again and the desktop durably applies it before startup completes.
    hub = await start(null)
    const cursor = state.openRevocationLedger().load()
    assert.equal(cursor?.kind, 'ALL'); assert.ok(cursor.id > epochOneCursor.id)
    assert.equal((await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' })).status, 401)
    assert.equal(await hub.recoverPanic('wrong-password', '746392'), false)
    assert.equal(await hub.recoverPanic('local-manager-test', '746392'), true)
    login = await send('POST', '/api/login', { username: 'owner', password: 'owner-test-password' }); assert.equal(login.status, 200)
    // Audit history of the restored database is sent again under the new epoch.
    assert.deepEqual(await hub.syncOnce(), { sent: 2, lastAcked: 2 })
    assert.equal(state.load().epoch, E3); assert.equal(state.load().lastAcked, 2)
    const second = requestCode('shifts', 43)
    assert.equal(await approveFromPhone(second, login.cookie), 200)
    assert.equal(consumeOneShot(43, 'shifts', second.gt.slice(3)), true)
    await hub.stop(); hub = null

    const inspect = new DatabaseSync(join(hubDir, 'remote-hub.sqlite'), { readOnly: true })
    try {
      const delivery = inspect.prepare('SELECT epoch,last_ack FROM remote_revocation_delivery WHERE id=1').get()
      assert.equal(delivery.epoch, E3); assert.equal(delivery.last_ack, cursor.id)
      const counts = Object.fromEntries(inspect.prepare('SELECT epoch, COUNT(*) AS n FROM remote_audit_events GROUP BY epoch').all().map(row => [row.epoch, row.n]))
      assert.deepEqual(counts, { [E1]: 3, [E3]: 2 })
      assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n, 0)
    } finally { inspect.close() }
  } finally {
    if (hub) await hub.stop().catch(() => {})
    revokeAll(); state.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('epoch ledger transition never recreates, adopts or rewinds uncertain ledgers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-epoch-ledgers-'))
  try {
    const fresh = name => {
      const store = openCloudStateStore(join(dir, name))
      store.save({ version: 1, storeId: 'store_test', epoch: E1, lastAcked: 0, anchorHash: '', restoreMarker: null })
      store.initializeRevocationLedger(); store.initializeGrantReplayLedger()
      return store
    }
    const E2 = '22345678-1234-4123-8123-123456789abc'
    // Same epoch: nothing changes.
    const same = fresh('same')
    assert.deepEqual(same.prepareEpochLedgers(), { rotated: false })
    same.close()

    // A new epoch that already acknowledged audit history cannot adopt old ledgers.
    const synced = fresh('synced'), syncedDir = join(dir, 'synced')
    synced.save({ version: 1, storeId: 'store_test', epoch: E2, lastAcked: 0, anchorHash: '', restoreMarker: null })
    synced.save({ version: 1, storeId: 'store_test', epoch: E2, lastAcked: 1, anchorHash: 'a'.repeat(64), restoreMarker: null })
    const before = readFileSync(join(syncedDir, 'revocation-ledger.json'), 'utf8')
    assert.throws(() => synced.prepareEpochLedgers(), /reconciliation/)
    assert.equal(readFileSync(join(syncedDir, 'revocation-ledger.json'), 'utf8'), before)
    synced.close()

    // A corrupt ledger is not replaced, and the other ledger is not touched first.
    const corrupt = fresh('corrupt'), corruptDir = join(dir, 'corrupt')
    corrupt.save({ version: 1, storeId: 'store_test', epoch: E2, lastAcked: 0, anchorHash: '', restoreMarker: null })
    writeFileSync(join(corruptDir, 'revocation-ledger.json'), '{')
    const replayBefore = readFileSync(join(corruptDir, 'grant-replay-ledger.json'), 'utf8')
    assert.throws(() => corrupt.prepareEpochLedgers(), /Invalid revocation ledger/)
    assert.equal(readFileSync(join(corruptDir, 'revocation-ledger.json'), 'utf8'), '{')
    assert.equal(readFileSync(join(corruptDir, 'grant-replay-ledger.json'), 'utf8'), replayBefore)
    corrupt.close()

    // A ledger of another store is never adopted.
    const foreign = fresh('foreign'), foreignDir = join(dir, 'foreign')
    foreign.save({ version: 1, storeId: 'store_test', epoch: E2, lastAcked: 0, anchorHash: '', restoreMarker: null })
    writeFileSync(join(foreignDir, 'grant-replay-ledger.json'), JSON.stringify({ version: 1, storeId: 'store_other', epoch: E1, latest: 0, entries: [] }))
    assert.throws(() => foreign.prepareEpochLedgers(), /Invalid grant replay ledger/)
    assert.equal(JSON.parse(readFileSync(join(foreignDir, 'revocation-ledger.json'), 'utf8')).epoch, E1)
    foreign.close()

    // A missing marker means initialization was never completed: still closed.
    const missing = fresh('missing'), missingDir = join(dir, 'missing')
    missing.save({ version: 1, storeId: 'store_test', epoch: E2, lastAcked: 0, anchorHash: '', restoreMarker: null })
    rmSync(join(missingDir, 'revocation-ledger.initialized'))
    assert.throws(() => missing.prepareEpochLedgers(), /ENOENT/)
    assert.throws(() => prepareRemoteEpoch(missing, 'not-a-marker'), /Invalid remote epoch input/)
    missing.close()
    // The failing open-time transition releases the lock and changes nothing.
    const stateBefore = readFileSync(join(missingDir, 'cloud-state.json'), 'utf8')
    assert.throws(() => openCloudStateStore(missingDir, { restoreMarker: null }), /ENOENT/)
    assert.throws(() => openCloudStateStore(missingDir, { restoreMarker: 'f'.repeat(64) }), /ENOENT/)
    assert.equal(JSON.parse(readFileSync(join(missingDir, 'cloud-state.json'), 'utf8')).restoreMarker, 'f'.repeat(64))
    assert.notEqual(readFileSync(join(missingDir, 'cloud-state.json'), 'utf8'), stateBefore)
    openCloudStateStore(missingDir).close()
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('hub delivery cursor moves only on the explicit rotation request and keeps pending entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-epoch-identity-'))
  const db = new DatabaseSync(join(dir, 'remote-hub.sqlite'))
  try {
    const identity = createHubIdentity(db, { panels: ['shifts'], approvalPanels: ['shifts'] })
    assert.equal(identity.bootstrap('owner', 'owner-test-password', '746392'), true)
    const E3 = '32345678-1234-4123-8123-123456789abc'
    assert.equal(identity.networkRevocationCursor(E1), 0)
    // A pending entry from the earlier epoch and a latched Panic (set directly
    // in this temporary file) must survive the rotation.
    db.prepare("INSERT INTO remote_identity_revocations(at,kind,member_id,acknowledged_at) VALUES(1,'ALL',NULL,NULL)").run()
    db.prepare('UPDATE remote_identity_panic SET latched=1 WHERE id=1').run()
    assert.throws(() => identity.networkRevocationCursor(E3), /Revocation cursor mismatch/)
    assert.throws(() => identity.rotateNetworkRevocationEpoch('not-an-epoch'), /Invalid revocation epoch/)
    assert.equal(identity.rotateNetworkRevocationEpoch(E3), true)
    assert.equal(identity.networkRevocationCursor(E3), 0)
    assert.equal(identity.rotateNetworkRevocationEpoch(E3), false)
    assert.throws(() => identity.networkRevocationCursor(E1), /Revocation cursor mismatch/)
    const pending = identity.pendingRevocations()
    assert.deepEqual(pending.map(x => x.kind), ['ALL', 'ALL'])
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM remote_identity_audit WHERE kind='REVOCATION_EPOCH_ROTATED'").get().n, 1)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
