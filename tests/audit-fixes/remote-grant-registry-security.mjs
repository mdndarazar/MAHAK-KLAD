import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  initRemoteGrantRegistry, requestCode, getPending, createGrant, consumeOneShot,
  isGrantActiveForWindow, remoteGrantActive, isActiveForCurrentWindow, markUsed, revokeBy, revokeAll, cancelForWindow
} from '../../src/main/services/RemoteGrantRegistry.ts'

let opened=[],cleared=[]
initRemoteGrantRegistry({notePanelUnlocked:(panel,scope,owner)=>opened.push({panel,scope,owner}),clearPanelScope:(panel,owner)=>cleared.push({panel,owner}),clearPanelSessions:()=>assert.fail('must not clear unrelated sessions')})
const approve=(p,overrides={})=>createGrant({panel:'sales-return',ownerWindowId:10,tier:'NORMAL',mode:'PANEL',memberId:'member_1',requestId:p.requestId,ttlMs:1000,...overrides})
const token=p=>p.gt.slice(3)
function reset(){revokeAll();opened=[];cleared=[]}
await test('request has a cryptographically random credential separate from visible code',()=>{
  reset();const a=requestCode('sales-return',10), b=requestCode('sales-return',11)
  assert.match(a.code,/^[0-9]{6}$/);assert.match(a.gt,/^gt-[A-Za-z0-9_-]{43}$/);assert.notEqual(a.gt,b.gt)
  assert.notEqual(a.requestId,b.requestId);assert.equal(getPending(10,'sales-return').requestId,a.requestId)
  assert.equal(JSON.stringify(getPending(10,'sales-return')).includes(a.gt),false)
})
await test('approval is bound to live pending request, panel and window; does not open a panel',()=>{
  reset();const p=requestCode('sales-return',10)
  assert.equal(approve(p,{requestId:'invented'}),null);assert.equal(approve(p,{ownerWindowId:11}),null)
  assert.equal(approve(p,{panel:'settings'}),null);assert.equal(approve(p,{ttlMs:3600001}),null)
  assert.ok(approve(p));assert.equal(getPending(10,'sales-return'),null);assert.equal(approve(p),null)
  assert.deepEqual(opened,[]);assert.equal(isGrantActiveForWindow('sales-return',10),false)
})
await test('credential is checked and scope is isolated to the matching owner and panel',()=>{
  reset();const p=requestCode('sales-return',10);approve(p)
  assert.equal(consumeOneShot(null,'sales-return',token(p)),false)
  assert.equal(consumeOneShot(11,'sales-return',token(p)),false)
  assert.equal(consumeOneShot(10,'settings',token(p)),false)
  assert.equal(consumeOneShot(10,'sales-return',p.code),false)
  assert.equal(consumeOneShot(10,'sales-return','x'.repeat(43)),false)
  assert.equal(consumeOneShot(10,'sales-return',token(p)),true)
  assert.deepEqual(opened,[{panel:'sales-return',scope:'PANEL',owner:10}])
  assert.equal(isGrantActiveForWindow('sales-return',10),true)
  assert.equal(isGrantActiveForWindow('sales-return',11),false)
  assert.equal(remoteGrantActive('sales-return'),false);assert.equal(isActiveForCurrentWindow('sales-return'),false)
  assert.equal(consumeOneShot(10,'sales-return',token(p)),true);assert.equal(opened.length,1)
})
await test('five failed credentials lock even a correct credential, and revoke clears pending',()=>{
  reset();const p=requestCode('sales-return',10);approve(p)
  for(let i=0;i<5;i++)assert.equal(consumeOneShot(10,'sales-return','bad'),false)
  assert.equal(consumeOneShot(10,'sales-return',token(p)),false);assert.deepEqual(opened,[])
  requestCode('settings',10);revokeAll();assert.equal(getPending(10,'settings'),null)
})
await test('sensitive grant is one-shot with local five minute cap, never opens a reusable session',()=>{
  reset();const p=requestCode('sales-return',10)
  assert.equal(approve(p,{tier:'SENSITIVE_MONEY',ttlMs:3600001}),null)
  assert.ok(approve(p,{tier:'SENSITIVE_MONEY',ttlMs:300000}))
  assert.equal(consumeOneShot(10,'sales-return',token(p)),true)
  assert.equal(consumeOneShot(10,'sales-return',token(p)),false)
  assert.equal(isGrantActiveForWindow('sales-return',10),false);assert.deepEqual(opened,[])
})
await test('replacing pending request invalidates old approval and revoked member cannot reuse a grant',()=>{
  reset();const old=requestCode('sales-return',10),fresh=requestCode('sales-return',10)
  assert.equal(approve(old),null);assert.ok(approve(fresh));assert.equal(consumeOneShot(10,'sales-return',token(old)),false)
  assert.equal(consumeOneShot(10,'sales-return',token(fresh)),true);revokeBy('other');assert.equal(isGrantActiveForWindow('sales-return',10),true)
  revokeBy('member_1');assert.equal(isGrantActiveForWindow('sales-return',10),false)
  assert.deepEqual(cleared,[{panel:'sales-return',owner:10}]);assert.equal(consumeOneShot(10,'sales-return',token(fresh)),false)
})
await test('cancel is isolated to its window and panel and cannot clear guessing lockout',()=>{
  reset();const first=requestCode('sales-return',10),other=requestCode('sales-return',11)
  approve(first);approve(other,{ownerWindowId:11});assert.equal(consumeOneShot(11,'sales-return',token(other)),true)
  for(let i=0;i<5;i++)assert.equal(consumeOneShot(10,'sales-return','bad'),false)
  assert.equal(cancelForWindow(10,'sales-return'),true);assert.equal(isGrantActiveForWindow('sales-return',11),true)
  const fresh=requestCode('sales-return',10);approve(fresh)
  assert.equal(consumeOneShot(10,'sales-return',token(fresh)),false)
  assert.equal(cancelForWindow(11),true);assert.equal(isGrantActiveForWindow('sales-return',11),false)
  assert.equal(cancelForWindow(0),false);assert.equal(cancelForWindow(10,'bad/panel'),false)
})
await test('absolute expiry closes claimed grant even when marked used',async()=>{
  reset();const p=requestCode('sales-return',10);approve(p,{ttlMs:35})
  assert.equal(consumeOneShot(10,'sales-return',token(p)),true);markUsed('sales-return',10)
  await delay(70);assert.equal(isGrantActiveForWindow('sales-return',10),false)
  assert.deepEqual(cleared,[{panel:'sales-return',owner:10}]);assert.equal(consumeOneShot(10,'sales-return',token(p)),false)
})
await test('invalid request inputs fail closed',()=>{
  reset();for(const [p,o] of [['',1],['sales-return',0],['sales-return',-1],['sales-return',null],['bad/panel',1]])assert.throws(()=>requestCode(p,o))
})
revokeAll()
