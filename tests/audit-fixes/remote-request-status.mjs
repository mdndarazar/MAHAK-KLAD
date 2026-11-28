import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { requestCode, getRequestStatus, createGrant, consumeOneShot, initRemoteGrantRegistry, revokeAll, revokeBy, cancelForWindow } from '../../src/main/services/RemoteGrantRegistry.ts'

// Experimental in-process registry; no Electron IPC, real phone or HTTPS involved.
initRemoteGrantRegistry({ notePanelUnlocked: () => {}, clearPanelScope: () => {}, clearPanelSessions: () => assert.fail('unrelated sessions must not be cleared') })
const panel = 'sales-return', owner = 91
const status = p => getRequestStatus(owner, panel, p.requestId)
const approve = (p, overrides = {}) => createGrant({ panel, ownerWindowId: owner, tier: 'NORMAL', mode: 'PANEL', memberId: 'member', requestId: p.requestId, ttlMs: 1000, ...overrides })

try {
  await test('status is bound to the request, panel and sending window, and does not claim the grant', () => {
    revokeAll()
    const p = requestCode(panel, owner)
    assert.equal(status(p), 'PENDING')
    assert.equal(getRequestStatus(owner + 1, panel, p.requestId), 'UNAVAILABLE')
    assert.equal(getRequestStatus(owner, 'settings', p.requestId), 'UNAVAILABLE')
    assert.equal(getRequestStatus(owner, panel, 'unknown'), 'UNAVAILABLE')
    assert.equal(getRequestStatus(0, panel, p.requestId), 'UNAVAILABLE')
    assert.ok(approve(p))
    assert.equal(status(p), 'APPROVED')
    assert.equal(status(p), 'APPROVED')
    assert.equal(consumeOneShot(owner, panel, p.gt.slice(3)), true)
    assert.equal(status(p), 'CLAIMED')
    revokeBy('member')
    assert.equal(status(p), 'UNAVAILABLE')
  })
  await test('replacement, cancellation and expiry do not report approval for a different request', async () => {
    revokeAll()
    const old = requestCode(panel, owner)
    const fresh = requestCode(panel, owner)
    assert.equal(status(old), 'UNAVAILABLE')
    assert.equal(status(fresh), 'PENDING')
    assert.ok(approve(fresh, { ttlMs: 30 }))
    assert.equal(status(fresh), 'APPROVED')
    assert.equal(consumeOneShot(owner, panel, fresh.gt.slice(3)), true)
    await delay(60)
    assert.equal(status(fresh), 'UNAVAILABLE')
    const next = requestCode(panel, owner)
    cancelForWindow(owner, panel)
    assert.equal(status(next), 'UNAVAILABLE')
  })
  await test('one-shot status cannot be mistaken for a reusable claimed session', () => {
    revokeAll()
    const p = requestCode(panel, owner)
    assert.ok(approve(p, { tier: 'SENSITIVE_MONEY' }))
    assert.equal(status(p), 'APPROVED')
    assert.equal(consumeOneShot(owner, panel, p.gt.slice(3)), true)
    assert.equal(status(p), 'UNAVAILABLE')
  })
  await test('UI uses unwrapped IPC data and does not promise automatic opening (structural only)', () => {
    const ui = readFileSync(new URL('../../src/renderer/src/components/RemoteRequestBox.tsx', import.meta.url), 'utf8')
    const ipc = readFileSync(new URL('../../src/main/ipc/remoteAuth.ts', import.meta.url), 'utf8')
    assert.match(ui, /call<RemoteAuthRequestResult>/)
    assert.match(ui, /requestId: request\.requestId/)
    assert.match(ui, /state === 'APPROVED'/)
    assert.doesNotMatch(ui, /خودکار باز می‌شود/)
    assert.match(ipc, /getRequestStatus\(owner, panel, requestId\)/)
  })
} finally { revokeAll() }
