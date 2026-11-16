import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Separate isolated database and Electron/Prisma harness. This is not the real
// desktop integration: readiness remains false and no IPC/UI is enabled.
const dir = mkdtempSync(join(tmpdir(), 'mahak-isolated-panel-grants-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')
const registry = await import('../../src/main/services/RemoteGrantRegistry.ts')
const session = await import('../../src/main/services/panelSession.ts')
const { remoteImplementationReady } = await import('../../src/shared/remoteAuthChannels.ts')
const panel = 'settings', owner = 301, other = 302
const grant = (windowId, ttlMs = 1000, tier = 'NORMAL') => {
  const request = registry.requestCode(panel, windowId)
  const created = registry.createGrant({ panel, ownerWindowId: windowId, tier, mode: tier === 'NORMAL' ? 'PANEL' : 'ONE_SHOT', memberId: 'member', requestId: request.requestId, ttlMs })
  assert.ok(created)
  assert.equal(registry.consumeOneShot(windowId, panel, request.gt.slice(3)), true)
  return request
}
try {
  await test('isolated registry must be selected before any request or grant exists', () => {
    const pending = registry.requestCode(panel, owner)
    assert.throws(() => registry.initIsolatedRemoteGrantRegistry(), /not empty/)
    assert.equal(registry.cancelForWindow(owner, panel), true)
    registry.initIsolatedRemoteGrantRegistry()
    registry.initIsolatedRemoteGrantRegistry() // idempotent, never resets a live registry
    assert.throws(() => registry.initRemoteGrantRegistry({ notePanelUnlocked() {}, clearPanelScope() {}, clearPanelSessions() {} }), /cannot be replaced/)
    assert.equal(registry.getRequestStatus(owner, panel, pending.requestId), 'UNAVAILABLE')
    assert.equal(remoteImplementationReady(), false)
  })
  await test('remote admission is a separate scope; it does not open or overwrite local panel sessions', () => {
    session.clearPanelSessions(owner); session.clearPanelSessions(other)
    session.notePanelUnlocked(panel, 'PANEL', owner)
    grant(owner); grant(other)
    assert.equal(session.isPanelUnlocked(panel, owner), true)
    assert.equal(session.isPanelUnlocked(panel, other), false)
    assert.equal(registry.hasIsolatedRemotePanel(panel, owner), true)
    assert.equal(registry.hasIsolatedRemotePanel(panel, other), true)
    assert.deepEqual(registry.listIsolatedRemotePanels(owner), [panel])
    assert.deepEqual(registry.listIsolatedRemotePanels(999), [])
    assert.equal(registry.hasIsolatedRemotePanel(panel, owner, 'yes'), false)
  })
  await test('revoking remote scope cannot delete a local login in the same panel', () => {
    // A local unlock after remote admission must also remain intact.
    session.notePanelUnlocked(panel, 'PANEL', owner)
    assert.equal(registry.cancelForWindow(owner, panel), true)
    assert.equal(registry.hasIsolatedRemotePanel(panel, owner), false)
    assert.equal(registry.hasIsolatedRemotePanel(panel, other), true)
    assert.equal(session.isPanelUnlocked(panel, owner), true)
    assert.equal(session.isPanelUnlocked(panel, other), false)
    registry.revokeBy('member')
    assert.equal(registry.hasIsolatedRemotePanel(panel, other), false)
    assert.equal(session.isPanelUnlocked(panel, owner), true)
  })
  await test('remote absolute expiry and revoke-all do not revoke the local session', async () => {
    grant(owner, 30)
    await delay(65)
    assert.equal(registry.hasIsolatedRemotePanel(panel, owner), false)
    assert.deepEqual(registry.listIsolatedRemotePanels(owner), [])
    assert.equal(session.isPanelUnlocked(panel, owner), true)
    grant(owner)
    registry.revokeAll()
    assert.equal(registry.hasIsolatedRemotePanel(panel, owner), false)
    assert.equal(session.isPanelUnlocked(panel, owner), true)
  })
  await test('real activity touch never extends the absolute grant deadline', async () => {
    grant(other, 50)
    await delay(20)
    assert.equal(registry.hasIsolatedRemotePanel(panel, other, true), true)
    assert.deepEqual(registry.listIsolatedRemotePanels(other), [panel])
    await delay(50)
    assert.equal(registry.hasIsolatedRemotePanel(panel, other, true), false)
    assert.deepEqual(registry.listIsolatedRemotePanels(other), [])
    assert.equal(session.isPanelUnlocked(panel, owner), true)
  })
  await test('sensitive one-shot never becomes a reusable remote panel scope', () => {
    grant(other, 1000, 'SENSITIVE_MONEY')
    assert.equal(registry.hasIsolatedRemotePanel(panel, other), false)
    assert.deepEqual(registry.listIsolatedRemotePanels(other), [])
    assert.equal(session.isPanelUnlocked(panel, owner), true)
  })
} finally {
  registry.revokeAll()
  session.clearPanelSessions(owner); session.clearPanelSessions(other)
}
