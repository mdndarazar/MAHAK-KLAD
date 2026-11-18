import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { request } from 'node:http'
import { mkdtempSync,mkdirSync,rmSync,statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Actual direct merge implementation with live child and
// isolated SQLite. Electron and Prisma adapters are harness stubs.
test('direct merge of a migrated temporary backup fences an approved remote grant',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-real-merge-ipc-')),hubDir=join(dir,'hub'),stateDir=join(dir,'state'),childFile=join(dir,'child.cjs'),importDir=join(dir,'backups','imported');mkdirSync(hubDir);mkdirSync(join(dir,'data'));mkdirSync(importDir,{recursive:true})
 process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'data','shop.db')
 await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
 const electron=await import('electron'),handlers=new Map();electron.ipcMain.handle=(ch,fn)=>handlers.set(ch,fn);electron.BrowserWindow.fromWebContents=()=>({isDestroyed:()=>false})
 const {harnessClient,PrismaClient}=await import('../../test/harness/stubs/prismaClient.mjs'),{makeSeeder}=await import('../../test/harness/seed.mjs'),{applyMigrations}=await import('../../src/main/db/migrator.ts')
 const target=harnessClient();makeSeeder(target)
 const {IPC}=await import('@shared/ipc'),{DEFAULT_MANAGER_PASSWORD,SETTING_KEYS}=await import('@shared/receipt')
 const id='imported-migrated.db',backup=join(importDir,id);new DatabaseSync(backup).close()
 let source=new PrismaClient({datasources:{db:{url:`file:${backup}?connection_limit=1`}}})
 const report=await applyMigrations(source,backup,{touchFile:false});assert.ok(report.applied.length>0);assert.equal(report.baselined.length,0);await source.$disconnect()
 source=new PrismaClient({datasources:{db:{url:`file:${backup}?connection_limit=1`}}})
 const sourceSeed=makeSeeder(source);sourceSeed.insert('Shift',{name:'isolated-archive-shift',number:711,dayJalali:'1405/01/01',openedAt:new Date('2026-01-01T00:00:00Z')});await source.$disconnect()
 await target.setting.upsert({where:{key:SETTING_KEYS.backupImports},create:{key:SETTING_KEYS.backupImports,value:JSON.stringify([{id,fileName:id,size:statSync(backup).size,at:new Date().toISOString()}])},update:{value:JSON.stringify([{id,fileName:id,size:statSync(backup).size,at:new Date().toISOString()}])}})
 const {registerIpcHandlers}=await import('../../src/main/ipc/index.ts'),{startExperimentalHubSupervisor}=await import('../../src/main/services/cloud/experimentalHubSupervisor.ts'),{createExperimentalRestoreBarrier}=await import('../../src/main/services/cloud/experimentalRestoreBarrier.ts'),{openCloudStateStore}=await import('../../src/main/services/cloud/cloudState.ts')
 const {initRemoteGrantRegistry,requestCode,consumeOneShot,isGrantActiveForWindow,revokeAll}=await import('../../src/main/services/RemoteGrantRegistry.ts'),session=await import('../../src/main/services/panelSession.ts')
 const state=openCloudStateStore(stateDir),epoch='12345678-1234-4123-8123-123456789abc'
 state.save({version:1,storeId:'store_test',epoch,lastAcked:0,anchorHash:'',restoreMarker:null});state.initializeRevocationLedger();state.initializeGrantReplayLedger()
 initRemoteGrantRegistry({notePanelUnlocked:session.notePanelUnlocked,clearPanelScope:session.clearPanelScope,clearPanelSessions:session.clearPanelSessions});registerIpcHandlers()
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[],waitForIdle:async()=>{}},state,restoreBarrier:createExperimentalRestoreBarrier(),coordinateDesktopBackup:true,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)},approval:{key:Buffer.alloc(32,3),policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}}})
  const send=(method,path,body,cookie)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path,method,headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1',...(data?{'content-type':'application/json','content-length':data.length}:{}),...(cookie?{cookie}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}))});req.on('error',reject);req.end(data)})
  const login=await send('POST','/api/login',{username:'owner',password:'owner-test-password'});assert.equal(login.status,200)
  const p=requestCode('shifts',42);let seen=false
  for(let i=0;i<30&&!seen;i++){const r=await send('GET','/api/requests',undefined,login.cookie);seen=r.body.requests?.some(x=>x.requestId===p.requestId);if(!seen)await new Promise(r=>setTimeout(r,100))}
  assert.ok(seen);assert.equal((await send('POST','/api/approve',{requestId:p.requestId,code:p.code,pin:'746392'},login.cookie)).status,200);assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(session.isPanelUnlocked('shifts',42),true)
  const {mergeBackup}=await import('../../src/main/services/MergeService.ts')
  const result=await mergeBackup({file:backup,fileName:id})
  assert.ok(result && typeof result==='object')
  assert.notEqual(state.load().epoch,epoch);assert.equal(isGrantActiveForWindow('shifts',42),false);assert.equal(session.isPanelUnlocked('shifts',42),false)
  const rows=await target.$queryRawUnsafe('SELECT name FROM Shift WHERE name=?','isolated-archive-shift');assert.equal(rows.length,1)
  await assert.rejects(hub.syncOnce(),/unavailable/)
 } finally {if(hub)await hub.stop().catch(()=>{});revokeAll();session.clearPanelSessions(42);state.close();await target.$disconnect();rmSync(dir,{recursive:true,force:true})}
})
