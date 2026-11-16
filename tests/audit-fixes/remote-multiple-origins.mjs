import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { createMobileReadOnlyHandler, startMobileReadOnlyHub } from '../../src/main/services/cloud/mobileReadOnlyHub.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { remoteImplementationReady } from '../../src/shared/remoteAuthChannels.ts'

// Two public names are simulated using Host/Origin headers over loopback HTTP.
// No real HTTPS, reverse proxy, Tailscale, Cloudflare, Electron or phone is tested.
const dir=mkdtempSync(join(tmpdir(),'mahak-multi-origin-')),db=new DatabaseSync(join(dir,'identity.sqlite'))
const identity=createHubIdentity(db,{panels:['custody','shifts'],approvalPanels:[]})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const reader={latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[]}
const allowed=['https://shop.example','https://overlay.example:8443']
const base={identity,reader}
function send(port,path,{host='shop.example',method='GET',body,origin,headers={}}={}){
 const data=body===undefined?null:Buffer.from(JSON.stringify(body))
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers:{host,...(data?{'content-type':'application/json','content-length':data.length}:{}),...(origin?{origin}:{}),...headers}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))
 });req.on('error',reject);req.end(data??undefined)})
}
const login=(port,host,origin)=>send(port,'/api/login',{host,origin,method:'POST',body:{username:'owner',password:'owner-test-password'},headers:{'x-mahak-request':'1'}})
try {
 await test('strict origin configuration cannot be ambiguous, broadened or mutated later',async()=>{
  for(const invalid of [
   {},{origin:'https://shop.example',origins:allowed},{origins:[]},{origins:Array(5).fill('https://example.org')},
   {origins:['http://shop.example']},{origins:['https://shop.example/path']},{origins:['https://u:p@shop.example']},
   {origins:['https://shop.example','https://shop.example:443']},{origins:'https://shop.example'},{origins:new Array(1)}
  ])assert.throws(()=>createMobileReadOnlyHandler({...base,...invalid}))
  const mutable=[...allowed],hub=await startMobileReadOnlyHub({...base,origins:mutable})
  try{mutable.push('https://evil.example');assert.equal((await send(hub.port,'/',{host:'evil.example'})).status,421)}finally{await hub.close()}
 })
 await test('each configured host is usable but cross-route and unknown origins cannot POST',async()=>{
  const hub=await startMobileReadOnlyHub({...base,origins:allowed})
  try{
   assert.equal((await send(hub.port,'/',{host:'shop.example'})).status,200)
   assert.equal((await send(hub.port,'/',{host:'overlay.example:8443'})).status,200)
   assert.equal((await send(hub.port,'/',{host:'unknown.example'})).status,421)
   assert.equal((await login(hub.port,'shop.example','https://overlay.example:8443')).status,403)
   assert.equal((await login(hub.port,'overlay.example:8443','https://shop.example')).status,403)
   assert.equal((await login(hub.port,'shop.example','https://evil.example')).status,403)
   for(const [host,origin] of [['shop.example','https://shop.example'],['overlay.example:8443','https://overlay.example:8443']]){
    const result=await login(hub.port,host,origin);assert.equal(result.status,200)
    const cookie=result.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/Domain=/i)
    const response=await send(hub.port,'/api/session',{host,headers:{cookie:cookie.split(';')[0]}});assert.equal(response.status,200)
   }
  }finally{await hub.close()}
 })
 await test('separate child accepts both configured simulated routes without enabling the app',async()=>{
  assert.equal(remoteImplementationReady(),false)
  const childFile=join(dir,'child.cjs');await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  const supervisor=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:mkdtempSync(join(tmpdir(),'mahak-multi-origin-hub-')),
   origins:allowed,owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,91),snapshotMaxAgeMs:5000,
   reader:{...reader,auditPage:async()=>[]},state:{load:()=>null,save:()=>{}},readRestoreMarker:async()=>null,timeoutMs:5000})
  try{
   assert.equal((await login(supervisor.mobilePort,'shop.example','https://shop.example')).status,200)
   assert.equal((await login(supervisor.mobilePort,'overlay.example:8443','https://overlay.example:8443')).status,200)
   assert.equal((await login(supervisor.mobilePort,'overlay.example:8443','https://shop.example')).status,403)
   assert.equal((await send(supervisor.mobilePort,'/',{host:'unknown.example'})).status,421)
  }finally{await supervisor.stop()}
 })
}finally{db.close()}
