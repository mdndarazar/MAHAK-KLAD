import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubIdentity } from '../../src/main/services/cloud/hubIdentity.ts'

test('owner panic atomically latches, revokes all hub sessions and queues ALL across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mahak-panic-')),path=join(dir,'hub.db');let db=new DatabaseSync(path)
  try {
    const opts={panels:['sales'],approvalPanels:['sales']}
    let identity=createHubIdentity(db,opts)
    assert.equal(identity.bootstrap('owner','long-password-test','746392'),true)
    const a=identity.login('owner','long-password-test'),b=identity.login('owner','long-password-test')
    assert.equal(a.ok,true);assert.equal(b.ok,true)
    assert.equal(identity.panic(a.token,'111111'),false);assert.ok(identity.whoAmI(b.token))
    assert.equal(identity.panic(a.token,'746392'),true)
    assert.equal(identity.whoAmI(a.token),null);assert.equal(identity.whoAmI(b.token),null)
    assert.equal(identity.isPaused(),true);assert.equal(identity.pendingRevocations(1)[0].kind,'ALL')
    assert.equal(identity.login('owner','long-password-test').ok,false)
    db.close();db=new DatabaseSync(path);identity=createHubIdentity(db,opts)
    assert.equal(identity.login('owner','long-password-test').ok,false)
    assert.equal(identity.isPaused(),true);assert.equal(identity.pendingRevocations(1)[0].kind,'ALL')
  } finally {db.close();rmSync(dir,{recursive:true,force:true})}
})
