/**
 * Trusted in-process experimental bridge. Not wired into the application.
 * A real cross-process/network bridge must authenticate messages and durable ACKs;
 * never expose the acknowledgment interface to a mobile or unauthenticated API.
 * Require a serialized host and drain before allowing any further approvals.
 */
import { revokeAll, revokeBy } from '../RemoteGrantRegistry'
type Entry = { id: number; kind: 'ALL' | 'MEMBER'; memberId: string | null }
type Queue = { pendingRevocations(limit?: number): Entry[]; acknowledgeRevocation(id: number): boolean }
export function drainInProcessRevocations(queue: Queue, limit = 100): { applied: number; remaining: boolean } {
  if (!queue || typeof queue.pendingRevocations !== 'function' || typeof queue.acknowledgeRevocation !== 'function' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid revocation bridge')
  const entries = queue.pendingRevocations(limit)
  if (!Array.isArray(entries) || entries.length > limit) throw new Error('Invalid revocation queue')
  let previous = 0
  // Validate the whole batch before revoking or acknowledging anything. Even a
  // trusted adapter must not be able to silently skip an earlier queued event.
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.id) || entry.id <= previous ||
        !((entry.kind === 'ALL' && entry.memberId === null) ||
          (entry.kind === 'MEMBER' && typeof entry.memberId === 'string' && /^[a-f0-9]{32}$/.test(entry.memberId)))) {
      throw new Error('Invalid revocation queue')
    }
    previous = entry.id
  }
  let applied = 0
  for (const entry of entries) {
    if (entry.kind === 'ALL' && entry.memberId === null) revokeAll()
    else if (entry.kind === 'MEMBER' && typeof entry.memberId === 'string' && /^[a-f0-9]{32}$/.test(entry.memberId)) revokeBy(entry.memberId)
    else throw new Error('Invalid revocation')
    // Revocation is idempotent; if this fails, leave the item pending and retry.
    if (queue.acknowledgeRevocation(entry.id) !== true) throw new Error('Revocation acknowledgement failed')
    applied++
  }
  const remaining = queue.pendingRevocations(1)
  if (!Array.isArray(remaining) || remaining.length > 1 ||
      (remaining.length === 1 && (!remaining[0] || !Number.isSafeInteger(remaining[0].id) || remaining[0].id <= previous ||
        !((remaining[0].kind === 'ALL' && remaining[0].memberId === null) ||
          (remaining[0].kind === 'MEMBER' && typeof remaining[0].memberId === 'string' && /^[a-f0-9]{32}$/.test(remaining[0].memberId)))))) {
    throw new Error('Invalid revocation queue')
  }
  return { applied, remaining: remaining.length > 0 }
}
