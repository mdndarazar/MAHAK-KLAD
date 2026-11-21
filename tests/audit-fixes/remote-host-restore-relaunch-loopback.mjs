import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'

// A full backup replacement through the real backup IPC and BackupService
// ends with app.relaunch() + app.exit(0), which skips before-quit. The desktop
// host must already have stopped the hub by then, so that no state or hub lock
// is left behind and the relaunched application starts the hub again in a new
// epoch. Real host, provisioning, backup IPC, BackupService, supervisor and
// child/HTTP on temporary files; Electron (safeStorage, app.exit) and Prisma
// are harness stubs. The relaunch is a fresh Node process, not Electron.
const ORIGIN = 'https://shop.example', OWNER = { username: 'owner', password: 'owner-phone-pass-1', pin: '582614' }
const paths = dir => ({ stateLock: join(dir, 'remote-hub', 'state', 'cloud-state.lock'), hubLock: join(dir, 'remote-hub', 'hub', 'remote-hub.lock'), state: join(dir, 'remote-hub', 'state'), marker: join(dir, 'backups', 'last-restore.txt') })
function patchElectron(electron, secret, handlers, events) {
  Object.assign(electron.safeStorage, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
    decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } })
  electron.ipcMain.handle = (name, fn) => handlers.set(name, fn)
  electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
  electron.app.on = (name, fn) => { (events[name] ||= []).push(fn) }
}
const call = (port, method, path, body, cookie) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
  const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'shop.example', origin: ORIGIN, 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], body: text ? JSON.parse(text) : null }))
  }); req.on('error', reject); req.end(data ?? undefined)
})
const refused = port => new Promise(resolve => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false) }); s.once('error', () => resolve(true)) })
const until = async (check, what, ms = 10000) => { const deadline = Date.now() + ms; while (!(await check())) { if (Date.now() > deadline) assert.fail(what); await new Promise(r => setTimeout(r, 25)) } }

