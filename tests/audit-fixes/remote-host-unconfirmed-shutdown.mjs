import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Test the real host lifecycle with injected adapters and exclusively temporary files.
test('failed desktop child shutdown is reported and state remains locked',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-host-failed-')),root=join(dir,'remote-hub'),resources=join(dir,'resources'),db=join(dir,'data','shop.db')
 for(const p of [join(root,'state'),join(root,'hub'),join(resources,'remote'),join(dir,'data')])mkdirSync(p,{recursive:true})
 for(const p of [db,join(root,'state','cloud-state.json'),join(root,'hub','remote-hub.sqlite'),join(resources,'remote','node.exe'),join(resources,'remote','remote-hub-child.cjs')])writeFileSync(p,'x')
 writeFileSync(join(root,'config.json'),JSON.stringify({version:1,origin:'https://example.test'}))
 let closed=0,starts=0
 globalThis.__hostFailure={app:{getPath:()=>dir,on:()=>{}},ready:()=>true,enabled:()=>true,open:()=>({load:()=>({storeId:'store_test',epoch:'epoch'}),openRevocationLedger(){},openGrantReplayLedger(){},close(){closed++}}),start:async()=>{starts++;return {mobilePort:12345,stop:async()=>{throw Error('child stop uncertain')}}}}
 const plugin={name:'lifecycle-test-adapters',setup(b){
  b.onResolve({filter:/.*/},args=>{
   const names={'electron':'electron','../db/client':'db','../ipc/remoteAuth':'ipc','../../shared/remoteAuthChannels':'ready','./cloud/remoteSettings':'settings','./cloud/cloudReader':'reader','./cloud/cloudState':'state','./cloud/remoteTransportVault':'vault','./cloud/experimentalRestoreBarrier':'barrier','./cloud/experimentalHubSupervisor':'hub','./cloud/experimentalHubScheduler':'scheduler','./cloud/mobileOrigins':'origins','./RemoteGrantRegistry':'registry','./panelSession':'sessions'}
   return names[args.path]?{path:names[args.path],namespace:'fake'}:undefined
  })
  b.onLoad({filter:/.*/,namespace:'fake'},({path})=>({loader:'js',contents:({electron:'export const app=globalThis.__hostFailure.app,safeStorage={};',db:'export const prisma={};',ipc:'export function registerRemoteAuthHandlers(){}',ready:'export const remoteImplementationReady=globalThis.__hostFailure.ready;',settings:'export const remoteSettingEnabled=globalThis.__hostFailure.enabled;',reader:'export const createCloudReader=()=>({});',state:'export const openCloudStateStore=globalThis.__hostFailure.open;',vault:'export const createRemoteTransportVault=()=>({load:()=>({commandKey:Buffer.alloc(32),auditKey:Buffer.alloc(32)})});',barrier:'export const createExperimentalRestoreBarrier=()=>({});',hub:'export const startExperimentalHubSupervisor=globalThis.__hostFailure.start;',scheduler:'export const createExperimentalHubScheduler=()=>({start(){},stop:async()=>{}});',origins:'export const normalizeMobileOrigins=x=>[x];',registry:'export function initRemoteGrantRegistry(){}',sessions:'export function noteRemotePanelUnlocked(){};export function clearPanelScope(){};export function clearPanelSessions(){}'})[path]}))
 }}
 const previousResources=process.resourcesPath,previousUrl=process.env.DATABASE_URL
 process.resourcesPath=resources;process.env.DATABASE_URL=`file:${db}`
 try {
  const outfile=join(dir,'host.cjs');await build({entryPoints:['src/main/services/CloudSyncService.ts'],outfile,bundle:true,platform:'node',format:'cjs',plugins:[plugin],logLevel:'silent'})
  const api=createRequire(import.meta.url)(outfile);await api.startCloudSync();assert.equal(api.cloudSyncStatus().running,true)
  await assert.rejects(api.stopCloudSync(),/shutdown not confirmed/);assert.equal(closed,0);assert.equal(api.cloudSyncStatus().running,false)
  await assert.rejects(api.stopCloudSync(),/shutdown not confirmed/);await api.startCloudSync();assert.equal(starts,1);assert.equal(closed,0)
 } finally {process.resourcesPath=previousResources;if(previousUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousUrl;delete globalThis.__hostFailure;rmSync(dir,{recursive:true,force:true})}
})
