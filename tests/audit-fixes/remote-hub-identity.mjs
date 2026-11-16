import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'

const PASS='owner-long-password',PIN='293847',MEMBERPASS='member-long-password',MEMBERPIN='417263'
const normal=[{panel:'sales-return',view:true,approve:true}], viewOnly=[{panel:'sales-return',view:true,approve:false}]
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'mahak-identity-')),path=join(dir,'hub-test.db');let clock=1800000000000,db,hub
 const open=()=>{db=new DatabaseSync(path);db.exec('PRAGMA synchronous=FULL');hub=createHubIdentity(db,{panels:['sales-return','credit-void','custody'],approvalPanels:['sales-return','credit-void'],now:()=>clock})}
 open();assert.equal(hub.bootstrap('Owner',PASS,PIN),true)
 return {get db(){return db},get hub(){return hub},setTime:n=>{clock=n},time:()=>clock,reopen:()=>{db.close();open()},close:()=>db.close()}
}
const login=(hub,name='owner',password=PASS)=>{const result=hub.login(name,password);assert.equal(result.ok,true);return result.token}
function inviteAndActivate(hub,owner,name,role='MANAGER',acl=normal){
 const invite=hub.createInvite(owner,PIN,role,acl);assert.equal(invite.ok,true)
 assert.equal(hub.acceptInvite(invite.invite,name,MEMBERPASS,MEMBERPIN),true)
 assert.deepEqual(hub.login(name,MEMBERPASS),{ok:false});assert.equal(hub.approveMember(owner,PIN,name),true)
 return login(hub,name,MEMBERPASS)
}
await test('bootstrap occurs once, sessions have hashed tokens and audit contains no credentials',()=>{
 const x=setup();try{
  const h=x.hub;assert.equal(h.bootstrap('another',PASS,PIN),false)
  assert.deepEqual(h.login('owner','wrong-password'),{ok:false});const token=login(h)
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(x.db.prepare('SELECT token_hash FROM remote_sessions').get().token_hash.includes(token),false)
  assert.equal(h.authorize(token,'sales-return','VIEW').role,'OWNER')
  assert.equal(h.authorize(token,'custody','VIEW').role,'OWNER')
  assert.equal(h.authorize(token,'custody','APPROVE',PIN),null)
  assert.equal(h.createInvite(token,PIN,'MANAGER',[{panel:'custody',view:true,approve:true}]).ok,false)
  assert.equal(h.authorize(token,'unknown','VIEW'),null)
  const rows=x.db.prepare('SELECT * FROM remote_identity_audit').all();assert.ok(rows.length>=3)
  assert.ok(!JSON.stringify(rows).includes(PASS));assert.ok(!JSON.stringify(rows).includes(PIN));assert.ok(!JSON.stringify(rows).includes(token))
  assert.equal(h.logout(token),true);assert.equal(h.authorize(token,'sales-return','VIEW'),null)
 }finally{x.close()}
})
await test('invitation is single-use, needs owner approval, and manager ACL is enforced',()=>{
 const x=setup();try{
  const h=x.hub,owner=login(h),inv=h.createInvite(owner,PIN,'MANAGER',normal)
  assert.equal(inv.ok,true);assert.equal(h.acceptInvite(inv.invite,'Manager',MEMBERPASS,MEMBERPIN),true)
  assert.equal(h.acceptInvite(inv.invite,'other',MEMBERPASS,MEMBERPIN),false)
  assert.deepEqual(h.login('manager',MEMBERPASS),{ok:false})
  assert.equal(h.approveMember(owner,'000000','manager'),false);assert.equal(h.approveMember(owner,PIN,'manager'),true)
  const m=login(h,'manager',MEMBERPASS)
  assert.equal(h.authorize(m,'sales-return','VIEW').role,'MANAGER')
  assert.equal(h.authorize(m,'sales-return','APPROVE','000000'),null)
  assert.equal(h.authorize(m,'sales-return','APPROVE',MEMBERPIN).role,'MANAGER')
  assert.equal(h.authorize(m,'credit-void','VIEW'),null);assert.equal(h.createInvite(m,MEMBERPIN,'MANAGER',normal).ok,false)
  assert.equal(h.setAcl(owner,PIN,'manager',[{panel:'credit-void',view:true,approve:false}]),true)
  assert.equal(h.authorize(m,'sales-return','VIEW'),null);assert.equal(h.authorize(m,'credit-void','VIEW').role,'MANAGER')
  assert.equal(h.authorize(m,'credit-void','APPROVE',MEMBERPIN),null)
 }finally{x.close()}
})
await test('viewer cannot receive approve ACL or approve, and owner cannot be removed',()=>{
 const x=setup();try{
  const h=x.hub,owner=login(h)
  assert.deepEqual(h.createInvite(owner,PIN,'VIEWER',normal),{ok:false})
  const viewer=inviteAndActivate(h,owner,'viewer','VIEWER',viewOnly)
  assert.equal(h.authorize(viewer,'sales-return','VIEW').role,'VIEWER');assert.equal(h.authorize(viewer,'sales-return','APPROVE',MEMBERPIN),null)
  assert.equal(h.setAcl(owner,PIN,'viewer',normal),false);assert.deepEqual(h.removeMember(owner,PIN,'owner'),{ok:false})
 }finally{x.close()}
})
await test('removal immediately invalidates sessions; caller receives ID to revoke external grants',()=>{
 const x=setup();try{
  const h=x.hub,owner=login(h),m=inviteAndActivate(h,owner,'manager')
  const id=h.authorize(m,'sales-return','VIEW').id,result=h.removeMember(owner,PIN,'manager')
  assert.deepEqual(result,{ok:true,memberId:id});assert.equal(h.authorize(m,'sales-return','VIEW'),null)
  assert.deepEqual(h.login('manager',MEMBERPASS),{ok:false})
 }finally{x.close()}
})
await test('five seats include pending invitations; expiration frees unused seats',()=>{
 const x=setup();try{
  const h=x.hub,owner=login(h),tokens=[]
  for(let i=0;i<4;i++){const r=h.createInvite(owner,PIN,'VIEWER',viewOnly);assert.equal(r.ok,true);tokens.push(r.invite)}
  assert.deepEqual(h.createInvite(owner,PIN,'VIEWER',viewOnly),{ok:false})
  assert.equal(h.acceptInvite(tokens[0],'person-one',MEMBERPASS,MEMBERPIN),true)
  assert.deepEqual(h.createInvite(owner,PIN,'VIEWER',viewOnly),{ok:false})
  x.setTime(x.time()+2*24*60*60_000+1);const nextOwner=login(h)
  assert.equal(h.acceptInvite(tokens[1],'person-two',MEMBERPASS,MEMBERPIN),false)
  assert.equal(h.createInvite(nextOwner,PIN,'VIEWER',viewOnly).ok,true)
 }finally{x.close()}
})
await test('wrong login or PIN locks persist across database restart',()=>{
 const x=setup();try{
  let h=x.hub
  for(let i=0;i<5;i++)assert.deepEqual(h.login('owner','incorrect-long-password'),{ok:false})
  x.reopen();h=x.hub;assert.deepEqual(h.login('owner',PASS),{ok:false})
  x.setTime(x.time()+15*60_000);const owner=login(h)
  for(let i=0;i<5;i++)assert.equal(h.authorize(owner,'sales-return','APPROVE','000000'),null)
  x.reopen();h=x.hub;assert.equal(h.authorize(owner,'sales-return','APPROVE',PIN),null)
  x.setTime(x.time()+15*60_000);const newOwner=login(h)
  assert.equal(h.authorize(newOwner,'sales-return','APPROVE',PIN).role,'OWNER')
 }finally{x.close()}
})
await test('owner pause blocks approval but not view; viewer or bad PIN cannot resume',()=>{
 const x=setup();try{
  const h=x.hub,owner=login(h),m=inviteAndActivate(h,owner,'manager')
  assert.equal(h.setPaused(m,MEMBERPIN,true),false);assert.equal(h.setPaused(owner,PIN,true),true);assert.equal(h.isPaused(),true)
  assert.equal(h.authorize(m,'sales-return','VIEW').role,'MANAGER');assert.equal(h.authorize(m,'sales-return','APPROVE',MEMBERPIN),null)
  assert.equal(h.setPaused(owner,'000000',false),false);assert.equal(h.setPaused(owner,PIN,false),true)
  assert.equal(h.authorize(m,'sales-return','APPROVE',MEMBERPIN).role,'MANAGER')
 }finally{x.close()}
})
await test('sessions expire by idle time and clock rollback fails closed across restart',()=>{
 const x=setup();try{
  let h=x.hub;const token=login(h);x.setTime(x.time()+10*60_000)
  assert.equal(h.authorize(token,'sales-return','VIEW'),null)
  const t=x.time();x.reopen();h=x.hub;x.setTime(t-1)
  assert.throws(()=>h.login('owner',PASS),/clock/);x.setTime(t);assert.equal(h.login('owner',PASS).ok,true)
 }finally{x.close()}
})
await test('revocation outbox persists across restart and must be acknowledged in order',()=>{
 const x=setup();try{
  let h=x.hub,owner=login(h);inviteAndActivate(h,owner,'manager')
  assert.equal(h.setAcl(owner,PIN,'manager',viewOnly),true);assert.equal(h.setPaused(owner,PIN,true),true)
  const items=h.pendingRevocations();assert.equal(items.length,2);assert.equal(items[0].kind,'MEMBER');assert.equal(items[1].kind,'ALL')
  assert.equal(h.acknowledgeRevocation(items[1].id),false)
  x.reopen();h=x.hub;assert.deepEqual(h.pendingRevocations(),items)
  assert.equal(h.acknowledgeRevocation(items[0].id),true);assert.equal(h.acknowledgeRevocation(items[1].id),true)
  assert.deepEqual(h.pendingRevocations(),[])
 }finally{x.close()}
})
await test('seat reservations and audit are transactional when database write fails',()=>{
 const x=setup();try{
  const h=x.hub,owner=login(h)
  x.db.exec("CREATE TRIGGER reject_invite_audit BEFORE INSERT ON remote_identity_audit WHEN NEW.kind='INVITE_CREATED' BEGIN SELECT RAISE(ABORT,'simulated failure'); END;")
  assert.throws(()=>h.createInvite(owner,PIN,'MANAGER',normal))
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM remote_invites').get().n,0)
  x.db.exec('DROP TRIGGER reject_invite_audit');assert.equal(h.createInvite(owner,PIN,'MANAGER',normal).ok,true)
 }finally{x.close()}
})
