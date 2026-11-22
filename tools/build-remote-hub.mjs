// Package the experimental child as a standalone Node entry after electron-vite
// has built the main app. It remains disabled until the readiness gate is met.
// Windows packaging copies the build's trusted Node runtime and its license;
// this does not start the remote feature or prove Electron/DPAPI integration.
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** همان دستور `INSTALL-WINDOWS-CMD.md` (آزمون `plan1405-build-license-message.mjs` یکی بودن را می‌سنجد). */
const NODE_LICENSE_COMMAND = String.raw`node -e "const path=require('path'),fs=require('fs');const dest=path.join(path.dirname(process.execPath),'LICENSE');fetch('https://api.github.com/repos/nodejs/node/contents/LICENSE?ref='+process.version,{headers:{'Accept':'application/vnd.github.raw','User-Agent':'mahak-pos-build'}}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text()}).then(t=>{if(!t.startsWith('Node.js is licensed for use as follows:'))throw new Error('unexpected content');fs.writeFileSync(dest,t);console.log('OK: '+dest)}).catch(e=>{console.error('FAILED: '+e.message);process.exit(1)})"`

await build({
  entryPoints: [resolve('src/main/services/cloud/experimentalHubChild.ts')],
  outfile: resolve('out/main/remote-hub-child.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info'
})

if (process.platform === 'win32') {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (process.arch !== 'x64' || major < 22 || (major === 22 && minor < 13)) throw new Error('Windows x64 Node 22.13+ is required to package the hub')
  const probe = spawnSync(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.close()"], {encoding:'utf8', timeout:10000, windowsHide:true})
  if (probe.error || probe.status !== 0) throw new Error('Packaging Node cannot load node:sqlite')
  const license = join(dirname(process.execPath), 'LICENSE')
  if (!existsSync(license)) {
    // طرح ۱۴۰۵ · کار کوچک ۴ (تأیید مالک): پیام فارسی روشن با همان دستور راهنمای نصب؛ ساخت چیزی دریافت نمی‌کند.
    console.error([
      '',
      'ERROR: Packaging Node license is missing: ' + license,
      'خطا: فایل LICENSE کنار node.exe نیست؛ نصب‌کنندهٔ رسمی Node این فایل را نمی‌گذارد.',
      'راه حل: دستور زیر را در همین cmd مدیر بزنید. باید OK: چاپ کند. بعد BUILD-WINDOWS.cmd را دوباره بزنید.',
      'اگر FAILED چاپ کرد، با فیلترشکن دوباره امتحان کنید. همین دستور در INSTALL-WINDOWS-CMD.md هم هست.',
      'Fix: run this command in this Administrator CMD (it must print OK:), then run BUILD-WINDOWS.cmd again:',
      '',
      NODE_LICENSE_COMMAND,
      ''
    ].join('\n'))
    process.exit(1)
  }
  const runtimeDir = resolve('build/remote-runtime')
  mkdirSync(runtimeDir, {recursive:true})
  copyFileSync(process.execPath, join(runtimeDir, 'node.exe'))
  copyFileSync(license, join(runtimeDir, 'LICENSE'))
}
