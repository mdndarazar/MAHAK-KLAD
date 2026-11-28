import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Test credentials and database exist only in a newly created temporary folder.
const dir = mkdtempSync(join(tmpdir(), 'mahak-gt-password-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { authService, assertPanelPasswordStrict } = await import('../../src/main/services/AuthService.ts')
const { createGrant, revokeAll } = await import('../../src/main/services/RemoteGrantRegistry.ts')
const { runWithPanelSessionOwner } = await import('../../src/main/services/panelSession.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const panel = PANEL_KEYS.settings
const owner = 337
const run = (fn) => runWithPanelSessionOwner(owner, fn)
seed.setting(SETTING_KEYS.securityConfig, { lockoutEnabled: true, maxAttempts: 10, lockMinutes: 10 })
seed.setting('shift.config', { byTime: true, templates: [{ name: 'آزمایش', startTime: '00:00', endTime: '00:00' }] })
await authService.setPanelPassword({panel, managerPassword:DEFAULT_MANAGER_PASSWORD, password:'gt-second-test'})
await authService.setPanelShiftPassword({panel, shift:1, managerPassword:DEFAULT_MANAGER_PASSWORD, password:'gt-third-test'})
await authService.changePassword({current:DEFAULT_MANAGER_PASSWORD, next:'gt-manager-test'})

await test('manager password beginning gt- retains MANAGER scope', async () => {
  assert.equal((await run(()=>authService.verifyPanel({panel,password:'gt-manager-test'}))).scope,'MANAGER')
  assert.equal(await run(()=>assertPanelPasswordStrict(panel,'gt-manager-test','test')),'MANAGER')
})
await test('second and third passwords beginning gt- retain PANEL scope', async () => {
  for (const password of ['gt-second-test','gt-third-test']) {
    assert.equal((await run(()=>authService.verifyPanel({panel,password}))).scope,'PANEL')
    assert.equal(await run(()=>assertPanelPasswordStrict(panel,password,'test')),'PANEL')
  }
})
await test('invalid gt- value cannot authorize even if a fake grant exists', async () => {
  createGrant({panel,ownerWindowId:owner,tier:'NORMAL',mode:'PANEL',memberId:'fake',requestId:'fake',ttlMs:60000})
  try {
    await assert.rejects(run(()=>authService.verifyPanel({panel,password:'gt-fake'})))
    await assert.rejects(run(()=>assertPanelPasswordStrict(panel,'gt-fake','test')))
    assert.equal((await run(()=>authService.verifyPanel({panel,password:'gt-manager-test'}))).scope,'MANAGER')
  } finally { revokeAll() }
})
await test('existing normal password rejection and manager authentication remain active', async () => {
  await assert.rejects(run(()=>authService.verifyPanel({panel,password:'wrong-password'})))
  assert.equal((await authService.verify({password:'gt-manager-test'})).ok,true)
})
