import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs,{mkdtempSync,rmSync,unlinkSync,writeFileSync,readdirSync} from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openCloudStateStore} from '../../src/main/services/cloud/cloudState.ts'
const first={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
const nonce=n=>n.repeat(32)
test('grant replay survives restart, binds epoch, rejects rollback and cannot be reinitialized',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-grant-replay-'));let state=openCloudStateStore(dir)
 try {
  state.save(first);assert.throws(()=>state.openGrantReplayLedger());state.initializeGrantReplayLedger()
  let ledger=state.openGrantReplayLedger(2)
  assert.equal(ledger.consume('request1',nonce('a'),4000,1000),'OK')
  assert.equal(ledger.consume('request1',nonce('b'),4000,1100),'REPLAY')
  assert.equal(ledger.consume('request2',nonce('a'),4000,1100),'REPLAY')
  assert.equal(ledger.consume('request2',nonce('b'),4000,1050),'INVALID')
  assert.equal(ledger.consume('request2',nonce('b'),4000,1200),'OK')
  assert.equal(ledger.consume('request3',nonce('c'),4000,1200),'CAPACITY')
  state.close();state=openCloudStateStore(dir);ledger=state.openGrantReplayLedger(2)
  assert.equal(ledger.consume('request1',nonce('a'),4000,1300),'REPLAY')
  assert.equal(ledger.consume('request3',nonce('c'),8000,4000),'OK')
  assert.throws(()=>state.initializeGrantReplayLedger())
  state.save({...first,epoch:'abcdefab-cdef-4abc-8abc-abcdefabcdef'});assert.throws(()=>ledger.consume('request4',nonce('d'),8000,5000),/Invalid grant replay ledger/)
 } finally {state.close();rmSync(dir,{recursive:true,force:true})}
})
test('missing, malformed, duplicate, marker and ownership failures are closed',()=>{
 for(const mode of ['missing','corrupt','duplicate','marker','lock']) {
  const dir=mkdtempSync(join(tmpdir(),'mahak-grant-fail-')),state=openCloudStateStore(dir)
  try {
   state.save(first);state.initializeGrantReplayLedger();const ledger=state.openGrantReplayLedger();assert.equal(ledger.consume('request1',nonce('a'),4000,1000),'OK')
   const path=join(dir,'grant-replay-ledger.json')
   if(mode==='missing')unlinkSync(path)
   if(mode==='corrupt')writeFileSync(path,'bad')
   if(mode==='duplicate'){const value=JSON.parse(fs.readFileSync(path,'utf8'));value.entries.push({...value.entries[0],requestId:'other'});writeFileSync(path,JSON.stringify(value))}
   if(mode==='marker')unlinkSync(join(dir,'grant-replay-ledger.initialized'))
   if(mode==='lock')writeFileSync(join(dir,'cloud-state.lock'),'not-owner')
   assert.throws(()=>ledger.consume('request2',nonce('b'),4000,1200));assert.throws(()=>state.openGrantReplayLedger())
   if(mode==='lock')assert.throws(()=>state.close(),/ownership lost/);else state.close()
  } finally {try{state.close()}catch{};rmSync(dir,{recursive:true,force:true})}
 }
})
test('failed file fsync or rename cannot commit a grant replay nonce',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-grant-write-')),state=openCloudStateStore(dir)
 try {
  state.save(first);state.initializeGrantReplayLedger();const ledger=state.openGrantReplayLedger();assert.equal(ledger.consume('request1',nonce('a'),4000,1000),'OK')
  for(const name of ['fsyncSync','renameSync']) {
   const original=fs[name]
   try {fs[name]=()=>{throw new Error('injected failure')};syncBuiltinESMExports();assert.throws(()=>ledger.consume('request2',nonce('b'),4000,1200),/injected/)}
   finally {fs[name]=original;syncBuiltinESMExports()}
   assert.equal(ledger.consume('request1',nonce('a'),4000,1200),'REPLAY')
   assert.deepEqual(readdirSync(dir).filter(x=>x.endsWith('.tmp')),[])
  }
  assert.equal(ledger.consume('request2',nonce('b'),4000,1200),'OK')
 } finally {state.close();rmSync(dir,{recursive:true,force:true})}
})
