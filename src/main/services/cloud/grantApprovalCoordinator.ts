/**
 * In-process approval coordinator, used by the desktop approval bridge.
 * It does not authenticate a mobile session, persist member ACLs, provision keys,
 * provide an API, or implement Panic. Its caller must supply trusted local policy,
 * synchronous current membership/ACL and pause checks. Replay state is process-local
 * unless a trusted durable store is supplied. Pending requests and grants also
 * disappear on restart. Authenticated commands are consumed before local policy
 * checks; after a denial request anew.
 */
import { createSignedGrantVerifier, type SignedGrantCommand, type GrantReplayStore } from './signedCommandVerifier'
import { createGrant, getPending, type GrantMode, type GrantTier } from '../RemoteGrantRegistry'

type LocalPolicy = { tier: GrantTier; mode: GrantMode; ttlMs: number }
type Options = {
  key: Uint8Array
  storeId: string
  // Policies are decided locally, not by the incoming command.
  policies: Readonly<Record<string, LocalPolicy>>
  // Must consult trusted, current membership and ACL data, not the command alone.
  mayApprove: (memberId: string, panel: string, command: Readonly<SignedGrantCommand>) => boolean
  // Must consult current local persistent Panic/pause state; unknown must not be false.
  isPaused: () => boolean
  now?: () => number
  replayStore?: GrantReplayStore
}
type ApprovalResult = { ok: true; requestId: string } | { ok: false }
const PANEL = /^[A-Za-z0-9_.:-]{1,128}$/

export function createGrantApprovalCoordinator(options: Options) {
  if (!options || !options.policies || typeof options.mayApprove !== 'function' || typeof options.isPaused !== 'function') {
    throw new Error('Invalid local approval policy')
  }
  const policies = new Map<string, Readonly<LocalPolicy>>()
  for (const [panel, policy] of Object.entries(options.policies)) {
    if (!PANEL.test(panel) || !policy || (policy.tier !== 'NORMAL' && policy.tier !== 'SENSITIVE_MONEY') ||
        (policy.mode !== 'PANEL' && policy.mode !== 'ONE_SHOT') ||
        (policy.tier === 'SENSITIVE_MONEY' && policy.mode !== 'ONE_SHOT') ||
        !Number.isSafeInteger(policy.ttlMs) || policy.ttlMs <= 0 ||
        policy.ttlMs > (policy.tier === 'NORMAL' ? 600_000 : 300_000)) throw new Error('Invalid local approval policy')
    policies.set(panel, Object.freeze({ tier: policy.tier, mode: policy.mode, ttlMs: policy.ttlMs }))
  }
  const verify = createSignedGrantVerifier({ key: options.key, storeId: options.storeId, allowedPanels: policies.keys(), now: options.now, replayStore: options.replayStore })
  const isPaused = options.isPaused, mayApprove = options.mayApprove
  return {
    approve(input: unknown): ApprovalResult {
      try {
        const verified = verify(input)
        if (!verified.ok) return { ok: false }
        const c: Readonly<SignedGrantCommand> = Object.freeze(verified.command)
        const policy = policies.get(c.panel)
        if (!policy || c.tier !== policy.tier || isPaused() !== false || mayApprove(c.memberId, c.panel, c) !== true) return { ok: false }
        const pending = getPending(c.ownerWindowId, c.panel)
        if (!pending || pending.requestId !== c.requestId) return { ok: false }
        const grant = createGrant({ requestId: c.requestId, panel: c.panel, ownerWindowId: c.ownerWindowId,
          memberId: c.memberId, tier: policy.tier, mode: policy.mode, ttlMs: policy.ttlMs })
        if (!grant) return { ok: false }
        return { ok: true, requestId: c.requestId }
      } catch {
        // Includes policy-provider errors and unexpected payloads: never approve.
        return { ok: false }
      }
    }
  }
}
