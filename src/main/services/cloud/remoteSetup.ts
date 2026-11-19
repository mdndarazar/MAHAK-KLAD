/**
 * Owner provisioning files for the desktop remote hub. Main process only: no
 * Electron import, no network and no shop database access. Every secret stays
 * out of the files written here except the transport keys, which are encrypted
 * by the caller-supplied secure storage (Electron safeStorage / Windows DPAPI).
 *
 * Creation is explicit and never repairs: an existing remote directory is never
 * overwritten, and a partial creation is reported as `partial` until the owner
 * retires it (rename, not delete) and starts again.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCloudStateStore } from './cloudState'
import { createRemoteTransportVault } from './remoteTransportVault'
import { normalizeMobileOrigins } from './mobileOrigins'

/** Fixed loopback port that the owner's overlay/tunnel forwards to. */
export const REMOTE_DEFAULT_PORT = 47821
export type RemoteSetupErrorCode = 'INVALID_INPUT' | 'ORIGIN' | 'PORT' | 'USERNAME' | 'PASSWORD' | 'PIN' | 'ALREADY_CONFIGURED'
export class RemoteSetupError extends Error {
  readonly code: RemoteSetupErrorCode
  constructor(code: RemoteSetupErrorCode) { super(`Remote setup rejected: ${code}`); this.code = code }
}
export type RemoteOwner = { username: string; password: string; pin: string }
type SafeStorage = Parameters<typeof createRemoteTransportVault>[2]

export function remotePaths(userData: string) {
  const root = join(userData, 'remote-hub'), state = join(root, 'state'), hub = join(root, 'hub')
  return {
    root, state, hub, config: join(root, 'config.json'), key: join(root, 'remote-transport-key.v1'),
    hubDatabase: join(hub, 'remote-hub.sqlite'), settings: join(userData, 'remote-settings.json'),
    stateFiles: ['cloud-state.json', 'revocation-ledger.json', 'revocation-ledger.initialized', 'grant-replay-ledger.json', 'grant-replay-ledger.initialized'].map(name => join(state, name))
  }
}

/** Same rule as the hub identity: NFC, trimmed, lowercase, 3-64 letters,
 * digits, `_`, `.` or `-`. The child validates again; this only fails early. */
export function normalizeRemoteUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.normalize('NFC').trim().toLowerCase()
  return name.length >= 3 && name.length <= 64 && /^[\p{L}\p{N}_.-]+$/u.test(name) ? name : null
}

export function validateRemoteOwner(input: { username?: unknown; password?: unknown; pin?: unknown }): RemoteOwner {
  const username = normalizeRemoteUsername(input.username)
  if (!username) throw new RemoteSetupError('USERNAME')
  const password = input.password
  if (typeof password !== 'string' || password.length < 10 || Buffer.byteLength(password, 'utf8') > 128) throw new RemoteSetupError('PASSWORD')
  const pin = input.pin
  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin) || pin === password) throw new RemoteSetupError('PIN')
  return { username, password, pin }
}

export function validateRemoteEndpoint(input: { origin?: unknown; port?: unknown }): { origin: string; port: number } {
  let origin: string
  try { origin = normalizeMobileOrigins(input.origin, undefined)[0] } catch { throw new RemoteSetupError('ORIGIN') }
  const port = input.port
  if (!Number.isSafeInteger(port) || (port as number) < 1024 || (port as number) > 65535) throw new RemoteSetupError('PORT')
  return { origin, port: port as number }
}

/** Strict `{version:1,origin[,port]}`. A configuration without a port uses an
 * ephemeral loopback port (not reachable by a tunnel); setup always writes one. */
export function readRemoteConfig(path: string): { origin: string; port: number | null } {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 2048) throw new Error('Remote configuration unavailable')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('Invalid remote configuration') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote configuration')
  const config = value as Record<string, unknown>, keys = Object.keys(config).sort().join(',')
  if ((keys !== 'origin,version' && keys !== 'origin,port,version') || config.version !== 1) throw new Error('Invalid remote configuration')
  if (config.port !== undefined && (!Number.isSafeInteger(config.port) || (config.port as number) < 1024 || (config.port as number) > 65535)) throw new Error('Invalid remote configuration')
  return { origin: normalizeMobileOrigins(config.origin, undefined)[0], port: config.port === undefined ? null : config.port as number }
}

