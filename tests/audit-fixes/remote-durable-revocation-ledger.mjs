import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
const first={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
const entry={id:5,kind:'ALL',memberId:null},member={id:7,kind:'MEMBER',memberId:'a'.repeat(32)}
const nonce=n=>n.repeat(48)
test('revocation ledger binds store and epoch, persists nonce and cursor, and refuses reset',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-rev-ledger-'));let state=openCloudStateStore(dir)
 try {
  state.save(first);assert.throws(()=>state.openRevocationLedger());state.initializeRevocationLedger()
  let ledger=state.openRevocationLedger();assert.equal(ledger.load(),null);assert.equal(ledger.hasNonce(nonce('a')),false)
  ledger.save(entry,nonce('a'));assert.throws(()=>ledger.save(entry,nonce('a')));ledger.save(entry,nonce('b'))
  assert.throws(()=>ledger.save({...entry,kind:'MEMBER',memberId:'a'.repeat(32)},nonce('c')))
  ledger.save(member,nonce('c'));assert.throws(()=>ledger.save(entry,nonce('d')))
  state.close();state=openCloudStateStore(dir);ledger=state.openRevocationLedger()
  assert.deepEqual(ledger.load(),member);assert.equal(ledger.hasNonce(nonce('a')),true);assert.equal(ledger.hasNonce(nonce('c')),true)
  assert.throws(()=>state.initializeRevocationLedger())
  state.save({...first,epoch:'abcdefab-cdef-4abc-8abc-abcdefabcdef'});assert.throws(()=>ledger.load(),/Invalid revocation ledger/)
  state.close();state=openCloudStateStore(dir);assert.throws(()=>state.openRevocationLedger(),/Invalid revocation ledger/)
 } finally {state.close();rmSync(dir,{recursive:true,force:true})}
})
test('missing or corrupt ledger and lost lock fail closed without replacement',()=>{
 for(const mode of ['missing','corrupt','lock']) {
  const dir=mkdtempSync(join(tmpdir(),'mahak-rev-ledger-fail-')),state=openCloudStateStore(dir)
  try {
   state.save(first);state.initializeRevocationLedger();const ledger=state.openRevocationLedger();ledger.save(entry,nonce('a'))
   const path=join(dir,'revocation-ledger.json')
   if(mode==='missing')unlinkSync(path)
   if(mode==='corrupt')writeFileSync(path,'bad')
   if(mode==='lock')writeFileSync(join(dir,'cloud-state.lock'),'not-owner')
   assert.throws(()=>ledger.load());assert.throws(()=>ledger.save(member,nonce('b')));assert.throws(()=>state.initializeRevocationLedger())
   if(mode==='lock')assert.throws(()=>state.close(),/ownership lost/);else state.close()
  } finally {try{state.close()}catch{};rmSync(dir,{recursive:true,force:true})}
 }
})
test('failed sync or rename never advances a durable nonce or cursor',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-rev-ledger-write-')),state=openCloudStateStore(dir)
 try {
  state.save(first);state.initializeRevocationLedger();const ledger=state.openRevocationLedger();ledger.save(entry,nonce('a'))
  for(const method of ['fsyncSync','renameSync']) {
   const original=fs[method]
   try {fs[method]=()=>{throw new Error('injected failure')};syncBuiltinESMExports();assert.throws(()=>ledger.save(member,nonce('b')),/injected/)}
   finally {fs[method]=original;syncBuiltinESMExports()}
   assert.deepEqual(ledger.load(),entry);assert.equal(ledger.hasNonce(nonce('b')),false)
   assert.deepEqual(readdirSync(dir).filter(x=>x.endsWith('.tmp')),[])
  }
 } finally {state.close();rmSync(dir,{recursive:true,force:true})}
})
