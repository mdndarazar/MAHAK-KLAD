import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_PANELS } from '../../src/shared/enums.ts'
import { LOCKED_PANELS } from '../../src/shared/panels.ts'

// The desktop offers a phone approval only for panels the hub can approve: one
// shared list drives the host's approval policy, the request IPC and the
// lock-screen button. Real IPC handlers and registry in an isolated bundle
// (simulated Electron window); the renderer check is structural only.
test('the phone-unlockable panels are real locked panels with titles', () => {
  assert.deepEqual([...REMOTE_PANELS].slice(0, 44), LOCKED_PANELS.filter(item => item.kind === 'part').map(item => item.key)); assert.equal(REMOTE_PANELS.length, 92)
  return import('../../src/shared/gateCatalog.ts').then(({ GATE_CATALOG }) => { for (const key of REMOTE_PANELS) {
    const panel = LOCKED_PANELS.find(item => item.key === key) ?? LOCKED_PANELS.find(item => GATE_CATALOG[key]?.category === 3 && item.key === GATE_CATALOG[key].lockKey)
    assert.ok(panel && typeof panel.title === 'string' && panel.title.length > 0, key)
  } })
})

test('the request IPC refuses a panel without an approval policy; the host passes the shared list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-remote-panels-')), outfile = join(dir, 'entry.cjs'), handlers = new Map()
  const plugin = { name: 'isolated-ipc', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake' }))
    b.onResolve({ filter: /remoteAuthChannels$/ }, () => ({ path: 'channels', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ loader: 'js', contents: args.path === 'electron'
      ? 'export const ipcMain=globalThis.__remotePanels.ipcMain; export const BrowserWindow=globalThis.__remotePanels.BrowserWindow;'
      : "export const remoteImplementationReady=()=>true; export const REMOTE_GT_PREFIX='gt-'; export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',claim:'remoteAuth:claim',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner',recover:'remoteAuth:recover'};" }))
  } }
  globalThis.__remotePanels = { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) } }
  try {
    await build({ stdin: { contents: "export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [plugin], logLevel: 'silent' })
    const api = createRequire(import.meta.url)(outfile)
    api.initRemoteGrantRegistry({ notePanelUnlocked: () => () => {}, clearPanelScope: () => {}, clearPanelSessions: () => {} })
    api.registerRemoteAuthHandlers(undefined, REMOTE_PANELS)
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
    const request = handlers.get('remoteAuth:request')
    for (const panel of ['not-a-panel', 'custody', 'act-refund-full', 'constructor', 'products ']) {
      const result = await request({ sender }, { panel })
      if (panel === 'products ') { assert.equal(result.ok, true, 'surrounding spaces are trimmed as before'); continue }
      assert.deepEqual(result, { ok: false, error: 'این پنل با تأیید گوشی باز نمی‌شود.' }, panel)
      assert.equal(api.getPending(7, panel), null, panel)
    }
    for (const panel of REMOTE_PANELS) {
      const result = await request({ sender }, { panel })
      assert.equal(result.ok, true, panel); assert.match(result.data.code, /^[0-9]{6}$/); assert.equal(api.getPending(7, panel)?.requestId, result.data.requestId)
    }
    api.revokeAll()
  } finally { delete globalThis.__remotePanels; rmSync(dir, { recursive: true, force: true }) }
  const host = readFileSync(new URL('../../src/main/services/CloudSyncService.ts', import.meta.url), 'utf8')
  assert.match(host, /import \{ REMOTE_PANELS \} from '\.\.\/\.\.\/shared\/enums'/)
  assert.match(host, /const PANELS = REMOTE_PANELS\r?\n/)
  assert.match(host, /const POLICIES = Object\.fromEntries\(PANELS\.map\(/)
  assert.match(host, /registerRemoteAuthHandlers\(async\(password,pin\)=>hub \? hub\.recoverPanic\(password,pin\) : false,PANELS\)/)
})

test('the lock screen shows the request button only on those panels (structural)', () => {
  const ui = readFileSync(new URL('../../src/renderer/src/components/RemoteRequestBox.tsx', import.meta.url), 'utf8')
  assert.match(ui, /import \{ REMOTE_PANELS \} from '@shared\/enums'/)
  assert.match(ui, /const remotePanel = \(REMOTE_PANELS as readonly string\[\]\)\.includes\(panel\)/)
  assert.match(ui, /\{!current \? \(remotePanel &&\s*<button className="btn btn-ghost w-full" disabled=\{busy\} onClick=\{\(\) => void create\(\)\}>/)
  // Panic recovery stays available on every locked panel while the hub runs.
  assert.match(ui, /if \(!hostRunning && !current\) return null/)
  assert.ok(ui.indexOf('بازیابی توقف اضطراری راه دور') < ui.indexOf('{!current ? (remotePanel &&'))
})
