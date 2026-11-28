import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { remoteSettingEnabled } from '../../src/main/services/cloud/remoteSettings.ts'

// CI supplies the unpacked Windows installer's resources. Local execution can
// point at a temporary copy, which is not evidence of installer packaging.
test('unpacked hub resource runs through the packaged Node executable',async()=>{
 const base=process.env.REMOTE_TEST_RESOURCE_DIR
 assert.ok(base,'REMOTE_TEST_RESOURCE_DIR is required')
 const childFile=resolve(base,'remote/remote-hub-child.cjs'),nodeExecutable=resolve(base,'remote/node.exe')
 assert.deepEqual(readFileSync(childFile),readFileSync(resolve('out/main/remote-hub-child.cjs')))
 assert.ok(readFileSync(resolve(base,'remote/LICENSE')).length>0)
 const probe=spawnSync(nodeExecutable,['-e',"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.close();console.log(process.versions.node)"],{encoding:'utf8',timeout:10000,windowsHide:true})
 assert.equal(probe.status,0,probe.stderr);assert.match(probe.stdout,/^\d+\.\d+\.\d+/)
 assert.equal(remoteSettingEnabled(mkdtempSync(join(tmpdir(),'mahak-default-off-'))),false)
 const dir=mkdtempSync(join(tmpdir(),'mahak-installed-hub-')),hubDir=join(dir,'hub');mkdirSync(hubDir)
 const state=openCloudStateStore(join(dir,'state'))
 let hub
 try {
  state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
  hub=await startExperimentalHubSupervisor({nodeExecutable,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:10000})
  const status=await new Promise((resolve,reject)=>{const body=Buffer.from(JSON.stringify({username:'owner',password:'owner-test-password'})),req=request({hostname:'127.0.0.1',port:hub.mobilePort,path:'/api/login',method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':body.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));res.on('error',reject)});req.on('error',reject);req.end(body)})
  assert.equal(status,200);await hub.stop();hub=undefined
 } finally {if(hub)await hub.stop();state.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
