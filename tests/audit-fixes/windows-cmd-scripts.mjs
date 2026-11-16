import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const scripts=['SETUP-WINDOWS.cmd','BUILD-WINDOWS.cmd','RUN-WINDOWS.cmd']
await test('scripts contain no database or lockfile removal and require Node 24 x64',()=>{
 for(const file of scripts){const s=readFileSync(file,'utf8');assert.match(s,/process\.versions\.node/);assert.match(s,/process\.arch/)
  assert.doesNotMatch(s,/^\s*(?:del|erase|rmdir|rd|git\s+clean|git\s+reset)\b/im)
  assert.doesNotMatch(s,/prisma\s+migrate\s+(?:reset|deploy|dev)/i)
 }
 assert.match(readFileSync('RUN-WINDOWS.cmd','utf8'),/if defined DATABASE_URL goto :databaseconfig/i)
 assert.match(readFileSync('RUN-WINDOWS.cmd','utf8'),/if exist "\.env" goto :databaseconfig/i)
})
if(process.platform!=='win32') {
 await test('Windows CMD behavior', {skip:'Requires real Windows cmd.exe and Node 24 x64'},()=>{})
} else {
 const dir=mkdtempSync(join(tmpdir(),'mahak cmd & ')),source=resolve(dir,'source folder'),fake=join(dir,'fake bin'),log=join(dir,'calls.log')
 mkdirSync(source,{recursive:true});mkdirSync(fake,{recursive:true})
 for(const name of scripts)copyFileSync(name,join(source,name))
 mkdirSync(join(source,'prisma','migrations','0_init'),{recursive:true});mkdirSync(join(source,'node_modules','.bin'),{recursive:true})
 writeFileSync(join(source,'package.json'),'{}');writeFileSync(join(source,'package-lock.json'),'LOCKFILE SENTINEL')
 writeFileSync(join(source,'prisma','schema.prisma'),'SCHEMA SENTINEL');writeFileSync(join(source,'prisma','migrations','0_init','migration.sql'),'MIGRATION SENTINEL')
 writeFileSync(join(source,'node_modules','.bin','electron-vite.cmd'),'@exit /b 0\r\n');writeFileSync(join(source,'shop.db'),'DATABASE SENTINEL')
 writeFileSync(join(fake,'npm.cmd'),[
  '@echo off',
  'echo %* ^| %DATABASE_URL%>>"%MAHAK_TEST_LOG%"',
  'if "%MAHAK_TEST_FAIL%"=="ci" if "%1"=="ci" exit /b 7',
  'if "%MAHAK_TEST_FAIL%"=="generate" if "%2"=="db:generate" exit /b 7',
  'if "%MAHAK_TEST_FAIL%"=="typecheck" if "%2"=="typecheck" exit /b 7',
  'if "%MAHAK_TEST_FAIL%"=="build" if "%2"=="dist:win" exit /b 7',
  'exit /b 0',''
 ].join('\r\n'))
 const baseEnv={...process.env,PATH:fake+';'+process.env.PATH,MAHAK_TEST_LOG:log}
 delete baseEnv.DATABASE_URL;delete baseEnv.MAHAK_TEST_FAIL
 const calls=()=>{const value=existsSync(log)?readFileSync(log,'utf8').trim():'';return value ? value.split(/\r?\n/) : []}
 const resetLog=()=>writeFileSync(log,'')
 // Execute by relative name from a path containing spaces and '&'; cmd.exe's
 // /c quote stripping would otherwise split an absolute quoted command itself.
 const exec=(file,{env={},input=''}={})=>spawnSync('cmd.exe',['/d','/c',file],{cwd:source,env:{...baseEnv,...env},encoding:'utf8',input,timeout:20000})
 const safe=()=>{assert.equal(readFileSync(join(source,'shop.db'),'utf8'),'DATABASE SENTINEL');assert.equal(readFileSync(join(source,'package-lock.json'),'utf8'),'LOCKFILE SENTINEL')}
 await test('setup performs locked install and client generation, in order and with an isolated generation URL',()=>{
  resetLog();const r=exec('SETUP-WINDOWS.cmd');assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(calls(),['ci | file:./unused-generation.db','run db:generate | file:./unused-generation.db']);safe()
 })
 await test('setup stops on install or generation failure',()=>{
  resetLog();let r=exec('SETUP-WINDOWS.cmd',{env:{MAHAK_TEST_FAIL:'ci'}});assert.notEqual(r.status,0);assert.equal(calls().length,1)
  resetLog();r=exec('SETUP-WINDOWS.cmd',{env:{MAHAK_TEST_FAIL:'generate'}});assert.notEqual(r.status,0);assert.equal(calls().length,2);safe()
 })
 await test('build stops on typecheck failure and only builds after successful validation',()=>{
  resetLog();let r=exec('BUILD-WINDOWS.cmd',{env:{MAHAK_TEST_FAIL:'typecheck'}});assert.notEqual(r.status,0);assert.equal(calls().length,1)
  resetLog();r=exec('BUILD-WINDOWS.cmd');assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(calls(),['run typecheck | file:./unused-generation.db','run dist:win -- --publish never | file:./unused-generation.db']);safe()
 })
 await test('run refuses database override, .env, and explicit cancellation',()=>{
  resetLog();let r=exec('RUN-WINDOWS.cmd',{env:{DATABASE_URL:'file:DO_NOT_USE.db'},input:'Y\r\n'});assert.notEqual(r.status,0);assert.deepEqual(calls(),[])
  writeFileSync(join(source,'.env'),'DATABASE_URL=DO_NOT_USE')
  r=exec('RUN-WINDOWS.cmd',{input:'Y\r\n'});assert.notEqual(r.status,0);assert.deepEqual(calls(),[])
  // Keep the .env sentinel; use a different fresh folder for the remaining checks.
  assert.equal(readFileSync(join(source,'.env'),'utf8'),'DATABASE_URL=DO_NOT_USE');safe()
 })
 await test('run requires explicit Y before launching',()=>{
  const second=join(dir,'second folder');mkdirSync(second,{recursive:true})
  for(const name of scripts)copyFileSync(name,join(second,name))
  mkdirSync(join(second,'prisma','migrations','0_init'),{recursive:true});mkdirSync(join(second,'node_modules','.bin'),{recursive:true})
  writeFileSync(join(second,'package.json'),'{}');writeFileSync(join(second,'package-lock.json'),'LOCKFILE SENTINEL')
  writeFileSync(join(second,'prisma','migrations','0_init','migration.sql'),'MIGRATION SENTINEL');writeFileSync(join(second,'node_modules','.bin','electron-vite.cmd'),'@exit /b 0\r\n')
  const launch=input=>spawnSync('cmd.exe',['/d','/c','RUN-WINDOWS.cmd'],{cwd:second,env:baseEnv,encoding:'utf8',input,timeout:20000})
  resetLog();let r=launch('N\r\n');assert.notEqual(r.status,0);assert.deepEqual(calls(),[])
  resetLog();r=launch('Y\r\n');assert.equal(r.status,0,r.stdout+r.stderr);assert.deepEqual(calls(),['run dev |'])
  assert.equal(readFileSync(join(second,'package-lock.json'),'utf8'),'LOCKFILE SENTINEL')
 })
}
