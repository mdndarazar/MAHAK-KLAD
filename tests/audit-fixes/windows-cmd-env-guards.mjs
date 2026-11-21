import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Static protection checks; actual cmd.exe behavior is exercised separately on Windows.
await test('run script refuses all known local env files without deleting them',()=>{
 const script=readFileSync('RUN-WINDOWS.cmd','utf8')
 for(const file of ['.env','.env.local','.env.development','.env.development.local','prisma\\.env']) {
  assert.ok(script.includes(`if exist "${file}" goto :databaseconfig`),file)
 }
 assert.match(script,/if defined DATABASE_URL goto :databaseconfig/)
 assert.doesNotMatch(script,/^\s*(?:del|erase|rmdir|rd)\b/im)
})
