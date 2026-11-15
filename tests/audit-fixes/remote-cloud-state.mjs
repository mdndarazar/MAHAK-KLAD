import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openCloudStateStore } from '../../src/main/services/cloud/cloudState.ts'

const modulePath=fileURLToPath(new URL('../../src/main/services/cloud/cloudState.ts',import.meta.url))
const mk=()=>mkdtempSync(join(tmpdir(),'mahak-cloud-state-'))
const first={version:1,storeId:'store_test',epoch:'12345678-1234-4123-8123-123456789abc',lastAcked:0,anchorHash:'',restoreMarker:null}
const advanced={...first,lastAcked:5,anchorHash:'a'.repeat(64)}
const child=(dir,close=false)=>spawnSync(process.execPath,['--input-type=module','-e',
  `import {openCloudStateStore} from ${JSON.stringify(new URL(`file://${modulePath}`).href)}; const s=openCloudStateStore(${JSON.stringify(dir)}); ${close?'s.close();':''}`],{encoding:'utf8'})

await test('empty, atomic save, reopen and preserve full state across processes',()=>{
  const dir=mk(),s=openCloudStateStore(dir);assert.equal(s.load(),null);s.save(first);assert.deepEqual(s.load(),first)
  s.save(advanced);assert.deepEqual(s.load(),advanced);s.close()
  assert.equal(child(dir,true).status,0)
  const reopened=openCloudStateStore(dir);assert.deepEqual(reopened.load(),advanced);reopened.close()
})
await test('second owner cannot open the same store in either process',()=>{
  const dir=mk(),s=openCloudStateStore(dir)
  assert.throws(()=>openCloudStateStore(dir));assert.notEqual(child(dir).status,0)
  s.close();const another=openCloudStateStore(dir);another.close()
})
await test('crashed owner leaves lock and a subsequent process fails closed',()=>{
  const dir=mk();assert.equal(child(dir).status,0)
  assert.equal(existsSync(join(dir,'cloud-state.lock')),true)
  assert.throws(()=>openCloudStateStore(dir))
})
await test('tampered or replaced lock is never unlinked by previous owner',()=>{
  const dir=mk(),s=openCloudStateStore(dir);const lock=join(dir,'cloud-state.lock')
  writeFileSync(lock,'different-owner')
  assert.throws(()=>s.close(),/ownership lost/)
  assert.equal(readFileSync(lock,'utf8'),'different-owner')
  assert.throws(()=>s.load(),/closed/)
})
await test('invalid inputs, unknown fields and unsafe integers are rejected without creating state',()=>{
  const dir=mk(),s=openCloudStateStore(dir)
  for(const patch of [{version:2},{storeId:'bad/store'},{epoch:'bad'},{lastAcked:-1},{lastAcked:Number.MAX_SAFE_INTEGER+1},{lastAcked:1},{anchorHash:'abc'},{restoreMarker:'bad'},{extra:true}]) {
    assert.throws(()=>s.save({...first,...patch}))
  }
  assert.equal(existsSync(join(dir,'cloud-state.json')),false);s.close()
})
await test('rejected transitions do not overwrite last good state',()=>{
  const dir=mk(),s=openCloudStateStore(dir);s.save(advanced)
  for(const invalid of [first,{...advanced,storeId:'another'},{...advanced,anchorHash:'b'.repeat(64)},
    {...advanced,restoreMarker:'c'.repeat(64)}, {...advanced,epoch:'abcdefab-1234-4123-8123-123456789abc'}]) assert.throws(()=>s.save(invalid))
  assert.deepEqual(s.load(),advanced);s.close()
})
await test('new epoch must start at zero; normal ack advance retains epoch and marker',()=>{
  const dir=mk(),s=openCloudStateStore(dir);s.save(first);s.save(advanced)
  const next={...first,epoch:'abcdefab-1234-4123-8123-123456789abc',restoreMarker:'c'.repeat(64)}
  s.save(next);assert.deepEqual(s.load(),next)
  const later={...next,lastAcked:7,anchorHash:'d'.repeat(64)};s.save(later);assert.deepEqual(s.load(),later);s.close()
})
await test('corrupt or oversized state is not treated as empty and cannot be overwritten',()=>{
  for(const content of ['{not-json',JSON.stringify({...first,extra:true}),'x'.repeat(9000)]) {
    const dir=mk(),s=openCloudStateStore(dir),path=join(dir,'cloud-state.json');writeFileSync(path,content)
    assert.throws(()=>s.load());assert.throws(()=>s.save(first));assert.equal(readFileSync(path,'utf8'),content);s.close()
  }
})
await test('legacy state is preserved and requires explicit migration',()=>{
  const dir=mk(),s=openCloudStateStore(dir),path=join(dir,'cloud-state.json')
  const legacy=JSON.stringify({epoch:first.epoch,cursor:50,chainHash:'abc',mode:'HUB_LOCAL',endpoints:[]})
  writeFileSync(path,legacy)
  assert.throws(()=>s.load());assert.throws(()=>s.save(first));assert.equal(readFileSync(path,'utf8'),legacy);s.close()
})
await test('failed fsync or rename keeps the old state and removes only owned temporary files',()=>{
  const dir=mk(),s=openCloudStateStore(dir),path=join(dir,'cloud-state.json');s.save(first)
  for (const method of ['fsyncSync','renameSync']) {
    const original=fs[method]
    try {
      fs[method]=()=>{throw new Error(`injected ${method} failure`)};syncBuiltinESMExports()
      assert.throws(()=>s.save(advanced),/injected/)
    } finally {fs[method]=original;syncBuiltinESMExports()}
    assert.deepEqual(s.load(),first)
    assert.equal(readFileSync(path,'utf8'),JSON.stringify(first))
    assert.deepEqual(readdirSync(dir).filter(n=>n.endsWith('.tmp')),[])
  }
  s.close()
})
await test('symlink state is refused rather than followed or treated as missing', {skip:process.platform==='win32'?'Windows symlink creation often requires privileges':false},()=>{
  const dir=mk(),s=openCloudStateStore(dir),path=join(dir,'cloud-state.json')
  symlinkSync(join(dir,'nonexistent-target'),path)
  assert.throws(()=>s.load());assert.throws(()=>s.save(first));assert.equal(lstatSync(path).isSymbolicLink(),true);s.close()
})
await test('closing is idempotent and operations on closed store fail',()=>{
  const dir=mk(),s=openCloudStateStore(dir);s.close();s.close()
  assert.throws(()=>s.load(),/closed/);assert.throws(()=>s.save(first),/closed/)
})
await test('new files use private POSIX modes',{skip:process.platform==='win32'?'POSIX modes do not prove Windows ACLs':false},()=>{
  const dir=mk(),s=openCloudStateStore(dir);s.save(first)
  assert.equal(lstatSync(join(dir,'cloud-state.lock')).mode&0o077,0)
  assert.equal(lstatSync(join(dir,'cloud-state.json')).mode&0o077,0);s.close()
})
