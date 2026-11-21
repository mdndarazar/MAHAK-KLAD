/**
 * Experimental end-to-end approval admission, not exposed as an HTTP or IPC API.
 * The host must run identity + registry + this coordinator in one trusted,
 * serialized owner process. It must protect transport, sessions and key storage,
 * propagate revocations, integrate Panic, configure durable replay storage and
 * audit the actual desktop operation. Do not enable the app based on this module alone.
 */
import { timingSafeEqual } from 'node:crypto'
import { createGrantApprovalCoordinator } from './grantApprovalCoordinator'
import type { GrantReplayStore } from './signedCommandVerifier'
import { getPending, type GrantMode, type GrantTier } from '../RemoteGrantRegistry'

type Identity = {
  isPaused(): boolean
  pendingRevocations(limit?: number): unknown[]
  authorize(token: string, panel: string, permission: 'APPROVE', pin: string): { id: string; role: string } | null
}
type Options = {
  key: Uint8Array; storeId: string
  policies: Readonly<Record<string, { tier: GrantTier; mode: GrantMode; ttlMs: number }>>
  identity: Identity; replayStore: GrantReplayStore; now?: () => number
}
type Credentials = { sessionToken: string; pin: string; code: string }
export function createAuthenticatedApproval(options: Options) {
  if (!options?.identity || typeof options.identity.isPaused !== 'function' || typeof options.identity.authorize !== 'function' ||
      typeof options.identity.pendingRevocations !== 'function' || !options.replayStore ||
      typeof options.replayStore.consume !== 'function') throw new Error('Invalid identity or replay store')
  let credentials: Credentials | null = null
  const coordinator = createGrantApprovalCoordinator({
    key: options.key, storeId: options.storeId, policies: options.policies, now: options.now, replayStore: options.replayStore,
    isPaused: () => {
      if (options.identity.isPaused() !== false) return true
      const pending = options.identity.pendingRevocations(1)
      return !Array.isArray(pending) || pending.length > 0
    },
    mayApprove: (memberId, panel, command) => {
      const c = credentials
      if (!c) return false
      const pending = getPending(command.ownerWindowId, panel)
      if (!pending || pending.requestId !== command.requestId || !timingSafeEqual(Buffer.from(c.code), Buffer.from(pending.code))) return false
      const principal = options.identity.authorize(c.sessionToken, panel, 'APPROVE', c.pin)
      return !!principal && principal.id === memberId && (principal.role === 'OWNER' || principal.role === 'MANAGER')
    }
  })
  return {
    approve(input: unknown, authorization: Credentials): { ok: true; requestId: string } | { ok: false } {
      // No asynchronous work is allowed while credentials are in this scope.
      if (credentials || !authorization || typeof authorization.sessionToken !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(authorization.sessionToken) ||
          typeof authorization.pin !== 'string' || !/^[0-9]{6}$/.test(authorization.pin) ||
          typeof authorization.code !== 'string' || !/^[0-9]{6}$/.test(authorization.code)) return { ok: false }
      credentials = { sessionToken: authorization.sessionToken, pin: authorization.pin, code: authorization.code }
      try { return coordinator.approve(input) } finally { credentials = null }
    }
  }
}
