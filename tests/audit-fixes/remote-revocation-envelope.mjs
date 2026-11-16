import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExperimentalRevocationEnvelope } from '../../src/main/services/cloud/experimentalRevocationEnvelope.ts'

// Cryptographic primitive only: no network, replay ledger, ACK or desktop grant integration.
const key=Buffer.alloc(32,42),epoch='12345678-1234-4123-8123-123456789abc';let now=1800000000000
const codec=createExperimentalRevocationEnvelope(key,'store_test',epoch,()=>now)
await test('valid ALL and MEMBER events are authenticated and scoped',()=>{
 for(const event of [{id:1,kind:'ALL',memberId:null},{id:2,kind:'MEMBER',memberId:'a'.repeat(32)}]){
  const signed=codec.sign(event);assert.deepEqual(codec.verify(signed),event)
  assert.equal(createExperimentalRevocationEnvelope(key,'other',epoch,()=>now).verify(signed),null)
  assert.equal(createExperimentalRevocationEnvelope(Buffer.alloc(32,7),'store_test',epoch,()=>now).verify(signed),null)
 }
})
await test('altered, malformed, expired, future and accessor messages are rejected',()=>{
 const signed=codec.sign({id:1,kind:'ALL',memberId:null})
 for(const changed of [{...signed,id:2},{...signed,kind:'MEMBER',memberId:'a'.repeat(32)}, {...signed,epoch:'87654321-4321-4321-8321-cba987654321'},
  {...signed,signature:'0'.repeat(64)}, {...signed,extra:true}, {...signed,nonce:'bad'}, {...signed,issuedAt:now+1},
  {...signed,get id(){throw Error('getter')}}]) assert.equal(codec.verify(changed),null)
 now+=30_000;assert.equal(codec.verify(signed),null);now-=30_000
 assert.throws(()=>codec.sign({id:0,kind:'ALL',memberId:null}),/Invalid/)
})
