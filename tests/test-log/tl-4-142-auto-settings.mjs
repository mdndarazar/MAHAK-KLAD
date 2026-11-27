/**
 * دفتر آزمون ۴-۱۴۲ — تبدیل خودکار یک‌بارهٔ تنظیمات عوارض/حق سرویس پس از نصب یا ارتقا: پیام ساده و
 * غیرهشداری «⚙️ تبدیل خودکار تنظیمات «…»» بی «کاربر: نامشخص»؛ تغییر تنظیمات به دست کاربر همان هشدار مهم.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { auditPageToEvents, emptyLookups, EVENT_FIELDS, FORBIDDEN_FIELD_NAMES } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const ctx = { offsetHours: 0, threshold: 0, includeCustomerName: false, data: emptyLookups() }
ctx.data.users.set(5, 'مدیر')
const row = (over) => ({ id: 142, at: Date.UTC(2026, 10, 27, 9, 0), userId: null, action: 'SETTINGS_UPDATE', entity: 'Setting', entityId: null, after: '{"enabled":true}', note: null, ...over })
const one = (over) => auditPageToEvents([row(over)], ctx, { closeShiftIds: [] })

await test('the app\'s own one-time conversion: plain, not important, no unknown user', () => {
  const [ev] = one({ note: 'مهاجرت تنظیمات «عوارض و مالیات · پنل فروش (خرده)» به سیستم واحد دسته‌بندی‌محور' })
  assert.match(ev.title, /^⚙️ تبدیل خودکار تنظیمات «عوارض و مالیات · پنل فروش \(خرده\)» · /)
  assert.deepEqual(ev.lines, ['یک بار، کار خود برنامه پس از نصب یا به‌روزرسانی؛ کسی تنظیمی را عوض نکرده.'])
  assert.equal(ev.important, false)
  // نام ناشناخته در یادداشت خوانده نمی‌شود
  const [odd] = one({ note: 'مهاجرت تنظیمات «چیز دیگر با تلفن ۰۹۱۲» به سیستم واحد دسته‌بندی‌محور' })
  assert.match(odd.title, /^⚙️ تبدیل خودکار تنظیمات «عوارض یا حق سرویس» · /)
  assert.ok(!JSON.stringify(odd).includes('۰۹۱۲'))
})

await test('a real settings change by a user stays an important warning with the user name', () => {
  const [ev] = one({ userId: 5, note: 'مهاجرت تنظیمات «عوارض و مالیات · پنل فروش (خرده)» به سیستم واحد دسته‌بندی‌محور' })
  assert.match(ev.title, /^⚙️ تنظیمات برنامه عوض شد · /)
  assert.deepEqual(ev.lines, ['کاربر: مدیر'])
  assert.equal(ev.important, true)
  const [other] = one({ note: 'یادداشت دیگر' })
  assert.equal(other.important, true)
  assert.deepEqual(other.lines, ['کاربر: نامشخص'])
})

await test('note is still not a message field', () => {
  for (const fields of Object.values(EVENT_FIELDS)) for (const f of fields) assert.ok(!FORBIDDEN_FIELD_NAMES.includes(f), f)
})
