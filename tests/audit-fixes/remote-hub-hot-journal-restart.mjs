import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fork, spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, writeFileSync, symlinkSync, readFileSync, renameSync, lstatSync, linkSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

// A writer killed in the middle of a transaction (the supervisor's fail-closed
// kill is TerminateProcess on Windows) leaves a hot rollback journal next to
// the hub database. Real child process on temporary directories; no Electron,
// phone, tunnel or shop data. Seen on Windows CI run 44484304921.
const dir = mkdtempSync(join(tmpdir(), 'mahak-hot-journal-')), childFile = join(dir, 'hub.cjs')
await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
const KEY = '11'.repeat(32), OWNER = { username: 'owner', password: 'owner-test-password', pin: '746392' }
const config = (directory, owner, auditKey = KEY) => ({ directory, origin: 'https://store.example', owner, auditKey, snapshotMaxAgeMs: 5000 })
const spawned = []
function child() {
  const c = fork(childFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), queue = [], waiters = []
  spawned.push(c)
  c.on('message', message => { const w = waiters.shift(); if (w) w(message); else queue.push(message) })
  return { c, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)), exited: () => c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise(resolve => c.once('exit', resolve)) }
}
async function startHub(directory, owner, auditKey) {
  const instance = child()
  instance.c.send({ type: 'start', config: config(directory, owner, auditKey) })
  return { instance, ready: await instance.next() }
}
async function stopHub(instance) { instance.c.send({ type: 'stop' }); assert.deepEqual(await instance.next(), { type: 'stopped' }); await instance.exited() }
// Writes until the page cache spills into the database file, then dies.
function killedWriter(database, sql) {
  const script = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(database)});d.exec('PRAGMA journal_mode=DELETE;PRAGMA cache_size=1;PRAGMA synchronous=FULL');d.exec('BEGIN IMMEDIATE');d.exec('CREATE TABLE remote_scratch(x BLOB)');const s=d.prepare('INSERT INTO remote_scratch VALUES(?)');for(let i=0;i<300;i++)s.run(Buffer.alloc(4000,i%250));d.exec(${JSON.stringify(sql)});process.kill(process.pid,'SIGKILL')`
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'the writer must die inside its transaction')
  assert.equal(existsSync(`${database}-journal`), true, 'a rollback journal must be left behind')
  // Precondition: the journal is hot, so a read-only connection cannot read.
  const ro = new DatabaseSync(database, { readOnly: true })
  try { assert.throws(() => ro.prepare('SELECT COUNT(*) FROM sqlite_master').get(), error => error.errcode === 776 || /readonly database/.test(error.message)) } finally { ro.close() }
}
const tables = database => { const d = new DatabaseSync(database, { readOnly: true }); try { return d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name) } finally { d.close() } }
const login = (port, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body))
  const req = request({ hostname: '127.0.0.1', port, path: '/api/login', method: 'POST', headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', 'content-type': 'application/json', 'content-length': data.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', reject); req.end(data)
})

try {
  await test('a hub killed mid-write restarts: the hot journal is rolled back to the last committed state', async () => {
    const hubDir = mkdtempSync(join(dir, 'hub-')), database = join(hubDir, 'remote-hub.sqlite')
    let { instance, ready } = await startHub(hubDir, OWNER)
    assert.equal(ready.type, 'ready'); await stopHub(instance)
    killedWriter(database, 'UPDATE remote_members SET login_fails=4')
    ;({ instance, ready } = await startHub(hubDir, null))
    assert.equal(ready.type, 'ready', 'the restart must not fail on the hot journal')
    assert.equal(existsSync(`${database}-journal`), false)
    assert.equal(await login(ready.mobilePort, { username: OWNER.username, password: OWNER.password }), 200)
    await stopHub(instance)
    assert.equal(tables(database).includes('remote_scratch'), false, 'uncommitted schema is rolled back')
    const d = new DatabaseSync(database, { readOnly: true })
    try { assert.deepEqual({ ...d.prepare('SELECT COUNT(*) AS n, MAX(login_fails) AS f FROM remote_members').get() }, { n: 1, f: 0 }) } finally { d.close() }
    assert.equal(existsSync(join(hubDir, 'remote-hub.lock')), false)
  })

  await test('identity and key checks still refuse a foreign database or another key after the rollback', async () => {
    const foreignDir = mkdtempSync(join(dir, 'foreign-')), foreign = join(foreignDir, 'remote-hub.sqlite')
    const app = new DatabaseSync(foreign); app.exec('CREATE TABLE "Product"(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO "Product"(name) VALUES (\'committed\')'); app.close()
    killedWriter(foreign, 'INSERT INTO "Product"(name) VALUES (\'uncommitted\')')
    let { instance, ready } = await startHub(foreignDir, null)
    assert.deepEqual(ready, { type: 'error', operation: 'start' }); await instance.exited()
    assert.deepEqual(tables(foreign), ['Product'], 'no hub table is created in a foreign database')
    const d = new DatabaseSync(foreign, { readOnly: true })
    try { assert.deepEqual(d.prepare('SELECT name FROM "Product"').all().map(r => r.name), ['committed']) } finally { d.close() }
    assert.equal(existsSync(join(foreignDir, 'remote-hub.lock')), false)

    const hubDir = mkdtempSync(join(dir, 'other-key-')), database = join(hubDir, 'remote-hub.sqlite')
    ;({ instance, ready } = await startHub(hubDir, OWNER)); assert.equal(ready.type, 'ready'); await stopHub(instance)
    const before = tables(database)
    killedWriter(database, 'UPDATE remote_members SET login_fails=4')
    ;({ instance, ready } = await startHub(hubDir, null, '22'.repeat(32)))
    assert.deepEqual(ready, { type: 'error', operation: 'start' }); await instance.exited()
    assert.deepEqual(tables(database), before)
  })

  await test('a stale journal that is not hot is harmless; a linked journal is refused and never replayed', async () => {
    const hubDir = mkdtempSync(join(dir, 'stale-')), database = join(hubDir, 'remote-hub.sqlite')
    let { instance, ready } = await startHub(hubDir, OWNER); assert.equal(ready.type, 'ready'); await stopHub(instance)
    writeFileSync(`${database}-journal`, Buffer.alloc(512))
    ;({ instance, ready } = await startHub(hubDir, null)); assert.equal(ready.type, 'ready'); await stopHub(instance)
    // A real hot journal that is also reachable from another path (hard link):
    // SQLite would replay it, so only the child's own file check refuses it.
    killedWriter(database, 'UPDATE remote_members SET login_fails=4')
    const linked = join(dir, 'outside-hardlink.bin')
    linkSync(`${database}-journal`, linked)
    const journalBytes = readFileSync(linked)
    ;({ instance, ready } = await startHub(hubDir, null))
    assert.deepEqual(ready, { type: 'error', operation: 'start' }); await instance.exited()
    assert.deepEqual(readFileSync(linked), journalBytes); assert.equal(existsSync(`${database}-journal`), true)
    if (process.platform !== 'win32') {
      // Moved outside and symlinked back: SQLite itself refuses to follow it;
      // the child's type check is a second layer. Nothing is replayed.
      rmSync(`${database}-journal`); rmSync(linked)
      killedWriter(database, 'UPDATE remote_members SET login_fails=4')
      const target = join(dir, 'outside-journal.bin')
      renameSync(`${database}-journal`, target); symlinkSync(target, `${database}-journal`)
      const bytes = readFileSync(target)
      ;({ instance, ready } = await startHub(hubDir, null))
      assert.deepEqual(ready, { type: 'error', operation: 'start' }); await instance.exited()
      assert.deepEqual(readFileSync(target), bytes, 'the linked file is neither replayed nor changed')
      assert.equal(lstatSync(`${database}-journal`).isSymbolicLink(), true)
    }
  })
} finally {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
}
