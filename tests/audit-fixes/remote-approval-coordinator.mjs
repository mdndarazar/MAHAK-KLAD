import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { createGrantApprovalCoordinator } from '../../src/main/services/cloud/grantApprovalCoordinator.ts'
import { initRemoteGrantRegistry, requestCode, getPending, consumeOneShot, isGrantActiveForWindow, revokeBy, revokeAll, cancelForWindow } from '../../src/main/services/RemoteGrantRegistry.ts'

// All participants are in process; there is no real mobile app, IPC or network here.
const KEY=Buffer.alloc(32,0x6c),NOW=1_800_000_000_000
let opened=[],cleared=[]
initRemoteGrantRegistry({notePanelUnlocked:(panel,scope,owner)=>opened.push({panel,scope,owner}),clearPanelScope:(panel,owner)=>cleared.push({panel,owner}),clearPanelSessions:()=>assert.fail('must not clear all sessions')})
function setup(opts={}){
  let paused=false,allowed=true
  const policies={'sales-return':{tier:'NORMAL',mode:'PANEL',ttlMs:600000},'credit-void':{tier:'SENSITIVE_MONEY',mode:'ONE_SHOT',ttlMs:300000}}
  const options={key:KEY,storeId:'store_1',policies,now:()=>NOW,isPaused:()=>paused,mayApprove:(member,panel)=>allowed&&member==='manager_1'&&Object.hasOwn(policies,panel),...opts}
  const coordinator=createGrantApprovalCoordinator(options)
  return {coordinator,policies,setPaused:v=>{paused=v},setAllowed:v=>{allowed=v}}
}
function sign(patch={}){
  const c={version:1,storeId:'store_1',requestId:'missing',nonce:randomBytes(24).toString('base64url'),panel:'sales-return',ownerWindowId:10,memberId:'manager_1',tier:'NORMAL',issuedAt:NOW,expiresAt:NOW+30000,...patch}
  const bytes=JSON.stringify([c.version,c.storeId,c.requestId,c.nonce,c.panel,c.ownerWindowId,c.memberId,c.tier,c.issuedAt,c.expiresAt])
  return {...c,signature:createHmac('sha256',KEY).update(bytes).digest('hex')}
}
const token=p=>p.gt.slice(3)
function reset(){revokeAll();opened=[];cleared=[]}
await test('valid signed approval binds live request; only correct window credential claims panel',()=>{
  reset();const {coordinator}=setup(),p=requestCode('sales-return',10),cmd=sign({requestId:p.requestId})
  assert.deepEqual(coordinator.approve(cmd),{ok:true,requestId:p.requestId})
  assert.equal(getPending(10,'sales-return'),null);assert.deepEqual(opened,[])
  assert.deepEqual(coordinator.approve(cmd),{ok:false});assert.equal(consumeOneShot(11,'sales-return',token(p)),false)
  assert.equal(consumeOneShot(10,'sales-return',token(p)),true);assert.equal(isGrantActiveForWindow('sales-return',10),true)
  revokeBy('manager_1');assert.equal(isGrantActiveForWindow('sales-return',10),false)
})
await test('fresh verifier cannot replay an already consumed in-memory pending request',()=>{
  reset();const first=setup(),p=requestCode('sales-return',10),cmd=sign({requestId:p.requestId})
  assert.deepEqual(first.coordinator.approve(cmd),{ok:true,requestId:p.requestId})
  const freshVerifier=setup();assert.deepEqual(freshVerifier.coordinator.approve(cmd),{ok:false})
  assert.equal(consumeOneShot(10,'sales-return',token(p)),true)
})
await test('modified, expired, wrong store or signer cannot consume request',()=>{
  reset();const {coordinator}=setup(),p=requestCode('sales-return',10),valid=sign({requestId:p.requestId})
  for(const bad of [{...valid,signature:'0'.repeat(64)},{...valid,ownerWindowId:11},sign({requestId:p.requestId,storeId:'other'}),sign({requestId:p.requestId,issuedAt:NOW-60001,expiresAt:NOW+1})])assert.deepEqual(coordinator.approve(bad),{ok:false})
  assert.ok(getPending(10,'sales-return'));assert.deepEqual(coordinator.approve(valid),{ok:true,requestId:p.requestId})
})
await test('unknown, canceled, replaced, mismatched owner or panel requests are rejected',()=>{
  reset();const {coordinator}=setup(),old=requestCode('sales-return',10),p=requestCode('sales-return',10)
  assert.deepEqual(coordinator.approve(sign({requestId:old.requestId})),{ok:false})
  assert.deepEqual(coordinator.approve(sign({requestId:p.requestId,ownerWindowId:11})),{ok:false})
  assert.deepEqual(coordinator.approve(sign({requestId:p.requestId,panel:'credit-void',tier:'SENSITIVE_MONEY'})),{ok:false})
  cancelForWindow(10,'sales-return');assert.deepEqual(coordinator.approve(sign({requestId:p.requestId})),{ok:false})
  assert.equal(consumeOneShot(10,'sales-return',token(p)),false)
})
await test('pause and current ACL deny; malformed or throwing providers fail closed',()=>{
  reset();const s=setup(),p=requestCode('sales-return',10)
  s.setPaused(true);assert.deepEqual(s.coordinator.approve(sign({requestId:p.requestId})),{ok:false})
  s.setPaused(false);s.setAllowed(false);assert.deepEqual(s.coordinator.approve(sign({requestId:p.requestId})),{ok:false})
  assert.deepEqual(setup({isPaused:()=>{throw Error('unknown')}}).coordinator.approve(sign({requestId:p.requestId})),{ok:false})
  assert.deepEqual(setup({mayApprove:()=>Promise.resolve(true)}).coordinator.approve(sign({requestId:p.requestId})),{ok:false})
  assert.equal(consumeOneShot(10,'sales-return',token(p)),false)
})
await test('local sensitive tier cannot be weakened and is one-shot',()=>{
  reset();const {coordinator}=setup(),p=requestCode('credit-void',10)
  assert.deepEqual(coordinator.approve(sign({panel:'credit-void',requestId:p.requestId,tier:'NORMAL'})),{ok:false})
  // An authenticated denied command consumes its replay slot; request anew.
  assert.deepEqual(coordinator.approve(sign({panel:'credit-void',requestId:p.requestId,tier:'SENSITIVE_MONEY'})),{ok:false})
  const fresh=requestCode('credit-void',10)
  assert.deepEqual(coordinator.approve(sign({panel:'credit-void',requestId:fresh.requestId,tier:'SENSITIVE_MONEY'})),{ok:true,requestId:fresh.requestId})
  assert.equal(consumeOneShot(10,'credit-void',token(fresh)),true);assert.equal(consumeOneShot(10,'credit-void',token(fresh)),false)
  assert.deepEqual(opened,[])
})
await test('policy is copied; no unknown panels, excessive TTL or reusable sensitive grant',()=>{
  reset();const s=setup();s.policies['sales-return'].tier='SENSITIVE_MONEY';s.policies['sales-return'].ttlMs=1
  const p=requestCode('sales-return',10);assert.deepEqual(s.coordinator.approve(sign({requestId:p.requestId})),{ok:true,requestId:p.requestId})
  assert.throws(()=>setup({policies:{x:{tier:'SENSITIVE_MONEY',mode:'PANEL',ttlMs:1000}}}))
  assert.throws(()=>setup({policies:{x:{tier:'NORMAL',mode:'PANEL',ttlMs:3600001}}}))
  assert.throws(()=>setup({policies:{'bad/panel':{tier:'NORMAL',mode:'PANEL',ttlMs:1000}}}))
  const unknown=requestCode('other',10);assert.deepEqual(s.coordinator.approve(sign({panel:'other',requestId:unknown.requestId})),{ok:false})
})
await test('object getters and proxies cannot change signed fields during verification',()=>{
  reset();const {coordinator}=setup(),p=requestCode('sales-return',10),cmd=sign({requestId:p.requestId})
  let accessed=0;Object.defineProperty(cmd,'memberId',{enumerable:true,get(){accessed++;return 'manager_1'}})
  assert.deepEqual(coordinator.approve(cmd),{ok:false});assert.equal(accessed,0)
  assert.deepEqual(coordinator.approve(new Proxy({}, {ownKeys(){throw Error('attack')}})),{ok:false})
  assert.ok(getPending(10,'sales-return'))
})
revokeAll()
