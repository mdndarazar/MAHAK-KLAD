/**
 * Experimental at-rest storage for two independently generated hub transport
 * keys. It does not start remote services or provision a mobile account. The
 * caller MUST supply Electron's trusted safeStorage (Windows DPAPI on Windows),
 * a private app-owned directory and a stable store identifier. Never substitute
 * an identity/no-op protector. Windows ACLs, DPAPI recovery/backup and actual
 * Electron packaging still need platform tests before this is wired into the app.
 *
 * Losing, truncating, corrupting, or copying this encrypted file to another OS
 * user must fail closed; it is never silently overwritten or regenerated. A
 * failed create may leave an unusable partial file requiring explicit recovery.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

type SafeStorage = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}
type Material = { storeId: string; auditKey: Buffer; commandKey: Buffer }
const STORE = /^[A-Za-z0-9_-]{1,128}$/
const HEX = /^[a-f0-9]{64}$/
const MAX_BYTES = 16384
const FILENAME = 'remote-transport-key.v1'
function checkStorage(storage: SafeStorage) {
  if (!storage || typeof storage.isEncryptionAvailable !== 'function' || typeof storage.encryptString !== 'function' ||
      typeof storage.decryptString !== 'function' || storage.isEncryptionAvailable() !== true) throw new Error('Secure storage unavailable')
  // Electron on Linux can report available while using its unencrypted fallback.
  // Other platforms do not necessarily expose this Linux-only API.
  if (process.platform === 'linux' && (typeof storage.getSelectedStorageBackend !== 'function' ||
      !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(storage.getSelectedStorageBackend()))) {
    throw new Error('Secure storage unavailable')
  }
}
function decode(value: string, storeId: string): Material {
  let data: unknown
  try { data=JSON.parse(value) } catch { throw new Error('Invalid encrypted transport key') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid encrypted transport key')
  const v=data as Record<string,unknown>
  if (Object.keys(v).sort().join(',') !== 'auditKey,commandKey,storeId,version' || v.version !== 1 || v.storeId !== storeId ||
      typeof v.auditKey !== 'string' || !HEX.test(v.auditKey) || typeof v.commandKey !== 'string' || !HEX.test(v.commandKey)) throw new Error('Invalid encrypted transport key')
  const auditKey=Buffer.from(v.auditKey,'hex'), commandKey=Buffer.from(v.commandKey,'hex')
  if (timingSafeEqual(auditKey,commandKey)) throw new Error('Invalid encrypted transport key')
  return {storeId,auditKey,commandKey}
}

/** Explicit create is separate from load; no fallback from a load failure. */
export function createRemoteTransportVault(directory: string, storeId: string, storage: SafeStorage) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || typeof storeId !== 'string' || !STORE.test(storeId)) throw new Error('Invalid vault configuration')
  const resolved=realpathSync(directory)
  if (!lstatSync(resolved).isDirectory()) throw new Error('Invalid vault directory')
  const path=join(resolved,FILENAME)
  function load(): Material {
    checkStorage(storage)
    const initial=lstatSync(path)
    if (!initial.isFile() || initial.nlink !== 1 || initial.size < 1 || initial.size > MAX_BYTES) throw new Error('Invalid encrypted transport key')
    let fd: number | undefined
    try {
      const flags=constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0))
      fd=openSync(path,flags)
      const stat=fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== initial.size || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > MAX_BYTES) throw new Error('Invalid encrypted transport key')
      // Bound the read even if another local process grows the file after fstat.
      const buffer=Buffer.alloc(stat.size+1)
      let length=0, count=0
      do { count=readSync(fd,buffer,length,buffer.length-length,null);length+=count } while (count > 0 && length < buffer.length)
      if (length !== stat.size) throw new Error('Invalid encrypted transport key')
      let plaintext: string
      try { plaintext=storage.decryptString(buffer.subarray(0,length)) } catch { throw new Error('Encrypted transport key unavailable') }
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext,'utf8') > MAX_BYTES) throw new Error('Invalid encrypted transport key')
      return decode(plaintext,storeId)
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  function create(): Material {
    checkStorage(storage)
    const auditKey=randomBytes(32)
    let commandKey=randomBytes(32)
    while (timingSafeEqual(auditKey,commandKey)) commandKey=randomBytes(32)
    const plaintext=JSON.stringify({version:1,storeId,auditKey:auditKey.toString('hex'),commandKey:commandKey.toString('hex')})
    let encrypted: Buffer
    try { encrypted=storage.encryptString(plaintext) } catch { throw new Error('Secure storage failed') }
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > MAX_BYTES) throw new Error('Secure storage failed')
    // Exclusive creation never overwrites another process or an existing broken
    // key. File/directory ACLs and power-loss durability require platform tests.
    const fd=openSync(path,'wx',0o600)
    try { writeFileSync(fd,encrypted);fsyncSync(fd) } finally { closeSync(fd) }
    return {storeId,auditKey,commandKey}
  }
  return { create, load }
}
