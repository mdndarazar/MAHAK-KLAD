import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../tools/redline-check.mjs', import.meta.url))
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'mahak-redline-fixture-'))
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid')
  const put=(path,content)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),content)}
  put('src/main/services/SalesService.ts','protected\n')
  put('src/main/services/AuthService.ts','a\nb\nc\nd\ne\nf\n')
  put('src/renderer/src/components/ManagerGate.tsx','original\n')
  put('prisma/schema.prisma','schema\n')
  git('add','.');git('commit','-qm','isolated fixture baseline')
  const base=git('rev-parse','HEAD')
  const check=(...args)=>spawnSync(process.execPath,[script,...args],{cwd:dir,encoding:'utf8'})
  return {dir,git,put,base,check}
}

test('explicit baseline required and valid',()=>{
  const f=fixture();assert.equal(f.check().status,2);assert.equal(f.check('--base','not-a-sha').status,2)
  assert.equal(f.check('--base',f.base).status,0)
})
test('approved source and untracked cloud files pass',()=>{
  const f=fixture();f.put('src/renderer/src/components/ManagerGate.tsx','original\nadded\n')
  f.put('src/main/services/cloud/read.ts','export const ok = true\n')
  const r=f.check('--base',f.base);assert.equal(r.status,0,r.stderr)
})
test('protected edits and new unapproved files fail even when unstaged',()=>{
  const f=fixture();f.put('src/main/services/SalesService.ts','changed\n')
  f.put('src/main/services/SomeUnexpectedService.ts','new\n')
  const r=f.check('--base',f.base);assert.equal(r.status,1);assert.match(r.stderr,/SalesService/);assert.match(r.stderr,/SomeUnexpectedService/)
})
test('staged schema modifications and tracked deletions fail',()=>{
  const f=fixture();f.put('prisma/schema.prisma','changed\n');f.git('add','prisma/schema.prisma')
  rmSync(join(f.dir,'src/renderer/src/components/ManagerGate.tsx'))
  const r=f.check('--base',f.base);assert.equal(r.status,1);assert.match(r.stderr,/schema\.prisma/);assert.match(r.stderr,/Deleted file/)
})
test('auth budget counts both additions and deletions',()=>{
  const f=fixture();f.put('src/main/services/AuthService.ts','g\nh\ni\nj\nk\nl\n')
  const r=f.check('--base',f.base);assert.equal(r.status,1);assert.match(r.stderr,/12 > 10/)
})
test('committed protected modifications since baseline fail',()=>{
  const f=fixture();f.put('src/main/services/SalesService.ts','changed\n');f.git('add','.');f.git('commit','-qm','protected change')
  const r=f.check('--base',f.base);assert.equal(r.status,1);assert.match(r.stderr,/SalesService/)
})
