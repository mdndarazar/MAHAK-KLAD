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
import { createExperimentalRemoteCommandIssuer } from './experimentalRemoteCommandIssuer'
import { approvalEnvelopeMac } from './experimentalApprovalEnvelope'

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
// Freshness for supervisor reads is measured entirely by the child, starting
// before the parent reads. This avoids comparing clocks from separate processes.
let snapshotCapture: {id:number; monotonic:number; wall:number} | null = null, lastCaptureId = 0
let invoiceId=0
type MirrorItem={requestId:string;panel:string;code:string;ownerWindowId:number}
let mirror:{at:number;seq:number;items:MirrorItem[]}|null=null, approvalId=0
type GrantItem={panel:string;claimed:boolean;remainingMs:number}
let grantMirror:{at:number;seq:number;items:GrantItem[]}|null=null
const waitingApprovals=new Map<number,{resolve:(ok:boolean)=>void;timer:ReturnType<typeof setTimeout>}>()
function failApprovals() { for (const item of waitingApprovals.values()) {clearTimeout(item.timer);item.resolve(false)} waitingApprovals.clear() }
function parseMirror(message:Record<string,any>) {
  if (!sameKeys(message,'items,seq,type') || !safeInt(message.seq,1) || (mirror && message.seq<=mirror.seq) || !Array.isArray(message.items) || message.items.length>200) return
  const items:MirrorItem[]=[]
  for (const x of message.items) {
    if (!okObject(x) || !sameKeys(x,'code,ownerWindowId,panel,requestId') || typeof x.requestId!=='string' || !/^[a-f0-9]{32}$/.test(x.requestId) ||
        typeof x.panel!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(x.panel) || typeof x.code!=='string' || !/^[0-9]{6}$/.test(x.code) || !safeInt(x.ownerWindowId,1)) return
    items.push({requestId:x.requestId,panel:x.panel,code:x.code,ownerWindowId:x.ownerWindowId})
  }
  mirror={at:performance.now(),seq:message.seq,items}
}
// Owner's live view only; it never authorizes anything. A malformed list is
// ignored, so the previous copy ages out and the view reports unavailable.
function parseGrantMirror(message:Record<string,any>) {
  if (!sameKeys(message,'items,seq,type') || !safeInt(message.seq,1) || (grantMirror && message.seq<=grantMirror.seq) || !Array.isArray(message.items) || message.items.length>200) return
  const items:GrantItem[]=[]
  for (const x of message.items) {
    if (!okObject(x) || !sameKeys(x,'claimed,panel,remainingMs') || typeof x.panel!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(x.panel) ||
        typeof x.claimed!=='boolean' || !safeInt(x.remainingMs,1) || x.remainingMs>86_400_000) return
    items.push({panel:x.panel,claimed:x.claimed,remainingMs:x.remainingMs})
  }
  grantMirror={at:performance.now(),seq:message.seq,items}
}
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
  failInvoice();failApprovals()
  if (revocationTimer) clearInterval(revocationTimer)
  if (mobile) { await mobile.closeNow().catch(() => {}); mobile = undefined }
  if (revocationActive) await revocationActive.catch(() => {})
  await closeServer(auditServer); auditServer = undefined
  if (db) { db.close(); db = undefined }
  releaseLock()
}
const SQLITE_READONLY_ROLLBACK = 776
/** A process killed in the middle of a write (the supervisor's fail-closed
 * kill is TerminateProcess on Windows; also power loss) leaves a hot rollback
 * journal. A read-only connection cannot roll it back, so without this every
 * later start would fail. Only that case is handled: the single write before
 * identification is SQLite's own rollback, which restores the file's last
 * committed state; identity and key checks then run as before. */
