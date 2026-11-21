import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reserveDesktopBackupCoordination,desktopBackupCoordinationActive,withDesktopBackupCoordination } from '../../src/main/services/cloud/desktopBackupCoordination.ts'

test('backup coordination prevents startup overlap and supports same-operation nested merge',async()=>{
 let release,entered;const wait=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r})
 const a=withDesktopBackupCoordination(async()=>{entered();await wait;return 42});await started
 const b=withDesktopBackupCoordination(async()=>17);assert.equal(await b,17,'local-only concurrent calls retain legacy behavior')
 assert.throws(()=>reserveDesktopBackupCoordination(),/unavailable/);release();assert.equal(await a,42)
 const lease=reserveDesktopBackupCoordination();assert.equal(desktopBackupCoordinationActive(),true)
 await assert.rejects(withDesktopBackupCoordination(async()=>1),/unavailable/,'starting supervisor does not allow backup')
 let invoked=0;lease.install(async operation=>{invoked++;await operation()})
 assert.equal(await withDesktopBackupCoordination(async()=>withDesktopBackupCoordination(async()=>99)),99);assert.equal(invoked,1)
 let unlock,notify;const gate=new Promise(r=>{unlock=r}),ready=new Promise(r=>{notify=r})
 const first=withDesktopBackupCoordination(async()=>{notify();await gate;return 'done'});await ready
 await assert.rejects(withDesktopBackupCoordination(async()=>1),/unavailable/)
 assert.throws(()=>lease.release(),/unavailable/);unlock();assert.equal(await first,'done');lease.release();assert.equal(desktopBackupCoordinationActive(),false)
})
