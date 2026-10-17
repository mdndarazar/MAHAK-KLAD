/**
 * Credit reminder SMS is opt-in, not inferred from a phone number. This suite
 * exercises the real migration tables, the manager grant, the reminder bridge
 * and the final queue worker on a disposable SQLite database. LOG_ONLY is used
 * as the provider: no real SMS or customer database is touched.
 *
 * node --import ./test/harness/register.mjs tests/sms/credit-reminder-explicit-consent.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-consent-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { issueStoreCredit, storeCreditService, changeCreditHolder } = await import('../../src/main/services/StoreCreditService.ts')
const { setNotificationSender } = await import('../../src/main/services/NotificationSender.ts')
const { smsNotificationSender } = await import('../../src/main/services/sms/SmsNotificationSender.ts')
const { enqueueSms, runSmsQueueOnce } = await import('../../src/main/services/sms/SmsQueue.ts')
const { smsCredentialService } = await import('../../src/main/services/sms/SmsCredentials.ts')
const { notePanelUnlocked, clearPanelSessions } = await import('../../src/main/services/panelSession.ts')
const { PANEL_KEYS } = await import('@shared/panels')
const { DEFAULT_MANAGER_PASSWORD: PW } = await import('@shared/receipt')
const { CreditReminderStatus } = await import('@shared/credit')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('مدیر آزمون رضایت')
const DAY = 86_400_000
const row = (id) => seed.one('SELECT * FROM "StoreCredit" WHERE id = ?', id)
const outbox = (id) => seed.one('SELECT * FROM "SmsOutbox" WHERE id = ?', id)
const count = (table) => seed.count(table)
const issue = async (phone) => {
  const c = await issueStoreCredit(db, { source: 'MANUAL', amount: 500_000, holderPhone: phone, userId })
  sql.prepare('UPDATE "StoreCredit" SET issuedAt = ? WHERE id = ?').run(Date.now() - 40 * DAY, c.id)
  return c
}
const grant = (credit, phone, evidence = 'رضایت آگاهانهٔ مخاطب در رسید شماره ۲۳') =>
  storeCreditService.grantReminderConsent({ id: credit.id, phone, evidence, managerPassword: PW, userId })
const error = async (fn, needle) => {
  await assert.rejects(fn, (e) => {
    assert.match(String(e?.message ?? e), new RegExp(needle))
    return true
  })
}

let calls = 0
setNotificationSender({
  name: 'فرستندهٔ آزمایشی بدون شبکه', live: true,
  async send(phone, text) {
    calls++
    assert.ok(phone && text)
    return { ok: true, externalId: String(calls), detail: 'پذیرفته شد' }
  }
})

const original = await issue('09129990001')
assert.equal(row(original.id).reminderOptOut, 0, 'legacy flag defaults to false, but is not consent')
assert.equal(row(original.id).reminderConsentAt, null, 'new and old credits start without consent')
const dueWithoutConsent = await storeCreditService.reminderCandidates({ onlyDue: false })
assert.equal(dueWithoutConsent.rows.find((c) => c.credit.id === original.id)?.should, false)
assert.match(dueWithoutConsent.rows.find((c) => c.credit.id === original.id)?.reason ?? '', /رضایت/)
assert.equal((await storeCreditService.reminderCandidates({ onlyDue: true })).rows.some((c) => c.credit.id === original.id), false)
const skipped = await storeCreditService.queueReminder({ id: original.id, userId, force: true })
assert.equal(skipped.status, CreditReminderStatus.SKIPPED, 'force must not bypass missing consent')
assert.equal(calls, 0)
assert.equal(row(original.id).reminderCount, 0)
const skippedRaw = seed.one('SELECT text, placeholdersJson FROM "CreditReminderLog" WHERE creditId = ? ORDER BY id DESC', original.id)
assert.equal(String(skippedRaw.text).includes(original.code), false, 'rejected reminder does not persist the spendable code')
assert.equal(String(skippedRaw.placeholdersJson).includes(original.code), false)

const raw = await enqueueSms({ eventType: 'CREDIT_REMINDER', phone: '09129990001', body: 'باید مسدود شود',
  relatedEntity: 'CreditReminder', relatedEntityId: original.id, dedupeKey: 'unconsented-direct' })
assert.equal(raw.skipped, true, 'direct outbox calls cannot bypass the opt-in gate')
assert.equal(count('SmsOutbox'), 0)
const missingId = await enqueueSms({ eventType: 'CREDIT_REMINDER_NO_EXPIRY', phone: '09129990001',
  body: 'بی شناسه', dedupeKey: 'unbound-direct' })
assert.equal(missingId.skipped, true, 'both reminder event types need a bound credit')

await error(() => grant(original, '09129990001'), 'نشست فعال مدیر')
assert.equal(row(original.id).reminderConsentAt, null)
notePanelUnlocked(PANEL_KEYS.creditManagement, 'MANAGER')
await error(() => storeCreditService.grantReminderConsent({ id: original.id, phone: '09129990001',
  evidence: 'رضایت مثبت مخاطب در سند', managerPassword: 'wrong', userId }), 'رمز')
await error(() => grant(original, '09129990002'), 'شماره')
await error(() => grant(original, '09129990001', 'شماره'), 'شاهد')
assert.equal(row(original.id).reminderConsentAt, null)
await grant(original, '۰۹۱۲۹۹۹۰۰۰۱')
const accepted = row(original.id)
assert.ok(accepted.reminderConsentAt != null)
assert.equal(accepted.reminderConsentPhone, '09129990001')
assert.match(accepted.reminderConsentEvidence, /رسید/)
const consentAudit = seed.one('SELECT note, after FROM "AuditLog" WHERE action = ? AND entityId = ? ORDER BY id DESC',
  'CREDIT_REMINDER_CONSENT', original.id)
assert.ok(consentAudit)
assert.equal(String(consentAudit.note).includes(original.code), false)
assert.equal(String(consentAudit.after).includes(original.code), false)
assert.equal((await storeCreditService.reminderCandidates({ onlyDue: true })).rows.some((c) => c.credit.id === original.id), true)
const sent = await storeCreditService.queueReminder({ id: original.id, userId })
assert.equal(sent.status, CreditReminderStatus.LOGGED)
assert.equal(calls, 1, 'a reminder may be sent only after the separate grant')
assert.equal(row(original.id).reminderCount, 1)

// Altering the holder, even restoring the old number later, revokes consent.
await changeCreditHolder({ id: original.id, holderPhone: '09129990003', reason: 'گیرنده عوض شد', managerPassword: PW, userId })
assert.equal(row(original.id).reminderConsentAt, null)
await changeCreditHolder({ id: original.id, holderPhone: '09129990001', reason: 'شماره قبلی دوباره ثبت شد', managerPassword: PW, userId })
assert.equal((await storeCreditService.queueReminder({ id: original.id, force: true, userId })).status, CreditReminderStatus.SKIPPED)
assert.equal(calls, 1, 'returning to an old phone must not revive an old permission')

// Historic outbox row predating a later grant: never auto-backfill.
const legacy = await issue('09129990004')
const beforeConsent = Date.now() - DAY
const legacyOutboxId = seed.insert('SmsOutbox', {
  dedupeKey: 'legacy-before-opt-in', eventType: 'CREDIT_REMINDER',
  phoneSnapshot: '09129990004', bodySnapshot: `کد قدیمی: ${legacy.code}`,
  relatedEntity: 'CreditReminder', relatedEntityId: legacy.id,
  status: 'PENDING', createdAt: beforeConsent, nextAttemptAt: Date.now() - 1000
})
await grant(legacy, '09129990004')
assert.ok(Number(row(legacy.id).reminderConsentAt) > beforeConsent)

// Pending row whose consent was later revoked: checked again immediately
// before the provider, without consuming a single send attempt.
const pending = await issue('09129990005')
await grant(pending, '09129990005')
setNotificationSender(smsNotificationSender)
const queued = await storeCreditService.queueReminder({ id: pending.id, force: true, userId })
assert.equal(queued.status, CreditReminderStatus.LOGGED)
const pendingOutbox = seed.one('SELECT * FROM "SmsOutbox" WHERE relatedEntityId = ? ORDER BY id DESC', pending.id)
assert.ok(pendingOutbox?.id)
await changeCreditHolder({ id: pending.id, reminderOptOut: true, reason: 'مخاطب رضایتش را پس گرفت', managerPassword: PW, userId })
assert.equal(row(pending.id).reminderConsentAt, null)
assert.equal((await storeCreditService.queueReminder({ id: pending.id, force: true, userId })).status,
  CreditReminderStatus.OPTED_OUT)

await smsCredentialService.save({ providerKey: 'LOG_ONLY', name: 'خط آزمایشی', purpose: 'SERVICE', isActive: true, userId })
const processed = await runSmsQueueOnce()
assert.ok(processed.picked >= 2, `the real worker must inspect queued reminders: ${JSON.stringify(processed)}`)
for (const id of [legacyOutboxId, pendingOutbox.id]) {
  const canceled = outbox(id)
  assert.equal(canceled.status, 'CANCELED')
  assert.equal(canceled.lastErrorCode, 'NO_CREDIT_REMINDER_CONSENT')
  assert.equal(canceled.attemptCount, 0, 'provider was never called')
  assert.equal(seed.count('SmsAttempt', 'outboxId = ?', id), 0)
}
assert.equal(calls, 1)
clearPanelSessions()
console.log('✓ credit SMS: no implicit phone consent, manager evidence/actor, force & direct queue blocked, old pending/revoked canceled before provider')
