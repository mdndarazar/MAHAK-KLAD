/**
 * دفتر آزمون ۴-۳۸ — یک رفتار روشن برای دکمه‌های ذخیره:
 *  - ماژول مشترک `UnsavedChanges.tsx` (با esbuild ساخته و با react-dom/server کشیده): `saveSections` فقط بخش‌های تغییرکرده
 *    را به ترتیب و با تابع خودشان ذخیره می‌کند و شکست یکی جلوی بقیه را نمی‌گیرد؛ پیام نام بخش ناموفق را می‌گوید؛ پرسش
 *    بیرون رفتن («ذخیره»، «بیرون رفتن بی ذخیره»، «ماندن») و یک نشان «تغییرات ذخیره نشده»؛
 *  - مسیرهای واقعی سرور (`registerIpcHandlers`) با همان payload صفحهٔ تنظیمات: در نشست مدیر یک دکمه همهٔ بخش‌ها را ذخیره
 *    می‌کند و «تنظیمات امنیتی» بی رمز تایپی فقط خودش ذخیره نمی‌شود؛ بی نشست، بخش قفل‌دار بی رمز ذخیره نمی‌شود و بخش دیگر
 *    ذخیره می‌شود؛ چرا بستهٔ کلی نخست می‌رود و تنظیمات امنیتیِ ذخیره‌شده را می‌فرستد؛
 *  - سیم‌کشی صفحه‌ها: هفت دکمهٔ تنظیمات همه «ذخیرهٔ همه»اند، متن‌های حواله به دکمهٔ دیگر برداشته شده، یک نشان، و پرسش
 *    بیرون رفتن در تنظیمات، عوارض و حق سرویس، و انبارگردانی.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-38-save-all.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-38-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')
const require = createRequire(import.meta.url)
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- ماژول مشترک، ساخته مثل برنامه
const MOD = JSON.stringify(join(ROOT, 'src/renderer/src/components/UnsavedChanges.tsx'))
const bundleFile = join(DIR, 'unsaved.cjs')
await build({
  stdin: {
    contents: `import { createElement } from 'react'\nimport { renderToStaticMarkup } from 'react-dom/server'\nimport * as m from ${MOD}\n` +
      `export const html = (name, props) => renderToStaticMarkup(createElement(m[name], props))\nexport * from ${MOD}\n`,
    resolveDir: ROOT, loader: 'jsx', sourcefile: 'tl-4-38-entry.jsx'
  },
  outfile: bundleFile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent'
})
const U = require(bundleFile)

// ---------------------------------------------------------------- کانال‌های واقعی main روی پایگاه موقت
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (ch, fn) => handlers.set(ch, fn)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
harnessClient()
const sessions = await import('../../src/main/services/panelSession.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { GATE_PROOF_MARKER: MARK } = await import('@shared/gateCatalog')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
registerIpcHandlers()
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const data = async (id, ch, payload) => { const r = await ipc(id, ch, payload); assert.equal(r.ok, true, r.error); return r.data }
/** یک بخش، همان‌طور که صفحهٔ تنظیمات می‌فرستد: `null` یعنی ذخیره شد، وگرنه همان پیام سرور. */
const section = (name, id, ch, payload) => ({ name, dirty: true, save: async () => { const r = await ipc(id, ch, payload); return r.ok ? null : r.error } })
const BUNDLE = 'تنظیمات رسید، چاپ، فروش، شیفت و لیبل'
const NAMES = [BUNDLE, 'تنظیمات امنیتی', 'افست ساعت رسمی', 'سقف اضافه‌کاری', 'سیاست حسابداری', 'سیاست تخفیف', 'قاعدهٔ بازپرداخت']

