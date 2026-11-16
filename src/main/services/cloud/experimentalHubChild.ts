/**
 * Experimental separate Node child for the loopback read-only mobile hub and
 * audit receiver. Not bundled, started, or enabled by Electron. The parent must
 * provide the Node runtime, protect its IPC channel/key, supply fresh read-only
 * snapshots, and configure an HTTPS proxy. Optional invoice facts use a trusted
 * private parent IPC and are not a financial report. No grants or approval
 * transport are provided here. Node's built-in SQLite and Windows durability/ACL behavior must
 * be verified in the actual deployment runtime before this can be integrated.
 *
 * Only a dedicated `remote-hub.sqlite` is opened, never shop.db. A stale lock is
 * deliberately not broken automatically after a crash.
 */
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server } from 'node:http'
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createHubIdentity } from './hubIdentity'
import { startMobileReadOnlyHub } from './mobileReadOnlyHub'
import { createLocalAuditReceiver } from './localAuditReceiver'
import { isInvoiceDate, parseInvoicePage } from './invoiceFactsValidation'
import { normalizeMobileOrigins } from './mobileOrigins'
import { drainNetworkRevocations } from './inProcessRevocationBridge'

if (typeof process.send !== 'function') throw new Error('A private parent IPC channel is required')
const send = (message: unknown) => { if (process.connected && process.send) process.send(message) }
const okObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const sameKeys = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const safeInt = (v: unknown, min: number) => Number.isSafeInteger(v) && (v as number) >= min
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= max
const amount = (v: unknown): v is string => text(v, 100) && /^-?(0|[1-9][0-9]*)$/.test(v)

type Snapshot = { boundary: Record<string, unknown> | null; shifts: Record<string, unknown>[] }
function parseSnapshot(value: unknown): Snapshot {
  if (!okObject(value) || !sameKeys(value, 'boundary,shifts') || !Array.isArray(value.shifts) || value.shifts.length > 200) throw new Error('Invalid snapshot')
  const raw = value.boundary
  let boundary: Snapshot['boundary'] = null
  if (raw !== null) {
    if (!okObject(raw) || !sameKeys(raw, 'atDatabaseValue,id,kind,observedOperationalTotal,operationalDay,source,theoreticalExpectedTotal,totalTheoreticalDifference') ||
        raw.source !== 'HISTORICAL_BOUNDARY' || !safeInt(raw.id, 1) || !text(raw.atDatabaseValue) || !text(raw.kind) || !text(raw.operationalDay) ||
        !amount(raw.theoreticalExpectedTotal) || !amount(raw.observedOperationalTotal) || !amount(raw.totalTheoreticalDifference)) throw new Error('Invalid boundary')
    boundary = { source: raw.source, id: raw.id, atDatabaseValue: raw.atDatabaseValue, kind: raw.kind, operationalDay: raw.operationalDay,
      theoreticalExpectedTotal: raw.theoreticalExpectedTotal, observedOperationalTotal: raw.observedOperationalTotal, totalTheoreticalDifference: raw.totalTheoreticalDifference }
  }
  let last = 0
  const shifts = value.shifts.map((item: unknown) => {
    if (!okObject(item) || !sameKeys(item, 'id,name,number,openedAtDatabaseValue,operationalDay') || !safeInt(item.id, 1) ||
        item.id <= last || !safeInt(item.number, 0) || !text(item.name) || !text(item.operationalDay) || !text(item.openedAtDatabaseValue)) throw new Error('Invalid shift')
    last = item.id
    return { id:item.id, name:item.name, number:item.number, operationalDay:item.operationalDay, openedAtDatabaseValue:item.openedAtDatabaseValue }
  })
  const result = { boundary, shifts }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 96 * 1024) throw new Error('Snapshot too large')
  return result
}

