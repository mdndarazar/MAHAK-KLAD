import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,rmSync,existsSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { remoteImplementationReady } from '../../src/shared/remoteAuthChannels.ts'

// Runs the asset produced by npm run build with the current test Node executable.
// No Electron, packaged Node runtime, phone, production keys or customer database
// are involved. A missing asset fails the test instead of rebuilding it.
test('packaged hub child starts, serves loopback, and shuts down without enabling the app',async()=>{
 const childFile=resolve('out/main/remote-hub-child.cjs');assert.ok(existsSync(childFile));assert.equal(remoteImplementationReady(),false)
 const dir=mkdtempSync(join(tmpdir(),'mahak-packaged-hub-')),hubDir=join(dir,'hub');mkdirSync(hubDir)
 const state=openCloudStateStore(join(dir,'state'));state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
 let hub
 try {
  hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000})
  const login=await new Promise((resolve,reject)=>{const body=Buffer.from(JSON.stringify({username:'owner',password:'owner-test-password'})),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path:'/api/login',method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':body.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(body)})
  assert.equal(login,200);await hub.stop();hub=null
 } finally {if(hub)await hub.stop().catch(()=>{});state.close();rmSync(dir,{recursive:true,force:true})}
})
