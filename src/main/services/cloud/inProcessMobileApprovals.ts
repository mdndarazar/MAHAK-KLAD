/**
 * Experimental in-process mobile approval controller. No network listener and
 * not started by Electron. A real separate hub must transport requests and
 * signed commands securely and enforce desktop audit/revocation before enabling.
 * The host must serialize identity, replay store and registry access.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { listPendingRequests, type GrantMode, type GrantTier } from '../RemoteGrantRegistry'
import { createAuthenticatedApproval } from './authenticatedApproval'
import type { GrantReplayStore, SignedGrantCommand } from './signedCommandVerifier'

type Identity = {
  isPaused(): boolean
  pendingRevocations(limit?: number): unknown[]
  authorize(token: string, panel: string, permission: 'APPROVE', pin: string): { id: string; role: string } | null
  canApprove(token: string, panel: string): { id: string; role: string } | null
}
type Options = {
  identity: Identity; replayStore: GrantReplayStore; key: Uint8Array; storeId: string
  policies: Readonly<Record<string,{tier: GrantTier; mode: GrantMode; ttlMs: number}>>
  now?: () => number
}
export function createInProcessMobileApprovals(options: Options) {
  if (!options || !options.identity || typeof options.identity.canApprove !== 'function' ||
      !(options.key instanceof Uint8Array) || options.key.byteLength < 32) throw new Error('Invalid mobile approval configuration')
  const key=Buffer.from(options.key), clock=options.now ?? Date.now, storeId=options.storeId, identity=options.identity
  // Independent immutable copy: callers cannot downgrade the policy after setup.
  const policies=Object.fromEntries(Object.entries(options.policies ?? {}).map(([panel,p]) => [panel,{tier:p.tier,mode:p.mode,ttlMs:p.ttlMs}]))
  if (Object.hasOwn(policies,'custody')) throw new Error('Custody approval is disabled')
  const approvals=createAuthenticatedApproval({identity,replayStore:options.replayStore,key,storeId,policies,now:clock})
  return {
    list(token: string): { requestId:string; panel:string; code:string }[] {
      const result: { requestId:string; panel:string; code:string }[]=[]
      const decisions=new Map<string,boolean>()
      for (const p of listPendingRequests()) {
        if (!Object.hasOwn(policies,p.panel)) continue
        if (!decisions.has(p.panel)) decisions.set(p.panel,!!identity.canApprove(token,p.panel))
        if (decisions.get(p.panel)) {
          result.push({requestId:p.requestId,panel:p.panel,code:p.code})
          if (result.length === 200) break
        }
      }
      return result
    },
    approve(token: string, requestId: string, code: string, pin: string): boolean {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId) ||
          typeof code !== 'string' || !/^[0-9]{6}$/.test(code) || typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) return false
      try {
        const pending=listPendingRequests().find(p=>p.requestId===requestId)
        if (!pending || !Object.hasOwn(policies,pending.panel) || !timingSafeEqual(Buffer.from(code),Buffer.from(pending.code))) return false
        // PIN and current ACL are checked before issuing a command; the coordinator
        // checks them again after signature/replay verification.
        const principal=identity.authorize(token,pending.panel,'APPROVE',pin)
        if (!principal || (principal.role !== 'OWNER' && principal.role !== 'MANAGER')) return false
        const issuedAt=clock()
        if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Number.MAX_SAFE_INTEGER-60_000) return false
        const command: Omit<SignedGrantCommand,'signature'>={
          version:1,storeId,requestId,nonce:randomBytes(24).toString('base64url'),panel:pending.panel,
          ownerWindowId:pending.ownerWindowId,memberId:principal.id,tier:policies[pending.panel].tier,issuedAt,expiresAt:issuedAt+60_000
        }
        const bytes=JSON.stringify([command.version,command.storeId,command.requestId,command.nonce,command.panel,command.ownerWindowId,command.memberId,command.tier,command.issuedAt,command.expiresAt])
        const signature=createHmac('sha256',key).update(bytes,'utf8').digest('hex')
        return approvals.approve({...command,signature},{sessionToken:token,pin,code}).ok
      } catch { return false }
    }
  }
}
