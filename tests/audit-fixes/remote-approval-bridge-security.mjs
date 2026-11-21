import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { createExperimentalApprovalBridge } from '../../src/main/services/cloud/experimentalApprovalBridge.ts'
import { approvalEnvelopeMac } from '../../src/main/services/cloud/experimentalApprovalEnvelope.ts'
import { acquireRemoteAdmissionLease,initRemoteGrantRegistry,requestCode,consumeOneShot,isGrantActiveForWindow,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

test('bridge rejects tampering, stale fence and replay; uncertain ledger blocks admissions',()=>{
 const key=Buffer.alloc(32,3),storeId='store_test',epoch='12345678-1234-4123-8123-123456789abc',db=new DatabaseSync(':memory:')
 const replay=createDurableGrantReplay(db,storeId),lease=acquireRemoteAdmissionLease();lease.open()
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 let output=[],cursor=5,id=0,fail=false,blocked=false
 const bridge=createExperimentalApprovalBridge({key,storeId,epoch,policies:{shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}},
  replayStore:{consume:(...args)=>{if(fail)throw new Error('write failed');return replay.consume(...args)}},appliedRevocation:()=>cursor,isClosed:()=>false,
  send:m=>output.push(m),onReplayFailure:()=>{blocked=true;lease.block();revokeAll()}})
 const signed=p=>{const c={version:1,storeId,requestId:p.requestId,nonce:randomBytes(24).toString('base64url'),panel:'shifts',ownerWindowId:42,memberId:'owner',tier:'NORMAL',issuedAt:Date.now(),expiresAt:Date.now()+3000};return {...c,signature:createHmac('sha256',key).update(JSON.stringify([c.version,c.storeId,c.requestId,c.nonce,c.panel,c.ownerWindowId,c.memberId,c.tier,c.issuedAt,c.expiresAt])).digest('hex')}}
 const send=(command,fence,mac)=>{const n=++id;output=[];bridge.onMessage({type:'approvalCommand',id:n,fence,command,mac:mac??approvalEnvelopeMac(key,storeId,epoch,n,fence,command.signature)});return output.at(-1)}
 try {
  const p=requestCode('shifts',42),c=signed(p)
  assert.equal(send(c,cursor,'0'.repeat(64)).ok,false);assert.equal(send(c,cursor-1).ok,false);assert.equal(send(c,cursor+1).ok,false)
  assert.equal(send(c,cursor).ok,true);assert.equal(send(c,cursor).ok,false,'signed command replay rejected')
  assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',42),true)
  const next=requestCode('shifts',42),d=signed(next);fail=true
  assert.equal(send(d,cursor).ok,false);assert.equal(blocked,true);assert.equal(isGrantActiveForWindow('shifts',42),false)
  assert.throws(()=>requestCode('shifts',43),/admission closed/)
 } finally {revokeAll();lease.release();db.close()}
})
