import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { createGrantApprovalCoordinator } from '../../src/main/services/cloud/grantApprovalCoordinator.ts'
import { createExperimentalRemoteCommandIssuer } from '../../src/main/services/cloud/experimentalRemoteCommandIssuer.ts'
import { initIsolatedRemoteGrantRegistry,requestCode,listPendingRequests,consumeOneShot,isGrantActiveForWindow,revokeAll } from '../../src/main/services/RemoteGrantRegistry.ts'

// One-process simulation with two isolated SQLite files. No IPC, actual Electron,
// production network or device. Desktop membership trust is delegated to the
// signed hub attestation here; revocation/audit transport is not implemented.
const dir=mkdtempSync(join(tmpdir(),'mahak-command-issuer-')),hub=new DatabaseSync(join(dir,'hub.sqlite')),ledger=new DatabaseSync(join(dir,'desktop-ledger.sqlite'))
const identity=createHubIdentity(hub,{panels:['custody','sales-return','credit-void'],approvalPanels:['sales-return','credit-void']})
assert.equal(identity.bootstrap('owner','owner-test-password','746392'),true)
const owner=identity.login('owner','owner-test-password').token
const invite=identity.createInvite(owner,'746392','VIEWER',[{panel:'sales-return',view:true,approve:false}]).invite
assert.equal(identity.acceptInvite(invite,'viewer','viewer-test-password','482931'),true)
assert.equal(identity.approveMember(owner,'746392','viewer'),true)
const viewer=identity.login('viewer','viewer-test-password').token
initIsolatedRemoteGrantRegistry()
const policies={'sales-return':{tier:'NORMAL',mode:'PANEL',ttlMs:600000},'credit-void':{tier:'SENSITIVE_MONEY',mode:'ONE_SHOT',ttlMs:300000}}
const key=Buffer.alloc(32,37),replay=createDurableGrantReplay(ledger,'store_1')
const coordinator=createGrantApprovalCoordinator({key,storeId:'store_1',policies,replayStore:replay,isPaused:()=>identity.isPaused() || identity.pendingRevocations(1).length>0,mayApprove:()=>true})
let sent=[],release=null
const issuer=createExperimentalRemoteCommandIssuer({key,storeId:'store_1',policies,identity,pending:listPendingRequests,
  send:async command=>{sent.push(command);if(release)await release;return coordinator.approve(command).ok}})
try {
 await test('request listing applies role/ACL and never exposes local credentials or window identity',()=>{
  const p=requestCode('sales-return',81)
  assert.deepEqual(issuer.list(owner),[{requestId:p.requestId,panel:'sales-return',code:p.code}])
  assert.deepEqual(issuer.list(viewer),[])
  assert.ok(!JSON.stringify(issuer.list(owner)).includes(p.gt));assert.ok(!JSON.stringify(issuer.list(owner)).includes('ownerWindowId'))
 })
 await test('wrong code, PIN and VIEWER cannot issue a command',async()=>{
  const p=listPendingRequests().find(x=>x.panel==='sales-return')
  assert.equal(await issuer.approve(owner,p.requestId,p.code === '000000' ? '000001' : '000000','746392'),false)
  assert.equal(await issuer.approve(owner,p.requestId,p.code,'000000'),false)
  assert.equal(await issuer.approve(viewer,p.requestId,p.code,'482931'),false)
  assert.equal(sent.length,0);assert.equal(isGrantActiveForWindow('sales-return',81),false)
 })
 await test('one signed, replay-protected approval is tied to the live window/request',async()=>{
  const p=listPendingRequests().find(x=>x.panel==='sales-return')
  let unblock;release=new Promise(r=>{unblock=r})
  const first=issuer.approve(owner,p.requestId,p.code,'746392')
  assert.equal(await issuer.approve(owner,p.requestId,p.code,'746392'),false)
  unblock();assert.equal(await first,true);release=null
  assert.equal(sent.length,1);assert.equal(sent[0].ownerWindowId,81);assert.equal(sent[0].expiresAt-sent[0].issuedAt,3000)
  assert.equal(coordinator.approve(sent[0]).ok,false)
  assert.equal(isGrantActiveForWindow('sales-return',81),false) // no credential was claimed
 })
 await test('sensitive approval consumes only the original one-shot credential',async()=>{
  const p=requestCode('credit-void',82)
  assert.equal(await issuer.approve(owner,p.requestId,p.code,'746392'),true)
  assert.equal(consumeOneShot(82,'credit-void',p.gt.slice(3)),true)
  assert.equal(consumeOneShot(82,'credit-void',p.gt.slice(3)),false)
  assert.equal(isGrantActiveForWindow('credit-void',82),false)
 })
 await test('pending revocations/pause stop issuing new commands',async()=>{
  const p=requestCode('sales-return',83)
  assert.equal(identity.setPaused(owner,'746392',true),true)
  assert.deepEqual(issuer.list(owner),[])
  assert.equal(await issuer.approve(owner,p.requestId,p.code,'746392'),false)
  assert.equal(sent.length,2)
 })
 await test('issuer rejects custody policy, malformed snapshots, and replaced requests',async()=>{
  assert.throws(()=>createExperimentalRemoteCommandIssuer({key,storeId:'store_1',policies:{custody:{tier:'NORMAL',mode:'PANEL',ttlMs:1000}},identity,pending:()=>[],send:async()=>true}),/policy/)
  const request={requestId:'a'.repeat(32),panel:'sales-return',code:'123456',ownerWindowId:1},token='a'.repeat(43)
  let current=[request],sends=0
  const replacement=createExperimentalRemoteCommandIssuer({key,storeId:'store_1',policies,
    identity:{canApprove:()=>({id:'member_1',role:'MANAGER'}),authorize:()=>{current=[];return{id:'member_1',role:'MANAGER'}}},
    pending:()=>current,send:async()=>{sends++;return true}})
  assert.equal(await replacement.approve(token,request.requestId,request.code,'123456'),false);assert.equal(sends,0)
  current=[request,request];assert.deepEqual(replacement.list(token),[])
  current=[{...request,requestId:'b'.repeat(32),panel:'custody'},request]
  assert.deepEqual(replacement.list(token),[{requestId:request.requestId,panel:request.panel,code:request.code}])
  assert.equal(await replacement.approve(token,'b'.repeat(32),request.code,'123456'),false)
  assert.equal(sends,0)
 })
} finally {revokeAll();hub.close();ledger.close()}