let initialized = false, shuttingDown = false
let lockFd: number | undefined, lockPath = '', lockToken = ''
let db: DatabaseSync | undefined, auditServer: Server | undefined
let recoveryIdentity: ReturnType<typeof createHubIdentity> | undefined
let recoveryEpoch = ''
let mobile: Awaited<ReturnType<typeof startMobileReadOnlyHub>> | undefined
let revocationTimer: ReturnType<typeof setInterval> | undefined
let revocationActive: Promise<{applied:number;remaining:boolean}> | undefined
let snapshot: Snapshot | null = null, snapshotAt = 0, snapshotMaxAge = 0, lastSnapshotCapture = 0
let invoiceId=0
let invoicePending: null | {id:number; from:string; to:string; afterId:number; resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>} = null
function failInvoice() {
  const pending=invoicePending
  if (!pending) return
  invoicePending=null;clearTimeout(pending.timer);pending.reject(new Error('Invoice read unavailable'))
}
function requestInvoices(from:string,to:string,afterId:number,limit:number):Promise<unknown> {
  if (shuttingDown || !process.connected || invoicePending || invoiceId >= Number.MAX_SAFE_INTEGER ||
      !isInvoiceDate(from) || !isInvoiceDate(to) || from > to || !safeInt(afterId,0) || limit !== 50) return Promise.reject(new Error('Invalid invoice request'))
  const id=++invoiceId
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => { if (invoicePending?.id === id) failInvoice() },3000)
    invoicePending={id,from,to,afterId,resolve,reject,timer}
    try { send({type:'invoiceRead',id,fromDay:from,toDay:to,afterId}) } catch { failInvoice() }
  })
}