test('saveSections saves only the changed sections, in order, each with its own function; a failure does not stop the rest; the message names it', async () => {
  const calls = []
  const mk = (name, dirty, result) => ({ name, dirty, save: async () => { calls.push(name); if (result instanceof Error) throw result; return result } })
  const r = await U.saveSections([mk('الف', true, null), mk('ب', false, null), mk('ج', true, 'رمز مدیر را وارد کنید.'), mk('د', true, new Error('شبکه قطع شد')), mk('ه', true, undefined)])
  assert.deepEqual(calls, ['الف', 'ج', 'د', 'ه'])
  assert.deepEqual(r, { saved: ['الف', 'ه'], failed: [{ name: 'ج', error: 'رمز مدیر را وارد کنید.' }, { name: 'د', error: 'شبکه قطع شد' }] })
  assert.deepEqual(U.saveReportText(r), { ok: '✓ ذخیره شد: «الف»، «ه»', error: '«ج» ذخیره نشد: رمز مدیر را وارد کنید.\n«د» ذخیره نشد: شبکه قطع شد' })
  assert.deepEqual(U.saveReportText({ saved: [], failed: [{ name: 'ج', error: 'x' }] }), { ok: null, error: '«ج» ذخیره نشد: x' })
  assert.deepEqual(U.saveReportText({ saved: [], failed: [] }), { ok: '✓ ذخیره شد', error: null })
})

test('leaving with unsaved changes: «ذخیره» leaves only if everything saved, «بیرون رفتن بی ذخیره» discards, «ماندن» stays; one badge', async () => {
  let saves = 0
  const ok = async () => { saves++; return true }, bad = async () => { saves++; return false }
  assert.equal(await U.resolveLeave('stay', ok), 'stay')
  assert.equal(await U.resolveLeave('discard', ok), 'go-discard')
  assert.equal(saves, 0, 'neither «ماندن» nor «بیرون رفتن بی ذخیره» saves')
  assert.equal(await U.resolveLeave('save', ok), 'go')
  assert.equal(await U.resolveLeave('save', bad), 'stay', 'a section failed: stay and show which one')
  assert.equal(saves, 2)
  const dialog = U.html('UnsavedChangesDialog', { busy: false, onChoose: () => {} })
  assert.ok(dialog.includes('تغییرهای ذخیره‌نشده دارید؛ ذخیره شود؟'))
  assert.deepEqual([...dialog.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]), ['ذخیره', 'بیرون رفتن بی ذخیره', 'ماندن'])
  assert.doesNotMatch(dialog, /disabled/)
  const busy = U.html('UnsavedChangesDialog', { busy: true, onChoose: () => {} })
  assert.equal((busy.match(/disabled=""/g) ?? []).length, 3)
  assert.ok(busy.includes('در حال ذخیره…'))
  assert.equal(U.html('UnsavedBadge', { show: false }), '')
  const badge = U.html('UnsavedBadge', { show: true, sections: ['سیاست تخفیف', 'افست ساعت رسمی'] })
  assert.ok(badge.includes('>تغییرات ذخیره نشده<') && badge.includes('title="ذخیره‌نشده: سیاست تخفیف، افست ساعت رسمی"'), badge)
})

