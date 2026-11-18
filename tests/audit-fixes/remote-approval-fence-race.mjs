import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { createExperimentalRemoteCommandIssuer } from '../../src/main/services/cloud/experimentalRemoteCommandIssuer.ts'
import { createExperimentalApprovalBridge } from '../../src/main/services/cloud/experimentalApprovalBridge.ts'
import { approvalEnvelopeMac } from '../../src/main/services/cloud/experimentalApprovalEnvelope.ts'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { initRemoteGrantRegistry,acquireRemoteAdmissionLease,requestCode,listPendingRequests,consumeOneShot,isGrantActiveForWindow,revokeBy,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// Deliberate async hop tests both orderings using the actual issuer and bridge;
// the separate loopback test covers HTTP/child. Temporary in-memory DB only.
test('a delayed approval cannot reopen a grant after member revocation',async()=>{
 const db=new DatabaseSync(':memory:'),replayDb=new DatabaseSync(':memory:'),epoch='12345678-1234-4123-8123-123456789abc',storeId='store_test',key=Buffer.alloc(32,3)
 const identity=createHubIdentity(db,{panels:['shifts'],approvalPanels:['shifts']});identity.bootstrap('owner','owner-test-password','746392')
 const owner=identity.login('owner','owner-test-password').token
 const policies={shifts:{tier:'NORMAL',mode:'PANEL',ttlMs:60000}}
 initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}})
 const lease=acquireRemoteAdmissionLease();lease.open()
 let cursor=0,id=0,held=null,result=[]
 const bridge=createExperimentalApprovalBridge({key,storeId,epoch,policies,replayStore:createDurableGrantReplay(replayDb,storeId),appliedRevocation:()=>cursor,isClosed:()=>false,send:m=>result.push(m),onReplayFailure:()=>assert.fail('unexpected replay failure')})
 identity.networkRevocationCursor(epoch)
 const member=(name,pin)=>{const invite=identity.createInvite(owner,'746392','MANAGER',[{panel:'shifts',view:true,approve:true}]).invite;identity.acceptInvite(invite,name,`${name}-test-password`,pin);identity.approveMember(owner,'746392',name);return identity.login(name,`${name}-test-password`).token}
 const drain=()=>{for(const event of identity.pendingRevocations()){if(event.kind==='ALL')revokeAll();else revokeBy(event.memberId);assert.equal(identity.acknowledgeNetworkRevocation(epoch,cursor,event.id),true);cursor=event.id}}
 const issuer=createExperimentalRemoteCommandIssuer({key,storeId,policies,identity,pending:listPendingRequests,send:command=>new Promise(resolve=>{
  const fence=identity.networkRevocationCursor(epoch),current=++id
  const deliver=()=>{result=[];bridge.onMessage({type:'approvalCommand',id:current,fence,command,mac:approvalEnvelopeMac(key,storeId,epoch,current,fence,command.signature)});resolve(result.at(-1)?.ok===true)}
  if(held)held.push(deliver);else deliver()
 })})
 try {
  const alice=member('alice','482931'), p=requestCode('shifts',42);held=[]
  const approval=issuer.approve(alice,p.requestId,p.code,'482931');assert.equal(held.length,1)
  assert.equal(identity.removeMember(owner,'746392','alice').ok,true);drain();held.shift()();held=null
  assert.equal(await approval,false);assert.equal(consumeOneShot(42,'shifts',p.gt.slice(3)),false)
  const bob=member('bob','482932'), q=requestCode('shifts',43);held=[]
  const approval2=issuer.approve(bob,q.requestId,q.code,'482932');assert.equal(held.length,1);held.shift()();held=null
  assert.equal(await approval2,true);assert.equal(consumeOneShot(43,'shifts',q.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('shifts',43),true)
  assert.equal(identity.removeMember(owner,'746392','bob').ok,true);drain();assert.equal(isGrantActiveForWindow('shifts',43),false)
 } finally {revokeAll();lease.release();db.close();replayDb.close()}
})
