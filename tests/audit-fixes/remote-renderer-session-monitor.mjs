import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real renderer monitor bundled with simulated IPC, timer and readiness; this
// does not exercise a browser, React mounting, Electron or a real phone.
test('renderer monitoring is default-off, only reads status and fails closed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mahak-renderer-monitor-')),outfile=join(dir,'monitor.cjs')
 const plugin={name:'fake-monitor-dependencies',setup(b){
  b.onResolve({filter:/^@shared\/remoteAuthChannels$/},()=>({path:'channels',namespace:'fake'}))
  b.onResolve({filter:/^\.\.\/lib\/api$/},()=>({path:'api',namespace:'fake'}))
  b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:args.path==='channels' ? `export const remoteImplementationReady=()=>globalThis.__monitor.ready;export const REMOTE_AUTH_CHANNELS={};` : `export const CH={managerSessionStatus:'manager:session:status'};export const call=(...a)=>globalThis.__monitor.call(...a);`}))
 }}
 const original={setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval}
 let callback,cleared=0,calls=[],resolve,respond
 globalThis.__monitor={ready:false,call:async channel=>{calls.push(channel);return await respond()}}
 globalThis.setInterval=fn=>{callback=fn;return 1};globalThis.clearInterval=()=>{cleared++}
 const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
 try {
  await build({entryPoints:['src/renderer/src/components/RemoteRequestBox.tsx'],outfile,bundle:true,platform:'node',format:'cjs',plugins:[plugin],logLevel:'silent'})
  const {startRemoteSessionMonitor}=createRequire(import.meta.url)(outfile)
  let values=[],errors=0
  startRemoteSessionMonitor(true,x=>values.push(x),()=>errors++)();assert.equal(callback,undefined)
  globalThis.__monitor.ready=true
  const stop=startRemoteSessionMonitor(true,x=>values.push(x),()=>errors++)
  respond=async()=>({manager:false,panels:['shifts']});callback();await flush();assert.deepEqual(values,[['shifts']]);assert.deepEqual(calls,['manager:session:status'])
  respond=async()=>({manager:false,panels:[]});callback();await flush();assert.deepEqual(values.at(-1),[])
  respond=async()=>({manager:false,panels:[7]});callback();await flush();assert.equal(errors,1)
  respond=()=>new Promise(r=>{resolve=r});callback();await flush();stop();resolve({manager:false,panels:['settings']});await flush();assert.deepEqual(values.at(-1),[]);assert.equal(cleared,1)
 } finally {globalThis.setInterval=original.setInterval;globalThis.clearInterval=original.clearInterval;delete globalThis.__monitor;rmSync(dir,{recursive:true,force:true})}
})
