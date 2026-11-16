/**
 * Experimental identity/ACL store for a dedicated local hub database.
 * This module is not connected to Electron, a web server or the mobile app.
 * Run its synchronous SQLite and scrypt work in a separate hub process, never
 * on the POS main thread or shop.db. The embedding application must protect DB
 * access, supply HTTPS/origin/CSRF protections and integrate remote revocation.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

type Statement = { run(...params: any[]): any; get(...params: any[]): any; all(...params: any[]): any[] }
type Database = { exec(sql: string): void; prepare(sql: string): Statement }
type Role = 'OWNER' | 'MANAGER' | 'VIEWER'
type Acl = { panel: string; view: boolean; approve: boolean }
type Session = { id: string; role: Role; username: string }
const DAY = 24 * 60 * 60_000, INVITE_TTL = 2 * DAY, IDLE = 10 * 60_000, ABSOLUTE = 8 * 60 * 60_000
const LOCK_MS = 15 * 60_000
const PANEL = /^[A-Za-z0-9_.:-]{1,128}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const HEX = /^[a-f0-9]+$/
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const randomToken = () => randomBytes(32).toString('base64url')
const usernameValue = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const name = v.normalize('NFC').trim().toLowerCase()
  return name.length >= 3 && name.length <= 64 && /^[\p{L}\p{N}_.-]+$/u.test(name) ? name : null
}
const passwordOk = (v: unknown): v is string => typeof v === 'string' && v.length >= 10 && Buffer.byteLength(v, 'utf8') <= 128
const pinOk = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{6}$/.test(v)
function derive(secret: string, salt: string) { return scryptSync(secret, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) }
function makeSecret(secret: string) { const salt = randomBytes(16).toString('hex'); return { salt, hash: derive(secret, salt).toString('hex') } }
function matches(secret: string, salt: string, expected: string): boolean {
  if (typeof salt !== 'string' || salt.length !== 32 || !HEX.test(salt) || typeof expected !== 'string' || expected.length !== 64 || !HEX.test(expected)) return false
  return timingSafeEqual(derive(secret, salt), Buffer.from(expected, 'hex'))
}

type Options = { panels: Iterable<string>; approvalPanels: Iterable<string>; now?: () => number }
export function createHubIdentity(db: Database, options: Options) {
  if (!db || !options || !options.panels || !options.approvalPanels) throw new Error('Invalid identity configuration')
  const panels = new Set(options.panels), approvalPanels = new Set(options.approvalPanels)
  if (!panels.size || [...panels].some(p => typeof p !== 'string' || !PANEL.test(p)) ||
      [...approvalPanels].some(p => !panels.has(p))) throw new Error('Invalid panel catalog')
  const now = options.now ?? Date.now
  db.exec(`CREATE TABLE IF NOT EXISTS remote_identity_meta (id INTEGER PRIMARY KEY CHECK(id=1), last_clock INTEGER NOT NULL, paused INTEGER NOT NULL);
    INSERT OR IGNORE INTO remote_identity_meta (id,last_clock,paused) VALUES (1,0,0);
    CREATE TABLE IF NOT EXISTS remote_members (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      status TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL,
      login_fails INTEGER NOT NULL DEFAULT 0, login_locked_until INTEGER NOT NULL DEFAULT 0,
      pin_fails INTEGER NOT NULL DEFAULT 0, pin_locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS remote_one_owner ON remote_members(role) WHERE role='OWNER' AND status != 'REMOVED';
    CREATE TABLE IF NOT EXISTS remote_member_acl (member_id TEXT NOT NULL, panel TEXT NOT NULL, can_view INTEGER NOT NULL, can_approve INTEGER NOT NULL, PRIMARY KEY(member_id,panel));
    CREATE TABLE IF NOT EXISTS remote_invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      status TEXT NOT NULL, expires_at INTEGER NOT NULL, acl_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS remote_sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS remote_identity_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, member_id TEXT, kind TEXT NOT NULL,
      detail TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS remote_identity_revocations (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      kind TEXT NOT NULL, member_id TEXT, acknowledged_at INTEGER);`)
  const q = (sql: string) => db.prepare(sql)
  const metaGet = q('SELECT last_clock, paused FROM remote_identity_meta WHERE id=1')
  const metaSet = q('UPDATE remote_identity_meta SET last_clock=? WHERE id=1')
  const clock = () => {
    const t = now(), m = metaGet.get()
    if (!Number.isSafeInteger(t) || t <= 0 || t > Number.MAX_SAFE_INTEGER - INVITE_TTL ||
        !m || !Number.isSafeInteger(m.last_clock) || t < m.last_clock) throw new Error('Identity clock invalid or moved backwards')
    metaSet.run(t); return t
  }
  const transact = <T>(fn: (t: number) => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(clock()); db.exec('COMMIT'); return result }
    catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
  }
  const audit = (at: number, member: string | null, kind: string, detail = '') => {
    const prev = q('SELECT hash FROM remote_identity_audit ORDER BY id DESC LIMIT 1').get()?.hash ?? ''
    const hash = sha(JSON.stringify([prev, at, member, kind, detail]))
    q('INSERT INTO remote_identity_audit(at,member_id,kind,detail,prev_hash,hash) VALUES(?,?,?,?,?,?)').run(at,member,kind,detail,prev,hash)
  }
  const enqueueRevoke = (t: number, kind: 'MEMBER' | 'ALL', memberId: string | null) => {
    q('INSERT INTO remote_identity_revocations(at,kind,member_id,acknowledged_at) VALUES(?,?,?,NULL)').run(t,kind,memberId)
  }
  const memberById = q('SELECT * FROM remote_members WHERE id=?')
  const memberByName = q('SELECT * FROM remote_members WHERE username=?')
  const memberInsert = q('INSERT INTO remote_members(id,username,role,status,password_salt,password_hash,pin_salt,pin_hash) VALUES(?,?,?,?,?,?,?,?)')
  const sessGet = q('SELECT * FROM remote_sessions WHERE token_hash=?')
  const sessionsDelete = q('DELETE FROM remote_sessions WHERE member_id=?')
  const session = (raw: unknown, t: number): Session | null => {
    if (typeof raw !== 'string' || !TOKEN.test(raw)) return null
    const h = sha(raw), s = sessGet.get(h)
    if (!s || t >= s.expires_at || t - s.last_seen >= IDLE || t < s.last_seen) { if (s) q('DELETE FROM remote_sessions WHERE token_hash=?').run(h); return null }
    const m = memberById.get(s.member_id)
    if (!m || m.status !== 'ACTIVE') { q('DELETE FROM remote_sessions WHERE token_hash=?').run(h); return null }
    q('UPDATE remote_sessions SET last_seen=? WHERE token_hash=?').run(t,h)
    return { id: m.id, role: m.role, username: m.username }
  }
  const pin = (member: Session, value: unknown, t: number): boolean => {
    const m = memberById.get(member.id)
    if (!m || t < m.pin_locked_until) return false
    const ok = pinOk(value) && matches(value, m.pin_salt, m.pin_hash)
    if (!ok) {
      const count = m.pin_fails + 1
      q('UPDATE remote_members SET pin_fails=?,pin_locked_until=? WHERE id=?').run(count >= 5 ? 0 : count, count >= 5 ? t + LOCK_MS : 0, member.id)
      audit(t, member.id, 'PIN_FAILED'); return false
    }
    q('UPDATE remote_members SET pin_fails=0,pin_locked_until=0 WHERE id=?').run(member.id)
    return true
  }
  const owner = (token: unknown, pinValue: unknown, t: number): Session | null => {
    const s = session(token, t)
    return s && s.role === 'OWNER' && pin(s, pinValue, t) ? s : null
  }
  const aclValid = (value: unknown, role: Role): Acl[] | null => {
    if (!Array.isArray(value) || value.length > panels.size) return null
    const seen = new Set<string>(), acl: Acl[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object' || typeof item.panel !== 'string' || !panels.has(item.panel) || seen.has(item.panel) ||
          typeof item.view !== 'boolean' || typeof item.approve !== 'boolean' ||
          (item.approve && (role === 'VIEWER' || !approvalPanels.has(item.panel)))) return null
      seen.add(item.panel); acl.push({ panel: item.panel, view: item.view, approve: item.approve })
    }
    return acl
  }
  const insertAcl = q('INSERT INTO remote_member_acl(member_id,panel,can_view,can_approve) VALUES(?,?,?,?)')
  function writeAcl(memberId: string, acl: Acl[]) {
    q('DELETE FROM remote_member_acl WHERE member_id=?').run(memberId)
    for (const a of acl) insertAcl.run(memberId,a.panel,a.view ? 1 : 0,a.approve ? 1 : 0)
  }
  return {
    /** Only local setup may invoke bootstrap; do not expose it to the network. */
    bootstrap(username: string, password: string, pinValue: string): boolean {
      const name = usernameValue(username)
      if (!name || !passwordOk(password) || !pinOk(pinValue) || password === pinValue) return false
      const p = makeSecret(password), v = makeSecret(pinValue), id = randomBytes(16).toString('hex')
      return transact(t => {
        if (q('SELECT COUNT(*) n FROM remote_members').get().n !== 0) return false
        memberInsert.run(id,name,'OWNER','ACTIVE',p.salt,p.hash,v.salt,v.hash); audit(t,id,'OWNER_BOOTSTRAP'); return true
      })
    },
    login(username: string, password: string): { ok: true; token: string } | { ok: false } {
      const name = usernameValue(username), secret = typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 128 ? password : ''
      return transact(t => {
        const m = name ? memberByName.get(name) : null
        // Unknown/disabled accounts use the same expensive work as a real login.
        const matched = matches(secret, m?.password_salt ?? '0'.repeat(32), m?.password_hash ?? '0'.repeat(64))
        if (!m || m.status !== 'ACTIVE' || t < m.login_locked_until) return { ok: false }
        if (!matched) {
          const count = m.login_fails + 1
          q('UPDATE remote_members SET login_fails=?,login_locked_until=? WHERE id=?').run(count >= 5 ? 0 : count, count >= 5 ? t + LOCK_MS : 0, m.id)
          audit(t,m.id,'LOGIN_FAILED'); return { ok: false }
        }
        q('UPDATE remote_members SET login_fails=0,login_locked_until=0 WHERE id=?').run(m.id)
        // Sessions that expired without being presented would otherwise remain
        // indefinitely. This affects only the dedicated hub DB, never shop.db.
        // A transport-level abuse limit is still required for active sessions.
        q('DELETE FROM remote_sessions WHERE expires_at<=? OR last_seen<=?').run(t,t-IDLE)
        const token = randomToken()
        q('INSERT INTO remote_sessions(token_hash,member_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)').run(sha(token),m.id,t,t,t+ABSOLUTE)
        audit(t,m.id,'LOGIN'); return { ok: true, token }
      })
    },
    logout(token: string): boolean {
      return transact(t => { const s = session(token,t); if (!s) return false; q('DELETE FROM remote_sessions WHERE token_hash=?').run(sha(token)); audit(t,s.id,'LOGOUT'); return true })
    },
    /** Internal session lookup; no credentials or PIN hashes are returned. */
    whoAmI(token: string): Session | null { return transact(t => session(token,t)) },
    /** Owner-only list of current and awaiting-approval accounts, never secrets. */
    listMembers(token: string): { username: string; role: Role; status: string; acl: Acl[] }[] | null {
      return transact(t => {
        const s = session(token,t)
        if (!s || s.role !== 'OWNER') return null
        return q("SELECT id,username,role,status FROM remote_members WHERE status!='REMOVED' ORDER BY username").all().map(m => {
          if ((m.role !== 'OWNER' && m.role !== 'MANAGER' && m.role !== 'VIEWER') ||
              (m.status !== 'ACTIVE' && m.status !== 'PENDING_OWNER_APPROVAL')) throw new Error('Invalid member record')
          const acl = q('SELECT panel,can_view,can_approve FROM remote_member_acl WHERE member_id=? ORDER BY panel').all(m.id).map(a => {
            if (typeof a.panel !== 'string' || !panels.has(a.panel) || ![0,1].includes(a.can_view) || ![0,1].includes(a.can_approve)) throw new Error('Invalid ACL record')
            return { panel:a.panel, view:a.can_view === 1, approve:a.can_approve === 1 }
          })
          return { username:m.username, role:m.role, status:m.status, acl }
        })
      })
    },
    createInvite(token: string, pinValue: string, role: 'MANAGER' | 'VIEWER', requestedAcl: Acl[]): { ok: true; invite: string } | { ok: false } {
      const acl = (role === 'MANAGER' || role === 'VIEWER') ? aclValid(requestedAcl,role) : null
      if (!acl) return { ok: false }
      return transact(t => {
        const s = owner(token,pinValue,t); if (!s) return { ok: false }
        q("UPDATE remote_invites SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=?").run(t)
        const used = q("SELECT COUNT(*) n FROM remote_members WHERE status!='REMOVED'").get().n + q("SELECT COUNT(*) n FROM remote_invites WHERE status='PENDING'").get().n
        if (used >= 5) return { ok: false }
        const invite = randomToken(), id = randomBytes(16).toString('hex')
        q('INSERT INTO remote_invites(id,token_hash,role,status,expires_at,acl_json) VALUES(?,?,?,?,?,?)').run(id,sha(invite),role,'PENDING',t+INVITE_TTL,JSON.stringify(acl))
        audit(t,s.id,'INVITE_CREATED',id); return { ok: true, invite }
      })
    },
    acceptInvite(invite: string, username: string, password: string, pinValue: string): boolean {
      const name = usernameValue(username)
      if (typeof invite !== 'string' || !TOKEN.test(invite) || !name || !passwordOk(password) || !pinOk(pinValue) || password === pinValue) return false
      const p = makeSecret(password), v = makeSecret(pinValue), id = randomBytes(16).toString('hex')
      return transact(t => {
        const row = q('SELECT * FROM remote_invites WHERE token_hash=?').get(sha(invite))
        if (!row || row.status !== 'PENDING' || t >= row.expires_at || memberByName.get(name)) return false
        let acl: Acl[] | null = null
        try { acl = aclValid(JSON.parse(row.acl_json),row.role) } catch {}
        if (!acl || (row.role !== 'MANAGER' && row.role !== 'VIEWER')) return false
        memberInsert.run(id,name,row.role,'PENDING_OWNER_APPROVAL',p.salt,p.hash,v.salt,v.hash)
        writeAcl(id,acl); q("UPDATE remote_invites SET status='CONSUMED' WHERE id=? AND status='PENDING'").run(row.id)
        audit(t,id,'INVITE_ACCEPTED',row.id); return true
      })
    },
    approveMember(token: string, pinValue: string, username: string): boolean {
      const name = usernameValue(username); if (!name) return false
      return transact(t => { const s = owner(token,pinValue,t); if (!s) return false
        const m = memberByName.get(name); if (!m || m.status !== 'PENDING_OWNER_APPROVAL') return false
        q("UPDATE remote_members SET status='ACTIVE' WHERE id=? AND status='PENDING_OWNER_APPROVAL'").run(m.id); audit(t,s.id,'MEMBER_APPROVED',m.id); return true })
    },
    setAcl(token: string, pinValue: string, username: string, requestedAcl: Acl[]): boolean {
      const name = usernameValue(username); if (!name) return false
      return transact(t => { const s = owner(token,pinValue,t); if (!s) return false
        const m = memberByName.get(name); if (!m || m.role === 'OWNER' || m.status === 'REMOVED') return false
        const acl = aclValid(requestedAcl,m.role); if (!acl) return false
        writeAcl(m.id,acl); enqueueRevoke(t,'MEMBER',m.id); audit(t,s.id,'ACL_CHANGED',m.id); return true })
    },
    removeMember(token: string, pinValue: string, username: string): { ok: true; memberId: string } | { ok: false } {
      const name = usernameValue(username); if (!name) return { ok:false }
      return transact(t => { const s = owner(token,pinValue,t); if (!s) return { ok:false }
        const m = memberByName.get(name); if (!m || m.role === 'OWNER' || m.status === 'REMOVED') return { ok:false }
        q("UPDATE remote_members SET status='REMOVED' WHERE id=?").run(m.id); sessionsDelete.run(m.id)
        enqueueRevoke(t,'MEMBER',m.id); audit(t,s.id,'MEMBER_REMOVED',m.id); return { ok:true, memberId:m.id } })
    },
    /** Inspect whether an authenticated member may see approval requests; actual
     * approval still requires the second PIN and all other checks. */
    canApprove(token: string, panel: string): Session | null {
      if (typeof panel !== 'string' || !approvalPanels.has(panel)) return null
      return transact(t => {
        const s = session(token,t)
        if (!s || (s.role !== 'OWNER' && s.role !== 'MANAGER') || metaGet.get().paused !== 0 ||
            q('SELECT 1 AS pending FROM remote_identity_revocations WHERE acknowledged_at IS NULL LIMIT 1').get()) return null
        if (s.role === 'OWNER') return s
        const acl=q('SELECT can_approve FROM remote_member_acl WHERE member_id=? AND panel=?').get(s.id,panel)
        return acl?.can_approve === 1 ? s : null
      })
    },
    authorize(token: string, panel: string, permission: 'VIEW' | 'APPROVE', pinValue?: string): Session | null {
      if (typeof panel !== 'string' || !panels.has(panel) || (permission !== 'VIEW' && permission !== 'APPROVE') ||
          (permission === 'APPROVE' && !approvalPanels.has(panel))) return null
      return transact(t => { const s = session(token,t); if (!s) return null
        const acl = s.role === 'OWNER' ? { can_view:1, can_approve:1 } : q('SELECT can_view,can_approve FROM remote_member_acl WHERE member_id=? AND panel=?').get(s.id,panel)
        if (!acl || (permission === 'VIEW' && acl.can_view !== 1) || (permission === 'APPROVE' && (s.role === 'VIEWER' || acl.can_approve !== 1))) return null
        // Never authorize an intervention while revocation delivery is pending,
        // even if pause was subsequently cleared or a caller bypasses the
        // higher-level approval coordinator.
        if (permission === 'APPROVE' && (metaGet.get().paused !== 0 ||
            q('SELECT 1 AS pending FROM remote_identity_revocations WHERE acknowledged_at IS NULL LIMIT 1').get() ||
            !pin(s,pinValue,t))) return null
        if (permission === 'APPROVE') audit(t,s.id,'APPROVAL_AUTHORIZED',panel)
        return s })
    },
    setPaused(token: string, pinValue: string, paused: boolean): boolean {
      if (typeof paused !== 'boolean') return false
      return transact(t => { const s = owner(token,pinValue,t); if (!s) return false
        q('UPDATE remote_identity_meta SET paused=? WHERE id=1').run(paused ? 1 : 0)
        if (paused) enqueueRevoke(t,'ALL',null)
        audit(t,s.id,paused ? 'PAUSED' : 'RESUMED'); return true })
    },
    /** Internal outbox: a separate trusted bridge must authenticate delivery and
     * acknowledge only after revocation has been applied. Never expose directly
     * to untrusted clients. Pending entries are retained across process restart. */
    pendingRevocations(limit = 100): { id: number; kind: 'ALL' | 'MEMBER'; memberId: string | null }[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid revocation limit')
      return q('SELECT id,kind,member_id FROM remote_identity_revocations WHERE acknowledged_at IS NULL ORDER BY id LIMIT ?').all(limit).map(row => {
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || (row.kind !== 'ALL' && row.kind !== 'MEMBER') ||
            (row.kind === 'ALL' ? row.member_id !== null : typeof row.member_id !== 'string' || !/^[a-f0-9]{32}$/.test(row.member_id))) throw new Error('Invalid revocation')
        return { id: row.id, kind: row.kind, memberId: row.member_id }
      })
    },
    acknowledgeRevocation(id: number): boolean {
      if (!Number.isSafeInteger(id) || id <= 0) return false
      return transact(t => {
        // Require ordered acknowledgement; skipping a prior revoke is unsafe.
        const next = q('SELECT id FROM remote_identity_revocations WHERE acknowledged_at IS NULL ORDER BY id LIMIT 1').get()
        if (!next || next.id !== id) return false
        q('UPDATE remote_identity_revocations SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL').run(t,id)
        return true
      })
    },
    isPaused(): boolean { return transact(() => metaGet.get().paused !== 0) }
  }
}
