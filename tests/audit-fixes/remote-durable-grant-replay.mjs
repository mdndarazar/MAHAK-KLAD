import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { createDurableGrantReplay } from '../../src/main/services/cloud/durableGrantReplay.ts'
import { createSignedGrantVerifier } from '../../src/main/services/cloud/signedCommandVerifier.ts'
const KEY=Buffer.alloc(32,0x38),NOW=1800000000000
function command(patch={}){
 const c={version:1,storeId:'store_1',requestId:'request_1',nonce:'abcdefghijklmnopqrstuvwx',panel:'sales-return',ownerWindowId:4,memberId:'member_1',tier:'NORMAL',issuedAt:NOW,expiresAt:NOW+30000,...patch}
 const bytes=JSON.stringify([c.version,c.storeId,c.requestId,c.nonce,c.panel,c.ownerWindowId,c.memberId,c.tier,c.issuedAt,c.expiresAt])
 return {...c,signature:createHmac('sha256',KEY).update(bytes).digest('hex')}
}
const path=join(mkdtempSync(join(tmpdir(),'mahak-replay-')),'hub.db');let db=new DatabaseSync(path),clock=NOW
const create=(size=2048)=>createSignedGrantVerifier({key:KEY,storeId:'store_1',allowedPanels:['sales-return'],now:()=>clock,replayStore:createDurableGrantReplay(db,'store_1',size)})
try {
 await test('signature checked before ledger entry and accepted commands persist across restart',()=>{
  const verify=create(),c=command();assert.deepEqual(verify({...c,signature:'0'.repeat(64)}),{ok:false,reason:'INVALID'})
  assert.equal(db.prepare('SELECT COUNT(*) n FROM remote_command_replay').get().n,0)
  assert.equal(verify(c).ok,true);db.close();db=new DatabaseSync(path)
  assert.deepEqual(create()(c),{ok:false,reason:'REPLAY'})
  assert.deepEqual(create()(command({nonce:'differentabcdefghijklmnop'})),{ok:false,reason:'REPLAY'})
  assert.deepEqual(create()(command({requestId:'different'})),{ok:false,reason:'REPLAY'})
 })
 await test('capacity does not evict live entries; cleanup permits new entries only after expiry',()=>{
  const verify=create(1),second=command({requestId:'request_2',nonce:'differentabcdefghijklmnop'})
  assert.deepEqual(verify(second),{ok:false,reason:'CAPACITY'})
  assert.deepEqual(verify(command()),{ok:false,reason:'REPLAY'})
  clock=NOW+30001
  const later=command({requestId:'request_2',nonce:'differentabcdefghijklmnop',issuedAt:clock,expiresAt:clock+30000})
  assert.equal(verify(later).ok,true);assert.equal(db.prepare('SELECT COUNT(*) n FROM remote_command_replay').get().n,1)
 })
 await test('rollback clock rejects even after new verifier and DB restart',()=>{
  db.close();db=new DatabaseSync(path);clock=NOW
  assert.deepEqual(create()(command({requestId:'request_3',nonce:'abcdefghijklmnopqrstuvyz'})),{ok:false,reason:'INVALID'})
 })
 await test('store failure and invalid store result never produce verified approval',()=>{
  clock=NOW+30001;const c=command({requestId:'request_4',nonce:'abcdefghijklmnopqrstuvyz',issuedAt:clock,expiresAt:clock+30000})
  for(const replayStore of [{consume(){throw Error('disk failure')}},{consume(){return 'unexpected'}}]){
   const verify=createSignedGrantVerifier({key:KEY,storeId:'store_1',allowedPanels:['sales-return'],now:()=>clock,replayStore})
   assert.deepEqual(verify(c),{ok:false,reason:'INVALID'})
  }
 })
 await test('failure during transaction does not leave a partial reservation',()=>{
  const store=createDurableGrantReplay(db,'other_store')
  db.exec("CREATE TRIGGER reject_command BEFORE INSERT ON remote_command_replay WHEN NEW.store_id='other_store' BEGIN SELECT RAISE(ABORT,'simulated disk error'); END;")
  assert.throws(()=>store.consume('request_9','abcdefghijklmnopqrstuvwx',clock+30000,clock))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM remote_command_replay_clock WHERE store_id='other_store'").get().n,0)
  db.exec('DROP TRIGGER reject_command');assert.equal(store.consume('request_9','abcdefghijklmnopqrstuvwx',clock+30000,clock),'OK')
 })
}finally{db.close()}
