/**
 * Local sync-state building block, not started by the application. This stores
 * no shop data and never opens shop.db. A future agent must hold this lock for
 * its entire lifetime and must not advance lastAcked without a durable remote
 * acknowledgment. Restore detection, outbox and transport are not implemented.
 *
 * A leftover lock after a crash intentionally blocks startup: do not break it
 * automatically based on PID/time (PID reuse and a slow process are unsafe).
 * Atomic rename and file fsync protect against partial writes in ordinary process
 * failures; power-loss durability and Windows behavior still require real tests.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CloudState = {
  version: 1
  storeId: string
  epoch: string
  lastAcked: number
  anchorHash: string
  restoreMarker: string | null
}

const FIELDS = ['version', 'storeId', 'epoch', 'lastAcked', 'anchorHash', 'restoreMarker'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[0-9a-f]{64}$/
const MAX_STATE_BYTES = 8192

function validated(input: unknown): CloudState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid cloud state')
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== FIELDS.length || FIELDS.some((key) => !Object.hasOwn(value, key)) ||
      value.version !== 1 || typeof value.storeId !== 'string' || !ID.test(value.storeId) ||
      typeof value.epoch !== 'string' || !UUID.test(value.epoch) ||
      !Number.isSafeInteger(value.lastAcked) || (value.lastAcked as number) < 0 ||
      typeof value.anchorHash !== 'string' ||
      (value.lastAcked === 0 ? value.anchorHash !== '' : !HASH.test(value.anchorHash)) ||
      (value.restoreMarker !== null && (typeof value.restoreMarker !== 'string' || !HASH.test(value.restoreMarker)))) {
    throw new Error('Invalid cloud state')
  }
  return {
    version: 1, storeId: value.storeId as string, epoch: value.epoch as string,
    lastAcked: value.lastAcked as number, anchorHash: value.anchorHash as string,
    restoreMarker: value.restoreMarker as string | null
  }
}

export function openCloudStateStore(directory: string) {
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('Invalid state directory')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const statePath = join(directory, 'cloud-state.json')
  const lockPath = join(directory, 'cloud-state.lock')
  const token = randomBytes(32).toString('hex')
  let lockFd: number | undefined
  try {
    lockFd = openSync(lockPath, 'wx', 0o600)
    writeFileSync(lockFd, token, 'utf8')
    fsyncSync(lockFd)
  } catch (error) {
    // If our lock was created but could not be initialized, do not leave a
    // seemingly usable lock. Never unlink an existing lock from another owner.
    if (lockFd !== undefined) {
      try { closeSync(lockFd) } catch {}
      try { unlinkSync(lockPath) } catch {}
    }
    throw error
  }
  let closed = false, ownershipLost = false
  const ownsLock = (): boolean => {
    try { return lstatSync(lockPath).isFile() && readFileSync(lockPath, 'utf8') === token } catch { return false }
  }
  const ensureOpen = () => {
    if (closed) throw new Error('Cloud state store is closed')
    // Detect an accidentally removed or replaced lock before using state. This
    // is not protection against a malicious concurrent filesystem actor.
    if (ownershipLost || !ownsLock()) {
      ownershipLost = true
      throw new Error('Cloud state lock ownership lost')
    }
  }
  function load(): CloudState | null {
    ensureOpen()
    let stat
    try { stat = lstatSync(statePath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('Invalid cloud state file')
    let decoded: unknown
    try { decoded = JSON.parse(readFileSync(statePath, 'utf8')) }
    catch { throw new Error('Invalid cloud state file') }
    return validated(decoded)
  }
  function save(value: CloudState): void {
    ensureOpen()
    const state = validated(value)
    const payload = JSON.stringify(state)
    if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) throw new Error('Cloud state is too large')
    // Never overwrite a corrupt state, change store identity, or rewind an epoch.
    const previous = load()
    if (previous && (previous.storeId !== state.storeId ||
        (previous.epoch === state.epoch && (state.lastAcked < previous.lastAcked ||
          (state.lastAcked === previous.lastAcked && state.anchorHash !== previous.anchorHash) ||
          state.restoreMarker !== previous.restoreMarker)) ||
        (previous.epoch !== state.epoch && state.lastAcked !== 0))) {
      throw new Error('Invalid cloud state transition')
    }
    const tmpPath = join(directory, `.cloud-state-${randomBytes(16).toString('hex')}.tmp`)
    let fd: number | undefined
    let created = false
    try {
      fd = openSync(tmpPath, 'wx', 0o600)
      created = true
      writeFileSync(fd, payload, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmpPath, statePath)
      created = false
    } finally {
      if (fd !== undefined) try { closeSync(fd) } catch {}
      if (created) try { unlinkSync(tmpPath) } catch {}
    }
  }
  function close(): void {
    if (closed) return
    // A replaced or missing lock is not ours to remove. Fail closed.
    const owned = !ownershipLost && ownsLock()
    closeSync(lockFd!)
    closed = true
    if (!owned) throw new Error('Cloud state lock ownership lost')
    unlinkSync(lockPath)
  }
  return { load, save, close }
}
