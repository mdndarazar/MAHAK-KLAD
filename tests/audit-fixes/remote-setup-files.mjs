import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Owner provisioning files on temporary directories only. Secure storage is an
// AES-GCM stand-in for Electron safeStorage/DPAPI; no Electron, Windows ACL,
// shop database, network or phone is involved.
const {
  REMOTE_DEFAULT_PORT, RemoteSetupError, createRemoteSetupFiles, readRemoteConfig, remoteSetupFiles, retireRemoteSetup,
  validateRemoteEndpoint, validateRemoteOwner, writeRemoteSetting, restoreMarkerHash
} = await import('../../src/main/services/cloud/remoteSetup.ts')
const { remoteSettingEnabled } = await import('../../src/main/services/cloud/remoteSettings.ts')
const { openCloudStateStore } = await import('../../src/main/services/cloud/cloudState.ts')
const { createRemoteTransportVault } = await import('../../src/main/services/cloud/remoteTransportVault.ts')

const secret = randomBytes(32)
const storage = (available = true) => ({ isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret, iv), out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') } })
const code = (fn, expected) => assert.throws(fn, error => error instanceof RemoteSetupError && error.code === expected)
const temp = () => mkdtempSync(join(tmpdir(), 'mahak-remote-setup-'))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')

test('owner and endpoint validation matches the hub identity rules and fails early', () => {
  assert.equal(REMOTE_DEFAULT_PORT, 47821)
  assert.deepEqual(validateRemoteEndpoint({ origin: 'https://Shop.Example', port: 47821 }), { origin: 'https://shop.example', port: 47821 })
  for (const origin of ['http://shop.example', 'https://shop.example/path', 'https://user:pw@shop.example', 'shop.example', '', 42]) code(() => validateRemoteEndpoint({ origin, port: 47821 }), 'ORIGIN')
  for (const port of [80, 1023, 65536, '47821', 47821.5, null, undefined]) code(() => validateRemoteEndpoint({ origin: 'https://shop.example', port }), 'PORT')
  assert.deepEqual(validateRemoteOwner({ username: ' Owner.One ', password: 'long-enough-1', pin: '246810' }), { username: 'owner.one', password: 'long-enough-1', pin: '246810' })
  for (const username of ['ab', 'bad name', 'x'.repeat(65), 'semi;colon', 7]) code(() => validateRemoteOwner({ username, password: 'long-enough-1', pin: '246810' }), 'USERNAME')
  for (const password of ['short-9ch', 'ب'.repeat(65), 1234567890]) code(() => validateRemoteOwner({ username: 'owner', password, pin: '246810' }), 'PASSWORD')
  for (const pin of ['12345', '1234567', 'abcdef', '۱۲۳۴۵۶', 123456]) code(() => validateRemoteOwner({ username: 'owner', password: 'long-enough-1', pin }), 'PIN')
})

test('setup creates identity, both ledgers, encrypted keys and finally the configuration; a second setup is refused', () => {
  const dir = temp()
  try {
    assert.deepEqual(remoteSetupFiles(dir), { configured: false, partial: false, ownerRequired: false, origin: null, port: null })
    const { storeId } = createRemoteSetupFiles(dir, { origin: 'https://shop.example', port: 47900 }, storage(), null)
    assert.match(storeId, /^store_[0-9a-f]{32}$/)
    const root = join(dir, 'remote-hub')
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')), { version: 1, origin: 'https://shop.example', port: 47900 })
    assert.deepEqual(readRemoteConfig(join(root, 'config.json')), { origin: 'https://shop.example', port: 47900 })
    const store = openCloudStateStore(join(root, 'state'))
    try {
      const state = store.load()
      assert.equal(state.storeId, storeId); assert.equal(state.lastAcked, 0); assert.equal(state.anchorHash, ''); assert.equal(state.restoreMarker, null)
      assert.match(state.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(store.openRevocationLedger().load(), null)
      assert.equal(typeof store.openGrantReplayLedger().consume, 'function')
    } finally { store.close() }
    const keys = createRemoteTransportVault(root, storeId, storage()).load()
    assert.equal(keys.auditKey.length, 32); assert.equal(keys.commandKey.length, 32); assert.notDeepEqual(keys.auditKey, keys.commandKey)
    assert.equal(readFileSync(join(root, 'remote-transport-key.v1')).includes(keys.auditKey.toString('hex')), false, 'keys are encrypted at rest')
    if (process.platform !== 'win32') {
      for (const path of [root, join(root, 'state'), join(root, 'hub')]) assert.equal(statSync(path).mode & 0o777, 0o700)
      for (const path of [join(root, 'config.json'), join(root, 'remote-transport-key.v1')]) assert.equal(statSync(path).mode & 0o077, 0)
    }
    assert.deepEqual(remoteSetupFiles(dir), { configured: true, partial: false, ownerRequired: true, origin: 'https://shop.example', port: 47900 })
    writeFileSync(join(root, 'hub', 'remote-hub.sqlite'), '')
    assert.equal(remoteSetupFiles(dir).ownerRequired, false)
    const before = [sha(join(root, 'config.json')), sha(join(root, 'state', 'cloud-state.json')), sha(join(root, 'remote-transport-key.v1'))]
    code(() => createRemoteSetupFiles(dir, { origin: 'https://other.example', port: 47901 }, storage(), null), 'ALREADY_CONFIGURED')
    assert.deepEqual([sha(join(root, 'config.json')), sha(join(root, 'state', 'cloud-state.json')), sha(join(root, 'remote-transport-key.v1'))], before)
    assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), [])

    // The current restore marker is adopted at setup, so the first start does
    // not treat an old restore as a new one.
    const other = temp()
    try {
      mkdirSync(join(other, 'backups')); writeFileSync(join(other, 'backups', 'last-restore.txt'), 'restored 1404')
      const marker = restoreMarkerHash(join(other, 'backups', 'last-restore.txt'))
      assert.match(marker, /^[0-9a-f]{64}$/)
      createRemoteSetupFiles(other, { origin: 'https://shop.example', port: 47900 }, storage(), marker)
      const s2 = openCloudStateStore(join(other, 'remote-hub', 'state'))
      try { assert.equal(s2.load().restoreMarker, marker) } finally { s2.close() }
      assert.equal(restoreMarkerHash(join(other, 'backups', 'missing.txt')), null)
    } finally { rmSync(other, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an interrupted setup stays partial, is never repaired, and is retired by rename only', () => {
  const dir = temp()
  try {
    assert.throws(() => createRemoteSetupFiles(dir, { origin: 'https://shop.example', port: 47900 }, storage(false), null), /Secure storage unavailable/)
    const partial = remoteSetupFiles(dir)
    assert.equal(partial.configured, false); assert.equal(partial.partial, true); assert.equal(partial.ownerRequired, false)
    assert.equal(existsSync(join(dir, 'remote-hub', 'config.json')), false, 'configuration is written last')
    code(() => createRemoteSetupFiles(dir, { origin: 'https://shop.example', port: 47900 }, storage(), null), 'ALREADY_CONFIGURED')
    const name = retireRemoteSetup(dir)
    assert.match(name, /^remote-hub-removed-[0-9]{14}-[0-9a-f]{6}$/)
    assert.equal(existsSync(join(dir, 'remote-hub')), false)
    assert.equal(existsSync(join(dir, name, 'state', 'cloud-state.json')), true, 'retired files are kept, not deleted')
    assert.equal(retireRemoteSetup(dir), null)
    assert.deepEqual(remoteSetupFiles(dir), { configured: false, partial: false, ownerRequired: false, origin: null, port: null })
    createRemoteSetupFiles(dir, { origin: 'https://shop.example', port: 47900 }, storage(), null)
    assert.equal(remoteSetupFiles(dir).configured, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the owner opt-in is written atomically and read back only as exact {"enabled":true}', () => {
  const dir = temp()
  try {
    assert.equal(remoteSettingEnabled(dir), false)
    writeRemoteSetting(dir, true)
    assert.equal(readFileSync(join(dir, 'remote-settings.json'), 'utf8'), '{"enabled":true}'); assert.equal(remoteSettingEnabled(dir), true)
    writeRemoteSetting(dir, false)
    assert.equal(readFileSync(join(dir, 'remote-settings.json'), 'utf8'), '{"enabled":false}'); assert.equal(remoteSettingEnabled(dir), false)
    assert.throws(() => writeRemoteSetting(dir, 'true'), /Remote setting unavailable/)
    assert.throws(() => writeRemoteSetting(join(dir, 'missing'), true), /Remote setting unavailable/)
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the configuration reader is strict; a missing port means an ephemeral port', () => {
  const dir = temp(), path = join(dir, 'config.json')
  try {
    writeFileSync(path, JSON.stringify({ version: 1, origin: 'https://shop.example' }))
    assert.deepEqual(readRemoteConfig(path), { origin: 'https://shop.example', port: null })
    for (const value of [{ version: 1, origin: 'https://shop.example', port: 80 }, { version: 1, origin: 'https://shop.example', port: '47821' },
      { version: 2, origin: 'https://shop.example' }, { version: 1, origin: 'http://shop.example' }, { version: 1, origin: 'https://shop.example', extra: true }, [1]]) {
      writeFileSync(path, JSON.stringify(value)); assert.throws(() => readRemoteConfig(path))
    }
    writeFileSync(path, '{not json'); assert.throws(() => readRemoteConfig(path), /Invalid remote configuration/)
    writeFileSync(path, JSON.stringify({ version: 1, origin: 'https://shop.example', port: 47821 }))
    linkSync(path, join(dir, 'second-link.json'))
    assert.throws(() => readRemoteConfig(path), /Remote configuration unavailable/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
