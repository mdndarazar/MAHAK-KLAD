/**
 * File-level part of the composite shop database fingerprint used by the
 * experimental remote hub. The supervisor checks it inside every restore-marker
 * read and adds the last acknowledged audit anchor and an observed audit
 * high-water row, before every approval, claim and outbound send. Any change or
 * read failure is treated as a restore by the caller (revoke, stop sync, fence
 * the epoch); nothing here repairs or adopts a different database.
 *
 * Checked here, without opening SQLite or writing anything:
 *  - file identity: a regular single-link file on the same device and inode;
 *  - fixed SQLite header fields: magic, page size, text encoding, application id;
 *  - the header file-change counter never decreases. In rollback-journal mode
 *    SQLite increments it on every committed write (VACUUM included), so a
 *    backup copied back over the live file carries an older value.
 * The counter is compared and adopted only while no `-journal` file is listed
 * before and after the read: while a commit is writing pages, or after a crash
 * left a hot journal, page 1 can hold a counter that the journal rollback will
 * undo. The journal itself is never opened (directory listing only), so
 * SQLite's own journal create/delete is not disturbed.
 *
 * NOT detected: WAL/MEMORY/OFF journal modes (the counter is then not reliable
 * and only the other checks apply); an external writer editing rows in place;
 * a replacement crafted to match these values. Not a content hash, not a lock.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
type AuditRow = { id: number; at: string; action: string; entity: string }
/** Same row hash as the audit anchor of the sync state. */
export const auditRowHash = (row: AuditRow): string =>
  createHash('sha256').update(JSON.stringify([row.id, row.at, row.action, row.entity]), 'utf8').digest('hex')
export type DatabaseHeader = { pageSize: number; changeCounter: number; textEncoding: number; applicationId: number }

/** Reads only the 100-byte header through a short-lived read-only handle. */
export function readDatabaseHeader(path: string): DatabaseHeader {
  const buffer = Buffer.alloc(100)
  const fd = openSync(path, 'r')
  let read = 0
  try { read = readSync(fd, buffer, 0, 100, 0) } finally { closeSync(fd) }
  if (read !== 100 || !buffer.subarray(0, 16).equals(MAGIC)) throw new Error('Invalid database header')
  const raw = buffer.readUInt16BE(16), pageSize = raw === 1 ? 65536 : raw
  const textEncoding = buffer.readUInt32BE(56)
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || textEncoding < 1 || textEncoding > 3) throw new Error('Invalid database header')
  return { pageSize, changeCounter: buffer.readUInt32BE(24), textEncoding, applicationId: buffer.readInt32BE(68) }
}

export function createDatabaseFingerprint(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid database path')
  const directory = dirname(path), journal = `${basename(path)}-journal`
  const identity = (): string => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.ino === 0n) throw new Error('Database identity unavailable')
    return `${stat.dev}:${stat.ino}`
  }
  const journalListed = (): boolean => {
    const names = readdirSync(directory)
    return process.platform === 'win32' ? names.some(name => name.toLowerCase() === journal.toLowerCase()) : names.includes(journal)
  }
  const initialIdentity = identity()
  const initialHeader = readDatabaseHeader(path)
  let committedCounter: number | null = null
  function verify(): void {
    if (identity() !== initialIdentity) throw new Error('Database identity changed')
    const quietBefore = !journalListed()
    const header = readDatabaseHeader(path)
    const quietAfter = !journalListed()
    if (identity() !== initialIdentity) throw new Error('Database identity changed')
    if (header.pageSize !== initialHeader.pageSize || header.textEncoding !== initialHeader.textEncoding ||
        header.applicationId !== initialHeader.applicationId) throw new Error('Database header changed')
    // A transaction is (or may have been) active: neither compare nor adopt.
    if (!quietBefore || !quietAfter) return
    if (committedCounter !== null && header.changeCounter < committedCounter) throw new Error('Database change counter decreased')
    committedCounter = header.changeCounter
  }
  verify()
  /** Last change counter read while no journal was listed; null if none yet. */
  return { verify, committedCounter: (): number | null => committedCounter }
}

/**
 * Baseline persisted by the running hub for one store and epoch, so that a
 * replacement while the application was closed (marker unchanged) is detected
 * at the next startup. Missing means "no information"; anything malformed
 * fails closed. Written only by the process holding the cloud state lock.
 */
export type FingerprintBaseline = { version: 1; storeId: string; epoch: string; counter: number; highWaterId: number; highWaterHash: string }
function validBaseline(value: unknown): FingerprintBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid database fingerprint')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'counter,epoch,highWaterHash,highWaterId,storeId,version' || v.version !== 1 ||
      typeof v.storeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.storeId) || typeof v.epoch !== 'string' || !UUID.test(v.epoch) ||
      !Number.isSafeInteger(v.counter) || (v.counter as number) < 0 || (v.counter as number) > 0xffffffff ||
      !Number.isSafeInteger(v.highWaterId) || (v.highWaterId as number) < 0 || typeof v.highWaterHash !== 'string' ||
      (v.highWaterId === 0 ? v.highWaterHash !== '' : !HASH.test(v.highWaterHash))) throw new Error('Invalid database fingerprint')
  return { version: 1, storeId: v.storeId, epoch: v.epoch, counter: v.counter as number, highWaterId: v.highWaterId as number, highWaterHash: v.highWaterHash }
}
export function readFingerprintBaseline(path: string): FingerprintBaseline | null {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024) throw new Error('Invalid database fingerprint')
  let decoded: unknown
  try { decoded = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('Invalid database fingerprint') }
  return validBaseline(decoded)
}
export function writeFingerprintBaseline(path: string, value: FingerprintBaseline): void {
  const payload = JSON.stringify(validBaseline(value))
  const temporary = join(dirname(path), `.database-fingerprint-${randomBytes(16).toString('hex')}.tmp`)
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

/**
 * Startup comparison against the baseline the previous run persisted. True:
 * the file is not the database that baseline came from (older change counter,
 * or the recorded high-water audit row is missing or different), so the caller
 * must start a new epoch. Read failures throw (startup stays fail-closed).
 */
export async function databaseChangedSince(path: string, baseline: FingerprintBaseline, auditTail: (id: number) => Promise<AuditRow[]>): Promise<boolean> {
  const valid = validBaseline(baseline)
  const counter = createDatabaseFingerprint(path).committedCounter()
  if (counter !== null && counter < valid.counter) return true
  if (valid.highWaterId > 0) {
    const rows = await auditTail(valid.highWaterId)
    if (!Array.isArray(rows) || rows.length > 2) throw new Error('Invalid audit tail')
    const first = rows[0]
    if (!first || first.id !== valid.highWaterId || typeof first.at !== 'string' || typeof first.action !== 'string' ||
        typeof first.entity !== 'string' || auditRowHash(first) !== valid.highWaterHash) return true
  }
  return false
}
