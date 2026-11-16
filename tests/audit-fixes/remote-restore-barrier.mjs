import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExperimentalRestoreBarrier } from '../../src/main/services/cloud/experimentalRestoreBarrier.ts'

// Pure in-process simulation; not connected to BackupService or a real restore.
await test('drain blocks new work, waits for all old work, and then restores exclusively',async()=>{
 const gate=createExperimentalRestoreBarrier();let releaseA,releaseB,restoreStart=false
 const a=gate.run(()=>new Promise(r=>{releaseA=r})),b=gate.run(()=>new Promise(r=>{releaseB=r}))
 const restoring=gate.restore(async()=>{restoreStart=true;assert.deepEqual(gate.status(),{state:'DRAINING',active:0})})
 await assert.rejects(gate.run(async()=>{}),/closed/);await assert.rejects(gate.restore(async()=>{}),/closed/)
 releaseA();await a;assert.equal(restoreStart,false);releaseB();await b;await restoring
 assert.equal(restoreStart,true);assert.equal(await gate.run(async()=>42),42)
})
await test('failed restore stays fail-closed; failed read releases its slot',async()=>{
 const gate=createExperimentalRestoreBarrier()
 await assert.rejects(gate.run(async()=>{throw Error('query')}),/query/)
 assert.equal(gate.status().active,0)
 await assert.rejects(gate.restore(async()=>{throw Error('restore')}),/restore/)
 assert.deepEqual(gate.status(),{state:'FAILED',active:0})
 await assert.rejects(gate.run(async()=>{}),/closed/);await assert.rejects(gate.restore(async()=>{}),/closed/)
})
