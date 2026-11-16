/**
 * Experimental desktop-to-local-hub audit transport; not started by the app.
 * This only connects to 127.0.0.1. No mobile endpoint, public listener, proxy,
 * WSS, key provisioning, production hub or mobile API is supplied here. An
 * experimental receiver exists but is not wired into the app. The receiver must
 * authenticate and durably deduplicate before signing a response. Do not activate
 * until all missing pieces are independently tested.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request } from 'node:http'
import type { AuditAck, AuditBatch } from './auditSync'

const PATH = '/internal/v1/audit'
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_REQUEST_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 4096
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const mac = (key: Buffer, fields: unknown[]) => createHmac('sha256', key).update(JSON.stringify(fields), 'utf8').digest('hex')

function checkedBatch(batch: AuditBatch): { payload: Buffer; digest: string } {
  if (!batch || batch.version !== 1 || typeof batch.storeId !== 'string' || !ID.test(batch.storeId) ||
      typeof batch.epoch !== 'string' || !EPOCH.test(batch.epoch) || typeof batch.digest !== 'string' ||
      !HASH.test(batch.digest) || !Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 200) {
    throw new Error('Invalid audit batch')
  }
  let previous = 0
  const events = batch.events.map((e) => {
    if (!e || !Number.isSafeInteger(e.id) || e.id <= previous || typeof e.at !== 'string' ||
        typeof e.action !== 'string' || typeof e.entity !== 'string') throw new Error('Invalid audit event')
    previous = e.id
    const event = { id: e.id, at: e.at, action: e.action, entity: e.entity }
    if (Buffer.byteLength(JSON.stringify([event.id, event.at, event.action, event.entity]), 'utf8') > 500) {
      throw new Error('Audit event too large')
    }
    return event
  })
  const digest = hash(JSON.stringify([1, batch.storeId, batch.epoch, events.map((e) => [e.id, e.at, e.action, e.entity])]))
  if (digest !== batch.digest) throw new Error('Invalid audit batch digest')
  // Construct a fresh allowlisted object so accidental caller properties never leave the process.
  const payload = Buffer.from(JSON.stringify({ version: 1, storeId: batch.storeId, epoch: batch.epoch, events, digest }), 'utf8')
  if (payload.length > MAX_REQUEST_BYTES) throw new Error('Audit batch too large')
  return { payload, digest }
}

export function createLoopbackAuditTransport(endpoint: string, secret: Uint8Array, timeoutMs = 5000) {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('Invalid local hub endpoint') }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      !Number.isInteger(port) || port < 1 || port > 65535 || url.pathname !== PATH ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid local hub endpoint')
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new Error('Invalid local hub transport configuration')
  }
  const key = Buffer.from(secret)
  return {
    send(batch: AuditBatch): Promise<AuditAck> {
      const { payload } = checkedBatch(batch)
      const nonce = randomBytes(16).toString('hex')
      const timestamp = Date.now()
      const signature = mac(key, ['mahak-audit-request-v1', 'POST', PATH, timestamp, nonce, hash(payload)])
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, value?: AuditAck) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value!)
        }
        const req = request({
          hostname: '127.0.0.1', port, method: 'POST', path: PATH, maxHeaderSize: 8192,
          headers: {
            'content-type': 'application/json', 'accept': 'application/json', 'content-length': payload.length,
            'x-mahak-time': String(timestamp), 'x-mahak-nonce': nonce, 'x-mahak-signature': signature
          }
        }, (res) => {
          if (res.statusCode !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(String(res.headers['content-type'] ?? ''))) {
            finish(new Error('Local hub returned an invalid response')); res.destroy(); return
          }
          const signatures: string[] = []
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (res.rawHeaders[i].toLowerCase() === 'x-mahak-ack-signature') signatures.push(res.rawHeaders[i + 1])
          }
          if (signatures.length !== 1 || !HASH.test(signatures[0])) {
            finish(new Error('Invalid local hub acknowledgment signature')); res.destroy(); return
          }
          let size = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) {
              finish(new Error('Local hub response too large')); res.destroy(); return
            }
            chunks.push(chunk)
          })
          res.on('error', () => finish(new Error('Local hub response failed')))
          res.on('end', () => {
            if (settled) return
            const data = Buffer.concat(chunks)
            const expected = Buffer.from(mac(key, ['mahak-audit-ack-v1', nonce, 200, hash(data)]), 'hex')
            const received = Buffer.from(signatures[0], 'hex')
            if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
              finish(new Error('Invalid local hub acknowledgment signature')); return
            }
            try {
              const ack = JSON.parse(data.toString('utf8')) as AuditAck
              if (!ack || Array.isArray(ack) || typeof ack !== 'object' ||
                  Object.keys(ack).sort().join(',') !== 'digest,epoch,lastId,storeId,version' ||
                  ack.version !== 1 || typeof ack.storeId !== 'string' || typeof ack.epoch !== 'string' ||
                  !Number.isSafeInteger(ack.lastId) || typeof ack.digest !== 'string') throw new Error('Invalid ack')
              finish(undefined, ack)
            } catch { finish(new Error('Invalid local hub acknowledgment')) }
          })
        })
        const timer = setTimeout(() => { finish(new Error('Local hub request timed out')); req.destroy() }, timeoutMs)
        req.on('error', () => finish(new Error('Local hub request failed')))
        req.end(payload)
      })
    }
  }
}
