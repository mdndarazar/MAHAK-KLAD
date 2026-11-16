import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { initRemoteGrantRegistry, requestCode, createGrant, consumeOneShot, isGrantActiveForWindow, getRequestStatus, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Real child, HTTP, durable receiver and registry. The panel callback is injected;
// no Electron lifecycle, production database, tunnel or phone is used.
test('stopping a real hub reports failed desktop cleanup and leaves grants inactive', async () => {
  const dir=mkdtempSync(join(tmpdir(),'mahak-stop-cleanup-'))
  const childFile=join(dir,'hub.cjs'), hubDir=join(dir,'hub'); mkdirSync(hubDir)
  await build({entryPoints:[fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url))],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
  const state=openCloudStateStore(join(dir,'state'))
  state.save({version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
  state.initializeRevocationLedger()
  let fail=false, cleanups=0, hub
  initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{cleanups++;if(fail)throw new Error('cleanup')},clearPanelSessions:()=>{}})
  try {
    hub=await startExperimentalHubSupervisor({nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:Buffer.alloc(32,1),snapshotMaxAgeMs:5000,reader:{latestBoundaryTotals:async()=>null,openShiftsPage:async()=>[],auditPage:async()=>[]},state,readRestoreMarker:async()=>null,timeoutMs:5000,revocation:{key:Buffer.alloc(32,2)}})
    const login=await new Promise((resolve,reject)=>{
      const body=Buffer.from(JSON.stringify({username:'owner',password:'owner-test-password'}))
      const req=request({hostname:'127.0.0.1',port:hub.mobilePort,path:'/api/login',method:'POST',headers:{host:'store.example',origin:'https://store.example','x-mahak-request':'1','content-type':'application/json','content-length':body.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(body)
    })
    assert.equal(login,200)
    const p=requestCode('shifts',42)
    assert.ok(createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId:'owner',requestId:p.requestId,ttlMs:60000}))
    assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true)
    const pending=requestCode('settings',43)
    fail=true
    const stopping=hub.stop()
    assert.equal(isGrantActiveForWindow('shifts',42),false)
    assert.equal(getRequestStatus(43,'settings',pending.requestId),'UNAVAILABLE')
    await assert.rejects(stopping,/cleanup not confirmed/)
    hub=null
    assert.ok(cleanups>=1)
    fail=false;revokeAll()
    assert.ok(cleanups>=2,'failed cleanup remains retryable')
    assert.equal(isGrantActiveForWindow('shifts',42),false)
  } finally {
    fail=false
    if (hub) await hub.stop().catch(()=>{})
    revokeAll();state.close();rmSync(dir,{recursive:true,force:true})
  }
})