if (process.env.MAHAK_RELAUNCH_DIR) {
  // Phase 2, in a fresh process: the relaunched application starts the host
  // at app start (opt-in on, owner exists), exactly as index.ts does.
  const dir = process.env.MAHAK_RELAUNCH_DIR, port = Number(process.env.MAHAK_RELAUNCH_PORT), report = {}
  process.resourcesPath = join(dir, 'resources')
  const electron = await import('electron')
  patchElectron(electron, Buffer.from(process.env.MAHAK_RELAUNCH_SECRET, 'hex'), new Map(), {})
  const host = await import('../../src/main/services/CloudSyncService.ts')
  try {
    await host.startCloudSync()
    const status = host.remoteHostState(); report.running = status.running; report.error = status.error
    if (status.running) report.login = (await call(port, 'POST', '/api/login', { username: OWNER.username, password: OWNER.password })).status
  } finally { try { await host.stopCloudSync() } catch (error) { report.stopError = String(error) } }
  const { openCloudStateStore } = await import('../../src/main/services/cloud/cloudState.ts')
  const store = openCloudStateStore(paths(dir).state)
  try { const value = store.load(); report.epoch = value.epoch; report.restoreMarker = value.restoreMarker } finally { store.close() }
  const { prisma } = await import('../../src/main/db/client.ts'); await prisma.$disconnect().catch(() => {})
  console.log(`RELAUNCH ${JSON.stringify(report)}`)
  process.exit(0)
} else {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-restore-relaunch-')), resources = join(dir, 'resources'), remote = join(resources, 'remote')
  const dbPath = join(dir, 'data', 'shop.db'), importDir = join(dir, 'backups', 'imported'), secret = randomBytes(32), handlers = new Map(), events = {}, exits = [], quits = []
  for (const path of [remote, join(dir, 'data'), importDir]) mkdirSync(path, { recursive: true })
  process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = dbPath; process.env.DATABASE_URL = `file:${dbPath}`; process.resourcesPath = resources
  const port = await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
  let host, reg, prisma, files, session, openCloudStateStore, setup, IPC, DEFAULT_MANAGER_PASSWORD, id
  // Shared setup: hub runtime, temporary shop database with an imported
  // backup, the real IPC handlers and owner setup; the host is not started yet.
  async function prepare() {
    await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: join(remote, 'remote-hub-child.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
    copyFileSync(process.execPath, join(remote, 'node.exe'))
    const electron = await import('electron')
    patchElectron(electron, secret, handlers, events)
    files = paths(dir)
    electron.app.relaunch = () => {}
    // What remains at the moment BackupService exits the application.
    electron.app.exit = code => { const s = host.remoteHostState(); exits.push({ code, stateLock: existsSync(files.stateLock), hubLock: existsSync(files.hubLock), running: s.running, busy: s.busy }) }
    electron.app.quit = () => { quits.push({ stateLock: existsSync(files.stateLock), running: host.remoteHostState().running }) }
    const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs'), { makeSeeder } = await import('../../test/harness/seed.mjs')
    prisma = harnessClient(); makeSeeder(prisma)
    ;({ IPC } = await import('@shared/ipc')); const receipt = await import('@shared/receipt'); DEFAULT_MANAGER_PASSWORD = receipt.DEFAULT_MANAGER_PASSWORD; const { SETTING_KEYS } = receipt
    // A backup of the temporary shop database, registered as an imported backup.
    id = 'imported-isolated.db'; const backup = join(importDir, id)
    await prisma.setting.upsert({ where: { key: 'restore.test.marker' }, create: { key: 'restore.test.marker', value: 'backup' }, update: { value: 'backup' } })
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)'); copyFileSync(dbPath, backup)
    await prisma.setting.upsert({ where: { key: 'restore.test.marker' }, create: { key: 'restore.test.marker', value: 'current' }, update: { value: 'current' } })
    const imports = JSON.stringify([{ id, fileName: id, size: statSync(backup).size, at: new Date().toISOString() }])
    await prisma.setting.upsert({ where: { key: SETTING_KEYS.backupImports }, create: { key: SETTING_KEYS.backupImports, value: imports }, update: { value: imports } })

    // Owner setup exactly as the setup page's configure does, then app start.
    setup = await import('../../src/main/services/cloud/remoteSetup.ts')
    setup.createRemoteSetupFiles(dir, { origin: ORIGIN, port }, electron.safeStorage, setup.restoreMarkerHash(files.marker))
    setup.writeRemoteSetting(dir, true)
    host = await import('../../src/main/services/CloudSyncService.ts')
    reg = await import('../../src/main/services/RemoteGrantRegistry.ts')
    session = await import('../../src/main/services/panelSession.ts'); ({ openCloudStateStore } = await import('../../src/main/services/cloud/cloudState.ts'))
    const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
    registerIpcHandlers()
  }

  test('closing the app while the hub is still stopping waits for the stop before quitting', async () => {
    await prepare()
    await host.startCloudSync({ owner: OWNER })
    assert.equal(host.remoteHostState().running, true, host.remoteHostState().error)
    assert.equal(existsSync(files.stateLock), true); assert.equal(existsSync(files.hubLock), true)
    const hook = events['before-quit']?.[0]; assert.equal(typeof hook, 'function')
    const stopping = host.stopCloudSync()
    let prevented = false
    hook({ preventDefault() { prevented = true } })
    assert.equal(prevented, true, 'quit is held while the stop is in progress')
    await stopping
    await until(() => quits.length === 1, 'app.quit after the stop')
    assert.deepEqual(quits[0], { stateLock: false, running: false })
    // A second before-quit (from that app.quit) passes through.
    let again = false; hook({ preventDefault() { again = true } }); assert.equal(again, false)
  })

  test('a failed restore through the backup IPC also stops the hub and releases both locks; the next start resumes', async () => {
    assert.ok(files, 'setup ran')
    await host.startCloudSync()
    assert.equal(host.remoteHostState().running, true, host.remoteHostState().error)
    assert.equal(host.remoteHostState().error, null)
    // Unknown backup: fenced by the coordination, then refused by BackupService.
    const failed = await handlers.get(IPC.backupApply)({ sender: { id: 42, isDestroyed: () => false, once: () => {} } }, { id: 'missing-backup.db', mode: 'replace', managerPassword: DEFAULT_MANAGER_PASSWORD })
    assert.equal(failed.ok, false, JSON.stringify(failed))
    await until(() => !host.remoteHostState().running && !host.remoteHostState().busy, 'hub stopped after the failed restore')
    assert.equal(existsSync(files.stateLock), false); assert.equal(existsSync(files.hubLock), false)
    assert.equal(host.remoteHostState().error, 'Remote stopped after backup restore'); assert.equal(host.remoteHostState().needsRestart, false)
    assert.equal(await refused(port), true)
    assert.equal(exits.length, 0, 'no relaunch for a failed restore')
    // The owner's next start (setup page or app start) resumes in the fenced epoch's successor.
    await host.startCloudSync()
    assert.equal(host.remoteHostState().running, true, host.remoteHostState().error); assert.equal(host.remoteHostState().error, null)
  })

  test('a full restore through the backup IPC leaves no lock at app.exit, and the relaunch starts the hub in a new epoch', async () => {
    assert.ok(files, 'setup ran')
    // App start again (the owner exists now), as after the restart above.
    await host.startCloudSync()
    assert.equal(host.remoteHostState().running, true, host.remoteHostState().error)

    // A phone approval opens a panel; another request is still waiting.
    const login = await call(port, 'POST', '/api/login', { username: OWNER.username, password: OWNER.password })
    assert.equal(login.status, 200)
    const asked = reg.requestCode('products', 42), waiting = reg.requestCode('settings', 43)
    await until(async () => (await call(port, 'GET', '/api/requests', undefined, login.cookie)).body?.requests?.some(r => r.requestId === asked.requestId), 'request mirrored to the phone')
    assert.equal((await call(port, 'POST', '/api/approve', { requestId: asked.requestId, code: asked.code, pin: OWNER.pin }, login.cookie)).status, 200)
    assert.equal(reg.consumeOneShot(42, 'products', asked.gt.slice(3)), true); assert.equal(session.isPanelUnlocked('products', 42), true)

    // Full replacement through the real backup IPC.
    const result = await handlers.get(IPC.backupApply)({ sender: { id: 42, isDestroyed: () => false, once: () => {} } }, { id, mode: 'replace', managerPassword: DEFAULT_MANAGER_PASSWORD })
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.willRestart, true)
    assert.equal(reg.isGrantActiveForWindow('products', 42), false); assert.equal(session.isPanelUnlocked('products', 42), false)
    assert.equal(reg.getRequestStatus(43, 'settings', waiting.requestId), 'UNAVAILABLE')
    const marker = setup.restoreMarkerHash(files.marker); assert.match(marker, /^[0-9a-f]{64}$/)

    // BackupService exits ~1.2 s later; by then the hub is stopped and both locks are gone.
    await until(() => exits.length === 1, 'BackupService exited the application')
    assert.deepEqual(exits[0], { code: 0, stateLock: false, hubLock: false, running: false, busy: false })
    assert.equal(await refused(port), true, 'no listener remains')
    assert.equal(host.remoteHostState().error, 'Remote stopped after backup restore')
    const fenced = openCloudStateStore(files.state); let fencedEpoch
    try { fencedEpoch = fenced.load().epoch } finally { fenced.close() }

    // Relaunch: a fresh process starts the hub at app start, in a new epoch for the restore marker.
    const child = spawn(process.execPath, ['--import', './test/harness/register.mjs', fileURLToPath(import.meta.url)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MAHAK_RELAUNCH_DIR: dir, MAHAK_RELAUNCH_PORT: String(port), MAHAK_RELAUNCH_SECRET: secret.toString('hex') } })
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c)
    const code = await new Promise(resolve => { const timer = setTimeout(() => child.kill(), 60000); child.once('exit', c => { clearTimeout(timer); resolve(c) }) })
    const line = out.split('\n').find(l => l.startsWith('RELAUNCH '))
    assert.ok(line, `relaunch report missing (exit ${code}): ${err.slice(-800)}`)
    const report = JSON.parse(line.slice('RELAUNCH '.length))
    assert.equal(report.running, true, `relaunched hub did not start: ${report.error}`)
    assert.equal(report.login, 200); assert.equal(report.stopError, undefined)
    assert.equal(report.restoreMarker, marker); assert.notEqual(report.epoch, fencedEpoch)
    assert.equal(existsSync(files.stateLock), false); assert.equal(existsSync(files.hubLock), false)
  })

  test.after(async () => {
    try { await host?.stopCloudSync() } catch {}
    try { reg?.revokeAll() } catch {}
    await prisma?.$disconnect().catch(() => {})
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
}
