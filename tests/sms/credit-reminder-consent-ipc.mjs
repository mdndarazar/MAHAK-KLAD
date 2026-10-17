/** Real main IPC sender scope + audited actor for credit SMS consent. */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-consent-ipc-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const senderA = { id: 93141, isDestroyed: () => false, once: () => {} }
const senderB = { id: 93142, isDestroyed: () => false, once: () => {} }
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { jalaliToday } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
registerIpcHandlers()
const invoke = (sender, ch, p) => handlers.get(ch)({ sender }, p)
const real = seed.user('کارمند حاضر')
const forged = seed.user('کارمند جعلی')
seed.insert('Shift', { name: 'صبح', number: 1, dayJalali: jalaliToday(), openedAt: Date.now() - 3600_000, userId: real })
const id = seed.insert('StoreCredit', {
  code: 'IPC-CONSENT-01', source: 'MANUAL', amount: 50_000, status: 'ACTIVE',
  issuedAt: Date.now(), issuedAtJalali: jalaliToday(), holderPhone: '09129994444'
})
const input = { id, phone: '09129994444', evidence: 'رسید امضاشده شماره ۵۳', managerPassword: PW,
  userId: forged, reminderConsentAt: new Date(1999, 0, 1), reminderConsentPhone: '09128880000' }
const fails = async (sender, needle) => {
  const result = await invoke(sender, IPC.creditReminderConsentGrant, input)
  assert.equal(result?.ok, false)
  assert.match(String(result?.error ?? ''), new RegExp(needle))
}
await fails(senderA, 'نشست فعال مدیر')
const verified = await invoke(senderA, IPC.managerVerify, { password: PW })
assert.equal(verified?.ok, true)
await fails(senderB, 'نشست فعال مدیر')
assert.equal(seed.one('SELECT reminderConsentAt FROM "StoreCredit" WHERE id = ?', id).reminderConsentAt, null)
await invoke(senderA, IPC.creditReminderConsentGrant, input)
const row = seed.one('SELECT reminderConsentAt, reminderConsentPhone, reminderConsentEvidence FROM "StoreCredit" WHERE id = ?', id)
assert.ok(Number(row.reminderConsentAt) > Date.now() - 60_000, 'timestamp must come from main, not renderer')
assert.equal(row.reminderConsentPhone, '09129994444', 'renderer cannot substitute destination')
assert.equal(row.reminderConsentEvidence, input.evidence)
const audit = seed.one('SELECT userId, note, after FROM "AuditLog" WHERE action = ? AND entityId = ? ORDER BY id DESC',
  'CREDIT_REMINDER_CONSENT', id)
assert.equal(Number(audit.userId), real, 'forged renderer actor cannot claim manager evidence')
assert.equal(String(audit.note).includes('IPC-CONSENT-01'), false, 'audit must not disclose spendable code')
console.log('✓ manager-only, sender-bound consent IPC: forged actor/time/destination rejected; audit uses shift actor')
