import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExperimentalRevocationEnvelope } from '../../src/main/services/cloud/experimentalRevocationEnvelope.ts'

// Controlled clock test: the verification rules remain strict, and sender
// backdating shortens rather than extends the signed lifetime.
test('revocation timestamps tolerate bounded slow receiver without extending freshness',()=>{
 const key=Buffer.alloc(32,9),epoch='12345678-1234-4123-8123-123456789abc',sentAt=1800000000000
 const event={id:1,kind:'ALL',memberId:null}
 const signed=createExperimentalRevocationEnvelope(key,'store_test',epoch,()=>sentAt).sign(event)
 assert.equal(signed.issuedAt,sentAt-1000)
 assert.equal(signed.expiresAt,sentAt+29000)
 const verify=now=>createExperimentalRevocationEnvelope(key,'store_test',epoch,()=>now).verify(signed)
 assert.deepEqual(verify(sentAt-1000),event)
 assert.equal(verify(sentAt-1001),null)
 assert.deepEqual(verify(sentAt+28999),event)
 assert.equal(verify(sentAt+29000),null)
 assert.throws(()=>createExperimentalRevocationEnvelope(key,'store_test',epoch,()=>1000).sign(event),/clock/)
})