function releaseLock() {
  if (lockFd === undefined) return
  let owns = false
  try { owns = lstatSync(lockPath).isFile() && readFileSync(lockPath, 'utf8') === lockToken } catch {}
  closeSync(lockFd); lockFd = undefined
  if (!owns) throw new Error('Hub lock ownership lost')
  unlinkSync(lockPath)
}
async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  failInvoice()
  if (revocationTimer) clearInterval(revocationTimer)
  if (mobile) { await mobile.closeNow().catch(() => {}); mobile = undefined }
  if (revocationActive) await revocationActive.catch(() => {})
  await closeServer(auditServer); auditServer = undefined
  if (db) { db.close(); db = undefined }
  releaseLock()
}
async function start(input: unknown) {
  if (!okObject(input)) throw new Error('Invalid configuration')
  const {revocation, ...config}=input
  if (revocation !== undefined && (!okObject(revocation) || !sameKeys(revocation,'epoch,key,port,storeId') ||
      typeof revocation.key !== 'string' || !/^[a-f0-9]{64}$/.test(revocation.key) ||
      !safeInt(revocation.port,1) || revocation.port>65535 || typeof revocation.storeId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(revocation.storeId) || typeof revocation.epoch !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(revocation.epoch))) throw new Error('Invalid revocation configuration')
  if (!(sameKeys(config, 'auditKey,directory,origin,owner,snapshotMaxAgeMs') ||
      sameKeys(config, 'auditKey,directory,origins,owner,snapshotMaxAgeMs') ||
      ((sameKeys(config, 'auditKey,directory,invoiceFacts,origin,owner,snapshotMaxAgeMs') ||
        sameKeys(config, 'auditKey,directory,invoiceFacts,origins,owner,snapshotMaxAgeMs')) && config.invoiceFacts === true)) ||
      typeof config.directory !== 'string' || !isAbsolute(config.directory) ||
      typeof config.auditKey !== 'string' || !/^[a-f0-9]{64}$/.test(config.auditKey) ||
      !Number.isSafeInteger(config.snapshotMaxAgeMs) || config.snapshotMaxAgeMs < 100 || config.snapshotMaxAgeMs > 60_000 ||
      (config.owner !== null && (!okObject(config.owner) || !sameKeys(config.owner, 'password,pin,username') ||
       typeof config.owner.username !== 'string' || typeof config.owner.password !== 'string' || typeof config.owner.pin !== 'string'))) throw new Error('Invalid configuration')
  const origins=normalizeMobileOrigins(config.origin,config.origins)
  const directory = realpathSync(config.directory)
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid hub directory')
  lockPath = join(directory, 'remote-hub.lock'); lockToken = randomBytes(32).toString('hex')
  lockFd = openSync(lockPath, 'wx', 0o600)
  writeFileSync(lockFd, lockToken, 'utf8')
  const databasePath = join(directory, 'remote-hub.sqlite')
  let newFile = false
  try {
    const fd = openSync(databasePath, 'wx', 0o600)
    closeSync(fd); newFile = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = lstatSync(databasePath)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid hub database file')
  const keyCheck=createHmac('sha256',Buffer.from(config.auditKey,'hex')).update('mahak-hub-audit-key-check-v1','utf8').digest()
  if (!newFile) {
    // Refuse an application DB or a hub with a different/lost key before any write.
    // A legacy hub without this binding requires explicit migration, not adoption.
    const inspect = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = inspect.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%'").all()
      if (rows.some(row => typeof row.name !== 'string' || !row.name.startsWith('remote_'))) throw new Error('Not a dedicated hub database')
      const saved=inspect.prepare('SELECT key_check FROM remote_transport_meta WHERE id=1').get()?.key_check
      if (typeof saved !== 'string' || !/^[a-f0-9]{64}$/.test(saved) || !timingSafeEqual(keyCheck,Buffer.from(saved,'hex'))) throw new Error('Hub key mismatch')
    } finally { inspect.close() }
  }
  db = new DatabaseSync(databasePath)
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=200;')
  if (newFile) {
    db.exec('CREATE TABLE remote_transport_meta (id INTEGER PRIMARY KEY CHECK(id=1), key_check TEXT NOT NULL)')
    db.prepare('INSERT INTO remote_transport_meta (id,key_check) VALUES (1,?)').run(keyCheck.toString('hex'))
  }
  const identity = createHubIdentity(db, { panels:config.invoiceFacts === true ? ['custody','shifts','invoices'] : ['custody','shifts'], approvalPanels:[] })
  recoveryIdentity=identity;recoveryEpoch=revocation === undefined ? '' : revocation.epoch
  const count = db.prepare('SELECT COUNT(*) AS n FROM remote_members').get()?.n
  if (count === 0) {
    if (!config.owner || !identity.bootstrap(config.owner.username,config.owner.password,config.owner.pin)) throw new Error('Owner setup required')
  } else {
    if (config.owner !== null || db.prepare("SELECT COUNT(*) AS n FROM remote_members WHERE role='OWNER' AND status='ACTIVE'").get()?.n !== 1) throw new Error('Invalid existing owner')
  }
  const revocationOptions = revocation === undefined ? undefined : {
    key:Buffer.from(revocation.key,'hex'), storeId:revocation.storeId as string,
    epoch:revocation.epoch as string, port:revocation.port as number
  }
  const drain = revocationOptions ? () => {
    if (shuttingDown) return Promise.reject(new Error('Hub stopping'))
    if (revocationActive) return revocationActive
    const task=drainNetworkRevocations(identity,revocationOptions).catch(error => {
      // A failure can occur before the receiver reaches its ledger callbacks
      // (e.g. a lost connection or a rejected packet). Tell the parent over the
      // private child channel; a successful later retry cannot itself prove that
      // desktop admission is safe to reopen.
      try { send({type:'revocationDeliveryFailed'}) } catch {}
      throw error
    })
    revocationActive=task
    void task.then(() => { if (revocationActive===task) revocationActive=undefined },
      () => { if (revocationActive===task) revocationActive=undefined })
    return task
  } : undefined
  if (drain) {
    const first=await drain()
    if (first.remaining) throw new Error('Revocations pending')
    revocationTimer=setInterval(() => { void drain().catch(() => {}) },1000)
    revocationTimer.unref?.()
  }
  const current = () => {
    if (!snapshot || performance.now() - snapshotAt >= snapshotMaxAge) throw new Error('Snapshot unavailable or stale')
    return snapshot
  }
  snapshotMaxAge = config.snapshotMaxAgeMs
  mobile = await startMobileReadOnlyHub({ origins, identity, ...(drain ? {drainRevocations:drain} : {}), reader: {
    latestBoundaryTotals:async () => current().boundary,
    openShiftsPage:async () => current().shifts,
    ...(config.invoiceFacts === true ? { invoiceFactsPage:requestInvoices } : {})
  } })
  const receiver = createLocalAuditReceiver(db, Buffer.from(config.auditKey, 'hex'))
  auditServer = createServer(receiver)
  await new Promise<void>((resolve,reject) => { auditServer!.once('error',reject); auditServer!.listen(0,'127.0.0.1',() => { auditServer!.off('error',reject); resolve() }) })
  const address = auditServer.address()
  if (!address || typeof address === 'string') throw new Error('Invalid audit listener')
  return { mobilePort:mobile.port, auditPort:address.port }
}

