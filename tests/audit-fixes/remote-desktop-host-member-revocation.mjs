import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createCipheriv,createDecipheriv,hkdfSync,randomBytes } from 'node:crypto'
import { mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync,renameSync,existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createRemoteTransportVault } from '../../src/main/services/cloud/remoteTransportVault.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

// Real desktop host, supervisor, child/HTTP, registry, and panelSession. Electron,
// Prisma, safeStorage and readiness are simulated. All files/keys are temporary;
// no installed Electron, DPAPI, tunnel, phone or real shop database is involved.
test('desktop host member approval, removal and durable acknowledgement close the real panel',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-desktop-host-')),root=join(dir,'remote-hub'),hubDir=join(root,'hub'),stateDir=join(root,'state'),resources=join(dir,'resources'),remote=join(resources,'remote'),db=join(dir,'data','shop.db'),child=join(remote,'remote-hub-child.cjs'),parent=join(dir,'parent.cjs')
 for(const path of [hubDir,stateDir,remote,join(dir,'data')])mkdirSync(path,{recursive:true})
 const dbHandle=new DatabaseSync(db);dbHandle.exec('CREATE TABLE test_value (value TEXT)');dbHandle.close()
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:child,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 copyFileSync(process.execPath,join(remote,'node.exe'))
 writeFileSync(join(dir,'remote-settings.json'),JSON.stringify({enabled:true}))
 writeFileSync(join(root,'config.json'),JSON.stringify({version:1,origin:'https://store.example'}))
 const secret=randomBytes(32),storage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',encryptString(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',secret,iv),out=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),out])},decryptString(value){const d=createDecipheriv('aes-256-gcm',secret,value.subarray(0,12));d.setAuthTag(value.subarray(12,28));return Buffer.concat([d.update(value.subarray(28)),d.final()]).toString('utf8')}}
 const keys=createRemoteTransportVault(root,'store_test',storage).create(),epoch='12345678-1234-4123-8123-123456789abc'
 const derive=purpose=>Buffer.from(hkdfSync('sha256',keys.commandKey,Buffer.from(`store_test:${epoch}`),Buffer.from(`mahak-remote-${purpose}-v1`),32))
 const state=openCloudStateStore(stateDir);state.save({version:1,storeId:'store_test',epoch,lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 const bootstrap=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile:child,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:keys.auditKey,snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,revocation:{key:derive('revocation')},approval:{key:derive('approval'),policies:{products:{tier:'NORMAL',mode:'PANEL',ttlMs:600000}}},timeoutMs:10000})
 await bootstrap.stop();state.close()
 const handlers=new Map(),events=new EventEmitter()
 globalThis.__desktopHost={app:{getPath:()=>dir,on:(name,handler)=>events.on(name,handler),quit:()=>{}},safeStorage:storage,Notification:class{static isSupported(){return true}show(){}},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},BrowserWindow:{fromWebContents:s=>s.valid?{isDestroyed:()=>false}:null}}
 const plugin={name:'desktop-host-adapters',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}))
  b.onResolve({filter:/^\.\.\/db\/client$/},()=>({path:'db',namespace:'fake'}))
  b.onResolve({filter:/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onResolve({filter:/^\.\/AuthService$/},()=>({path:'auth',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='electron' ? `export const app=globalThis.__desktopHost.app,safeStorage=globalThis.__desktopHost.safeStorage,Notification=globalThis.__desktopHost.Notification,ipcMain=globalThis.__desktopHost.ipcMain,BrowserWindow=globalThis.__desktopHost.BrowserWindow;` : args.path==='db' ? `export const prisma={$queryRawUnsafe:async()=>[]};` : args.path==='auth' ? `export const readPanelLocks=async()=>({});export const assertPanelPasswordStrict=async()=>{throw Error('not used')};` : `export const remoteImplementationReady=()=>true;export const REMOTE_GT_PREFIX='gt-';export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};`}))
 }}
 const oldResources=process.resourcesPath,oldUrl=process.env.DATABASE_URL
 process.resourcesPath=resources;process.env.DATABASE_URL=`file:${db}`
 let api
 try {
  await build({stdin:{contents:"export * from './src/main/services/CloudSyncService.ts'; export {isPanelUnlocked} from './src/main/services/panelSession.ts'",resolveDir:process.cwd(),loader:'ts'},outfile:parent,bundle:true,platform:'node',format:'cjs',target:'node22',plugins:[plugin],logLevel:'silent'})
  api=createRequire(import.meta.url)(parent);await api.startCloudSync()
  const info=api.cloudSyncStatus();assert.equal(info.running,true);assert.ok(info.mobilePort>0)
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:info.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const sender=Object.assign(new EventEmitter(),{id:42,valid:true,isDestroyed:()=>false}),call=(channel,payload)=>handlers.get(channel)({sender},payload)
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const invite=await send('POST','/api/invite/create',{pin:'746392',role:'MANAGER',acl:[{panel:'products',view:true,approve:true}]},login.cookie);assert.equal(invite.status,200)
  assert.equal((await send('POST','/api/invite/accept',{invite:invite.body.invite,username:'manager',password:'manager-test-password',pin:'482931'})).status,200)
  assert.equal((await send('POST','/api/member/approve',{username:'manager',pin:'746392'},login.cookie)).status,200)
  const manager=await send('POST','/api/login',{username:'manager',password:'manager-test-password'});assert.equal(manager.status,200)
  const p=(await call('remoteAuth:request',{panel:'products'})).data;let seen=false
  for(let i=0;i<30&&!seen;i++){const response=await send('GET','/api/requests',undefined,manager.cookie);seen=response.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'482931'},manager.cookie)).status,200)
  assert.equal((await call('remoteAuth:claim',{panel:'products',requestId:p.requestId,gt:p.gt})).ok,true);assert.equal(api.isPanelUnlocked('products',42),true)
  assert.equal((await send('POST','/api/member/remove',{username:'manager',pin:'746392'},login.cookie)).status,200)
  assert.equal(api.isPanelUnlocked('products',42),false)
  assert.equal((await call('remoteAuth:claim',{panel:'products',requestId:p.requestId,gt:p.gt})).ok,false)
  assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'482931'},manager.cookie)).status,401)
  // Close the child before the independent read-only SQLite inspection. The
  // assertions still verify the durable sender ACK and receiver ledger.
  await api.stopCloudSync();assert.equal(api.cloudSyncStatus().running,false);await assert.rejects(send('GET','/api/requests',undefined,login.cookie))
  const inspect=new DatabaseSync(join(hubDir,'remote-hub.sqlite'),{readOnly:true})
  try {assert.equal(inspect.prepare('SELECT last_ack n FROM remote_revocation_delivery').get().n,1);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM remote_identity_revocations WHERE acknowledged_at IS NULL').get().n,0)} finally {inspect.close()}
  assert.equal(JSON.parse((await import('node:fs')).readFileSync(join(stateDir,'revocation-ledger.json'),'utf8')).cursor.id,1)
  // A missing owner configuration must not recreate it or start a listener.
  renameSync(join(root,'config.json'),join(root,'config.saved'))
  await api.startCloudSync();assert.equal(api.cloudSyncStatus().running,false);assert.equal(existsSync(join(root,'config.json')),false)
 } finally {if(api)await api.stopCloudSync();process.resourcesPath=oldResources;if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;delete globalThis.__desktopHost;rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
