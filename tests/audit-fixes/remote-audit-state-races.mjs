import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createAuditSync } from '../../src/main/services/cloud/auditSync.ts'

// Real temporary sync-state files; audit source and transport are fakes. This
// does not exercise a real restore, production transport, or a shop database.
const initial={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
const next={...initial,epoch:'87654321-4321-4321-8321-cba987654321'}
const event={id:1,at:'2026-01-01T00:00:00Z',action:'SALE_CREATE',entity:'SaleInvoice'}
const ack=b=>({version:1,storeId:b.storeId,epoch:b.epoch,lastId:b.events.at(-1).id,digest:b.digest})
for(const scenario of ['during-read','during-empty-read','during-ack']) {
 await test(`audit state change ${scenario} fails closed`,async()=>{
  const state=openCloudStateStore(mkdtempSync(join(tmpdir(),'mahak-audit-race-')));state.save(initial)
  let sends=0
  try {
   const reader={auditPage:async()=>{
    if(scenario!=='during-ack')state.save(next)
    return scenario==='during-empty-read'?[]:[event]
   }}
   const transport={send:async b=>{sends++;if(scenario==='during-ack')state.save(next);return ack(b)}}
   const audit=createAuditSync({state,reader,transport,readRestoreMarker:async()=>null})
   await assert.rejects(audit.runOnce(),/Cloud state changed/)
   assert.equal(sends,scenario==='during-ack'?1:0)
   assert.deepEqual(state.load(),next)
  } finally { state.close() }
 })
}
