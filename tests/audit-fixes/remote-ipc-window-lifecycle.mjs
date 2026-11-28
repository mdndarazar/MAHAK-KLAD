import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Production readiness remains false. The readiness override below is confined
// to this isolated bundle so the real IPC handlers can be exercised; no live
// Electron, device, customer database or production setting is used.
test('remote IPC accepts live windows only and destroys only that window’s grants',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-remote-window-')),outfile=join(dir,'entry.cjs'),handlers=new Map()
 const plugin={name:'isolated-ipc',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fake'}))
  b.onResolve({filter:/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='electron' ? `export const ipcMain=globalThis.__remoteIpcTest.ipcMain; export const BrowserWindow=globalThis.__remoteIpcTest.BrowserWindow;` : `export const remoteImplementationReady=()=>true; export const REMOTE_GT_PREFIX='gt-'; export const REMOTE_AUTH_CHANNELS={request:'remoteAuth:request',status:'remoteAuth:status',cancel:'remoteAuth:cancel',used:'remoteAuth:used',banner:'remoteAuth:banner'};`}))
 }}
 globalThis.__remoteIpcTest={ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn)},BrowserWindow:{fromWebContents:sender=>sender.valid?{isDestroyed:()=>sender.windowDestroyed}:null}}
 try {
  await build({stdin:{contents:"export {registerRemoteAuthHandlers} from './src/main/ipc/remoteAuth.ts'; export * from './src/main/services/RemoteGrantRegistry.ts'",resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'cjs',plugins:[plugin],logLevel:'silent'})
  const api=createRequire(import.meta.url)(outfile)
  api.initRemoteGrantRegistry({notePanelUnlocked:()=>()=>{},clearPanelScope:()=>{},clearPanelSessions:()=>{throw new Error('local sessions must not be cleared')}})
  api.registerRemoteAuthHandlers()
  const sender=id=>Object.assign(new EventEmitter(),{id,valid:true,windowDestroyed:false,isDestroyed(){return false}})
  const one=sender(1),two=sender(2),invalid=sender(3);invalid.valid=false
  await assert.rejects(handlers.get('remoteAuth:request')({sender:invalid},{panel:'shifts'}),/owner/)
  const request=handlers.get('remoteAuth:request'), status=handlers.get('remoteAuth:status')
  const p=(await request({sender:one},{panel:'shifts'})).data, q=(await request({sender:two},{panel:'shifts'})).data
  assert.equal(one.listenerCount('destroyed'),1)
  assert.ok(api.createGrant({panel:'shifts',ownerWindowId:1,tier:'NORMAL',mode:'PANEL',memberId:'member',requestId:p.requestId,ttlMs:60000}))
  assert.equal(api.consumeOneShot(1,'shifts',p.gt.slice(3)),true)
  assert.ok(api.createGrant({panel:'shifts',ownerWindowId:2,tier:'NORMAL',mode:'PANEL',memberId:'member',requestId:q.requestId,ttlMs:60000}))
  assert.equal(api.consumeOneShot(2,'shifts',q.gt.slice(3)),true)
  await status({sender:one},{panel:'shifts',requestId:p.requestId});assert.equal(one.listenerCount('destroyed'),1)
  one.emit('destroyed')
  assert.equal(api.isGrantActiveForWindow('shifts',1),false)
  assert.equal(api.isGrantActiveForWindow('shifts',2),true)
  two.emit('destroyed');assert.equal(api.isGrantActiveForWindow('shifts',2),false)
  api.revokeAll()
 } finally {delete globalThis.__remoteIpcTest;rmSync(dir,{recursive:true,force:true})}
})

test('window cancellation keeps closing other scopes after a cleanup failure',async()=>{
 const api=await import('../../src/main/services/RemoteGrantRegistry.ts')
 let failing=true,closed=0
 api.initRemoteGrantRegistry({notePanelUnlocked:panel=>()=>{if(panel==='shifts' && failing)throw new Error('injected');closed++},clearPanelScope:()=>{},clearPanelSessions:()=>{throw new Error('local sessions must not be cleared')}})
 try {
  for(const panel of ['shifts','settings']){
   const p=api.requestCode(panel,41)
   assert.ok(api.createGrant({panel,ownerWindowId:41,tier:'NORMAL',mode:'PANEL',memberId:'member',requestId:p.requestId,ttlMs:60000}))
   assert.equal(api.consumeOneShot(41,panel,p.gt.slice(3)),true)
  }
  assert.throws(()=>api.cancelForWindow(41),/cleanup failed/)
  assert.equal(api.isGrantActiveForWindow('shifts',41),false)
  assert.equal(api.isGrantActiveForWindow('settings',41),false)
  assert.equal(closed,1)
  failing=false;assert.equal(api.cancelForWindow(41),true);assert.equal(closed,2)
 } finally {failing=false;api.revokeAll()}
})
