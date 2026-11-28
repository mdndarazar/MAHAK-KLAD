/**
 * Experimental authenticated ordered revocation transport on IPv4 loopback.
 * Not integrated into Electron or the hub. The host must serialize grant
 * admission with apply, durably persist the cursor, and revoke all grants on
 * startup before accepting connections. Both peers must share an exclusive key
 * scoped to a single store and epoch; this is not public/TLS transport.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { createExperimentalRevocationEnvelope } from './experimentalRevocationEnvelope'

type Entry = { id:number; kind:'ALL'|'MEMBER'; memberId:string|null }
type Cursor = { id:number; kind:'ALL'|'MEMBER'; memberId:string|null } | null
// save must atomically persist cursor and nonce; nonces must remain until epoch rotation.
type Ledger = { load():Cursor; hasNonce(nonce:string):boolean; save(entry:Entry,nonce:string):void; apply(entry:Entry):void }
type Envelope = ReturnType<ReturnType<typeof createExperimentalRevocationEnvelope>['sign']>
type Packet = { prev:number; envelope:Envelope; mac:string }
const MAX = 4096
const validCursor=(c:Cursor):boolean=>c===null || (Number.isSafeInteger(c.id) && c.id>0 &&
  ((c.kind==='ALL' && c.memberId===null) || (c.kind==='MEMBER' && typeof c.memberId==='string' && /^[a-f0-9]{32}$/.test(c.memberId))))
const same=(a:Entry,b:Entry)=>a.id===b.id && a.kind===b.kind && a.memberId===b.memberId
function exact(v:unknown,keys:string[]):v is Record<string,unknown> {
  if (!v || typeof v!=='object' || Array.isArray(v)) return false
  const d=Object.getOwnPropertyDescriptors(v)
  return Reflect.ownKeys(d).length===keys.length && keys.every(k=>Object.hasOwn(d,k) && Object.hasOwn(d[k],'value') && d[k].enumerable)
}
function cryptoFor(key:Uint8Array) {
  if (!(key instanceof Uint8Array) || key.byteLength!==32) throw new Error('Invalid transport key')
  const secret=Buffer.from(key)
  const mac=(purpose:string, data:unknown)=>createHmac('sha256',secret).update(JSON.stringify(['mahak-revocation-transport-v1',purpose,data])).digest('hex')
  const check=(actual:unknown,expected:string)=>typeof actual==='string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'))
  return {mac,check}
}
function collect(stream:NodeJS.ReadableStream):Promise<string> {
  return new Promise((resolve,reject)=>{
    let size=0; const chunks:Buffer[]=[]; let done=false
    stream.on('data',(chunk:Buffer)=>{if(done)return;size+=chunk.length;if(size>MAX){done=true;reject(new Error('Oversized message'));return}chunks.push(chunk)})
    stream.on('end',()=>{if(!done){done=true;resolve(Buffer.concat(chunks).toString('utf8'))}})
    stream.on('error',reject)
    stream.on('aborted',()=>reject(new Error('Aborted')))
  })
}
/** Caller is responsible for fail-closed startup and exclusive ledger ownership. */
export async function startExperimentalRevocationReceiver(options:{key:Uint8Array;storeId:string;epoch:string;ledger:Ledger}):Promise<{port:number;close():Promise<void>}> {
  const {key,storeId,epoch,ledger}=options
  if (!ledger || typeof ledger.load!=='function' || typeof ledger.hasNonce!=='function' || typeof ledger.save!=='function' || typeof ledger.apply!=='function') throw new Error('Invalid ledger')
  const auth=cryptoFor(key), envelopes=createExperimentalRevocationEnvelope(key,storeId,epoch)
  if (!validCursor(ledger.load())) throw new Error('Invalid cursor')
  const server:Server=createServer(async(req,res)=>{
    let authenticated=false, failure='validation'
    try {
      if (req.method!=='POST' || req.url!=='/internal/revoke' || req.headers['content-type']!=='application/json' || req.socket.remoteAddress!=='127.0.0.1') throw new Error('Rejected')
      const value:unknown=JSON.parse(await collect(req))
      if (!exact(value,['prev','envelope','mac']) || !Number.isSafeInteger(value.prev) || (value.prev as number)<0 ||
          !auth.check(value.mac,auth.mac('packet',[value.prev,value.envelope]))) throw new Error('Authentication failed')
      authenticated=true;failure='envelope'
      const event=envelopes.verify(value.envelope)
      if (!event) {
        const envelope=value.envelope as Partial<Envelope> | null,t=Date.now()
        if (envelope && Number.isSafeInteger(envelope.issuedAt) && envelope.issuedAt!>t) failure='clock-future'
        else if (envelope && Number.isSafeInteger(envelope.expiresAt) && envelope.expiresAt!<=t) failure='clock-expired'
        throw new Error('Invalid event')
      }
      failure='ledger';const cursor=ledger.load()
      if (!validCursor(cursor)) throw new Error('Invalid cursor')
      failure='order-or-replay'
      const previous=value.prev as number, nonce=(value.envelope as Envelope).nonce
      if (ledger.hasNonce(nonce)!==false) throw new Error('Replay rejected')
      if (cursor && same(cursor,event)) {
        // A fresh authenticated retry of the most recent event is safe; apply
        // again before acknowledging, covering loss of in-memory grant state.
        if (previous>=event.id) throw new Error('Invalid predecessor')
      } else if ((cursor?.id ?? 0)!==previous || event.id<=previous) throw new Error('Out of order or replay')
      failure='ledger';ledger.apply(event)
      ledger.save(event,nonce)
      const signature=(value.envelope as Envelope).signature
      const ack={id:event.id,signature,mac:auth.mac('ack',[event.id,signature])}
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(ack))
    } catch {
      // Report only a fixed category after packet MAC authentication; never log
      // IDs, payloads, nonces, signatures or credentials.
      if (authenticated) console.error(`[remote revocation] authenticated packet rejected: ${failure}`)
      if (!res.headersSent) res.writeHead(400,{'cache-control':'no-store'});res.end()
    }
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
  const address=server.address()
  if (!address || typeof address==='string') { server.close();throw new Error('Invalid address') }
  return {port:address.port,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}
/** Returns only after a matching authenticated ACK; caller must commit outbox
 * acknowledgement and last-acknowledged ID atomically before sending next. */
export async function sendExperimentalRevocation(options:{key:Uint8Array;storeId:string;epoch:string;port:number;prev:number;event:Entry;timeoutMs?:number}):Promise<void> {
  const {key,storeId,epoch,port,prev,event}=options, timeout=options.timeoutMs ?? 3000
  if (!Number.isSafeInteger(port)||port<1||port>65535||!Number.isSafeInteger(prev)||prev<0||!Number.isSafeInteger(timeout)||timeout<100||timeout>30000) throw new Error('Invalid transport configuration')
  const auth=cryptoFor(key),envelope=createExperimentalRevocationEnvelope(key,storeId,epoch).sign(event)
  if (event.id<=prev) throw new Error('Invalid predecessor')
  const packet:Packet={prev,envelope,mac:auth.mac('packet',[prev,envelope])}, data=Buffer.from(JSON.stringify(packet))
  const result=await new Promise<{status:number|undefined;body:string}>((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path:'/internal/revoke',method:'POST',headers:{'content-type':'application/json','content-length':data.length},agent:false},async res=>{
      try {resolve({status:res.statusCode,body:await collect(res)})} catch(e){reject(e)}
    })
    req.setTimeout(timeout,()=>req.destroy(new Error('Revocation timeout')));req.on('error',reject);req.end(data)
  })
  if(result.status!==200) throw new Error('Revocation rejected')
  const ack:unknown=JSON.parse(result.body)
  if (!exact(ack,['id','signature','mac']) || ack.id!==event.id || ack.signature!==envelope.signature || !auth.check(ack.mac,auth.mac('ack',[event.id,envelope.signature]))) throw new Error('Invalid acknowledgement')
}
