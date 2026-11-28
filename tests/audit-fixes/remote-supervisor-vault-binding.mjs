import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes,createCipheriv,createDecipheriv,createHash } from 'node:crypto'
import { build } from 'esbuild'
import { mkdtempSync,readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../../test/harness/prismaLite.mjs'
import { makeSeeder } from '../../test/harness/seed.mjs'
import { createCloudReader } from '../../src/main/services/cloud/cloudReader.ts'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'
import { createRemoteTransportVault } from '../../src/main/services/cloud/remoteTransportVault.ts'
import { startExperimentalHubSupervisor } from '../../src/main/services/cloud/experimentalHubSupervisor.ts'

// Synthetic authenticated protector and isolated DBs only. This does not test
// Electron safeStorage, Windows DPAPI/ACLs, real restore, HTTPS or a phone.
const dir=mkdtempSync(join(tmpdir(),'mahak-vault-binding-')),hubDir=mkdtempSync(join(tmpdir(),'mahak-vault-hub-')),childFile=join(dir,'hub.cjs')
await build({entryPoints:[new URL('../../src/main/services/cloud/experimentalHubChild.ts',import.meta.url).pathname],outfile:childFile,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'})
const localKey=randomBytes(32)
const storage={
  isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',
  encryptString(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',localKey,iv),b=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b])},
  decryptString(data){const c=createDecipheriv('aes-256-gcm',localKey,data.subarray(0,12));c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8')}
}
const vault=createRemoteTransportVault(dir,'store_vault',storage),keys=vault.create()
const store=createClient(join(dir,'isolated-shop.db')),seed=makeSeeder(store)
seed.insert('AuditLog',{at:1700000000000,action:'SALE_CREATE',entity:'SaleInvoice',note:'PRIVATE AUDIT'})
const state=openCloudStateStore(join(dir,'state'))
state.save({version:1,storeId:'store_vault',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null})
const reader=createCloudReader(store)
const options={nodeExecutable:process.execPath,childFile,directory:hubDir,origin:'https://store.example',owner:{username:'owner',password:'owner-test-password',pin:'746392'},auditKey:keys.auditKey,snapshotMaxAgeMs:5000,reader,state,readRestoreMarker:async()=>null,timeoutMs:5000}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
let supervisor
try {
  await test('protected key starts child and authenticates one audit cycle',async()=>{
    supervisor=await startExperimentalHubSupervisor(options)
    assert.deepEqual(await supervisor.syncOnce(),{sent:1,lastAcked:1})
    await supervisor.stop();supervisor=null
  })
  await test('wrong key or absent key binding cannot silently adopt an existing hub',async()=>{
    const path=join(hubDir,'remote-hub.sqlite'),before=hash(path)
    await assert.rejects(startExperimentalHubSupervisor({...options,owner:null,auditKey:Buffer.alloc(32,6)}),/unavailable/)
    assert.equal(hash(path),before)
    const legacy=mkdtempSync(join(tmpdir(),'mahak-unbound-hub-')),legacyPath=join(legacy,'remote-hub.sqlite')
    const db=new DatabaseSync(legacyPath);db.exec('CREATE TABLE remote_legacy (id INTEGER)');db.close()
    const oldHash=hash(legacyPath)
    await assert.rejects(startExperimentalHubSupervisor({...options,directory:legacy,owner:null}),/unavailable/)
    assert.equal(hash(legacyPath),oldHash)
    assert.throws(()=>vault.create(),/EEXIST/)
  })
  await test('loading the original protected key permits an idempotent restart',async()=>{
    const loaded=vault.load();assert.deepEqual(loaded,keys)
    supervisor=await startExperimentalHubSupervisor({...options,owner:null,auditKey:loaded.auditKey})
    assert.deepEqual(await supervisor.syncOnce(),{sent:0,lastAcked:1})
    await supervisor.stop();supervisor=null
  })
} finally {if(supervisor)await supervisor.stop();state.close();await store.$disconnect()}
