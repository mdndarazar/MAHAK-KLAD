import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { sendExperimentalRevocation } from '../../src/main/services/cloud/experimentalNetworkRevocation.ts'
import { createExperimentalRevocationEnvelope } from '../../src/main/services/cloud/experimentalRevocationEnvelope.ts'
const key=Buffer.alloc(32,7),storeId='test_store',epoch='12345678-1234-4123-8123-123456789abc'
const fixture=new URL('./fixtures/remote-revocation-receiver.mjs',import.meta.url)
function child(db){
  const process=fork(fixture,[db],{execArgv:['--import','./test/harness/register.mjs'],stdio:['ignore','ignore','inherit','ipc']})
  const applied=[]; process.on('message',m=>{if(m.type==='applied')applied.push(m.entry)})
  const ready=new Promise((resolve,reject)=>{process.on('message',m=>{if(m.type==='ready')resolve(m.port)});process.once('exit',code=>reject(new Error(`receiver exited ${code}`)))})
  return {process,applied,ready,stop:()=>new Promise(resolve=>{process.once('exit',resolve);process.send('stop')})}
}
function post(port,packet){const data=Buffer.from(JSON.stringify(packet));return new Promise((resolve,reject)=>{const r=request({host:'127.0.0.1',port,path:'/internal/revoke',method:'POST',headers:{'content-type':'application/json','content-length':data.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});r.on('error',reject);r.end(data)})}
test('two processes: authenticated ACK, ordering, replay rejection and restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mahak-revocation-network-')),db=join(dir,'isolated.db')
  let receiver=child(db)
  try {
    let port=await receiver.ready
    const send=(prev,event,k=key)=>sendExperimentalRevocation({key:k,storeId,epoch,port,prev,event})
    const one={id:1,kind:'ALL',memberId:null},two={id:2,kind:'MEMBER',memberId:'a'.repeat(32)},three={id:3,kind:'ALL',memberId:null}
    await assert.rejects(send(1,two),/rejected/)
    await assert.rejects(send(0,one,Buffer.alloc(32,8)),/rejected/)
    await send(0,one);await send(1,two)
    await assert.rejects(send(0,one),/rejected/)
    // A new signed retry is allowed only for the latest event after a lost ACK.
    await send(1,two)
    const envelope=createExperimentalRevocationEnvelope(key,storeId,epoch).sign(three),prev=2
    const mac=createHmac('sha256',key).update(JSON.stringify(['mahak-revocation-transport-v1','packet',[prev,envelope]])).digest('hex')
    const packet={prev,envelope,mac}
    assert.equal(await post(port,packet),200);assert.equal(await post(port,packet),400)
    await receiver.stop();receiver=child(db);port=await receiver.ready
    assert.equal(await post(port,packet),400)
    await send(2,three)
    assert.deepEqual(receiver.applied,[three])
  } finally {if(receiver.process.connected)await receiver.stop();rmSync(dir,{recursive:true,force:true})}
})
