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
  if (!queue || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid revocation bridge')
  let applied = 0
  for (const entry of queue.pendingRevocations(limit)) {
    if (entry.kind === 'ALL' && entry.memberId === null) revokeAll()
    else if (entry.kind === 'MEMBER' && typeof entry.memberId === 'string' && /^[a-f0-9]{32}$/.test(entry.memberId)) revokeBy(entry.memberId)
    else throw new Error('Invalid revocation')
    // Revocation is idempotent; if this fails, leave the item pending and retry.
    if (queue.acknowledgeRevocation(entry.id) !== true) throw new Error('Revocation acknowledgement failed')
    applied++
  }
  return { applied, remaining: queue.pendingRevocations(1).length > 0 }
}
