/**
 * Authenticated audit receiver, run inside the hub child process.
 * It expects a dedicated synchronous SQLite connection to a separate hub DB,
 * never shop.db. The owner must provision and protect the key and connection,
 * guarantee a single writer, and configure SQLite durability before using it.
 * This is not a mobile API, identity system, grant service, or complete hub.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

type Statement = { run(...values: any[]): any; get(...values: any[]): any }
type Database = { exec(sql: string): void; prepare(sql: string): Statement }
type Event = { id: number; at: string; action: string; entity: string }
type Batch = { version: 1; storeId: string; epoch: string; events: Event[]; digest: string }
const PATH = '/internal/v1/audit'
const MAX_BYTES = 128 * 1024
const SKEW_MS = 60_000
const HASH = /^[a-f0-9]{64}$/
const NONCE = /^[a-f0-9]{32}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const sign = (key: Buffer, fields: unknown[]) => createHmac('sha256', key).update(JSON.stringify(fields), 'utf8').digest('hex')
const sameKeys = (obj: object, keys: string) => Object.keys(obj).sort().join(',') === keys

function parseBatch(data: Buffer): Batch {
  const b: any = JSON.parse(data.toString('utf8'))
  if (!b || typeof b !== 'object' || Array.isArray(b) || !sameKeys(b, 'digest,epoch,events,storeId,version') ||
      b.version !== 1 || typeof b.storeId !== 'string' || !ID.test(b.storeId) ||
      typeof b.epoch !== 'string' || !EPOCH.test(b.epoch) || typeof b.digest !== 'string' || !HASH.test(b.digest) ||
      !Array.isArray(b.events) || b.events.length < 1 || b.events.length > 200) throw new Error('Invalid batch')
  let previous = 0
  const events: Event[] = b.events.map((e: any) => {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !sameKeys(e, 'action,at,entity,id') ||
        !Number.isSafeInteger(e.id) || e.id <= previous || typeof e.at !== 'string' ||
        typeof e.action !== 'string' || typeof e.entity !== 'string') throw new Error('Invalid event')
    previous = e.id
    const event = { id: e.id, at: e.at, action: e.action, entity: e.entity }
    if (Buffer.byteLength(JSON.stringify([event.id, event.at, event.action, event.entity]), 'utf8') > 500) throw new Error('Oversized event')
    return event
  })
  const hash = digest(JSON.stringify([1, b.storeId, b.epoch, events.map((e) => [e.id, e.at, e.action, e.entity])]))
  if (hash !== b.digest) throw new Error('Digest mismatch')
  return { version: 1, storeId: b.storeId, epoch: b.epoch, events, digest: b.digest }
}
function uniqueHeader(req: IncomingMessage, name: string): string | null {
  const values: string[] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1])
  return values.length === 1 ? values[0] : null
}
function errorResponse(res: ServerResponse, status: number) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
  res.end('{"ok":false}')
}

/** Creates only namespaced tables on the dedicated hub connection. */
export function createLocalAuditReceiver(db: Database, secret: Uint8Array, options: { now?: () => number; requestTimeoutMs?: number } = {}) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) throw new Error('Invalid receiver key')
  const key = Buffer.from(secret), now = options.now ?? Date.now, timeout = options.requestTimeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Invalid receiver timeout')
  db.exec(`CREATE TABLE IF NOT EXISTS remote_audit_events (
    store_id TEXT NOT NULL, epoch TEXT NOT NULL, audit_id INTEGER NOT NULL,
    at TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
    PRIMARY KEY (store_id, epoch, audit_id)
  ); CREATE TABLE IF NOT EXISTS remote_audit_nonces (
    nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS remote_audit_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1), latest_ms INTEGER NOT NULL
  );`)
  const clockRead = db.prepare('SELECT latest_ms FROM remote_audit_clock WHERE id = 1')
  const clockWrite = db.prepare('INSERT INTO remote_audit_clock (id, latest_ms) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET latest_ms = excluded.latest_ms')
  const find = db.prepare('SELECT at, action, entity FROM remote_audit_events WHERE store_id = ? AND epoch = ? AND audit_id = ?')
  const insert = db.prepare('INSERT INTO remote_audit_events (store_id, epoch, audit_id, at, action, entity) VALUES (?, ?, ?, ?, ?, ?)')
  const nonceInsert = db.prepare('INSERT INTO remote_audit_nonces (nonce, expires_at) VALUES (?, ?)')
  const nonceCleanup = db.prepare('DELETE FROM remote_audit_nonces WHERE expires_at < ?')

  return function receive(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== PATH) { errorResponse(res, 404); return }
    const time = uniqueHeader(req, 'x-mahak-time'), nonce = uniqueHeader(req, 'x-mahak-nonce')
    const signature = uniqueHeader(req, 'x-mahak-signature'), contentType = uniqueHeader(req, 'content-type')
    const length = uniqueHeader(req, 'content-length')
    if (!time || !/^[0-9]{1,16}$/.test(time) || !nonce || !NONCE.test(nonce) || !signature || !HASH.test(signature) ||
        !contentType || !/^application\/json(?:\s*;|\s*$)/i.test(contentType) ||
        !length || !/^[0-9]{1,6}$/.test(length) || Number(length) < 1 || Number(length) > MAX_BYTES || req.headers['transfer-encoding']) {
      errorResponse(res, 400); return
    }
    const timestamp = Number(time), started = now()
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(started) || Math.abs(started - timestamp) > SKEW_MS) { errorResponse(res, 401); return }
    let size = 0, done = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { done = true; errorResponse(res, 408); req.destroy() }, timeout)
    const fail = (status: number) => { if (done) return; done = true; clearTimeout(timer); errorResponse(res, status) }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BYTES || size > Number(length)) { fail(413); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('error', () => fail(400))
    req.on('aborted', () => fail(400))
    req.on('end', () => {
      if (done) return
      const receivedAt = now()
      if (size !== Number(length) || !Number.isSafeInteger(receivedAt) || Math.abs(receivedAt - timestamp) > SKEW_MS) { fail(401); return }
      const data = Buffer.concat(chunks)
      const expected = Buffer.from(sign(key, ['mahak-audit-request-v1', 'POST', PATH, timestamp, nonce, digest(data)]), 'hex')
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) { fail(401); return }
      let batch: Batch
      try { batch = parseBatch(data) } catch { fail(400); return }
      try {
        db.exec('BEGIN IMMEDIATE')
        try {
          // Do not accept timestamps after a clock rollback: old expired nonces may
          // already have been removed. Persist this watermark across restarts.
          const clock = clockRead.get()
          if (clock && (!Number.isSafeInteger(clock.latest_ms) || receivedAt < clock.latest_ms)) throw new Error('Clock moved backwards')
          clockWrite.run(receivedAt)
          nonceCleanup.run(receivedAt)
          // Reject exact network request replays even if all events were already stored.
          nonceInsert.run(nonce, timestamp + SKEW_MS)
          for (const event of batch.events) {
            const row = find.get(batch.storeId, batch.epoch, event.id)
            if (row) {
              if (row.at !== event.at || row.action !== event.action || row.entity !== event.entity) throw new Error('Event conflict')
            } else insert.run(batch.storeId, batch.epoch, event.id, event.at, event.action, event.entity)
          }
          db.exec('COMMIT')
        } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
      } catch { fail(409); return }
      const body = Buffer.from(JSON.stringify({ version: 1, storeId: batch.storeId, epoch: batch.epoch, lastId: batch.events[batch.events.length - 1].id, digest: batch.digest }))
      const ack = sign(key, ['mahak-audit-ack-v1', nonce, 200, digest(body)])
      done = true; clearTimeout(timer)
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
          'cache-control': 'no-store', 'x-mahak-ack-signature': ack })
        res.end(body)
      }
    })
  }
}
