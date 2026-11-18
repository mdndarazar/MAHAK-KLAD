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
const MAX_REVOCATION_NONCES = 20_000
const MAX_REVOCATION_BYTES = 2_000_000
const NONCE = /^[0-9a-f]{48}$/
const GRANT_NONCE = /^[A-Za-z0-9_-]{22,128}$/
const MAX_GRANT_REPLAY_BYTES = 1_000_000
type RevocationEntry = { id:number; kind:'ALL'|'MEMBER'; memberId:string|null }
type RevocationState = { version:1; storeId:string; epoch:string; cursor:RevocationEntry|null; nonces:string[] }
function validRevocationEntry(value:unknown):value is RevocationEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v=value as Record<string,unknown>
  return Object.keys(v).sort().join(',')==='id,kind,memberId' && Number.isSafeInteger(v.id) && (v.id as number)>0 &&
    ((v.kind==='ALL' && v.memberId===null) || (v.kind==='MEMBER' && typeof v.memberId==='string' && /^[a-f0-9]{32}$/.test(v.memberId)))
}

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
  // This file is private to the locked state owner, not shop.db. Initialization
  // is explicit and exclusive: missing/corrupt history is NEVER recreated by
  // open. Every epoch transition requires a separate, coordinated procedure.
  const revocationPath=join(directory,'revocation-ledger.json')
  const revocationMarkerPath=join(directory,'revocation-ledger.initialized')
  function readRevocations():RevocationState {
    ensureOpen()
    const marker=lstatSync(revocationMarkerPath)
    if (!marker.isFile() || marker.nlink!==1 || marker.size!==2 || readFileSync(revocationMarkerPath,'utf8')!=='v1') throw new Error('Invalid revocation marker')
    const state=load()
    if (!state) throw new Error('Cloud state unavailable')
    const stat=lstatSync(revocationPath)
    if (!stat.isFile() || stat.nlink!==1 || stat.size<1 || stat.size>MAX_REVOCATION_BYTES) throw new Error('Invalid revocation ledger')
    let value:unknown
    try { value=JSON.parse(readFileSync(revocationPath,'utf8')) } catch { throw new Error('Invalid revocation ledger') }
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid revocation ledger')
    const v=value as Record<string,unknown>
    if (Object.keys(v).sort().join(',')!=='cursor,epoch,nonces,storeId,version' || v.version!==1 || v.storeId!==state.storeId || v.epoch!==state.epoch ||
        (v.cursor!==null && !validRevocationEntry(v.cursor)) || !Array.isArray(v.nonces) || v.nonces.length>MAX_REVOCATION_NONCES ||
        v.nonces.some(n=>typeof n!=='string' || !NONCE.test(n)) || new Set(v.nonces).size!==v.nonces.length ||
        ((v.cursor===null)!==(v.nonces.length===0))) throw new Error('Invalid revocation ledger')
    return {version:1,storeId:state.storeId,epoch:state.epoch,cursor:v.cursor as RevocationEntry|null,nonces:v.nonces as string[]}
  }
  function initializeRevocationLedger():void {
    ensureOpen()
    const state=load()
    if (!state) throw new Error('Cloud state unavailable')
    const payload=JSON.stringify({version:1,storeId:state.storeId,epoch:state.epoch,cursor:null,nonces:[]})
    // Marker first: a crash or missing ledger must not permit automatic reset.
    const markerFd=openSync(revocationMarkerPath,'wx',0o600)
    try { writeFileSync(markerFd,'v1','utf8');fsyncSync(markerFd) } finally { closeSync(markerFd) }
    // An interrupted creation remains an error; never replace an existing file.
    const fd=openSync(revocationPath,'wx',0o600)
    try { writeFileSync(fd,payload,'utf8');fsyncSync(fd) } finally { closeSync(fd) }
  }
  function openRevocationLedger() {
    readRevocations()
    return {
      load():RevocationEntry|null { return readRevocations().cursor },
      hasNonce(nonce:string):boolean {
        if (typeof nonce!=='string' || !NONCE.test(nonce)) throw new Error('Invalid revocation nonce')
        return readRevocations().nonces.includes(nonce)
      },
      save(entry:RevocationEntry,nonce:string):void {
        if (!validRevocationEntry(entry) || typeof nonce!=='string' || !NONCE.test(nonce)) throw new Error('Invalid revocation entry')
        const previous=readRevocations(), cursor=previous.cursor
        if (previous.nonces.includes(nonce) || previous.nonces.length>=MAX_REVOCATION_NONCES ||
            (cursor && (entry.id<cursor.id || (entry.id===cursor.id && (entry.kind!==cursor.kind || entry.memberId!==cursor.memberId))))) throw new Error('Invalid revocation transition')
        const payload=JSON.stringify({...previous,cursor:{id:entry.id,kind:entry.kind,memberId:entry.memberId},nonces:[...previous.nonces,nonce]})
        if (Buffer.byteLength(payload,'utf8')>MAX_REVOCATION_BYTES) throw new Error('Revocation ledger full')
        const temporary=join(directory,`.revocation-ledger-${randomBytes(16).toString('hex')}.tmp`)
        let fd:number|undefined,created=false
        try {
          fd=openSync(temporary,'wx',0o600);created=true
          writeFileSync(fd,payload,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined
          ensureOpen();renameSync(temporary,revocationPath);created=false
        } finally { if (fd!==undefined) try {closeSync(fd)} catch {};if(created) try {unlinkSync(temporary)} catch {} }
      }
    }
  }
  // Desktop replay ledger is bound to the same exclusive store and epoch. A
  // missing, corrupt or mismatched ledger must never be silently recreated.
  // File fsync + rename do not establish power-loss or Windows ACL guarantees.
  const replayPath=join(directory,'grant-replay-ledger.json')
  const replayMarkerPath=join(directory,'grant-replay-ledger.initialized')
  type GrantEntry={requestId:string;nonce:string;expiresAt:number}
  type GrantState={version:1;storeId:string;epoch:string;latest:number;entries:GrantEntry[]}
  function readGrantReplay():GrantState {
    ensureOpen()
    const marker=lstatSync(replayMarkerPath)
    if (!marker.isFile() || marker.nlink!==1 || marker.size!==2 || readFileSync(replayMarkerPath,'utf8')!=='v1') throw new Error('Invalid grant replay marker')
    const state=load()
    if (!state) throw new Error('Cloud state unavailable')
    const stat=lstatSync(replayPath)
    if (!stat.isFile() || stat.nlink!==1 || stat.size<1 || stat.size>MAX_GRANT_REPLAY_BYTES) throw new Error('Invalid grant replay ledger')
    let raw:unknown
    try { raw=JSON.parse(readFileSync(replayPath,'utf8')) } catch { throw new Error('Invalid grant replay ledger') }
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Invalid grant replay ledger')
    const v=raw as Record<string,unknown>
    if (Object.keys(v).sort().join(',')!=='entries,epoch,latest,storeId,version' || v.version!==1 || v.storeId!==state.storeId || v.epoch!==state.epoch ||
        !Number.isSafeInteger(v.latest) || (v.latest as number)<0 || !Array.isArray(v.entries) || v.entries.length>100_000) throw new Error('Invalid grant replay ledger')
    const requests=new Set<string>(),nonces=new Set<string>(),entries:GrantEntry[]=[]
    for (const item of v.entries) {
      if (!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).sort().join(',')!=='expiresAt,nonce,requestId' ||
          typeof item.requestId!=='string' || !ID.test(item.requestId) || typeof item.nonce!=='string' || !GRANT_NONCE.test(item.nonce) ||
          !Number.isSafeInteger(item.expiresAt) || item.expiresAt<=0 || requests.has(item.requestId) || nonces.has(item.nonce)) throw new Error('Invalid grant replay ledger')
      requests.add(item.requestId);nonces.add(item.nonce);entries.push({requestId:item.requestId,nonce:item.nonce,expiresAt:item.expiresAt})
    }
    return {version:1,storeId:state.storeId,epoch:state.epoch,latest:v.latest as number,entries}
  }
  function writeGrantReplay(state:GrantState):void {
    const payload=JSON.stringify(state)
    if (Buffer.byteLength(payload,'utf8')>MAX_GRANT_REPLAY_BYTES) throw new Error('Grant replay ledger full')
    const temporary=join(directory,`.grant-replay-${randomBytes(16).toString('hex')}.tmp`)
    let fd:number|undefined,created=false
    try {
      fd=openSync(temporary,'wx',0o600);created=true
      writeFileSync(fd,payload,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined
      ensureOpen();renameSync(temporary,replayPath);created=false
    } finally { if (fd!==undefined) try {closeSync(fd)} catch {};if(created) try {unlinkSync(temporary)} catch {} }
  }
  function initializeGrantReplayLedger():void {
    ensureOpen()
    const state=load()
    if (!state) throw new Error('Cloud state unavailable')
    const payload=JSON.stringify({version:1,storeId:state.storeId,epoch:state.epoch,latest:0,entries:[]})
    const markerFd=openSync(replayMarkerPath,'wx',0o600)
    try {writeFileSync(markerFd,'v1','utf8');fsyncSync(markerFd)} finally {closeSync(markerFd)}
    const fd=openSync(replayPath,'wx',0o600)
    try {writeFileSync(fd,payload,'utf8');fsyncSync(fd)} finally {closeSync(fd)}
  }
  function openGrantReplayLedger(capacity=2048) {
    if (!Number.isSafeInteger(capacity) || capacity<1 || capacity>100_000) throw new Error('Invalid replay capacity')
    readGrantReplay()
    return {
      consume(requestId:string,nonce:string,expiresAt:number,now:number):'OK'|'REPLAY'|'CAPACITY'|'INVALID' {
        if (typeof requestId!=='string' || !ID.test(requestId) || typeof nonce!=='string' || !GRANT_NONCE.test(nonce) ||
            !Number.isSafeInteger(now) || now<=0 || !Number.isSafeInteger(expiresAt) || expiresAt<=now || expiresAt-now>75_000) return 'INVALID'
        const current=readGrantReplay()
        if (now<current.latest) return 'INVALID'
        const entries=current.entries.filter(item=>item.expiresAt>now)
        if (entries.some(item=>item.requestId===requestId || item.nonce===nonce)) {writeGrantReplay({...current,latest:now,entries});return 'REPLAY'}
        if (entries.length>=capacity) return 'CAPACITY'
        writeGrantReplay({...current,latest:now,entries:[...entries,{requestId,nonce,expiresAt}]})
        return 'OK'
      }
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
  return { load, save, initializeRevocationLedger, openRevocationLedger, initializeGrantReplayLedger, openGrantReplayLedger, close }
}