/** SHA-256 of the restore marker written by BackupService, or null if absent. */
export function restoreMarkerHash(path: string): string | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Invalid restore marker')
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function kind(path: string): 'missing' | 'file' | 'directory' | 'other' {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'other'
    if (stat.isFile()) return stat.nlink === 1 ? 'file' : 'other'
    return stat.isDirectory() ? 'directory' : 'other'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other'
  }
}

/** File-level view for the setup page; never returns secrets or key material. */
export function remoteSetupFiles(userData: string): { configured: boolean; partial: boolean; ownerRequired: boolean; origin: string | null; port: number | null } {
  const paths = remotePaths(userData)
  const root = kind(paths.root)
  if (root === 'missing') return { configured: false, partial: false, ownerRequired: false, origin: null, port: null }
  let config: { origin: string; port: number | null } | null = null
  try { config = readRemoteConfig(paths.config) } catch {}
  const complete = root === 'directory' && kind(paths.state) === 'directory' && kind(paths.hub) === 'directory' && config !== null &&
    kind(paths.key) === 'file' && paths.stateFiles.every(path => kind(path) === 'file')
  const hub = complete ? kind(paths.hubDatabase) : 'other'
  return {
    configured: complete, partial: !complete, ownerRequired: complete && hub === 'missing',
    origin: config?.origin ?? null, port: config?.port ?? null
  }
}

function writeAtomic(directory: string, path: string, payload: string): void {
  const temporary = join(directory, `.remote-${randomBytes(12).toString('hex')}.tmp`)
  let fd: number | undefined, created = false
  try {
    fd = openSync(temporary, 'wx', 0o600); created = true
    writeFileSync(fd, payload, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, path); created = false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    if (created) try { unlinkSync(temporary) } catch {}
  }
}

/** Creates the store identity, both ledgers, the encrypted transport keys and
 * finally the configuration. Refuses any existing remote directory. */
export function createRemoteSetupFiles(userData: string, endpoint: { origin: string; port: number }, storage: SafeStorage, restoreMarker: string | null): { storeId: string } {
  const { origin, port } = validateRemoteEndpoint(endpoint)
  if (restoreMarker !== null && (typeof restoreMarker !== 'string' || !/^[0-9a-f]{64}$/.test(restoreMarker))) throw new RemoteSetupError('INVALID_INPUT')
  const paths = remotePaths(userData)
  if (kind(userData) !== 'directory') throw new Error('Application data directory unavailable')
  if (kind(paths.root) !== 'missing') throw new RemoteSetupError('ALREADY_CONFIGURED')
  try { mkdirSync(paths.root, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RemoteSetupError('ALREADY_CONFIGURED')
    throw error
  }
  mkdirSync(paths.state, { mode: 0o700 }); mkdirSync(paths.hub, { mode: 0o700 })
  const storeId = `store_${randomBytes(16).toString('hex')}`
  const store = openCloudStateStore(paths.state)
  try {
    store.save({ version: 1, storeId, epoch: randomUUID(), lastAcked: 0, anchorHash: '', restoreMarker })
    store.initializeRevocationLedger(); store.initializeGrantReplayLedger()
  } finally { store.close() }
  createRemoteTransportVault(paths.root, storeId, storage).create()
  // Written last: an interrupted creation stays `partial`, never `configured`.
  writeAtomic(paths.root, paths.config, JSON.stringify({ version: 1, origin, port }))
  return { storeId }
}

/** Owner opt-in; read back by remoteSettingEnabled (exact `{"enabled":true}`). */
export function writeRemoteSetting(userData: string, enabled: boolean): void {
  if (typeof enabled !== 'boolean' || kind(userData) !== 'directory') throw new Error('Remote setting unavailable')
  writeAtomic(userData, remotePaths(userData).settings, JSON.stringify({ enabled }))
}

/** Only while the hub is confirmed stopped: renames (never deletes) the remote
 * directory so a fresh setup can start. Returns the new name, or null if absent. */
export function retireRemoteSetup(userData: string): string | null {
  const paths = remotePaths(userData)
  if (kind(paths.root) === 'missing') return null
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  const name = `remote-hub-removed-${stamp}-${randomBytes(3).toString('hex')}`
  renameSync(paths.root, join(userData, name))
  return name
}