test('in a manager session one button saves every changed section through its own server path; «تنظیمات امنیتی» without its typed password fails alone and is named; nothing reverts', async () => {
  const W = 901
  sessions.notePanelUnlocked('__manager__', 'MANAGER', W)
  const b0 = await data(W, IPC.settingsBundle)
  const policy0 = await data(W, IPC.settingsAccountingPolicy)
  assert.ok(b0.shift.templates.length > 0)
  const receipt = { ...b0.receipt, shopName: 'فروشگاه ۴-۳۸' }
  const templates = b0.shift.templates.map((t, i) => (i ? t : { ...t, name: 'صبح ۴-۳۸' }))
  const shift = { ...b0.shift, templates, names: templates.map((t) => t.name) }
  const security = { ...b0.security, lockMinutes: b0.security.lockMinutes + 5 }
  const discountMode = b0.discount.mode === 'OFF' ? 'FREE' : 'OFF'
  const report = await U.saveSections([
    // همان خط صفحه: تنظیمات امنیتیِ ذخیره‌شده (`lastSaved.security`) و افستِ ذخیره‌شده؛ رمز در نشست = نشانگر
    section(BUNDLE, W, IPC.settingsSaveBundle, { receipt, sale: b0.sale, shift, label: b0.label, security: b0.security, time: b0.time, managerPassword: MARK }),
    section(NAMES[1], W, IPC.settingsSaveBundle, { security, managerPassword: '' }),
    section(NAMES[2], W, IPC.settingsOfficialTimeSet, { offsetHours: 2, managerPassword: MARK }),
    section(NAMES[3], W, IPC.settingsShiftOvertimeMax, { minutes: 30, managerPassword: MARK }),
    section(NAMES[4], W, IPC.settingsAccountingPolicySet, { policy: { ...policy0, abnormalDiscountPercent: 17 }, managerPassword: MARK }),
    section(NAMES[5], W, IPC.discountPolicySave, { policy: { ...b0.discount, mode: discountMode }, panelPassword: MARK }),
    section(NAMES[6], W, IPC.discountTransferPolicySave, { preventExtraRefund: !b0.discountTransfer.preventExtraRefund, managerPassword: MARK })
  ])
  assert.deepEqual(report.saved, NAMES.filter((n) => n !== 'تنظیمات امنیتی'))
  assert.deepEqual(report.failed.map((f) => f.name), ['تنظیمات امنیتی'])
  assert.match(report.failed[0].error, /رمز/)
  const b1 = await data(W, IPC.settingsBundle)
  assert.equal(b1.receipt.shopName, 'فروشگاه ۴-۳۸')
  assert.equal(b1.shift.templates[0].name, 'صبح ۴-۳۸')
  assert.equal(b1.shift.overtimeMaxMinutes, 30, 'the bundle went first, so it did not put the old cap back')
  assert.equal(b1.time.offsetHours, 2, 'nor the old offset')
  assert.deepEqual(b1.security, b0.security, 'not written without its own typed password')
  assert.equal(b1.discount.mode, discountMode)
  assert.equal(b1.discountTransfer.preventExtraRefund, !b0.discountTransfer.preventExtraRefund)
  assert.equal((await data(W, IPC.settingsAccountingPolicy)).abnormalDiscountPercent, 17)

  // چرا صفحه تنظیمات امنیتیِ ذخیره‌شده را در بستهٔ کلی می‌فرستد: تغییر ذخیره‌نشدهٔ آن کل بسته را رد می‌کرد
  const whole = await ipc(W, IPC.settingsSaveBundle, { receipt: { ...b1.receipt, shopName: 'نباید ذخیره شود' }, security, managerPassword: MARK })
  assert.equal(whole.ok, false)
  assert.equal((await data(W, IPC.settingsBundle)).receipt.shopName, 'فروشگاه ۴-۳۸')
  // و چرا بستهٔ کلی نخست می‌رود: شیفتِ کهنه پس از سقف تازه، سقف قبلی را برمی‌گرداند
  await data(W, IPC.settingsShiftOvertimeMax, { minutes: 45, managerPassword: MARK })
  await data(W, IPC.settingsSaveBundle, { shift: b1.shift, managerPassword: MARK })
  assert.equal((await data(W, IPC.settingsBundle)).shift.overtimeMaxMinutes, 30)
  // با رمز تایپی، دکمهٔ بعدی همان بخش را هم ذخیره می‌کند
  assert.equal(await section(NAMES[1], W, IPC.settingsSaveBundle, { security, managerPassword: PW }).save(), null)
  assert.equal((await data(W, IPC.settingsBundle)).security.lockMinutes, security.lockMinutes)
  sessions.clearPanelSessions(W)
})

test('without a manager session: a locked section without its password is not saved and is named; the other section is saved', async () => {
  const W2 = 902
  const b = await data(W2, IPC.settingsBundle)
  const p0 = await data(W2, IPC.settingsAccountingPolicy)
  const report = await U.saveSections([
    section(BUNDLE, W2, IPC.settingsSaveBundle, { receipt: { ...b.receipt, shopName: 'بی نشست ۴-۳۸' }, sale: b.sale, shift: b.shift, label: b.label, security: b.security, time: b.time, managerPassword: '' }),
    section('سیاست حسابداری', W2, IPC.settingsAccountingPolicySet, { policy: { ...p0, abnormalDiscountPercent: 23 }, managerPassword: '' })
  ])
  assert.deepEqual(report.saved, [BUNDLE])
  assert.deepEqual(report.failed.map((f) => f.name), ['سیاست حسابداری'])
  assert.equal((await data(W2, IPC.settingsAccountingPolicy)).abnormalDiscountPercent, p0.abnormalDiscountPercent, 'nothing written without its own permission')
  assert.equal((await data(W2, IPC.settingsBundle)).receipt.shopName, 'بی نشست ۴-۳۸')
  const text = U.saveReportText(report)
  assert.equal(text.ok, `✓ ذخیره شد: «${BUNDLE}»`)
  assert.match(text.error, /^«سیاست حسابداری» ذخیره نشد: .*رمز/)
})

