import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync,copyFileSync,statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Real IPC handler + BackupService and child/HTTP on isolated harness DB.
// Electron and Prisma are harness stubs; no production data or phone.
test('real backup IPC cancels an in-flight guarded claim before replacement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-real-restore-ipc-')),hubDir=join(dir,'hub'),stateDir=join(dir,'state'),childFile=join(dir,'child.cjs'),dbPath=join(dir,'data','shop.db'),importDir=join(dir,'backups','imported');mkdirSync(hubDir);mkdirSync(join(dir,'data'));mkdirSync(importDir,{recursive:true})
 process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=dbPath
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const electron=await import('electron'),handlers=new Map();electron.ipcMain.handle=(ch,fn)=>handlers.set(ch,fn);electron.BrowserWindow.fromWebContents=()=>({isDestroyed:()=>false});electron.app.relaunch=()=>{};electron.app.exit=()=>{}
 const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs'),{makeSeeder}=await import('../../test/harness/seed.mjs'),prisma=harnessClient();makeSeeder(prisma)
 const {IPC}=await import('@shared/ipc'),{DEFAULT_MANAGER_PASSWORD,SETTING_KEYS}=await import('@shared/receipt')
 const id='imported-isolated.db',backup=join(importDir,id)
 await prisma.setting.upsert({where:{key:'restore.test.marker'},create:{key:'restore.test.marker',value:'backup'},update:{value:'backup'}})
 await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');copyFileSync(dbPath,backup)
 await prisma.setting.upsert({where:{key:'restore.test.marker'},create:{key:'restore.test.marker',value:'current'},update:{value:'current'}})
 await prisma.setting.upsert({where:{key:SETTING_KEYS.backupImports},create:{key:SETTING_KEYS.backupImports,value:JSON.stringify([{id,fileName:id,size:statSync(backup).size,at:new Date().toISOString()}])},update:{value:JSON.stringify([{id,fileName:id,size:statSync(backup).size,at:new Date().toISOString()}])}})
 const {registerIpcHandlers}=await import('../../src/main/ipc/index.ts'),{startExperimentalHubSupervisor}=await import('../../src/main/services/cloud/experimentalHubSupervisor.ts'),{createExperimentalRestoreBarrier}=await import('../../src/main/services/cloud/experimentalRestoreBarrier.ts'),{openCloudStateStore}=await import('../../src/main/services/cloud/cloudState.ts')
 const {initRemoteGrantRegistry,requestCode,claimRemotePanel,isGrantActiveForWindow,revokeAll}=await import('../../src/main/services/RemoteGrantRegistry.ts'),session=await import('../../src/main/services/panelSession.ts')
 const state=openCloudStateStore(stateDir),epoch='12345678-1234-4123-8123-123456789abc'
 state.save({version:1,storeId:'store_test',epoch,lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 initRemoteGrantRegistry({notePanelUnlocked:(panel,_scope,owner,allowed)=>session.noteRemotePanelUnlocked(panel,owner,allowed),clearPanelScope:session.clearPanelScope,clearPanelSessions:session.clearPanelSessions});registerIpcHandlers()
 let hub,disconnected=false,hold=false,notify,release
 const entered=new Promise(r=>{notify=r}), gate=new Promise(r=>{release=r})
 const readRestoreMarker=async()=>{if(hold){notify();await gate}return null}
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[],waitForIdle:async()=>{}},state,restoreBarrier:createExperimentalRestoreBarrier(),coordinateDesktopBackup:true,databaseFile:dbPath,readRestoreMarker,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200)
  const sender={id:42,isDestroyed:()=>false,once:()=>{}}
  hold=true
  const claim=claimRemotePanel(42,'shifts',p.requestId,p.gt.slice(3))
  await entered
  let finished=false
  const restoring=handlers.get(IPC.backupApply)({sender},{id,mode:'replace',managerPassword:DEFAULT_MANAGER_PASSWORD}).then(value=>{finished=true;return value})
  await new Promise(r=>setTimeout(r,150))
  assert.equal(finished,false,'backup must drain the in-flight approval identity check')
  assert.equal(isGrantActiveForWindow('shifts',42),false,'admissions close before waiting')
  const before=new DatabaseSync(dbPath,{readOnly:true});try{assert.equal(before.prepare('SELECT value FROM Setting WHERE key=?').get('restore.test.marker').value,'current')}finally{before.close()}
  hold=false;release()
  assert.equal(await claim,false,'claim must not create a session once restore has closed admission')
  assert.equal(session.isPanelUnlocked('shifts',42),false)
  const result=await restoring;disconnected=true
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.mode,'replace');assert.equal(result.data.willRestart,true)
  assert.notEqual(state.load().epoch,epoch);assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(session.isPanelUnlocked('shifts',42),false)
  const db=new DatabaseSync(dbPath,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM Setting WHERE key=?').get('restore.test.marker').value,'backup')}finally{db.close()}
  await assert.rejects(hub.syncOnce(),/unavailable/)
 } finally {hold=false;release();if(hub)await hub.stop().catch(()=>{});revokeAll();session.clearPanelSessions(42);state.close();if(!disconnected)await prisma.$disconnect().catch(()=>{});rmSync(dir,{recursive:true,force:true})}
})
