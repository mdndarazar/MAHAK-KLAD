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

// Actual IPC handler, registry, panelSession, supervisor and child HTTP. Only
// Electron, readiness and AuthService are stubbed; all data/keys are temporary.
test('mobile approval is claimed through desktop IPC and panic closes the real panel session',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-claim-ipc-')),childFile=join(dir,'hub.cjs'),parentFile=join(dir,'parent.cjs'),hubDir=join(dir,'hub'),handlers=new Map();mkdirSync(hubDir)
 const plugin={name:'test-adapters',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}))
  b.onResolve({filter:/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onResolve({filter:/^\.\/AuthService$/},()=>({path:'auth',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='electron' ? `export const ipcMain=globalThis.__claimIpc.ipcMain; export const BrowserWindow=globalThis.__claimIpc.BrowserWindow;` : args.path==='auth' ? `export const readPanelLocks=async()=>({}); export const assertPanelPasswordStrict=async()=>{throw Error('not used')};` : `export const remoteImplementationReady=()=>true; export const REMOTE_GT_PREFIX='gt-'; export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};`}))
 }}
 globalThis.__claimIpc={ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn)},BrowserWindow:{fromWebContents:s=>s.valid?{isDestroyed:()=>false}:null}}
 let state,hub,api
 try {
  await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  await build({stdin:{contents:"export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'; export * from './src/main/services/panelSession.ts'; export {startExperimentalHubSupervisor} from './src/main/services/cloud/experimentalHubSupervisor.ts'; export {openCloudStateStore} from './src/main/services/cloud/cloudState.ts'",resolveDir:process.cwd(),loader:'ts'},outfile:parentFile,bundle:true,platform:'node',format:'cjs',target:'node22',plugins:[plugin],logLevel:'silent'})
  api=createRequire(import.meta.url)(parentFile);state=api.openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
  api.initRemoteGrantRegistry({notePanelUnlocked:(panel,_scope,owner,allowed)=>api.noteRemotePanelUnlocked(panel,owner,allowed),clearPanelScope:api.clearPanelScope,clearPanelSessions:api.clearPanelSessions});api.registerRemoteAuthHandlers()
  hub=await api.startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const window=id=>Object.assign(new EventEmitter(),{id,valid:true,isDestroyed:()=>false}),one=window(42),other=window(43)
  const call=(channel,sender,payload)=>handlers.get(channel)({sender},payload)
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=(await call('remoteAuth:request',one,{panel:'shifts'})).data;let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  const payload={panel:'shifts',requestId:p.requestId,gt:p.gt}
  assert.equal((await call('remoteAuth:claim',other,payload)).ok,false)
  assert.equal((await call('remoteAuth:claim',one,{...payload,requestId:'wrong'})).ok,false)
  assert.equal((await call('remoteAuth:claim',one,{...payload,gt:'gt-'+ 'A'.repeat(43)})).ok,false)
  assert.equal((await call('remoteAuth:claim',one,payload)).ok,true)
  assert.equal(api.isPanelUnlocked('shifts',42),true);assert.equal(api.isPanelUnlocked('shifts',43),false)
  assert.equal((await call('remoteAuth:claim',one,payload)).ok,false)
  // A synthetic sensitive one-shot grant must never use the panel-claim route.
  const sensitive=(await call('remoteAuth:request',other,{panel:'settings'})).data
  assert.ok(api.createGrant({panel:'settings',ownerWindowId:43,tier:'SENSITIVE_MONEY',mode:'PANEL',memberId:'member',requestId:sensitive.requestId,ttlMs:60000}))
  assert.equal((await call('remoteAuth:claim',other,{panel:'settings',requestId:sensitive.requestId,gt:sensitive.gt})).ok,false)
  assert.equal(api.isPanelUnlocked('settings',43),false)
  assert.equal((await send('POST','/api/panic',{pin:'746392'},login.cookie)).status,200)
  assert.equal(api.isPanelUnlocked('shifts',42),false);assert.equal((await call('remoteAuth:claim',one,payload)).ok,false)
 } finally {if(hub)await hub.stop().catch(()=>{});if(api){api.revokeAll();api.clearPanelSessions(42)}if(state)state.close();delete globalThis.__claimIpc;rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
