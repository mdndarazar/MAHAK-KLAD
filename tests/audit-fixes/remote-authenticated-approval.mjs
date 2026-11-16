import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { createAuthenticatedApproval } from '../../src/main/services/cloud/authenticatedApproval.ts'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { drainInProcessRevocations } from '../../src/main/services/cloud/inProcessRevocationBridge.ts'
import { initRemoteGrantRegistry, requestCode, consumeOneShot, isGrantActiveForWindow, revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

const KEY=Buffer.alloc(32,0x27), NOW=1800000000000, PASSWORD='owner-secret-password', PIN='483920', MEMBERPASS='member-secret-password', MEMBERPIN='749201'
let opened=[]
initRemoteGrantRegistry({notePanelUnlocked:(panel,scope,owner)=>opened.push({panel,scope,owner}),clearPanelScope:()=>{},clearPanelSessions:()=>assert.fail('must not clear other sessions')})
function setup(){
 revokeAll();opened=[]
 const dir=mkdtempSync(join(tmpdir(),'mahak-approval-e2e-')),db=new DatabaseSync(join(dir,'hub.db'))
 const identity=createHubIdentity(db,{panels:['sales-return','custody'],approvalPanels:['sales-return'],now:()=>NOW})
 assert.equal(identity.bootstrap('owner',PASSWORD,PIN),true)
 const owner=identity.login('owner',PASSWORD).token
 const invite=identity.createInvite(owner,PIN,'MANAGER',[{panel:'sales-return',view:true,approve:true}]).invite
 assert.equal(identity.acceptInvite(invite,'manager',MEMBERPASS,MEMBERPIN),true)
 assert.equal(identity.approveMember(owner,PIN,'manager'),true)
 const manager=identity.login('manager',MEMBERPASS).token,managerId=identity.authorize(manager,'sales-return','VIEW').id
 const service=createAuthenticatedApproval({key:KEY,storeId:'store_1',identity,replayStore:createDurableGrantReplay(db,'store_1'),now:()=>NOW,policies:{'sales-return':{tier:'NORMAL',mode:'PANEL',ttlMs:600000}}})
 return {db,identity,owner,manager,managerId,service,close(){revokeAll();db.close()}}
}
function command(p,memberId,changes={}){
 const c={version:1,storeId:'store_1',requestId:p.requestId,nonce:randomBytes(24).toString('base64url'),panel:'sales-return',ownerWindowId:13,memberId,tier:'NORMAL',issuedAt:NOW,expiresAt:NOW+30000,...changes}
 const bytes=JSON.stringify([c.version,c.storeId,c.requestId,c.nonce,c.panel,c.ownerWindowId,c.memberId,c.tier,c.issuedAt,c.expiresAt])
 return {...c,signature:createHmac('sha256',KEY).update(bytes).digest('hex')}
}
const auth=(session,code,pin=MEMBERPIN)=>({sessionToken:session,pin,code})
await test('signed request + matching visual code + manager login + second PIN + ACL binds one window',()=>{
 const x=setup();try{
  const p=requestCode('sales-return',13),cmd=command(p,x.managerId)
  assert.deepEqual(x.service.approve(cmd,auth(x.manager,p.code)),{ok:true,requestId:p.requestId})
  assert.deepEqual(opened,[]);assert.equal(consumeOneShot(14,'sales-return',p.gt.slice(3)),false)
  assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),true);assert.equal(isGrantActiveForWindow('sales-return',13),true)
  assert.deepEqual(x.service.approve(cmd,auth(x.manager,p.code)),{ok:false})
 }finally{x.close()}
})
await test('wrong visible code, PIN, session and signed member cannot authorize a pending request',()=>{
 const x=setup();try{
  for(const [session,pin,wrongCode,member] of [[x.manager,MEMBERPIN,true,x.managerId],[x.manager,'000000',false,x.managerId],[randomBytes(32).toString('base64url'),MEMBERPIN,false,x.managerId],[x.owner,PIN,false,x.managerId]]){
   const p=requestCode('sales-return',13),code=wrongCode?(p.code==='111111'?'222222':'111111'):p.code
   assert.deepEqual(x.service.approve(command(p,member),auth(session,code,pin)),{ok:false})
   assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),false)
  }
  assert.deepEqual(opened,[])
 }finally{x.close()}
})
await test('pause, ACL removal, member deletion and replay leave desktop grant unclaimed',()=>{
 const x=setup();try{
  let p=requestCode('sales-return',13)
  assert.equal(x.identity.setPaused(x.owner,PIN,true),true)
  assert.deepEqual(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)),{ok:false})
  assert.equal(x.identity.setPaused(x.owner,PIN,false),true)
  assert.equal(x.identity.setAcl(x.owner,PIN,'manager',[{panel:'sales-return',view:true,approve:false}]),true)
  p=requestCode('sales-return',13);assert.deepEqual(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)),{ok:false})
  assert.equal(x.identity.removeMember(x.owner,PIN,'manager').ok,true)
  p=requestCode('sales-return',13);assert.deepEqual(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)),{ok:false})
  assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),false)
 }finally{x.close()}
})
await test('ACL change and panic queue revoke existing grants; approvals fail closed until drained',()=>{
 const x=setup();try{
  let p=requestCode('sales-return',13),cmd=command(p,x.managerId)
  assert.equal(x.service.approve(cmd,auth(x.manager,p.code)).ok,true)
  assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),true)
  assert.equal(x.identity.setAcl(x.owner,PIN,'manager',[{panel:'sales-return',view:true,approve:false}]),true)
  assert.equal(isGrantActiveForWindow('sales-return',13),true) // delivery has not happened yet
  assert.deepEqual(drainInProcessRevocations(x.identity),{applied:1,remaining:false})
  assert.equal(isGrantActiveForWindow('sales-return',13),false)
  assert.equal(x.identity.setAcl(x.owner,PIN,'manager',[{panel:'sales-return',view:true,approve:true}]),true)
  p=requestCode('sales-return',13);assert.equal(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)).ok,false)
  drainInProcessRevocations(x.identity)
  p=requestCode('sales-return',13);assert.equal(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)).ok,true)
  assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),true)
  assert.equal(x.identity.setPaused(x.owner,PIN,true),true);assert.equal(x.identity.setPaused(x.owner,PIN,false),true)
  assert.equal(isGrantActiveForWindow('sales-return',13),true)
  drainInProcessRevocations(x.identity);assert.equal(isGrantActiveForWindow('sales-return',13),false)
 }finally{x.close()}
})
await test('lost revocation acknowledgment is retried without losing the queued item',()=>{
 const x=setup();try{
  const p=requestCode('sales-return',13)
  assert.equal(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)).ok,true)
  assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),true)
  assert.equal(x.identity.setAcl(x.owner,PIN,'manager',[{panel:'sales-return',view:true,approve:false}]),true)
  assert.throws(()=>drainInProcessRevocations({pendingRevocations:x.identity.pendingRevocations,acknowledgeRevocation:()=>false}),/acknowledgement/)
  assert.equal(isGrantActiveForWindow('sales-return',13),false);assert.equal(x.identity.pendingRevocations().length,1)
  assert.deepEqual(drainInProcessRevocations(x.identity),{applied:1,remaining:false})
 }finally{x.close()}
})
await test('malformed revocation batches fail before any acknowledgement or grant change',()=>{
 const x=setup();try{
  const p=requestCode('sales-return',13)
  assert.equal(x.service.approve(command(p,x.managerId),auth(x.manager,p.code)).ok,true)
  assert.equal(consumeOneShot(13,'sales-return',p.gt.slice(3)),true)
  let acknowledgements=0
  for(const entries of [null,{},[{id:1,kind:'ALL',memberId:null},{id:1,kind:'ALL',memberId:null}],
    [{id:2,kind:'ALL',memberId:null},{id:1,kind:'ALL',memberId:null}],
    [{id:1,kind:'ALL',memberId:null},{id:2,kind:'MEMBER',memberId:'bad'}],
    Array.from({length:101},(_,i)=>({id:i+1,kind:'ALL',memberId:null}))]) {
   assert.throws(()=>drainInProcessRevocations({pendingRevocations:()=>entries,acknowledgeRevocation:()=>{acknowledgements++;return true}}),/Invalid revocation queue/)
   assert.equal(isGrantActiveForWindow('sales-return',13),true)
  }
  assert.equal(acknowledgements,0)
  let calls=0
  assert.throws(()=>drainInProcessRevocations({pendingRevocations:()=>++calls===1?[]:null,acknowledgeRevocation:()=>true}),/Invalid revocation queue/)
 }finally{x.close()}
})
await test('invalid signed payload and invalid auth shape do not consume live request',()=>{
 const x=setup();try{
  const p=requestCode('sales-return',13),cmd=command(p,x.managerId)
  assert.deepEqual(x.service.approve({...cmd,signature:'0'.repeat(64)},auth(x.manager,p.code)),{ok:false})
  assert.deepEqual(x.service.approve(cmd,auth(x.manager,'nope')),{ok:false})
  assert.deepEqual(x.service.approve(cmd,auth(x.manager,p.code)),{ok:true,requestId:p.requestId})
 }finally{x.close()}
})
