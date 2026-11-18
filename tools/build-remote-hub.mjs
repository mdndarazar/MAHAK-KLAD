// Package the experimental child as a standalone Node entry after electron-vite
// has built the main app. It remains disabled until the readiness gate is met.
// Windows packaging copies the build's trusted Node runtime and its license;
// this does not start the remote feature or prove Electron/DPAPI integration.
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

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
  if (!existsSync(license)) throw new Error('Packaging Node license is missing')
  const runtimeDir = resolve('build/remote-runtime')
  mkdirSync(runtimeDir, {recursive:true})
  copyFileSync(process.execPath, join(runtimeDir, 'node.exe'))
  copyFileSync(license, join(runtimeDir, 'LICENSE'))
}
