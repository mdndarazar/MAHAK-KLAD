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
test('restore fails closed after mirror timeout and rejects queued sync without changing database',async()=>{
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
  const reader=api.createCloudReader({$queryRawUnsafe:async(sql,...values)=>{if(hold){entered();await gate}const conn=new DatabaseSync(dbFile,{readOnly:true});try{return conn.prepare(sql).all(...values)}finally{conn.close()}}},1000)
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
  // Restore closes admission immediately, but must not touch the DB while the
  // mirror query is still executing, even after its reader timeout fires.
  hold=true;await reached
  const syncing=hub.syncOnce().then(()=>null,error=>error)
  let restored=false
  const restoring=hub.restoreExclusive(async()=>{restored=true;const conn=new DatabaseSync(dbFile);try{conn.exec("INSERT INTO AuditLog VALUES(2,'2025-01-02','RESTORE','Product')")}finally{conn.close()}}).then(()=>null,error=>error)
  await new Promise(r=>setTimeout(r,1400))
  assert.equal(restored,false)
  assert.equal(barrier.status().state,'DRAINING')
  assert.ok(barrier.status().active>=1)
  assert.equal(api.isPanelUnlocked('shifts',42),false)
  hold=false;release()
  assert.ok(await syncing instanceof Error,'queued sync must not run after restore closes admission')
  assert.ok(await restoring instanceof Error,'timeout must fail restore closed')
  assert.equal(restored,false)
  assert.equal(state.load().epoch,epoch)
  assert.equal(barrier.status().state,'FAILED')
  await assert.rejects(hub.syncOnce())

 } finally {hold=false;release();if(hub)await hub.stop().catch(()=>{});if(api){api.revokeAll();api.clearPanelSessions(42)}if(state)state.close();delete globalThis.__remoteTimeout;rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
