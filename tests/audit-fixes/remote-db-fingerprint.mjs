import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, copyFileSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabaseFingerprint, readDatabaseHeader, readFingerprintBaseline, writeFingerprintBaseline, databaseChangedSince, auditRowHash } from '../../src/main/services/cloud/databaseFingerprint.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'

// Temporary SQLite files only; no shop data, Electron or Windows involved.
const E1 = '12345678-1234-4123-8123-123456789abc'
const temp = () => mkdtempSync(join(tmpdir(), 'mahak-db-fingerprint-'))
const makeDb = path => {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE AuditLog(id INTEGER PRIMARY KEY, at TEXT, action TEXT, entity TEXT); CREATE TABLE note(v TEXT)')
  return db
}
const counterOf = path => readFileSync(path).readUInt32BE(24)
const setCounter = (path, value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); const fd = openSync(path, 'r+'); try { writeSync(fd, b, 0, 4, 24) } finally { closeSync(fd) } }
const tail = path => async id => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT id, at, action, entity FROM AuditLog WHERE id=? OR id=(SELECT MAX(id) FROM AuditLog) ORDER BY id LIMIT 2').all(id).map(r => ({ ...r })) } finally { db.close() }
}

test('ordinary commits and VACUUM advance the counter without tripping the fingerprint', () => {
  const dir = temp(), path = join(dir, 'shop.db')
  try {
    const db = makeDb(path)
    const fingerprint = createDatabaseFingerprint(path)
    const first = fingerprint.committedCounter()
    for (let i = 0; i < 20; i++) { db.prepare('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)').run(String(i), 'SALE', 'Invoice'); fingerprint.verify() }
    db.exec('VACUUM'); fingerprint.verify()
    db.exec("UPDATE note SET v='x'"); fingerprint.verify()
    assert.ok(fingerprint.committedCounter() > first)
    assert.equal(fingerprint.committedCounter(), counterOf(path))
    assert.equal(readDatabaseHeader(path).textEncoding, 1)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('an older copy written over the same file is detected by the change counter', () => {
  const dir = temp(), path = join(dir, 'shop.db'), backup = join(dir, 'backup.db')
  try {
    const db = makeDb(path)
    db.prepare('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)').run('1', 'SALE', 'Invoice')
    db.close(); copyFileSync(path, backup)
    const fingerprint = createDatabaseFingerprint(path), inode = lstatSync(path, { bigint: true }).ino
    // A write that leaves no audit row, then the older copy is written back.
    const live = new DatabaseSync(path); live.exec("INSERT INTO note VALUES('not audited')"); live.close()
    fingerprint.verify()
    copyFileSync(backup, path)
    if (process.platform !== 'win32') {
      // Same inode on POSIX: only the header counter can see this replacement.
      assert.equal(lstatSync(path, { bigint: true }).ino, inode)
      assert.throws(() => fingerprint.verify(), /Database change counter decreased/)
    } else assert.throws(() => fingerprint.verify(), /Database change counter decreased|Database identity changed/)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('rename replacement, extra links, invalid headers and header field changes fail closed', () => {
  const dir = temp(), path = join(dir, 'shop.db'), other = join(dir, 'other.db')
  try {
    makeDb(path).close(); makeDb(other).close()
    const fingerprint = createDatabaseFingerprint(path)
    renameSync(path, join(dir, 'old.db')); renameSync(other, path)
    assert.throws(() => fingerprint.verify(), /Database identity changed/)
    writeFileSync(join(dir, 'plain.db'), 'not a database')
    assert.throws(() => createDatabaseFingerprint(join(dir, 'plain.db')), /Invalid database header/)
    assert.throws(() => createDatabaseFingerprint('relative.db'), /Invalid database path/)
    if (process.platform !== 'win32') {
      symlinkSync(path, join(dir, 'link.db'))
      assert.throws(() => createDatabaseFingerprint(join(dir, 'link.db')), /Database identity unavailable/)
    }
    const fresh = createDatabaseFingerprint(path)
    const db = new DatabaseSync(path); db.exec('PRAGMA application_id=7'); db.close()
    assert.throws(() => fresh.verify(), /Database header changed/)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('a counter seen while a journal is listed is neither compared nor adopted', () => {
  const dir = temp(), path = join(dir, 'shop.db'), journal = join(dir, 'shop.db-journal')
  try {
    makeDb(path).close()
    const fingerprint = createDatabaseFingerprint(path), committed = fingerprint.committedCounter()
    // Simulated commit in progress (or hot journal): page 1 already shows a
    // higher counter that the journal rollback will undo.
    writeFileSync(journal, Buffer.alloc(512, 1)); setCounter(path, committed + 5)
    fingerprint.verify()
    assert.equal(fingerprint.committedCounter(), committed)
    setCounter(path, committed); unlinkSync(journal)
    fingerprint.verify()
    assert.equal(fingerprint.committedCounter(), committed)
    // Negative control: without a listed journal the same transient value is adopted.
    setCounter(path, committed + 5); fingerprint.verify(); setCounter(path, committed)
    assert.throws(() => fingerprint.verify(), /Database change counter decreased/)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('persisted baseline is strict, atomic and detects replacement while closed', async () => {
  const dir = temp(), path = join(dir, 'shop.db'), backup = join(dir, 'backup.db'), file = join(dir, 'database-fingerprint.json')
  try {
    const db = makeDb(path)
    for (let i = 1; i <= 3; i++) db.prepare('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)').run(String(i), 'SALE', 'Invoice')
    db.close(); copyFileSync(path, backup)
    const live = new DatabaseSync(path); live.prepare('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)').run('4', 'SALE', 'Invoice'); live.close()
    assert.equal(readFingerprintBaseline(file), null)
    const row = (await tail(path)(0))[0]
    const value = { version: 1, storeId: 'store_test', epoch: E1, counter: counterOf(path), highWaterId: row.id, highWaterHash: auditRowHash(row) }
    writeFingerprintBaseline(file, value)
    assert.deepEqual(readFingerprintBaseline(file), value)
    assert.equal(await databaseChangedSince(path, value, tail(path)), false)
    // More ordinary activity after the baseline is not a change.
    const more = new DatabaseSync(path); more.prepare('INSERT INTO AuditLog(at,action,entity) VALUES(?,?,?)').run('5', 'SALE', 'Invoice'); more.close()
    assert.equal(await databaseChangedSince(path, value, tail(path)), false)
    // Older copy: lower counter (and the recorded high-water row is missing).
    copyFileSync(backup, path)
    assert.equal(await databaseChangedSince(path, value, tail(path)), true)
    // Same counter but a different high-water row is also a change.
    const forged = { ...value, counter: 0, highWaterHash: 'f'.repeat(64) }
    assert.equal(await databaseChangedSince(path, { ...forged, highWaterId: 1 }, tail(path)), true)
    for (const bad of [{ ...value, extra: 1 }, { ...value, epoch: 'x' }, { ...value, counter: -1 }, { ...value, highWaterId: 0 }, { ...value, highWaterHash: 'abc' }, { ...value, storeId: 'a/b' }]) {
      assert.throws(() => writeFingerprintBaseline(file, bad), /Invalid database fingerprint/)
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad))
      assert.throws(() => readFingerprintBaseline(join(dir, 'bad.json')), /Invalid database fingerprint/)
    }
    writeFileSync(join(dir, 'bad.json'), '{not json')
    assert.throws(() => readFingerprintBaseline(join(dir, 'bad.json')), /Invalid database fingerprint/)
    assert.deepEqual(readFingerprintBaseline(file), value)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('changedEpoch rotates only the current epoch and uses the stopped-hub ledger transition', () => {
  const dir = temp(), stateDir = join(dir, 'state')
  try {
    let state = openCloudStateStore(stateDir)
    state.save({ version: 1, storeId: 'store_test', epoch: E1, lastAcked: 7, anchorHash: 'a'.repeat(64), restoreMarker: null })
    state.initializeRevocationLedger(); state.initializeGrantReplayLedger(); state.close()
    // A stale epoch proves nothing about the current one.
    state = openCloudStateStore(stateDir, { restoreMarker: null, changedEpoch: '87654321-4321-4321-8321-cba987654321' })
    assert.equal(state.load().epoch, E1); assert.equal(state.load().lastAcked, 7); state.close()
    state = openCloudStateStore(stateDir, { restoreMarker: null, changedEpoch: null })
    assert.equal(state.load().epoch, E1); state.close()
    state = openCloudStateStore(stateDir, { restoreMarker: null, changedEpoch: E1 })
    const rotated = state.load()
    assert.notEqual(rotated.epoch, E1); assert.equal(rotated.lastAcked, 0); assert.equal(rotated.anchorHash, ''); assert.equal(rotated.restoreMarker, null)
    for (const name of ['revocation-ledger.json', 'grant-replay-ledger.json']) assert.equal(JSON.parse(readFileSync(join(stateDir, name), 'utf8')).epoch, rotated.epoch)
    state.close()
    assert.throws(() => openCloudStateStore(stateDir, { restoreMarker: null, changedEpoch: 'not-a-uuid' }), /Invalid state options/)
    assert.throws(() => openCloudStateStore(stateDir, { restoreMarker: null, other: E1 }), /Invalid state options/)
    // The lock was released by every failed or successful open above.
    openCloudStateStore(stateDir).close()
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
