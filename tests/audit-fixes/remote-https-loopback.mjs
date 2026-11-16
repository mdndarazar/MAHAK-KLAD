import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'

// Local test proxy and ephemeral self-signed certificate only: NOT deployment,
// real DNS/Internet, a trusted production certificate, Windows DPAPI or a phone.
const dir=mkdtempSync(join(tmpdir(),'mahak-https-test-')),key=join(dir,'key.pem'),cert=join(dir,'cert.pem')
const make=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=shop.example','-addext','subjectAltName=DNS:shop.example'],{encoding:'utf8'})
if(make.status!==0)throw new Error('openssl test certificate generation failed')
const db=new DatabaseSync(join(dir,'hub.sqlite')),identity=createHubIdentity(db,{panels:['shifts'],approvalPanels:[]})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const hub=await startMobileReadOnlyHub({origin:'https://shop.example',identity,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[]}})
const proxy=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
 const upstream=httpRequest({hostname:'127.0.0.1',port:hub.port,method:req.method,path:req.url,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)})
 upstream.on('error',()=>res.destroy());req.pipe(upstream)
})
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve)})
const port=proxy.address().port
function call({ca,host='shop.example',origin,method='GET',body}={}){
 const data=body?Buffer.from(JSON.stringify(body)):null
 return new Promise((resolve,reject)=>{
  const req=httpsRequest({hostname:'127.0.0.1',port,servername:'shop.example',ca,method,path:method==='GET'?'/':'/api/login',headers:{host,...(origin?{origin,'x-mahak-request':'1'}:{}),...(data?{'content-type':'application/json','content-length':data.length}:{})}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
  });req.on('error',reject);req.end(data??undefined)
 })
}
try {
 await test('TLS rejects an untrusted certificate and accepts the explicitly trusted test certificate',async()=>{
  await assert.rejects(call(),/self-signed|certificate/i)
  assert.equal((await call({ca:readFileSync(cert)})).status,200)
 })
 await test('HTTPS proxy preserves Host and enforces same-origin login and secure cookie',async()=>{
  const ca=readFileSync(cert),body={username:'owner',password:'owner-test-password'}
  assert.equal((await call({ca,host:'bad.example'})).status,421)
  assert.equal((await call({ca,origin:'https://bad.example',method:'POST',body})).status,403)
  const result=await call({ca,origin:'https://shop.example',method:'POST',body})
  assert.equal(result.status,200);assert.match(result.headers['set-cookie'][0],/Secure/)
 })
}finally{
 await new Promise(resolve=>proxy.close(resolve));await hub.close();db.close()
}
