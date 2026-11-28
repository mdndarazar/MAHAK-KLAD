/**
 * دفتر آزمون ۴-۴۶ — «مدیریت اعتبار خرید»: فرم‌ها رمز تایپی را اجباری نمی‌کنند.
 *  - `buildOpPayload` بی رمز هم درخواست می‌سازد (دلیل همچنان اجباری)؛
 *  - مسیر واقعی سرور (`registerIpcHandlers`): ماژول با کد یک‌بارمصرف باز، «تعلیق» با کادر خالی ⇐ `GATE_REQUIRED:credit.void`
 *    (پنجرهٔ «باز کردن قفل») با پیام «… قفل جدا دارد …»؛ با کدِ همان کار ⇐ انجام؛ با قفل خاموش ⇐ بی رمز؛ ذخیرهٔ تنظیمات اعتبار
 *    با کدِ همان کار ⇐ انجام و بی آن ⇐ پنجرهٔ قفل؛
 *  - متن‌ها: برچسب‌های «(اگر دارید)»، دکمهٔ تنظیمات با کادر خالی روشن، نام قفل «ابطال و تغییر اعتبار».
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-46-credit-forms.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-46-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (ch, fn) => handlers.set(ch, fn)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const db = harnessClient()
const seed = makeSeeder(db)
const sessions = await import('../../src/main/services/panelSession.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { buildOpPayload, emptyOpDraft, CreditOp } = await import('../../src/shared/creditUi.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { PANEL_KEYS } = await import('@shared/panels')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { jalaliToday } = await import('@shared/jalali')
registerIpcHandlers()

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const redeem = (owner, key, code) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, () => redeemOneTimeCode(key, code)))
const mk = (code) => seed.insert('StoreCredit', { code, amount: 1_000_000, status: 'ACTIVE', source: 'MANUAL', issuedAt: Date.now(), issuedAtJalali: jalaliToday() })
const statusOf = (id) => seed.one('SELECT status FROM "StoreCredit" WHERE id = ?', id).status
const C = await lockIpc.createCodes({ managerPassword: PW })
const codes = C.codes.map((c) => c.code)

test('the operation form builds a request without a password (the server decides); the reason is still required', () => {
  for (const op of [CreditOp.VOID, CreditOp.SUSPEND]) {
    const r = buildOpPayload({ ...emptyOpDraft(op, 7), reason: 'سند اشتباه' }, {})
    assert.equal(r.ok, true, r.error)
    assert.equal(r.payload.managerPassword, '')
  }
  const typed = buildOpPayload({ ...emptyOpDraft(CreditOp.VOID, 7), reason: 'سند اشتباه', managerPassword: '1111' }, {})
  assert.equal(typed.payload.managerPassword, '1111')
  const noReason = buildOpPayload({ ...emptyOpDraft(CreditOp.SUSPEND, 7) }, {})
  assert.equal(noReason.ok, false)
  assert.match(noReason.error, /دلیل اجباری است/)
  assert.doesNotMatch(read('src/shared/creditUi.ts'), /سرویس بدون رمز این درخواست را رد می‌کند/)
})

test('module opened with a one-time code: «تعلیق» with an empty box brings the unlock dialog; a code for that action lets it through without the manager password', async () => {
  const W = 931
  assert.equal((await redeem(W, PANEL_KEYS.creditManagement, codes[0])).kind, 'part')
  const id = mk('S446A0001')
  const r = await ipc(W, IPC.creditSuspend, { id, reason: 'تعلیق آزمون ۴-۴۶', managerPassword: '' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'GATE_REQUIRED:credit.void', 'the renderer opens «باز کردن قفل» for this action')
  assert.match(r.error, /قفل جدا دارد\. با رمز مدیر یا رمز دوم\/سوم همین کار، کد یک‌بارمصرف یا مجوز از راه دور باز می‌شود\./)
  assert.doesNotMatch(r.error, /همیشه رمز/)
  assert.equal(statusOf(id), 'ACTIVE', 'the module grant alone does not open the action inside it')
  // پنجرهٔ قفل کد را برای همان شناسهٔ کار (از کد `GATE_REQUIRED`) می‌گیرد ⇐ بلیت یک‌بار همان کار
  assert.equal((await redeem(W, 'credit.void', codes[1])).kind, 'action')
  const ok = await ipc(W, IPC.creditSuspend, { id, reason: 'تعلیق آزمون ۴-۴۶', managerPassword: '' })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(statusOf(id), 'SUSPENDED')
})

test('credit settings: saving with an empty box brings the unlock dialog; with a code for that action it saves', async () => {
  const W = 932, W2 = 933
  const settings = (await ipc(W, IPC.creditSettingsGet)).data
  const refused = await ipc(W2, IPC.creditSettingsSet, { settings, panelPassword: '' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'GATE_REQUIRED:credit.settings-save')
  assert.equal((await redeem(W, 'credit.settings-save', codes[2])).kind, 'action')
  const saved = await ipc(W, IPC.creditSettingsSet, { settings, panelPassword: '' })
  assert.equal(saved.ok, true, saved.error)
})

test('with the action lock off the operation runs without any password', async () => {
  const set = await ipc(940, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [PANEL_KEYS.creditVoid]: false } })
  assert.equal(set.ok, true, set.error)
  const id = mk('S446B0002')
  const r = await ipc(941, IPC.creditSuspend, { id, reason: 'قفل خاموش ۴-۴۶', managerPassword: '' })
  assert.equal(r.ok, true, r.error)
  assert.equal(statusOf(id), 'SUSPENDED')
  await ipc(940, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [PANEL_KEYS.creditVoid]: true } })
})

test('texts: optional password labels, the settings button works with an empty box, the lock is «ابطال و تغییر اعتبار»', () => {
  const forms = read('src/renderer/src/components/CreditForms.tsx')
  assert.ok(forms.includes('<span>رمز مدیر یا رمز دوم/سوم «ابطال و تغییر اعتبار» (اگر دارید)</span>'))
  assert.ok(forms.includes('رمز مدیر یا رمز دوم/سوم «تنظیمات اعتبار خرید» (اگر دارید)'))
  assert.doesNotMatch(forms, /!password\.trim\(\)/, 'the save button is not disabled by an empty box')
  const page = read('src/renderer/src/pages/CreditManagement.tsx')
  assert.ok(page.includes('رمز مدیر یا رمز دوم/سوم «صدور دستی اعتبار» (اگر دارید):'))
  assert.ok(page.includes('رمز مدیر یا رمز دوم/سوم «تولید گروهی اعتبار» (اگر دارید):'))
  assert.doesNotMatch(page, /همیشه رمز مدیر می‌خواهد/)
  assert.match(read('src/shared/gateCatalog.ts'), /\['credit\.void', 'credit-void', 'STRICT', 'credit-void', 'panel', G\.credit, 'ابطال و تغییر اعتبار'\]/)
  const authSrc = read('src/main/services/AuthService.ts')
  assert.doesNotMatch(authSrc, /`«\$\{action\}» همیشه رمز/, 'no message says «always needs a password» any more')
  assert.ok(authSrc.includes("`«${action}» قفل جدا دارد. رمز واردشده پذیرفته نشد.`"))
})
