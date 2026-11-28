import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Only the isolated bundle overrides readiness and Electron; product readiness
// stays false. The clock is restored and no customer database is opened.
test('renderer keepalive IPC cannot extend an idle remote grant',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-remote-idle-')),outfile=join(dir,'entry.cjs'),handlers=new Map()
 const plugin={name:'isolated-ipc',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}))
  b.onResolve({filter:/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='electron' ? `export const ipcMain=globalThis.__remoteIdle.ipcMain;export const BrowserWindow=globalThis.__remoteIdle.BrowserWindow;` : `export const remoteImplementationReady=()=>true;export const REMOTE_GT_PREFIX='gt-';export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};`}))
 }}
 globalThis.__remoteIdle={ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn)},BrowserWindow:{fromWebContents:()=>({isDestroyed:()=>false})}}
 let now=1000,api
 const original=Object.getOwnPropertyDescriptor(performance,'now')
 try {
  await build({stdin:{contents:"export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts';export * from './src/main/services/RemoteGrantRegistry.ts'",resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'cjs',plugins:[plugin],logLevel:'silent'})
  Object.defineProperty(performance,'now',{value:()=>now,configurable:true})
  api=createRequire(import.meta.url)(outfile)
  api.initRemoteGrantRegistry({notePanelUnlocked:()=>()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{}});api.registerRemoteAuthHandlers()
  const sender=Object.assign(new EventEmitter(),{id:42,isDestroyed:()=>false}),event={sender}
  const p=(await handlers.get('remoteAuth:request')(event,{panel:'shifts'})).data
  assert.ok(api.createGrant({panel:'shifts',ownerWindowId:42,tier:'NORMAL',mode:'PANEL',memberId:'member',requestId:p.requestId,ttlMs:600000}))
  assert.equal(api.consumeOneShot(42,'shifts',p.gt.slice(3)),true)
  now+=120000
  assert.equal((await handlers.get('remoteAuth:used')(event,{panel:'shifts'})).ok,false)
  assert.equal((await handlers.get('remoteAuth:status')(event,{panel:'shifts',requestId:p.requestId})).data.state,'CLAIMED')
  now+=60001
  assert.equal(api.isGrantActiveForWindow('shifts',42),false,'unused grant expires even if renderer sends keepalive/status')
 } finally {
  if(api)api.revokeAll()
  if(original)Object.defineProperty(performance,'now',original);else delete performance.now
  delete globalThis.__remoteIdle;rmSync(dir,{recursive:true,force:true})
 }
})
