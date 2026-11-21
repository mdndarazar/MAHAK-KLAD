import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Real backup IPC handler, real BackupService validation, real child/HTTP and
// temporary SQLite only. Invalid backup ID prevents actual replacement.
test('backup IPC fences live hub only after strict password precheck',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-backup-ipc-')),hubDir=join(dir,'hub'),stateDir=join(dir,'state'),childFile=join(dir,'child.cjs');mkdirSync(hubDir);mkdirSync(join(dir,'data'))
 process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'data','shop.db')
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const electron=await import('electron'),handlers=new Map();electron.ipcMain.handle=(channel,handler)=>handlers.set(channel,handler)
 electron.BrowserWindow.fromWebContents=()=>({isDestroyed:()=>false})
 const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs'),{makeSeeder}=await import('../../test/harness/seed.mjs')
 const prisma=harnessClient();makeSeeder(prisma)
 const {IPC}=await import('@shared/ipc'),{DEFAULT_MANAGER_PASSWORD}=await import('@shared/receipt')
 const {registerIpcHandlers}=await import('../../src/main/ipc/index.ts')
 const {startExperimentalHubSupervisor}=await import('../../src/main/services/cloud/experimentalHubSupervisor.ts')
 const {createExperimentalRestoreBarrier}=await import('../../src/main/services/cloud/experimentalRestoreBarrier.ts')
 const {openCloudStateStore}=await import('../../src/main/services/cloud/cloudState.ts')
 const {initRemoteGrantRegistry,requestCode,consumeOneShot,isGrantActiveForWindow,revokeAll}=await import('../../src/main/services/RemoteGrantRegistry.ts')
 const session=await import('../../src/main/services/panelSession.ts')
 const state=openCloudStateStore(stateDir),epoch='12345678-1234-4123-8123-123456789abc'
 state.save({version:1,storeId:'store_test',epoch,lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 initRemoteGrantRegistry({notePanelUnlocked:session.notePanelUnlocked,clearPanelScope:session.clearPanelScope,clearPanelSessions:session.clearPanelSessions})
 registerIpcHandlers()
 const sender={id:42,isDestroyed:()=>false,once:()=>{}}
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[],waitForIdle:async()=>{}},state,restoreBarrier:createExperimentalRestoreBarrier(),coordinateDesktopBackup:true,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(session.isPanelUnlocked('shifts',42),true)
  const apply=handlers.get(IPC.backupApply);assert.ok(apply)
  const denied=await apply({sender},{id:'missing.db',mode:'replace'});assert.equal(denied.ok,false);assert.equal(state.load().epoch,epoch);assert.equal(isGrantActiveForWindow('shifts',42),true)
  const invalid=await apply({sender},{id:'missing.db',mode:'invalid'});assert.equal(invalid.ok,false);assert.equal(state.load().epoch,epoch);assert.equal(isGrantActiveForWindow('shifts',42),true)
  const result=await apply({sender},{id:'missing.db',mode:'replace',managerPassword:DEFAULT_MANAGER_PASSWORD});assert.equal(result.ok,false)
  assert.notEqual(state.load().epoch,epoch);assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(session.isPanelUnlocked('shifts',42),false)
  await assert.rejects(hub.syncOnce(),/barrier closed/)
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();session.clearPanelSessions(42);state.close();await prisma.$disconnect();rmSync(dir,{recursive:true,force:true})}
})
