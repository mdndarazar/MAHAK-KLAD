/**
 * One bounded audit-mirror cycle for a future transport. Not started by the app.
 *
 * The transport MUST authenticate both the peer and its acknowledgment, durably
 * persist the batch before acknowledging, and deduplicate by (store, epoch, id).
 * These requirements are NOT implemented here. There is no network adapter, spool,
 * restore recovery, worker, retry scheduler, PWA or live-data mirroring yet.
 * Records remain in shop.db until they can be read; this is not a durable outbox.
 * Rechecks cannot make a concurrent database restore atomic with state save;
 * the future coordinator must serialize restore, epoch rotation and this cycle.
 * Never activate this module for a customer without those missing components.
 */
import { createHash } from 'node:crypto'
import type { CloudState } from './cloudState'

type Event = { id: number; at: string; action: string; entity: string }
type Batch = { version: 1; storeId: string; epoch: string; events: Event[]; digest: string }
type Ack = { version: 1; storeId: string; epoch: string; lastId: number; digest: string }
type Dependencies = {
  state: { load(): CloudState | null; save(state: CloudState): void }
  reader: { auditPage(afterId: number, limit?: number): Promise<Event[]> }
  transport: { send(batch: Batch): Promise<Ack> }
  readRestoreMarker: () => Promise<string | null>
}

const HASH = /^[0-9a-f]{64}$/
const EVENT_MAX_BYTES = 500
const PAGE_SIZE = 200
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex')
function eventBytes(event: Event): string {
  return JSON.stringify([event.id, event.at, event.action, event.entity])
}
function eventHash(event: Event): string { return sha(eventBytes(event)) }
function checkedEvents(input: unknown, after: number, limit: number): Event[] {
  if (!Array.isArray(input) || input.length > limit) throw new Error('Invalid audit page')
  let prior = after
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid audit event')
    const e = item as Record<string, unknown>
    if (!Number.isSafeInteger(e.id) || (e.id as number) <= prior ||
        typeof e.at !== 'string' || typeof e.action !== 'string' || typeof e.entity !== 'string') {
      throw new Error('Invalid audit event')
    }
    prior = e.id as number
    const event = { id: e.id as number, at: e.at, action: e.action, entity: e.entity }
    if (Buffer.byteLength(eventBytes(event), 'utf8') > EVENT_MAX_BYTES) throw new Error('Audit event too large')
    return event
  })
}
function markerValue(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !HASH.test(value))) throw new Error('Invalid restore marker')
  return value as string | null
}
function validateAck(value: unknown, batch: Batch): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid acknowledgment')
  const ack = value as Partial<Ack>
  if (ack.version !== 1 || ack.storeId !== batch.storeId || ack.epoch !== batch.epoch ||
      ack.lastId !== batch.events[batch.events.length - 1].id || ack.digest !== batch.digest) {
    throw new Error('Invalid acknowledgment')
  }
}

/** Reject concurrent cycles; the lock remains held until the transport settles. */
export function createAuditSync(deps: Dependencies) {
  let running = false
  async function marker(expected: string | null): Promise<void> {
    if (markerValue(await deps.readRestoreMarker()) !== expected) throw new Error('Restore detected; sync paused')
  }
  async function anchor(id: number, expected: string): Promise<void> {
    const found = checkedEvents(await deps.reader.auditPage(id - 1, 1), id - 1, 1)
    if (found.length !== 1 || found[0].id !== id || eventHash(found[0]) !== expected) {
      throw new Error('Restore or audit history change detected; sync paused')
    }
  }
  return {
    async runOnce(): Promise<{ sent: number; lastAcked: number }> {
      if (running) throw new Error('Audit sync busy')
      running = true
      try {
        const state = deps.state.load()
        if (!state) throw new Error('Cloud state is not initialized')
        await marker(state.restoreMarker)
        if (state.lastAcked > 0) await anchor(state.lastAcked, state.anchorHash)
        const events = checkedEvents(await deps.reader.auditPage(state.lastAcked, PAGE_SIZE), state.lastAcked, PAGE_SIZE)
        await marker(state.restoreMarker)
        if (!events.length) return { sent: 0, lastAcked: state.lastAcked }
        const digest = sha(JSON.stringify([1, state.storeId, state.epoch, events.map((event) => [event.id, event.at, event.action, event.entity])]))
        const batch: Batch = { version: 1, storeId: state.storeId, epoch: state.epoch, events, digest }
        // Keep an independent expected batch in case the transport mutates its input.
        // The adapter itself must be trusted to authenticate durable acknowledgments.
        const expected: Batch = { ...batch, events: batch.events.map((event) => ({ ...event })) }
        const result = await deps.transport.send(batch)
        validateAck(result, expected)
        await marker(state.restoreMarker)
        if (state.lastAcked > 0) await anchor(state.lastAcked, state.anchorHash)
        const reread = checkedEvents(await deps.reader.auditPage(state.lastAcked, expected.events.length), state.lastAcked, expected.events.length)
        if (reread.length !== expected.events.length || reread.some((event, i) => eventBytes(event) !== eventBytes(expected.events[i]))) {
          throw new Error('Restore or audit history change detected; sync paused')
        }
        await marker(state.restoreMarker)
        const last = expected.events[expected.events.length - 1]
        const hash = eventHash(last)
        deps.state.save({ ...state, lastAcked: last.id, anchorHash: hash })
        return { sent: expected.events.length, lastAcked: last.id }
      } finally { running = false }
    }
  }
}
