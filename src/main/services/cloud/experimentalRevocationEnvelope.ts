/**
 * Experimental signed revocation envelope only. No network, key provisioning,
 * durable replay protection, ordered delivery, ACK, or registry integration.
 * A verified envelope is NOT evidence a desktop applied a revocation.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

type Event = { id:number; kind:'ALL'|'MEMBER'; memberId:string|null }
type Envelope = { version:1; storeId:string; epoch:string; id:number; kind:'ALL'|'MEMBER'; memberId:string|null; nonce:string; issuedAt:number; expiresAt:number; signature:string }
const ID=/^[A-Za-z0-9_-]{1,128}$/
const EPOCH=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NONCE=/^[0-9a-f]{48}$/
const SIG=/^[0-9a-f]{64}$/
function eventValid(v:Event):boolean {
  return !!v && Number.isSafeInteger(v.id) && v.id>0 && ((v.kind==='ALL' && v.memberId===null) ||
    (v.kind==='MEMBER' && typeof v.memberId==='string' && /^[a-f0-9]{32}$/.test(v.memberId)))
}
function bytes(v:Omit<Envelope,'signature'>):string {
  return JSON.stringify(['mahak-revocation-v1',v.version,v.storeId,v.epoch,v.id,v.kind,v.memberId,v.nonce,v.issuedAt,v.expiresAt])
}
export function createExperimentalRevocationEnvelope(key:Uint8Array,storeId:string,epoch:string,now:()=>number=Date.now) {
  if (!(key instanceof Uint8Array) || key.byteLength!==32 || typeof storeId!=='string' || !ID.test(storeId) ||
      typeof epoch!=='string' || !EPOCH.test(epoch) || typeof now!=='function') throw new Error('Invalid revocation configuration')
  const secret=Buffer.from(key)
  return {
    sign(event:Event):Envelope {
      if (!eventValid(event)) throw new Error('Invalid revocation')
      const timestamp=now()
      if (!Number.isSafeInteger(timestamp) || timestamp<=1000 || timestamp>Number.MAX_SAFE_INTEGER-30_000) throw new Error('Invalid clock')
      // Different Windows processes can observe slightly different wall-clock
      // readings. Backdate the signed issue time instead of accepting future
      // messages: the 30-second validity window is correspondingly shorter.
      const issuedAt=timestamp-1000
      const v:Omit<Envelope,'signature'>={version:1,storeId,epoch,id:event.id,kind:event.kind,memberId:event.memberId,
        nonce:randomBytes(24).toString('hex'),issuedAt,expiresAt:issuedAt+30_000}
      return {...v,signature:createHmac('sha256',secret).update(bytes(v)).digest('hex')}
    },
    verify(input:unknown): Event | null {
      try {
        if (!input || typeof input!=='object' || Array.isArray(input)) return null
        const d=Object.getOwnPropertyDescriptors(input), keys=['version','storeId','epoch','id','kind','memberId','nonce','issuedAt','expiresAt','signature']
        if (Reflect.ownKeys(d).length!==keys.length || keys.some(k=>!Object.hasOwn(d,k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable)) return null
        const v=Object.fromEntries(keys.map(k=>[k,d[k].value])) as Envelope
        const t=now()
        if (v.version!==1 || v.storeId!==storeId || v.epoch!==epoch || !eventValid(v) || typeof v.nonce!=='string' || !NONCE.test(v.nonce) ||
            !Number.isSafeInteger(t) || t<=0 || !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) ||
            v.issuedAt<=0 || v.issuedAt>t || v.expiresAt<=t || v.expiresAt-v.issuedAt!==30_000 ||
            typeof v.signature!=='string' || !SIG.test(v.signature)) return null
        const expected=createHmac('sha256',secret).update(bytes(v)).digest(), supplied=Buffer.from(v.signature,'hex')
        if (!timingSafeEqual(expected,supplied)) return null
        return {id:v.id,kind:v.kind,memberId:v.memberId}
      } catch { return null }
    }
  }
}
