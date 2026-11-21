import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mobileHtml,mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry,requestCode,createGrant,consumeOneShot,isGrantActiveForWindow,revokeAll,getRequestStatus } from '../../src/main/services/RemoteGrantRegistry.ts'

// Actual PWA script + HTTP + child outbox + desktop registry with temporary DB.
// DOM, desktop panel callbacks and HTTPS are simulated; not a phone or Electron.
test('owner PWA closes a grant and pending request via real child HTTP',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-pwa-p1-')), childFile=join(dir,'hub.cjs'), hubDir=join(dir,'hub')
 mkdirSync(hubDir)
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const state=openCloudStateStore(join(dir,'state'))
 state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger()
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 let hub,cookie=''
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}})
  const calls=[];let releaseRequests
  const delayedRequests=new Promise(resolve=>{releaseRequests=resolve})
  const fetch=(path,options={})=>new Promise((resolve,reject)=>{
   calls.push(path)
   if(path==='/api/requests'){delayedRequests.then(resolve,reject);return}
   const body=options.body,headers={host:'store.example',...(cookie?{cookie}:{}),...(options.headers||{})}
   if(options.method==='POST') headers.origin='https://store.example'
   const req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method:options.method||'GET',headers},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,json:async()=>JSON.parse(Buffer.concat(chunks).toString())})})
   });req.on('error',reject);req.end(body)
  })
  assert.equal((await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','x-mahak-request':'1'},body:JSON.stringify({username:'owner',password:'owner-test-password'})})).status,200)
  class Element {constructor(){this.hidden=false;this.value='';this.checked=false;this.children=[];this.events={};this._text=''}addEventListener(e,f){this.events[e]=f}appendChild(c){this.children.push(c)}set textContent(v){this._text=String(v);this.children=[]}get textContent(){return this._text}fire(e){return this.events[e]({preventDefault(){}})}}
  const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)}
  for(const id of ['dashboard','owner-tools','invoice-tools','invoice-acl-label','invoice-next','panic-close-tools'])el(id).hidden=true
  assert.match(mobileHtml,/id="panic-close-tools" hidden/)
  vm.runInNewContext(mobileJs,{document:{getElementById:el,createElement:()=>new Element()},navigator:{},fetch,console},{timeout:1000})
  const deadline=Date.now()+5000
  while(el('panic-close-tools').hidden&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20))
  assert.equal(el('panic-close-tools').hidden,false)
  while(!calls.includes('/api/requests')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20))
  assert.ok(calls.includes('/api/requests'))
  const p=requestCode('shifts',42)
  assert.ok(createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:p.requestId,ttlMs:60000}))
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true)
  const pending=requestCode('settings',43)
  el('panic-close-pin').value='000000'
  await el('panic-close-form').fire('submit')
  assert.equal(isGrantActiveForWindow('shifts',42),true)
  assert.equal(el('panic-close-pin').value,'');assert.match(el('message').textContent,/تأیید نشد/)
  releaseRequests({ok:true,json:async()=>({requests:[{requestId:'old',panel:'stale',code:'123456'}]})})
  await new Promise(r=>setTimeout(r,20))
  assert.equal(el('request-id').children.length,0);assert.equal(el('approval-form').hidden,true)
  el('panic-close-pin').value='746392'
  await el('panic-close-form').fire('submit')
  assert.equal(isGrantActiveForWindow('shifts',42),false)
  assert.equal(getRequestStatus(43,'settings',pending.requestId),'UNAVAILABLE')
  assert.equal(state.openRevocationLedger().load().id,1)
  assert.equal(el('panic-close-pin').value,'')
  assert.match(el('message').textContent,/بسته شدند/)
  assert.equal(el('dashboard').hidden,false)
  assert.equal(el('request-id').children.length,0);assert.equal(el('approval-form').hidden,true)
  assert.ok(calls.includes('/api/panic/close'))
 } finally {if(hub)await hub.stop();revokeAll();state.close();rmSync(dir,{recursive:true,force:true})}
})
