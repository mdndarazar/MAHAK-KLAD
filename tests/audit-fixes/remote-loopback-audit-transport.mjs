import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createAuditSync } from '../../src/main/services/cloud/auditSync.ts'
import { createLoopbackAuditTransport } from '../../src/main/services/cloud/loopbackAuditTransport.ts'

// This receiver is an in-memory test fake, NOT the production hub.
const key=Buffer.alloc(32,0x41), path='/internal/v1/audit'
const hash=(x)=>createHash('sha256').update(x).digest('hex')
const mac=(fields)=>createHmac('sha256',key).update(JSON.stringify(fields),'utf8').digest('hex')
let mode='ok',requests=[],persisted=new Map(),lastSigned=null
const server=createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
    const raw=Buffer.concat(chunks),nonce=req.headers['x-mahak-nonce'],timestamp=Number(req.headers['x-mahak-time'])
    const signature=mac(['mahak-audit-request-v1','POST',path,timestamp,nonce,hash(raw)])
    if(req.method!=='POST'||req.url!==path||req.headers['x-mahak-signature']!==signature||!Number.isSafeInteger(timestamp)||!/^[a-f0-9]{32}$/.test(nonce??'')){
      res.writeHead(401);res.end();return
    }
    const batch=JSON.parse(raw);requests.push({nonce,batch,raw:raw.toString('utf8')})
    if(mode==='redirect'){res.writeHead(302,{location:'http://example.invalid'});res.end();return}
    if(mode==='timeout')return
    for(const e of batch.events){const id=`${batch.storeId}/${batch.epoch}/${e.id}`,value=JSON.stringify(e)
      if(persisted.has(id)&&persisted.get(id)!==value){res.writeHead(409);res.end();return};persisted.set(id,value)}
    let ack={version:1,storeId:batch.storeId,epoch:batch.epoch,lastId:batch.events.at(-1).id,digest:batch.digest}
    if(mode==='wrong-ack')ack.lastId++
    let body=Buffer.from(mode==='bad-json'?'not json':mode==='large'?'x'.repeat(5000):JSON.stringify(ack))
    let signed=mac(['mahak-audit-ack-v1',nonce,200,hash(body)])
    if(mode==='bad-signature')signed='0'.repeat(64)
    if(mode==='replay-signature')signed=lastSigned
    if(mode==='tamper-after-sign')body=Buffer.from('changed')
    if(mode==='duplicate-signature')res.setHeader('x-mahak-ack-signature',[signed,signed])
    else if(mode!=='missing-signature')res.setHeader('x-mahak-ack-signature',signed)
    res.setHeader('content-type',mode==='wrong-content-type'?'text/plain':'application/json; charset=utf-8');res.writeHead(200);res.end(body)
    if(mode==='ok')lastSigned=signed
  })
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
const port=server.address().port, endpoint=`http://127.0.0.1:${port}${path}`
const batch=()=>{
  const e={id:1,at:'1700000000000',action:'SALE_CREATE',entity:'SaleInvoice'},storeId='store_test',epoch='12345678-1234-4123-8123-123456789abc'
  return {version:1,storeId,epoch,events:[e],digest:hash(JSON.stringify([1,storeId,epoch,[[e.id,e.at,e.action,e.entity]]]))}
}
try {
  await test('only exact loopback HTTP endpoint and sufficiently strong key accepted',()=>{
    for(const bad of [`http://localhost:${port}${path}`,`http://0.0.0.0:${port}${path}`,`http://192.168.1.1:${port}${path}`,`https://127.0.0.1:${port}${path}`,`http://127.0.0.1:${port}/other`,`http://u:p@127.0.0.1:${port}${path}`,`http://127.0.0.1:${port}${path}?x=1`,`http://127.0.0.1:${port}${path}#x`,'not a URL'])assert.throws(()=>createLoopbackAuditTransport(bad,key))
    assert.throws(()=>createLoopbackAuditTransport(endpoint,Buffer.alloc(31)));assert.throws(()=>createLoopbackAuditTransport(endpoint,key,0))
  })
  await test('real loopback + SQLite + state advance only on authenticated matching ack',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'mahak-http-sync-')),db=createClient(join(dir,'isolated.db')),seed=makeSeeder(db)
    seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',before:'SECRET',after:'SECRET',note:'SECRET'})
    const stateDir=join(dir,'state');mkdirSync(stateDir);const state=openCloudStateStore(stateDir)
    state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
    try {
      const localKey=Buffer.from(key),transport=createLoopbackAuditTransport(endpoint,localKey,1000);localKey.fill(0)
      const sync=createAuditSync({state,reader:createCloudReader(db),transport,readRestoreMarker:async()=>null})
      const changes=db.$harness.db.prepare('SELECT total_changes() n').get().n
      assert.deepEqual(await sync.runOnce(),{sent:1,lastAcked:1});assert.equal(state.load().lastAcked,1)
      assert.equal(db.$harness.db.prepare('SELECT total_changes() n').get().n,changes)
      assert.equal(requests.length,1);assert.ok(!requests[0].raw.includes('SECRET'))
    }finally{state.close();await db.$disconnect()}
  })
  await test('tampered, replayed, duplicate or missing signatures and altered response fail',async()=>{
    const transport=createLoopbackAuditTransport(endpoint,key,1000)
    for(const setting of ['bad-signature','replay-signature','tamper-after-sign','duplicate-signature','missing-signature']){
      mode=setting;await assert.rejects(transport.send(batch()),/signature/)
    }
  })
  await test('redirect, huge response, invalid JSON and timeouts fail closed',async()=>{
    const transport=createLoopbackAuditTransport(endpoint,key,80)
    for(const setting of ['redirect','large','bad-json','wrong-content-type','timeout']){
      mode=setting;await assert.rejects(transport.send(batch()))
    }
  })
  await test('valid signature is not enough if ack does not match sent batch',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'mahak-http-ack-')),db=createClient(join(dir,'isolated.db')),seed=makeSeeder(db)
    seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice'})
    const stateDir=join(dir,'state');mkdirSync(stateDir);const state=openCloudStateStore(stateDir)
    state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
    try{mode='wrong-ack';const sync=createAuditSync({state,reader:createCloudReader(db),transport:createLoopbackAuditTransport(endpoint,key,1000),readRestoreMarker:async()=>null})
      await assert.rejects(sync.runOnce(),/Invalid acknowledgment/);assert.equal(state.load().lastAcked,0)
    }finally{state.close();await db.$disconnect()}
  })
  await test('receiver rejects a wrong shared key',async()=>{
    mode='ok';await assert.rejects(createLoopbackAuditTransport(endpoint,Buffer.alloc(32,0x42),1000).send(batch()))
  })
  await test('tampered outbound batch is rejected and nonce differs per request',async()=>{
    const transport=createLoopbackAuditTransport(endpoint,key,1000),wrong=batch();wrong.events[0].action='ALTERED'
    assert.throws(()=>transport.send(wrong),/digest/)
    mode='ok';await transport.send(batch());await transport.send(batch())
    const nonces=requests.map(x=>x.nonce);assert.equal(new Set(nonces).size,nonces.length)
  })
} finally {
  server.closeAllConnections?.()
  await new Promise(resolve=>server.close(resolve))
}
