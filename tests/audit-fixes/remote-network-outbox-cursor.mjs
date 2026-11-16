import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'

const epoch='12345678-1234-4123-8123-123456789abc'
test('network outbox acknowledgement and sender cursor commit together across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mahak-network-outbox-')),file=join(dir,'hub.sqlite')
  let db=new DatabaseSync(file)
  try {
    const options={panels:['sales'],approvalPanels:['sales']}
    let identity=createHubIdentity(db,options)
    assert.equal(identity.bootstrap('owner','test-password-123','123456'),true)
    const owner=identity.login('owner','test-password-123');assert.equal(owner.ok,true)
    assert.equal(identity.setPaused(owner.token,'123456',true),true)
    assert.equal(identity.setPaused(owner.token,'123456',false),true)
    assert.equal(identity.setPaused(owner.token,'123456',true),true)
    const pending=identity.pendingRevocations();assert.equal(pending.length,2)
    assert.equal(identity.networkRevocationCursor(epoch),0)
    assert.equal(identity.acknowledgeRevocation(pending[0].id),false)
    assert.equal(identity.acknowledgeNetworkRevocation(epoch,0,pending[1].id),false)
    db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON remote_revocation_delivery BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    assert.throws(()=>identity.acknowledgeNetworkRevocation(epoch,0,pending[0].id))
    assert.equal(identity.networkRevocationCursor(epoch),0);assert.equal(identity.pendingRevocations().length,2)
    db.exec('DROP TRIGGER fail_cursor')
    assert.equal(identity.acknowledgeNetworkRevocation(epoch,0,pending[0].id),true)
    db.close();db=new DatabaseSync(file);identity=createHubIdentity(db,options)
    assert.equal(identity.networkRevocationCursor(epoch),pending[0].id)
    assert.equal(identity.acknowledgeNetworkRevocation(epoch,0,pending[1].id),false)
    assert.equal(identity.acknowledgeNetworkRevocation(epoch,pending[0].id,pending[1].id),true)
    assert.equal(identity.pendingRevocations().length,0)
    assert.throws(()=>identity.networkRevocationCursor('abcdefab-cdef-4abc-8abc-abcdefabcdef'))
  } finally {db.close();rmSync(dir,{recursive:true,force:true})}
})