function rollBackHotJournal(databasePath: string): void {
  const journal = `${databasePath}-journal`
  let stat
  try { stat = lstatSync(journal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid hub journal file')
  const probe = new DatabaseSync(databasePath, { readOnly: true })
  let hot = false
  try { probe.prepare('SELECT 1 FROM sqlite_master LIMIT 1').all() }
  catch (error) {
    const e = error as { errcode?: unknown; message?: unknown }
    if (e.errcode !== SQLITE_READONLY_ROLLBACK && !(e.errcode === undefined && /readonly database/.test(String(e.message)))) throw error
    hot = true
  } finally { probe.close() }
  if (!hot) return
  const writer = new DatabaseSync(databasePath)
  try { writer.prepare('SELECT 1 FROM sqlite_master LIMIT 1').all() } finally { writer.close() }
}
async function start(input: unknown) {
  if (!okObject(input)) throw new Error('Invalid configuration')
  const {revocation, approval, mobilePort, ...config}=input
  // Optional fixed loopback port for the owner's overlay/tunnel; 0 = ephemeral.
  if (mobilePort!==undefined && (!safeInt(mobilePort,1024) || mobilePort>65535)) throw new Error('Invalid mobile port')
  if (approval!==undefined && (!okObject(revocation) || !okObject(approval) || !sameKeys(approval,'key,panels,policies,storeId') ||
      typeof approval.key!=='string' || !/^[a-f0-9]{64}$/.test(approval.key) || approval.key===revocation.key || approval.key===config.auditKey ||
      approval.storeId!==revocation.storeId || !Array.isArray(approval.panels) || approval.panels.length<1 || approval.panels.length>64 ||
      approval.panels.some((p:unknown)=>typeof p!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(p) || p==='custody') ||
      new Set(approval.panels).size!==approval.panels.length || !okObject(approval.policies) ||
      Object.keys(approval.policies).sort().join(',')!==[...approval.panels].sort().join(',') ||
      Object.values(approval.policies).some(p=>!okObject(p) || !sameKeys(p,'mode,tier,ttlMs') || p.tier!=='NORMAL' || p.mode!=='PANEL' || !safeInt(p.ttlMs,1) || p.ttlMs>600_000))) throw new Error('Invalid approval configuration')
  if (revocation !== undefined && (!okObject(revocation) ||
      !(sameKeys(revocation,'epoch,key,port,storeId') || (sameKeys(revocation,'epoch,key,port,rotate,storeId') && revocation.rotate === true)) ||
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
    rollBackHotJournal(databasePath)
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
  const approvalPanels:string[]=approval===undefined ? [] : [...approval.panels]
  const panels=[...new Set([...(config.invoiceFacts === true ? ['custody','shifts','invoices'] : ['custody','shifts']),...approvalPanels])]
  const identity = createHubIdentity(db, { panels, approvalPanels })
  recoveryIdentity=identity;recoveryEpoch=revocation === undefined ? '' : revocation.epoch
  const count = db.prepare('SELECT COUNT(*) AS n FROM remote_members').get()?.n
  if (count === 0) {
    if (!config.owner || !identity.bootstrap(config.owner.username,config.owner.password,config.owner.pin)) throw new Error('Owner setup required')
  } else {
    if (config.owner !== null || db.prepare("SELECT COUNT(*) AS n FROM remote_members WHERE role='OWNER' AND status='ACTIVE'").get()?.n !== 1) throw new Error('Invalid existing owner')
  }
  // Explicit parent request after an explicit stopped-hub epoch transition with
  // a fresh desktop ledger. Never inferred from a mismatching stored epoch.
  if (revocation?.rotate === true) identity.rotateNetworkRevocationEpoch(revocation.epoch as string)
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
  let approvalController:{panels:readonly string[];list(token:string):{requestId:string;panel:string;code:string}[];grants():GrantItem[];approve(token:string,requestId:string,code:string,pin:string):Promise<boolean>}|undefined
  if (approval!==undefined && revocationOptions) {
    let uncertain=false
    const key=Buffer.from(approval.key,'hex'),storeId=revocationOptions.storeId,epoch=revocationOptions.epoch
    const issuer=createExperimentalRemoteCommandIssuer({key,storeId,policies:approval.policies,identity,
      pending:()=>{if (!mirror || performance.now()-mirror.at>=3000) throw new Error('Pending mirror stale');return mirror.items},
      send:command=>{
        if (shuttingDown || !process.connected || approvalId>=Number.MAX_SAFE_INTEGER) return Promise.resolve(false)
        const fence=identity.networkRevocationCursor(epoch), id=++approvalId
        return new Promise<boolean>(resolve=>{
          const timer=setTimeout(()=>{
            waitingApprovals.delete(id);uncertain=true
            // A lost result has an unknown outcome. Close the entire private
            // channel so the supervisor revokes all grants; never claim that an
            // asynchronous abort alone proves a grant was never used.
            try { process.disconnect?.() } catch {}
            resolve(false)
          },4000)
          waitingApprovals.set(id,{resolve,timer})
          try {send({type:'approvalCommand',id,command,fence,mac:approvalEnvelopeMac(key,storeId,epoch,id,fence,command.signature)})}
          catch {clearTimeout(timer);waitingApprovals.delete(id);uncertain=true;try {process.disconnect?.()} catch {};resolve(false)}
        })
      }})
    approvalController={panels:approvalPanels,list:token=>issuer.list(token),
      grants:()=>{
        // Same freshness bound as the request mirror: a desktop that stopped
        // vouching for its state yields "unavailable", never an empty list.
        const copy=grantMirror, age=copy ? performance.now()-copy.at : Infinity
        if (!copy || age>=3000) throw new Error('Grant mirror stale')
        return copy.items.map(g=>({...g,remainingMs:Math.floor(g.remainingMs-age)})).filter(g=>g.remainingMs>0)
      },
      approve:async(token,requestId,code,pin)=>{
      const ok=await issuer.approve(token,requestId,code,pin)
      if (uncertain) throw new Error('Approval outcome unavailable')
      return ok
    }}
  }
  mobile = await startMobileReadOnlyHub({ origins, identity, ...(approvalController ? {approval:approvalController} : {}), ...(drain ? {drainRevocations:drain} : {}), reader: {
    latestBoundaryTotals:async () => current().boundary,
    openShiftsPage:async () => current().shifts,
    ...(config.invoiceFacts === true ? { invoiceFactsPage:requestInvoices } : {})
  } }, mobilePort===undefined ? 0 : mobilePort as number)
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
  if (okObject(message) && message.type==='approvalResult') {
    const item=safeInt(message.id,1) ? waitingApprovals.get(message.id) : undefined
    if (item && typeof message.ok==='boolean') {waitingApprovals.delete(message.id);clearTimeout(item.timer);item.resolve(message.ok)}
    return
  }
  if (okObject(message) && message.type==='pendingRequests') {if(initialized && !shuttingDown) parseMirror(message);return}
  if (okObject(message) && message.type==='openGrants') {if(initialized && !shuttingDown) parseGrantMirror(message);return}
  actions = actions.then(async () => {
    if (!okObject(message) || typeof message.type !== 'string') return
    if (message.type === 'start' && !initialized) {
      initialized = true
      // The lock token lets the parent remove this lock after it has observed
      // this process exit; a killed child cannot release the lock itself.
      try { const ports = await start(message.config); send({ type:'ready', ...ports, pid:process.pid, lockToken }) }
      catch { await shutdown(); send({ type:'error', operation:'start' }); process.disconnect?.() }
      return
    }
    if (message.type === 'recoverPanic' && initialized && !shuttingDown && mobile && recoveryEpoch && recoveryIdentity) {
      if (!sameKeys(message,'id,lastAck,pin,type') || !safeInt(message.id,1) || !safeInt(message.lastAck,1) || typeof message.pin !== 'string' || !/^[0-9]{6}$/.test(message.pin)) return
      let ok=false
      try { ok=recoveryIdentity.recoverPanicLocally(message.pin,recoveryEpoch,message.lastAck) } catch {}
      send({type:'panicRecovered',id:message.id,ok});return
    }
    if ((message.type === 'snapshot' || message.type === 'invalidateSnapshot' || message.type === 'beginSnapshot') && initialized && !shuttingDown && mobile) {
      const id = message.id
      if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) return
      const response = (ok: boolean, reason?: string) => send({ type:'snapshot', ...(id === undefined ? {} : {id}), ok, ...(id !== undefined && reason ? {reason} : {}) })
      if (message.type === 'invalidateSnapshot') { snapshot = null; snapshotCapture=null; response(true); return }
      if (message.type === 'beginSnapshot') {
        snapshot=null; snapshotCapture=null
        if (!sameKeys(message,'captureId,id,type') || !safeInt(message.captureId,1) || message.captureId<=lastCaptureId) {response(false,'invalid-capture');return}
        lastCaptureId=message.captureId
        snapshotCapture={id:message.captureId,monotonic:performance.now(),wall:Date.now()}
        response(true);return
      }
      if (Object.hasOwn(message,'captureId')) {
        const capture=snapshotCapture; snapshotCapture=null
        const now=performance.now(), wall=Date.now()
        if (!sameKeys(message,'captureId,id,type,value') || !capture || message.captureId!==capture.id || !Number.isFinite(now) ||
            now<capture.monotonic || !Number.isSafeInteger(wall) || wall<capture.wall) {snapshot=null;response(false,'invalid-capture');return}
        const age=Math.max(now-capture.monotonic,wall-capture.wall)
        if (age>=snapshotMaxAge) {snapshot=null;response(false,'snapshot-expired');return}
        try {snapshot=parseSnapshot(message.value);snapshotAt=now-age;response(true)}
        catch {snapshot=null;response(false,'invalid-payload')}
        return
      }
      snapshotCapture=null
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