// Serialize startup, updates and stop so a concurrent stop cannot race startup.
let actions: Promise<void> = Promise.resolve()
process.on('message', message => {
  actions = actions.then(async () => {
    if (!okObject(message) || typeof message.type !== 'string') return
    if (message.type === 'start' && !initialized) {
      initialized = true
      try { const ports = await start(message.config); send({ type:'ready', ...ports, pid:process.pid }) }
      catch { await shutdown(); send({ type:'error', operation:'start' }); process.disconnect?.() }
      return
    }
    if (message.type === 'recoverPanic' && initialized && !shuttingDown && mobile && recoveryEpoch && recoveryIdentity) {
      if (!sameKeys(message,'id,lastAck,pin,type') || !safeInt(message.id,1) || !safeInt(message.lastAck,1) || typeof message.pin !== 'string' || !/^[0-9]{6}$/.test(message.pin)) return
      let ok=false
      try { ok=recoveryIdentity.recoverPanicLocally(message.pin,recoveryEpoch,message.lastAck) } catch {}
      send({type:'panicRecovered',id:message.id,ok});return
    }
    if ((message.type === 'snapshot' || message.type === 'invalidateSnapshot') && initialized && !shuttingDown && mobile) {
      const id = message.id
      if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) return
      const response = (ok: boolean, reason?: string) => send({ type:'snapshot', ...(id === undefined ? {} : {id}), ok, ...(id !== undefined && reason ? {reason} : {}) })
      if (message.type === 'invalidateSnapshot') { snapshot = null; response(true); return }
      // Only fixed, non-sensitive error codes leave the child. Keep all clock
      // checks fail-closed; these codes distinguish intermittent OS-clock races
      // from invalid DTOs without logging the snapshot's contents.
      const wall = Date.now(), captured = message.capturedAtMs
      let reason=''
      if (!Number.isSafeInteger(captured) || captured <= 0) reason='invalid-capture'
      else if (captured < lastSnapshotCapture) reason='clock-regressed'
      else if (captured > wall) reason='clock-future'
      else if (wall - captured >= snapshotMaxAge) reason='snapshot-expired'
      if (reason) { snapshot=null;response(false,reason);return }
      try {
        const value = parseSnapshot(message.value)
        snapshot = value; snapshotAt = performance.now() - (wall - captured); lastSnapshotCapture = captured
        response(true)
      } catch { snapshot = null; response(false,'invalid-payload') }
      return
    }
    if (message.type === 'invoiceReadResult' && invoicePending && message.id === invoicePending.id) {
      const pending=invoicePending;invoicePending=null;clearTimeout(pending.timer)
      try {
        if (message.ok !== true || !sameKeys(message,'id,ok,type,value')) throw new Error('Invoice read unavailable')
        pending.resolve(parseInvoicePage(message.value,pending.from,pending.to,pending.afterId))
      } catch { pending.reject(new Error('Invoice read unavailable')) }
      return
    }
    if (message.type === 'stop') {
      await shutdown(); send({ type:'stopped' }); process.disconnect?.()
    }
  }).catch(async () => { await shutdown(); process.disconnect?.() })
})
process.on('disconnect', () => { void actions.finally(shutdown).finally(() => process.exit(0)) })
