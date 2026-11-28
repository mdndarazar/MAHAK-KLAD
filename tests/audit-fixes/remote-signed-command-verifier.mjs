import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createSignedGrantVerifier } from '../../src/main/services/cloud/signedCommandVerifier.ts'

// Isolated verification only: no database, IPC, live grant, or network.
const KEY = Buffer.alloc(32, 0x41)
const NOW = 1_800_000_000_000
const NONCE = 'abcdefghijklmnopqrstuvwx'
function base(overrides = {}) {
  return {
    version: 1, storeId: 'store-1', requestId: 'request-1', nonce: NONCE,
    panel: 'salesReturn', ownerWindowId: 7, memberId: 'manager-1', tier: 'NORMAL',
    issuedAt: NOW, expiresAt: NOW + 30_000, ...overrides
  }
}
function sign(unsigned, key = KEY) {
  const { version, storeId, requestId, nonce, panel, ownerWindowId, memberId, tier, issuedAt, expiresAt } = unsigned
  const bytes = JSON.stringify([version, storeId, requestId, nonce, panel, ownerWindowId, memberId, tier, issuedAt, expiresAt])
  return { ...unsigned, signature: createHmac('sha256', key).update(bytes, 'utf8').digest('hex') }
}
function setup(extra = {}) {
  let clock = NOW
  const options = { key: KEY, storeId: 'store-1', allowedPanels: ['salesReturn', 'credit'], now: () => clock, ...extra }
  return { verify: createSignedGrantVerifier(options), setTime: (n) => { clock = n } }
}
const invalid = (verify, command) => assert.deepEqual(verify(command), { ok: false, reason: 'INVALID' })
const expired = (verify, command) => assert.deepEqual(verify(command), { ok: false, reason: 'EXPIRED' })

test('valid command is accepted, then exact replay is rejected', () => {
  const { verify } = setup(); const c = sign(base()); assert.equal(verify(c).ok, true)
  assert.deepEqual(verify(c), { ok: false, reason: 'REPLAY' })
})
test('signature binds every grant field, including member, panel, owner and expiry', () => {
  const signed = sign(base())
  for (const [field, value] of Object.entries({storeId:'store-2',requestId:'other',nonce:'zyxwvutsrqponmlkjihgfedc',panel:'credit',ownerWindowId:8,memberId:'other',tier:'SENSITIVE_MONEY',issuedAt:NOW-1,expiresAt:NOW+29_999})) {
    invalid(setup().verify, { ...signed, [field]: value })
  }
})
test('unknown store, unknown panel, wrong key and missing fields fail closed', () => {
  invalid(setup().verify, sign(base({storeId:'store-2'})))
  invalid(setup().verify, sign(base({panel:'unknownPanel'})))
  invalid(setup().verify, sign(base(), Buffer.alloc(32, 0x42)))
  const incomplete = sign(base()); delete incomplete.memberId; invalid(setup().verify, incomplete)
})
test('reject malformed payload, surplus fields and forged signature formats', () => {
  const { verify } = setup(); for (const value of [null, [], 'x', 1, {}, {...sign(base()), extra:true}, {...sign(base()),signature:'00'}, {...sign(base()),signature:'F'.repeat(64)}, {...sign(base()),signature:'z'.repeat(64)}]) invalid(verify,value)
})
test('reject bad identifiers, owner, tier, nonce and unsafe timestamps', () => {
  for (const patch of [{storeId:''},{requestId:'a/b'},{nonce:'short'},{panel:'bad panel'},{ownerWindowId:0},{ownerWindowId:1.5},{ownerWindowId:Number.MAX_SAFE_INTEGER+1},{memberId:''},{tier:'ADMIN'},{issuedAt:NaN},{expiresAt:Number.MAX_SAFE_INTEGER+1},{version:2}]) invalid(setup().verify, sign(base(patch)))
})
test('expiry boundary, excessive lifetime and future timestamp are rejected', () => {
  for (const patch of [{expiresAt:NOW},{issuedAt:NOW-60_001,expiresAt:NOW+1},{issuedAt:NOW+15_001,expiresAt:NOW+20_000},{issuedAt:0},{expiresAt:NOW-1}]) expired(setup().verify,sign(base(patch)))
  assert.equal(setup().verify(sign(base({issuedAt:NOW+15_000,expiresAt:NOW+30_000}))).ok,true)
  assert.equal(setup().verify(sign(base({issuedAt:NOW,expiresAt:NOW+60_000}))).ok,true)
})
test('reused nonce or request ID is blocked even with a different signed command', () => {
  const { verify } = setup(); assert.equal(verify(sign(base())).ok,true)
  assert.deepEqual(verify(sign(base({requestId:'different'}))),{ok:false,reason:'REPLAY'})
  assert.deepEqual(verify(sign(base({nonce:'differentabcdefghijklmnop'}))),{ok:false,reason:'REPLAY'})
})
test('bad signature cannot consume a valid request or nonce', () => {
  const { verify } = setup(); const c=sign(base()); invalid(verify,{...c,signature:'0'.repeat(64)})
  assert.equal(verify(c).ok,true)
})
test('replay cache fills fail-closed rather than evicting active entries', () => {
  const { verify, setTime } = setup({maxEntries:1});const first=sign(base());assert.equal(verify(first).ok,true)
  const next=sign(base({requestId:'req2',nonce:'differentabcdefghijklmnop'}))
  assert.deepEqual(verify(next),{ok:false,reason:'CAPACITY'})
  assert.deepEqual(verify(first),{ok:false,reason:'REPLAY'})
  setTime(NOW+30_001)
  const later=sign(base({requestId:'req2',nonce:'differentabcdefghijklmnop',issuedAt:NOW+30_001,expiresAt:NOW+40_000}))
  assert.equal(verify(later).ok,true)
})
test('clock rollback does not revive expired signed command within a verifier', () => {
  const { verify, setTime } = setup(); const c=sign(base());setTime(NOW+30_001);expired(verify,c)
  setTime(NOW);expired(verify,c)
})
test('key and panel configuration are copied, not mutable from outside', () => {
  const key=Buffer.alloc(32,0x41),panels=['salesReturn']; const options={key,storeId:'store-1',allowedPanels:panels,now:()=>NOW}
  const verify=createSignedGrantVerifier(options);key.fill(0);panels.push('other');options.storeId='store-2'
  assert.equal(verify(sign(base())).ok,true)
  invalid(verify,sign(base({requestId:'different',nonce:'differentabcdefghijklmnop',panel:'other'})))
})
test('invalid configuration cannot start verifier', () => {
  for(const options of [{key:Buffer.alloc(31),storeId:'store-1',allowedPanels:[]},{key:KEY,storeId:'bad id',allowedPanels:[]},{key:KEY,storeId:'store-1',allowedPanels:[],maxEntries:0}]) assert.throws(()=>createSignedGrantVerifier(options))
})
test('returned command is a snapshot, not the caller object', () => {
  const { verify }=setup();const c=sign(base()),r=verify(c);assert.equal(r.ok,true);c.panel='credit';assert.equal(r.command.panel,'salesReturn')
})
