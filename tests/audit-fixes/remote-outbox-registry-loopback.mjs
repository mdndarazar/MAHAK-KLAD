import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startExperimentalRevocationReceiver } from '../../src/main/services/cloud/experimentalNetworkRevocation.ts'
import { initRemoteGrantRegistry,requestCode,createGrant,consumeOneShot,isGrantActiveForWindow,revokeAll,revokeBy } from '../../src/main/services/RemoteGrantRegistry.ts'

test('actual hub identity outbox travels by loopback and revokes actual registry grant before ACK',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mahak-real-outbox-')),db=new DatabaseSync(join(dir,'receiver.db'))
  db.exec('CREATE TABLE cursor (id INTEGER, kind TEXT, memberId TEXT);CREATE TABLE nonce (value TEXT PRIMARY KEY)')
  let cleared=0
  initRemoteGrantRegistry({notePanelUnlocked:()=>{},clearPanelScope:()=>{cleared++},clearPanelSessions:()=>{}})
  const p=requestCode('sales',12)
  assert.ok(createGrant({panel:'sales',ownerWindowId:12,tier:'NORMAL',mode:'PANEL',memberId:'a'.repeat(32),requestId:p.requestId,ttlMs:60000}))
  assert.equal(consumeOneShot(12,'sales',p.gt.slice(3)),true)
  assert.equal(isGrantActiveForWindow('sales',12),true)
  const ledger={load:()=>db.prepare('SELECT * FROM cursor').get()??null,hasNonce:n=>!!db.prepare('SELECT 1 FROM nonce WHERE value=?').get(n),
    apply:e=>{if(e.kind==='ALL')revokeAll();else revokeBy(e.memberId)},
    save:(e,n)=>{db.exec('BEGIN IMMEDIATE');try{db.exec('DELETE FROM cursor');db.prepare('INSERT INTO cursor VALUES(?,?,?)').run(e.id,e.kind,e.memberId);db.prepare('INSERT INTO nonce VALUES(?)').run(n);db.exec('COMMIT')}catch(err){db.exec('ROLLBACK');throw err}}}
  const receiver=await startExperimentalRevocationReceiver({key:Buffer.alloc(32,7),storeId:'test_store',epoch:'12345678-1234-4123-8123-123456789abc',ledger})
  const child=fork(new URL('./fixtures/remote-real-outbox-sender.mjs',import.meta.url),[join(dir,'hub.db')],{execArgv:['--import','./test/harness/register.mjs'],stdio:['ignore','ignore','inherit','ipc']})
  const messages=[];let notify
  child.on('message',m=>{messages.push(m);notify?.();notify=null})
  const next=async()=>{while(!messages.length)await new Promise(r=>notify=r);return messages.shift()}
  try {
    assert.equal((await next()).type,'ready');child.send({type:'send',port:receiver.port})
    const done=await next();assert.equal(done.type,'done',JSON.stringify(done));assert.equal(done.before,1);assert.equal(done.pending,0);assert.deepEqual(done.result,{applied:1,remaining:false})
    assert.ok(done.cursor>0);assert.equal(isGrantActiveForWindow('sales',12),false);assert.equal(cleared,1)
  } finally {child.send({type:'stop'});await new Promise(resolve=>child.once('exit',resolve));await receiver.close();revokeAll();db.close();rmSync(dir,{recursive:true,force:true})}
})
