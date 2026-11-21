import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, linkSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteTransportVault } from '../../src/main/services/cloud/remoteTransportVault.ts'

// Fake authenticated encryption for logic tests only; not Electron safeStorage,
// Windows DPAPI, Windows ACLs, backup/recovery or production key provisioning.
const makeProtector=()=>{
  const key=randomBytes(32)
  return {
    isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',
    encryptString(plain){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted])},
    decryptString(data){const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')}
  }
}
const dir=mkdtempSync(join(tmpdir(),'mahak-transport-vault-')),path=join(dir,'remote-transport-key.v1'),protector=makeProtector()
const vault=createRemoteTransportVault(dir,'store_test',protector)
let keys,original
await test('explicit creation produces independent random keys stored only through the protector',()=>{
  keys=vault.create();original=readFileSync(path)
  assert.equal(keys.storeId,'store_test');assert.equal(keys.auditKey.length,32);assert.equal(keys.commandKey.length,32);assert.notDeepEqual(keys.auditKey,keys.commandKey)
  assert.ok(!original.includes(Buffer.from(keys.auditKey.toString('hex'))));assert.ok(!original.includes(Buffer.from(keys.commandKey.toString('hex'))))
  const loaded=vault.load();assert.deepEqual(loaded,keys);assert.notEqual(loaded.auditKey,keys.auditKey)
})
await test('broken or obvious no-op protectors fail before a new file is created',()=>{
  const broken=[
    {...protector,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString('utf8')},
    {...protector,decryptString:()=>{throw Error('not recoverable')}},
    {...protector,decryptString:()=>'{"wrong":true}'},
    {...protector,decryptString:()=>null}
  ]
  for(const bad of broken){
    const d=mkdtempSync(join(tmpdir(),'mahak-vault-broken-')),candidate=join(d,'remote-transport-key.v1')
    assert.throws(()=>createRemoteTransportVault(d,'store_test',bad).create(),/Secure storage failed/)
    assert.equal(existsSync(candidate),false)
  }
})
await test('existing or damaged files and store mismatch cannot silently regenerate keys',()=>{
  assert.throws(()=>vault.create(),/EEXIST/);assert.deepEqual(readFileSync(path),original)
  assert.throws(()=>createRemoteTransportVault(dir,'another_store',protector).load(),/Invalid/)
  assert.throws(()=>createRemoteTransportVault(dir,'store_test',makeProtector()).load(),/unavailable/)
  const corrupted=Buffer.from(original);corrupted[corrupted.length-1]^=1;writeFileSync(path,corrupted)
  assert.throws(()=>vault.load(),/unavailable/);assert.throws(()=>vault.create(),/EEXIST/);assert.deepEqual(readFileSync(path),corrupted)
  writeFileSync(path,original);assert.deepEqual(vault.load(),keys)
})
await test('secure storage availability and unsafe Linux fallback fail closed',()=>{
  const unavailable={...protector,isEncryptionAvailable:()=>false}
  assert.throws(()=>createRemoteTransportVault(dir,'store_test',unavailable).load(),/unavailable/)
  if(process.platform==='linux'){
    const unsafe={...protector,getSelectedStorageBackend:()=> 'basic_text'}
    assert.throws(()=>createRemoteTransportVault(dir,'store_test',unsafe).load(),/unavailable/)
    assert.throws(()=>createRemoteTransportVault(dir,'store_test',{...protector,getSelectedStorageBackend:undefined}).load(),/unavailable/)
  }
  assert.deepEqual(readFileSync(path),original)
})
await test('symlinks and hardlinks are not read or replaced',()=>{
  // Windows symlink creation may require privileges; still exercise hardlinks.
  for(const kind of (process.platform==='win32'?['hardlink']:['symlink','hardlink'])){
    const d=mkdtempSync(join(tmpdir(),'mahak-transport-link-')),target=join(d,'sentinel'),candidate=join(d,'remote-transport-key.v1')
    writeFileSync(target,'do-not-modify')
    if(kind==='symlink')symlinkSync(target,candidate);else linkSync(target,candidate)
    const v=createRemoteTransportVault(d,'store_test',protector)
    assert.throws(()=>v.load(),/Invalid/);assert.throws(()=>v.create(),/EEXIST/)
    assert.equal(readFileSync(target,'utf8'),'do-not-modify')
  }
})
await test('invalid configuration and malformed encrypted payloads fail closed',()=>{
  assert.throws(()=>createRemoteTransportVault('relative','store_test',protector),/Invalid/)
  assert.throws(()=>createRemoteTransportVault(dir,'bad/store',protector),/Invalid/)
  const d=mkdtempSync(join(tmpdir(),'mahak-transport-malformed-')),p=join(d,'remote-transport-key.v1')
  for(const value of [null,{}, {version:1,storeId:'store_test',auditKey:'f'.repeat(64),commandKey:'f'.repeat(64)}, {version:1,storeId:'store_test',auditKey:'f'.repeat(64),commandKey:'a'.repeat(64),extra:'x'}]){
    writeFileSync(p,protector.encryptString(JSON.stringify(value)))
    assert.throws(()=>createRemoteTransportVault(d,'store_test',protector).load(),/Invalid/)
  }
})
