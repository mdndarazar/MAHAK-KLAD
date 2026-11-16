import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initRemoteGrantRegistry,requestCode,createGrant,consumeOneShot,isGrantActiveForWindow,getRequestStatus,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

test('failed host session cleanup keeps grant inactive and retryable while other grants and requests are revoked',()=>{
 let fail=true;const cleaned=[]
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelSessions:()=>{},clearPanelScope:(panel,owner)=>{if(owner===1 && fail)throw new Error('cleanup');cleaned.push([panel,owner])}})
 try {
  for (const owner of [1,2]) {
   const p=requestCode('sales',owner)
   assert.ok(createGrant({panel:'sales',ownerWindowId:owner,tier:'NORMAL',mode:'PANEL',memberId:'test',requestId:p.requestId,ttlMs:60000}))
   assert.equal(consumeOneShot(owner,'sales',p.gt.slice(3)),true)
  }
  const pending=requestCode('sales',3)
  assert.throws(()=>revokeAll(),/cleanup failed/)
  assert.equal(isGrantActiveForWindow('sales',1),false);assert.equal(isGrantActiveForWindow('sales',2),false)
  assert.equal(getRequestStatus(3,'sales',pending.requestId),'UNAVAILABLE');assert.deepEqual(cleaned,[['sales',2]])
  fail=false;revokeAll();assert.deepEqual(cleaned,[['sales',2],['sales',1]])
 } finally {fail=false;revokeAll()}
})
