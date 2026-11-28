/** Experimental desktop half of the approval transport. Not production-ready. */
import { timingSafeEqual } from 'node:crypto'
import { approvalEnvelopeMac } from './experimentalApprovalEnvelope'
import { listActiveGrants, listPendingRequests } from '../RemoteGrantRegistry'
import { createGrantApprovalCoordinator } from './grantApprovalCoordinator'
import type { GrantReplayStore } from './signedCommandVerifier'

type Policy = {tier:'NORMAL';mode:'PANEL';ttlMs:number}|{tier:'SENSITIVE_MONEY';mode:'ONE_SHOT';ttlMs:number}
export function createExperimentalApprovalBridge(options:{key:Uint8Array;storeId:string;epoch:string;policies:Readonly<Record<string,Policy>>;replayStore:GrantReplayStore;appliedRevocation:()=>number;isClosed:()=>boolean;send:(message:Record<string,unknown>)=>void;onReplayFailure:()=>void}) {
  const {key,storeId,epoch}=options
  if (!(key instanceof Uint8Array) || key.byteLength!==32 || !options.replayStore || typeof options.replayStore.consume!=='function' || typeof options.onReplayFailure!=='function') throw new Error('Invalid approval bridge')
  const policies=Object.fromEntries(Object.entries(options.policies).map(([panel,p])=>[panel,{...p}]))
  let lastId=0,seq=0
  const replayStore:GrantReplayStore={consume(requestId,nonce,expiresAt,now){
    try {
      const outcome=options.replayStore.consume(requestId,nonce,expiresAt,now)
      if (outcome==='OK' || outcome==='REPLAY') return outcome
      options.onReplayFailure();return outcome==='CAPACITY' ? 'CAPACITY' : 'INVALID'
    } catch {try {options.onReplayFailure()} catch {};return 'INVALID'}
  }}
  const coordinator=createGrantApprovalCoordinator({key,storeId,policies,replayStore,isPaused:options.isClosed,mayApprove:()=>true})
  return {
    onMessage(message:Record<string,any>):boolean {
      if (message.type!=='approvalCommand') return false
      const id=message.id, fence=message.fence, command=message.command, mac=message.mac
      let ok=false
      try {
        if (Object.keys(message).sort().join(',')!=='command,fence,id,mac,type' || !Number.isSafeInteger(id) || id<=lastId ||
            !Number.isSafeInteger(fence) || fence<0 || typeof mac!=='string' || !/^[a-f0-9]{64}$/.test(mac) ||
            !command || typeof command.signature!=='string' || !/^[a-f0-9]{64}$/.test(command.signature)) throw new Error('Invalid command')
        lastId=id
        const expected=approvalEnvelopeMac(key,storeId,epoch,id,fence,command.signature)
        if (timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(expected,'hex')) && !options.isClosed() && fence===options.appliedRevocation()) ok=coordinator.approve(command).ok
      } catch { ok=false }
      try { options.send({type:'approvalResult',id,ok}) } catch {}
      return true
    },
    tick():void {
      if (options.isClosed()) return
      const items=listPendingRequests().filter(p=>Object.hasOwn(policies,p.panel)).slice(0,200)
      options.send({type:'pendingRequests',seq:++seq,items})
      // Owner's live view of open grants: panel, claim state and time left only.
      const grants=listActiveGrants().filter(g=>Object.hasOwn(policies,g.panel)).slice(0,200)
        .map(g=>({panel:g.panel,claimed:g.claimed,remainingMs:Math.min(g.remainingMs,86_400_000)}))
      options.send({type:'openGrants',seq,items:grants})
    },
    clearMirror():void {
      if (options.isClosed()) return
      // An empty replacement clears stale requests without disclosing data.
      // Open grants are deliberately not replaced: an empty list would claim
      // that nothing is open. The child's copy ages out and reports unavailable.
      options.send({type:'pendingRequests',seq:++seq,items:[]})
    }
  }
}
