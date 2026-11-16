/**
 * SQLite replay ledger for signed approvals, on the dedicated hub DB only.
 * The caller configures durability and serializes access to the connection.
 * It must be used together with signature, pending-request, ACL and PIN checks.
 * No production transport, key provisioning or app activation is provided here.
 */
type Database = { exec(sql: string): void; prepare(sql: string): { run(...args: any[]): any; get(...args: any[]): any } }
type ReplayResult = 'OK' | 'REPLAY' | 'CAPACITY' | 'INVALID'
const ID = /^[A-Za-z0-9_-]{1,128}$/
const NONCE = /^[A-Za-z0-9_-]{22,128}$/
export function createDurableGrantReplay(db: Database, storeId: string, capacity = 2048) {
  if (!db || typeof storeId !== 'string' || !ID.test(storeId) || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new Error('Invalid replay store configuration')
  db.exec(`CREATE TABLE IF NOT EXISTS remote_command_replay (
    store_id TEXT NOT NULL, request_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(store_id, request_id), UNIQUE(store_id, nonce)
  ); CREATE TABLE IF NOT EXISTS remote_command_replay_clock (
    store_id TEXT PRIMARY KEY, latest_ms INTEGER NOT NULL
  );`)
  const readClock = db.prepare('SELECT latest_ms FROM remote_command_replay_clock WHERE store_id=?')
  const writeClock = db.prepare('INSERT INTO remote_command_replay_clock(store_id,latest_ms) VALUES(?,?) ON CONFLICT(store_id) DO UPDATE SET latest_ms=excluded.latest_ms')
  const cleanup = db.prepare('DELETE FROM remote_command_replay WHERE store_id=? AND expires_at<=?')
  const existing = db.prepare('SELECT 1 AS found FROM remote_command_replay WHERE store_id=? AND (request_id=? OR nonce=?) LIMIT 1')
  const count = db.prepare('SELECT COUNT(*) AS n FROM remote_command_replay WHERE store_id=?')
  const insert = db.prepare('INSERT INTO remote_command_replay(store_id,request_id,nonce,expires_at) VALUES(?,?,?,?)')
  return {
    consume(requestId: string, nonce: string, expiresAt: number, now: number): ReplayResult {
      if (typeof requestId !== 'string' || !ID.test(requestId) || typeof nonce !== 'string' || !NONCE.test(nonce) ||
          !Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 75_000) return 'INVALID'
      db.exec('BEGIN IMMEDIATE')
      try {
        const clock = readClock.get(storeId)
        if (clock && (!Number.isSafeInteger(clock.latest_ms) || now < clock.latest_ms)) { db.exec('ROLLBACK'); return 'INVALID' }
        writeClock.run(storeId,now); cleanup.run(storeId,now)
        let result: ReplayResult
        if (existing.get(storeId,requestId,nonce)) result = 'REPLAY'
        else if (count.get(storeId).n >= capacity) result = 'CAPACITY'
        else { insert.run(storeId,requestId,nonce,expiresAt); result = 'OK' }
        db.exec('COMMIT'); return result
      } catch (e) { try { db.exec('ROLLBACK') } catch {}; throw e }
    }
  }
}
