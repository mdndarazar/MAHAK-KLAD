// Package the experimental child as a standalone Node entry after electron-vite
// has built the main app. It remains disabled until the readiness gate is met.
// The child requires a separately provisioned Node runtime with node:sqlite;
// this bundle does not provide or locate such a runtime.
import { build } from 'esbuild'
import { resolve } from 'node:path'

await build({
  entryPoints: [resolve('src/main/services/cloud/experimentalHubChild.ts')],
  outfile: resolve('out/main/remote-hub-child.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info'
})
