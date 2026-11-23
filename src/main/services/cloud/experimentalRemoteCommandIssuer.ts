/**
 * Experimental hub-side signer for a future cross-process grant bridge. It is
 * not connected to the running application or mobile HTTP server. The caller
 * must supply a protected private transport, a trusted live request snapshot,
 * verified session/ACL/PIN, durable desktop replay protection, revocation and
 * audit before enabling remote access. A signed command alone is not a grant.
 */
import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto'
import type { SignedGrantCommand } from './signedCommandVerifier'
import type { GrantMode,GrantTier } from '../RemoteGrantRegistry'

type Pending = { requestId:string; panel:string; code:string; ownerWindowId:number; recent?:number }
type Identity = {
  canApprove(token:string,panel:string): {id:string;role:string} | null
  authorize(token:string,panel:string,permission:'APPROVE',pin:string): {id:string;role:string} | null
}
type Policy = {tier:GrantTier;mode:GrantMode;ttlMs:number}
type Options = {
  key:Uint8Array;storeId:string;policies:Readonly<Record<string,Policy>>;identity:Identity
  pending:()=>Pending[];send:(command:SignedGrantCommand)=>Promise<boolean>;now?:()=>number
}
const ID=/^[A-Za-z0-9_-]{1,128}$/,PANEL=/^[A-Za-z0-9_.:-]{1,128}$/,REQUEST=/^[a-f0-9]{32}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/

export function createExperimentalRemoteCommandIssuer(options:Options) {
  if (!options || !(options.key instanceof Uint8Array) || options.key.byteLength !== 32 ||
      typeof options.storeId !== 'string' || !ID.test(options.storeId) || !options.identity ||
      typeof options.identity.canApprove !== 'function' || typeof options.identity.authorize !== 'function' ||
      typeof options.pending !== 'function' || typeof options.send !== 'function') throw new Error('Invalid issuer configuration')
  const policies=new Map<string,Readonly<Policy>>()
  for (const [panel,p] of Object.entries(options.policies ?? {})) {
    if (!PANEL.test(panel) || panel === 'custody' || !p || (p.tier !== 'NORMAL' && p.tier !== 'SENSITIVE_MONEY') ||
        (p.mode !== 'PANEL' && p.mode !== 'ONE_SHOT') || (p.tier === 'SENSITIVE_MONEY' && p.mode !== 'ONE_SHOT') ||
        !Number.isSafeInteger(p.ttlMs) || p.ttlMs <= 0 || p.ttlMs > 3_600_000) throw new Error('Invalid issuer policy')
    policies.set(panel,Object.freeze({tier:p.tier,mode:p.mode,ttlMs:p.ttlMs}))
  }
  const key=Buffer.from(options.key),storeId=options.storeId,identity=options.identity,clock=options.now ?? Date.now
  const inflight=new Set<string>()
  let lastTime=0
  function requests(): Pending[] {
    const raw=options.pending()
    if (!Array.isArray(raw) || raw.length > 200) throw new Error('Invalid pending requests')
    const seen=new Set<string>()
    return raw.map(p=>{
      if (!p || typeof p.requestId !== 'string' || !REQUEST.test(p.requestId) || seen.has(p.requestId) ||
          typeof p.panel !== 'string' || !PANEL.test(p.panel) || typeof p.code !== 'string' || !/^[0-9]{6}$/.test(p.code) ||
          !Number.isSafeInteger(p.ownerWindowId) || p.ownerWindowId <= 0 ||
          (p.recent !== undefined && (!Number.isSafeInteger(p.recent) || p.recent <= 3 || p.recent > 1000))) throw new Error('Invalid pending request')
      seen.add(p.requestId)
      return {requestId:p.requestId,panel:p.panel,code:p.code,ownerWindowId:p.ownerWindowId,...(p.recent !== undefined ? {recent:p.recent} : {})}
    })
  }
  return {
    list(token:string): {requestId:string;panel:string;code:string;recent?:number}[] {
      if (typeof token !== 'string' || !TOKEN.test(token)) return []
      try {
        const decisions=new Map<string,boolean>()
        return requests().filter(p=>{
          if (!policies.has(p.panel)) return false
          if (!decisions.has(p.panel)) decisions.set(p.panel,!!identity.canApprove(token,p.panel))
          return decisions.get(p.panel) === true
        }).map(p=>({requestId:p.requestId,panel:p.panel,code:p.code,...(p.recent !== undefined ? {recent:p.recent} : {})}))
      } catch { return [] }
    },
    async approve(token:string,requestId:string,code:string,pin:string):Promise<boolean> {
      if (typeof token !== 'string' || !TOKEN.test(token) || typeof requestId !== 'string' || !REQUEST.test(requestId) ||
          typeof code !== 'string' || !/^[0-9]{6}$/.test(code) || typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin) ||
          inflight.has(requestId) || inflight.size >= 200) return false
      inflight.add(requestId)
      try {
        const p=requests().find(x=>x.requestId===requestId)
        if (!p || !policies.has(p.panel) || !timingSafeEqual(Buffer.from(code),Buffer.from(p.code))) return false
        const current=identity.canApprove(token,p.panel)
        if (!current || (current.role !== 'OWNER' && current.role !== 'MANAGER')) return false
        const principal=identity.authorize(token,p.panel,'APPROVE',pin)
        if (!principal || principal.id !== current.id || principal.role !== current.role || !ID.test(principal.id)) return false
        // If the trusted mirror changed during credential validation, reject; the
        // desktop must independently check its live pending request too.
        const again=requests().find(x=>x.requestId===requestId)
        if (!again || again.panel !== p.panel || again.ownerWindowId !== p.ownerWindowId || again.code !== p.code) return false
        const issuedAt=clock()
        if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt < lastTime || issuedAt > Number.MAX_SAFE_INTEGER-3000) return false
        lastTime=issuedAt
        const command: Omit<SignedGrantCommand,'signature'>={version:1,storeId,requestId,nonce:randomBytes(24).toString('base64url'),
          panel:p.panel,ownerWindowId:p.ownerWindowId,memberId:principal.id,tier:policies.get(p.panel)!.tier,issuedAt,expiresAt:issuedAt+3000}
        const bytes=JSON.stringify([command.version,command.storeId,command.requestId,command.nonce,command.panel,command.ownerWindowId,
          command.memberId,command.tier,command.issuedAt,command.expiresAt])
        const signature=createHmac('sha256',key).update(bytes,'utf8').digest('hex')
        return await options.send({...command,signature}) === true
      } catch { return false } finally { inflight.delete(requestId) }
    }
  }
}
