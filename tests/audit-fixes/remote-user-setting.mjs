import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { remoteSettingEnabled } from '../../src/main/services/cloud/remoteSettings.ts'

test('user setting defaults off and only accepts the exact explicit opt-in',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mahak-remote-setting-')),path=join(dir,'remote-settings.json')
  try {
    assert.equal(remoteSettingEnabled(dir),false)
    for (const value of ['null','{}','{"enabled":false}','{"enabled":"true"}','{"enabled":true,"extra":1}','{',' '.repeat(1025)]) {
      writeFileSync(path,value);assert.equal(remoteSettingEnabled(dir),false,value.slice(0,60))
    }
    writeFileSync(path,'{"enabled":true}');assert.equal(remoteSettingEnabled(dir),true)
    unlinkSync(path);writeFileSync(join(dir,'target'),'{"enabled":true}')
    if (process.platform!=='win32') {symlinkSync(join(dir,'target'),path);assert.equal(remoteSettingEnabled(dir),false)}
  } finally {rmSync(dir,{recursive:true,force:true})}
})