test('wiring: all seven save buttons of Settings save everything in that order; texts pointing at another button are gone; one badge and the leave prompt on the three pages', () => {
  const s = read('src/renderer/src/pages/Settings.tsx')
  assert.equal((s.match(/onClick=\{\(\) => void saveAll\(\)\}/g) ?? []).length, 7)
  assert.doesNotMatch(s, /onClick=\{\(\) => void (save|saveSecurity|saveDiscount|saveDiscountTransfer|saveOvertimeMax|savePolicy|saveOfficialTime)\(\)\}/)
  const list = s.slice(s.indexOf('const sections = ['), s.indexOf('const unsavedNames'))
  const order = NAMES.map((n) => list.indexOf(`name: '${n}'`))
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `the sections in order: ${order}`)
  for (const fn of ['dirty, save }', 'save: saveSecurity', 'save: saveOfficialTime', 'save: saveOvertimeMax', 'dirty: policyDirty, save: savePolicy', 'save: saveDiscount }', 'save: saveDiscountTransfer'])
    assert.ok(list.includes(fn), fn)
  for (const entry of [
    'dirty: JSON.stringify(security) !== JSON.stringify(lastSaved.security), save: saveSecurity',
    'dirty: timeDirty, save: saveOfficialTime', 'dirty: overtimeDirty, save: saveOvertimeMax',
    'dirty: JSON.stringify(discount) !== JSON.stringify(lastSaved.discount), save: saveDiscount',
    'dirty: discountTransfer.preventExtraRefund !== lastSaved.preventExtraRefund, save: saveDiscountTransfer'
  ]) assert.ok(list.includes(entry), entry)
  // «تغییر» هر بخش با همان خواندنی که تابع ذخیرهٔ خودش دارد
  assert.match(s, /const timeDirty = \(Number\(toLatinDigits\(timeOffset\)\.replace\(\/\[\^0-9\.\+-\]\/g, ''\)\) \|\| 0\) !== time\.offsetHours/)
  assert.match(s, /const overtimeDirty = Math\.trunc\(Number\(toLatinDigits\(overtimeCap\)\.replace\(\/\[\^0-9-\]\/g, ''\)\)\) !== \(shift\.overtimeMaxMinutes \?\? 0\)/)
  // آخرین مقدار ذخیره‌شده پس از بارگذاری و پس از هر ذخیرهٔ موفق
  assert.match(s, /setLastSaved\(\{ security: parseSecurityConfig\(b\.security\), discount: parseDiscountPolicy\(b\.discount\), preventExtraRefund: /)
  const bodyOf = (fn) => { const i = s.indexOf(`const ${fn} = async`); return s.slice(i, s.indexOf('\n  }\n', i)) }
  assert.ok(bodyOf('saveSecurity').includes('setLastSaved((s) => ({ ...s, security: next }))'))
  assert.ok(bodyOf('saveDiscount').includes('setLastSaved((s) => ({ ...s, discount: clean }))'))
  assert.ok(bodyOf('saveDiscountTransfer').includes('setLastSaved((s) => ({ ...s, preventExtraRefund: saved.preventExtraRefund }))'))
  for (const fn of ['save', 'saveSecurity', 'saveOfficialTime', 'saveOvertimeMax', 'savePolicy', 'saveDiscount', 'saveDiscountTransfer']) {
    const body = fn === 'save' ? s.slice(s.indexOf('const save = async () => {'), s.indexOf('const saveSecurity = async')) : bodyOf(fn)
    assert.ok(body.includes('return null') && body.includes("return String(e?.message ?? 'انجام نشد')"), `${fn}: null when saved, the server message when not`)
  }
  assert.ok(bodyOf('saveOvertimeMax').includes('return message'), 'an invalid cap is a named failure too')
  assert.ok(s.slice(s.indexOf('const saveAll = async'), s.indexOf('const leave = useLeaveGuard')).includes('return !report.failed.length'), 'leaving after «ذخیره» only when every section saved')
  const saveBody = s.slice(s.indexOf('const save = async () => {'), s.indexOf('const saveSecurity = async'))
  assert.ok(saveBody.indexOf('const security = lastSaved.security') > 0 && saveBody.indexOf('const security = lastSaved.security') < saveBody.indexOf('CH.settingsSaveBundle, { receipt'))
  assert.match(s, /setShift\(\(p\) => \(\{ \.\.\.p, overtimeMaxMinutes: next\.overtimeMaxMinutes \}\)\)/, 'the cap alone; unsaved shift edits stay')
  for (const fn of ['saveDiscount', 'saveDiscountTransfer']) {
    const body = s.slice(s.indexOf(`const ${fn} = async`), s.indexOf('\n  }\n', s.indexOf(`const ${fn} = async`)))
    assert.doesNotMatch(body, /await load\(\)/, `${fn}: a failure no longer reloads the whole form`)
  }
  for (const gone of ['نیازی به دکمه‌ی ذخیره‌ی تنظیمات نیست', 'با «ذخیره‌ی تنظیمات» بالای صفحه ذخیره نمی‌شود', 'با رمز مدیر بالا', 'نباید منتظر دکمه‌ی کلی'])
    assert.ok(!s.includes(gone), gone)
  assert.match(s, /\{byTimeSaved && <span className="kbd text-emerald-700">\{SAVED_TEXT\}<\/span>\}/)
  assert.ok(s.includes('>\n                    ذخیره‌ی سقف اضافه‌کاری\n'))
  assert.equal((s.match(/<UnsavedBadge show=\{unsaved\} sections=\{unsavedNames\} \/>/g) ?? []).length, 7)
  assert.equal((s.match(/onClick=\{\(\) => leave\.guard\(\(\) => setTab\('/g) ?? []).length, 13)
  assert.doesNotMatch(s, /onClick=\{\(\) => setTab\('/)
  assert.match(s, /const leave = useLeaveGuard\(unsaved, saveAll, async \(\) => \{ await load\(\); await loadPolicy\(\) \}\)/)
  const c = read('src/renderer/src/pages/CategoryCharges.tsx'), t = read('src/renderer/src/pages/Stocktake.tsx')
  assert.match(c, /const leave = useLeaveGuard\(dirty, save\)/)
  assert.match(t, /const leave = useLeaveGuard\(reminderDirty, saveSchedule, loadSchedule\)/)
  assert.equal((t.match(/leave\.guard\(\(\) => setTab\('/g) ?? []).length, 5)
  for (const [name, src] of [['Settings', s], ['CategoryCharges', c], ['Stocktake', t]]) {
    assert.ok(!/>تغییرات ذخیره نشده</.test(src) && src.includes('<UnsavedBadge'), `${name}: one badge component`)
    assert.ok(src.includes('{leave.dialog}'), `${name}: the leave prompt is rendered`)
  }
  assert.match(c, /flash\(`\$\{SAVED_TEXT\} · /)
  const cSave = c.slice(c.indexOf('const save = async'), c.indexOf('const leave = useLeaveGuard'))
  const tSave = t.slice(t.indexOf('const saveSchedule = async'), t.indexOf('const leave = useLeaveGuard'))
  for (const [name, body] of [['CategoryCharges', cSave], ['Stocktake', tSave]])
    assert.ok(body.includes('return true') && body.includes('return false'), `${name}: the leave prompt learns whether saving worked`)
  assert.match(t, /`\$\{SAVED_TEXT\} · ` \+/)
  const m = read('src/renderer/src/components/UnsavedChanges.tsx')
  assert.match(m, /useBlocker\(\(\{ currentLocation, nextLocation \}\) => unsaved && currentLocation\.pathname !== nextLocation\.pathname\)/)
})
