import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Real child/HTTP, IPC, registry, panel session, cloud reader and isolated SQLite.
// Electron/auth/readiness are simulated; a stalled query is injected explicitly.
test('approval waits for in-flight sync and preserves active session',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-timeout-')),childFile=join(dir,'hub.cjs'),parentFile=join(dir,'parent.cjs'),hubDir=join(dir,'hub'),dbFile=join(dir,'shop.db'),handlers=new Map();mkdirSync(hubDir)
 const db=new DatabaseSync(dbFile);db.exec("CREATE TABLE AuditLog(id INTEGER PRIMARY KEY, at TEXT, action TEXT, entity TEXT); INSERT INTO AuditLog VALUES(1,'2025-01-01','CREATE','Product')");db.close()
 const anchor=createHash('sha256').update(JSON.stringify([1,'2025-01-01','CREATE','Product'])).digest('hex')
 const plugin={name:'adapters',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}))
  b.onResolve({filter:/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onResolve({filter:/^\.\/AuthService$/},()=>({path:'auth',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='electron'?`export const ipcMain=globalThis.__remoteTimeout.ipcMain; export const BrowserWindow=globalThis.__remoteTimeout.BrowserWindow;`:args.path==='auth'?`export const readPanelLocks=async()=>({}); export const assertPanelPasswordStrict=async()=>{throw Error('not used')};`:`export const remoteImplementationReady=()=>true; export const REMOTE_GT_PREFIX='gt-'; export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};`}))
 }}
 globalThis.__remoteTimeout={ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn)},BrowserWindow:{fromWebContents:s=>s.valid?{isDestroyed:()=>false}:null}}
 let state,hub,api,release,entered;let hold=false
 const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r)
 try {
  await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  await build({stdin:{contents:"export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'; export * from './src/main/services/panelSession.ts'; export {startExperimentalHubSupervisor} from './src/main/services/cloud/experimentalHubSupervisor.ts'; export {openCloudStateStore} from './src/main/services/cloud/cloudState.ts'; export {createCloudReader} from './src/main/services/cloud/cloudReader.ts'; export {createExperimentalRestoreBarrier} from './src/main/services/cloud/experimentalRestoreBarrier.ts';",resolveDir:process.cwd(),loader:'ts'},outfile:parentFile,bundle:true,platform:'node',format:'cjs',target:'node22',plugins:[plugin],logLevel:'silent'})
  api=createRequire(import.meta.url)(parentFile);state=api.openCloudStateStore(join(dir,'state'));const epoch='12345678-1234-4123-8123-123456789abc';state.save({version:1,storeId:'store_test',epoch,lastAcked:1,anchorHash:anchor,restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
  api.initRemoteGrantRegistry({notePanelUnlocked:(panel,_scope,owner,allowed)=>api.noteRemotePanelUnlocked(panel,owner,allowed),clearPanelScope:api.clearPanelScope,clearPanelSessions:api.clearPanelSessions});api.registerRemoteAuthHandlers()
  const reader=api.createCloudReader({$queryRawUnsafe:async(sql,...values)=>{if(hold){entered();await gate}const conn=new DatabaseSync(dbFile,{readOnly:true});try{return conn.prepare(sql).all(...values)}finally{conn.close()}}},4000)
  const barrier=api.createExperimentalRestoreBarrier()
  hub=await api.startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader,state,databaseFile:dbFile,restoreBarrier:barrier,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000},settings:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const window=id=>Object.assign(new EventEmitter(),{id,valid:true,isDestroyed:()=>false}),one=window(42),two=window(43),call=(ch,sender,payload)=>handlers.get(ch)({sender},payload)
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  async function mirrored(p){for(let i=0;i<50;i++){const r=await send('GET','/api/requests',undefined,login.cookie);if(r.body.requests?.some(x=>x.requestId===p.requestId))return;await new Promise(r=>setTimeout(r,100))}throw Error('Request not mirrored')}
  const p=(await call('remoteAuth:request',one,{panel:'shifts'})).data;await mirrored(p)
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  assert.equal((await call('remoteAuth:claim',one,{panel:'shifts',requestId:p.requestId,gt:p.gt})).ok,true)
  assert.equal(api.isPanelUnlocked('shifts',42),true)
  const second=(await call('remoteAuth:request',two,{panel:'settings'})).data;await mirrored(second)
  // Suspend the actual SQL used by sync, then deliver a genuine signed mobile
  // approval through the child. Neither work should contend for the reader.
  hold=true
  const syncing=hub.syncOnce()
  await reached
  let approvalFinished=false
  const approval=send('POST','/api/approve',{requestId:second.requestId,code:second.code,pin:'746392'},login.cookie).then(result=>{approvalFinished=true;return result})
  await new Promise(r=>setTimeout(r,350))
  assert.equal(approvalFinished,false,'approval must wait for the foreground SQL owner')
  assert.equal(api.isPanelUnlocked('shifts',42),true)
  assert.equal(state.load().epoch,epoch)
  assert.ok(barrier.status().active>=2)
  hold=false;release()
  assert.equal((await syncing).sent,0)
  assert.equal((await approval).status,200)
  assert.equal((await call('remoteAuth:claim',two,{panel:'settings',requestId:second.requestId,gt:second.gt})).ok,true)
  assert.equal(api.isPanelUnlocked('shifts',42),true)
  assert.equal(api.isPanelUnlocked('settings',43),true)
  assert.equal(state.load().epoch,epoch)

 } finally {hold=false;release();if(hub)await hub.stop().catch(()=>{});if(api){api.revokeAll();api.clearPanelSessions(42);api.clearPanelSessions(43)}if(state)state.close();delete globalThis.__remoteTimeout;rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
