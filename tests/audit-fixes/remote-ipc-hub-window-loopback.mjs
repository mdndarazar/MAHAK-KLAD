import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Real IPC handlers, registry, supervisor and child/HTTP, all in one bundled
// parent. The readiness override and Electron sender are test-only; no actual
// Electron, phone, tunnel, production keys or shop data are involved.
test('a mobile-approved IPC request is revoked when its desktop window closes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-remote-ipc-hub-')),childFile=join(dir,'hub.cjs'),parentFile=join(dir,'parent.cjs'),hubDir=join(dir,'hub'),handlers=new Map();mkdirSync(hubDir)
 const plugin={name:'isolated-ipc',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}))
  b.onResolve({filter:/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='electron' ? `export const ipcMain=globalThis.__remoteIpcHub.ipcMain; export const BrowserWindow=globalThis.__remoteIpcHub.BrowserWindow;` : `export const remoteImplementationReady=()=>true; export const REMOTE_GT_PREFIX='gt-'; export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};`}))
 }}
 globalThis.__remoteIpcHub={ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn)},BrowserWindow:{fromWebContents:sender=>sender.valid?{isDestroyed:()=>false}:null}}
 let state,hub,api
 try {
  await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  await build({stdin:{contents:"export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'; export {startExperimentalHubSupervisor} from './src/main/services/cloud/experimentalHubSupervisor.ts'; export {openCloudStateStore} from './src/main/services/cloud/cloudState.ts'",resolveDir:process.cwd(),loader:'ts'},outfile:parentFile,bundle:true,platform:'node',format:'cjs',target:'node22',plugins:[plugin],logLevel:'silent'})
  api=createRequire(import.meta.url)(parentFile)
  state=api.openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
  let cleared=0
  api.initRemoteGrantRegistry({notePanelUnlocked:()=>()=>{cleared++},clearPanelScope:()=>{},clearPanelSessions:()=>{throw new Error('local sessions must not be cleared')}})
  api.registerRemoteAuthHandlers()
  hub=await api.startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const window=Object.assign(new EventEmitter(),{id:42,valid:true,isDestroyed:()=>false})
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=(await handlers.get('remoteAuth:request')({sender:window},{panel:'shifts'})).data;let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen)
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  assert.equal((await handlers.get('remoteAuth:status')({sender:window},{panel:'shifts',requestId:p.requestId})).data.state,'APPROVED')
  assert.equal(api.consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(api.isGrantActiveForWindow('shifts',42),true)
  const pending=(await handlers.get('remoteAuth:request')({sender:window},{panel:'settings'})).data
  window.emit('destroyed')
  assert.equal(api.isGrantActiveForWindow('shifts',42),false);assert.equal(api.getRequestStatus(42,'settings',pending.requestId),'UNAVAILABLE');assert.equal(cleared,1)
 } finally {if(hub)await hub.stop().catch(()=>{});if(api)api.revokeAll();if(state)state.close();delete globalThis.__remoteIpcHub;rmSync(dir,{recursive:true,force:true})}
})
