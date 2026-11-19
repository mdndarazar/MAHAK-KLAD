import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { remoteSettingEnabled } from '../../src/main/services/cloud/remoteSettings.ts'

// Bundle the real service and readiness gate; dependencies are tripwires, not
// a running Electron installation or a real database. No shop data is touched.
test('default-disabled cloud sync neither schedules work nor starts network or database activity', async () => {
  const dir=mkdtempSync(join(tmpdir(),'mahak-disabled-cloud-'))
  const outfile=join(dir,'service.cjs')
  const plugin={name:'isolated-dependencies',setup(b){
    b.onResolve({filter:/^(electron|\.\.\/db\/client|\.\.\/ipc\/remoteAuth|\.\/RemoteGrantRegistry|\.\/panelSession)$/},args=>({path:args.path,namespace:'tripwire'}))
    b.onLoad({filter:/.*/,namespace:'tripwire'},()=>({contents:`
      const hit=()=>{throw new Error('disabled service touched dependency')};
      export const app={getPath:hit}; export const prisma=new Proxy({}, {get:hit});
      export const registerRemoteAuthHandlers=hit; export const initRemoteGrantRegistry=hit;
      export const notePanelUnlocked=hit, clearPanelScope=hit, clearPanelSessions=hit;
    `,loader:'js'}))
  }}
  try {
    await build({entryPoints:['src/main/services/CloudSyncService.ts'],outfile,bundle:true,platform:'node',format:'cjs',plugins:[plugin],logLevel:'silent'})
    const require=createRequire(import.meta.url), net=require('node:net'), http=require('node:http'), https=require('node:https'), dgram=require('node:dgram'), fs=require('node:fs')
    const original={listen:net.Server.prototype.listen,connect:net.Socket.prototype.connect,request:http.request,httpsRequest:https.request,createSocket:dgram.createSocket,write:fs.writeFileSync,timeout:globalThis.setTimeout,interval:globalThis.setInterval,fetch:globalThis.fetch}
    const hits=[]; const trap=name=>(..._args)=>{hits.push(name);throw new Error(`unexpected ${name}`)}
    try {
      net.Server.prototype.listen=trap('listen');net.Socket.prototype.connect=trap('connect')
      http.request=trap('http');https.request=trap('https');dgram.createSocket=trap('udp');fs.writeFileSync=trap('write')
      globalThis.setTimeout=trap('timeout');globalThis.setInterval=trap('interval');globalThis.fetch=trap('fetch')
      const service=require(outfile)
      assert.equal(remoteSettingEnabled(dir),false)
      service.startCloudSync();service.startCloudSync();service.stopCloudSync()
      await Promise.resolve()
      assert.deepEqual(hits,[])
    } finally {
      net.Server.prototype.listen=original.listen;net.Socket.prototype.connect=original.connect
      http.request=original.request;https.request=original.httpsRequest;dgram.createSocket=original.createSocket;fs.writeFileSync=original.write
      globalThis.setTimeout=original.timeout;globalThis.setInterval=original.interval;globalThis.fetch=original.fetch
    }
  } finally {rmSync(dir,{recursive:true,force:true})}
})
