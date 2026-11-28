/**
 * طرح ۱۴۰۵ — دروازهٔ مرکزی قفل‌ها (معماری §۳-۴ تا §۳-۹؛ §۸-۲ بندهای ۳، ۴، ۵ و ۶).
 *
 * برای هر ۵۳ شناسهٔ کار، با همان تابع‌های واقعی AuthService و panelSession و پایگاه دادهٔ موقت:
 *   قفل خاموش بی رمز؛ نشست مدیر بی رمز و بی شمارش اشتباه؛ رمز مدیر؛ رمز دوم همان کار (و ماژول مادر برای strictها)؛
 *   بلیت فقط یک بار و فقط در همان پنجره؛ نشست پنجرهٔ دیگر بی اثر؛ دستهٔ ۱ با هیچ راهی جز خود مدیر؛ خاموش شدن
 *   قفل ماژول قفل کار را خاموش نمی‌کند؛ پیش‌فرض نصب «همه روشن»؛ بیرون از IPC رفتار امروز.
 * به‌علاوه: هفت قسمت تازه، نشانگر غیرراز، «یک بلیت = یک فراخوانی» و خط «روش تأیید» فقط برای روش‌های تازه.
 * هیچ پایگاه دادهٔ واقعی لمس نمی‌شود.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-gate-decision.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'plan1405-gate-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const auth = await import('../../src/main/services/AuthService.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const { runInGateCall, blankGateMarkers, currentGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { gateAction, gateSession, gateProbe, unlockActionWithPassword } = await import('../../src/main/services/locks/gate.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const { audit } = await import('../../src/main/services/AuditService.ts')
const { GATE_CATALOG, GATE_ACTION_IDS, GATE_PART_KEYS, GATE_PROOF_MARKER } = await import('../../src/shared/gateCatalog.ts')
const { allLockedConfig, parsePanelLocks, LOCKED_PANELS, PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const PW = DEFAULT_MANAGER_PASSWORD
const W1 = 7101, W2 = 7102

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' · ' + extra : ''}`) }
}
const outcome = async (fn) => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } }
const inCall = (owner, fn) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, fn))
const setLocks = (locks) => seed.setting(SETTING_KEYS.panelLocks, locks)
const lockoutRows = () => Number(seed.one('SELECT COUNT(*) AS n FROM "AuthLockout" WHERE failCount > 0')?.n ?? 0)
const resetAll = () => {
  sql.prepare('DELETE FROM "AuthLockout"').run()
  sessions.clearPanelSessions()
  tickets.clearGateTickets()
  setLocks({})
}

/** همان شکل پوشاندن جاهای واقعی (§۳-۵) برای یک شناسه */
function wrapped(id, password) {
  const e = GATE_CATALOG[id]
  if (e.origin === 'SESSION') return gateSession(id, () => sessions.assertManagerSession(e.titleFa))
  if (e.origin === 'STRICT') return gateAction(id, () => auth.assertPanelPasswordStrict(e.parentPanel, password, e.titleFa))
  return gateAction(id, () => auth.assertManagerPassword(password, e.titleFa))
}
const gate = (id, password = '', owner = W1) => outcome(() => inCall(owner, () => wrapped(id, password)))
const required = (r, id) => !r.ok && r.err?.code === `GATE_REQUIRED:${id}`

try {
  console.log('\n— ۰) پیش‌فرض نصب: همهٔ ۸۴ کلید روشن، جز «پنل فروش» (دفتر آزمون ۴-۵۳)؛ جایگزینِ پیش از خواندن همه را قفل می‌داند')
  ok('۸۴ کلید؛ جایگزینِ پیش از خواندن یا هنگام خطا همه روشن', LOCKED_PANELS.length === 84 && Object.values(allLockedConfig()).every((v) => v === true))
  ok('پیکربندی خالی یعنی همه روشن، جز «پنل فروش»', Object.entries(parsePanelLocks({})).every(([key, v]) => v === (key !== PANEL_KEYS.pos)))

  console.log('\n— ۱) هر ۵۳ شناسهٔ کار، از هر راه')
  let ownPwSet = 0
  for (const id of GATE_ACTION_IDS) {
    const e = GATE_CATALOG[id]
    resetAll()
    const r0 = await gate(id, '')
    const deny = required(r0, id)
    // قفل خاموش (کلیدهای policy را خود صداکننده می‌سنجد)
    setLocks({ [e.lockKey]: false })
    const rOff = await gate(id, '')
    const offOk = e.lockKind === 'panel' ? rOff.ok : required(rOff, id)
    // قفل ماژول مادر خاموش، قفل کار روشن ⇒ همچنان قفل
    setLocks({ [e.lockKey]: true, ...(e.parentPanel && e.parentPanel !== e.lockKey ? { [e.parentPanel]: false } : {}) })
    const rParentOff = await gate(id, '')
    const parentOk = !(e.parentPanel && e.parentPanel !== e.lockKey) || required(rParentOff, id)
    setLocks({})
    // نشست مدیر همین پنجره: بی رمز و با رمز غلط، بی شمارش اشتباه
    sessions.notePanelUnlocked('settings', 'MANAGER', W1)
    const before = lockoutRows()
    const rSession = await gate(id, '')
    const rSessionWrong = await gate(id, 'رمز-غلط-۹۹')
    const sessionOk = rSession.ok && rSessionWrong.ok && lockoutRows() === before
    // همان نشست در پنجرهٔ دیگر بی اثر
    const rOther = await gate(id, '', W2)
    const otherOk = required(rOther, id)
    sessions.clearPanelSessions()
    // رمز مدیر تایپی (کارهای «فقط نشست» رمز ندارند؛ برایشان راه رمز پنجرهٔ قفل است)
    const rPw = e.origin === 'SESSION' ? await outcome(() => inCall(W1, () => unlockActionWithPassword(id, PW))) : await gate(id, PW)
    tickets.clearGateTickets()
    // رمز دوم جدای خود «قفل کار» (یا همان کلید برای استثناها)
    await auth.authService.setPanelPassword({ panel: e.lockKey, managerPassword: PW, password: '7714' })
    ownPwSet++
    const rOwn = e.origin === 'SESSION' ? await outcome(() => inCall(W1, () => unlockActionWithPassword(id, '7714'))) : await gate(id, '7714')
    if (e.origin === 'SESSION') tickets.clearGateTickets()
    // رمز دوم ماژول مادر برای strictها
    let rParent = { ok: true }
    if (e.origin === 'STRICT' && e.parentPanel !== e.lockKey) {
      await auth.authService.setPanelPassword({ panel: e.parentPanel, managerPassword: PW, password: '8825' })
      rParent = await gate(id, '8825')
      await auth.authService.setPanelPassword({ panel: e.parentPanel, managerPassword: PW, password: '' })
    }
    await auth.authService.setPanelPassword({ panel: e.lockKey, managerPassword: PW, password: '' })
    // بلیت یک‌بار: فقط یک بار و فقط همین پنجره
    tickets.addGateTicket(W1, id, 60_000, 'REMOTE_GRANT')
    const rT2 = await gate(id, '', W2)
    const rT1 = await gate(id, '')
    const rT1again = await gate(id, '')
    const ticketOk = required(rT2, id) && rT1.ok && required(rT1again, id)
    ok(`${id}: رد بی رمز با GATE_REQUIRED · قفل خاموش · مادر خاموش ≠ کار · نشست مدیر · پنجرهٔ دیگر · رمز مدیر · رمز دوم خود کار · رمز مادر · بلیت یک‌بار`,
      deny && offOk && parentOk && sessionOk && otherOk && rPw.ok && rOwn.ok && rParent.ok && ticketOk,
      JSON.stringify({ deny, offOk, parentOk, sessionOk, otherOk, pw: rPw.ok, own: rOwn.ok, parent: rParent.ok, ticketOk, err: [r0, rPw, rOwn, rParent].find((x) => !x.ok)?.err?.message?.slice(0, 120) }))
  }
  ok('رمز دوم برای هر کلید کار گذاشته و برداشته شد', ownPwSet === GATE_ACTION_IDS.length)

  console.log('\n— ۲) رمز سوم همان کار در همان شیفت')
  resetAll()
  seed.insert('Shift', { name: 'شیفت آزمون دروازه', number: 1, dayJalali: '1405/09/01', openedAt: Date.now() - 60_000, userId: seed.user('کارمند دروازه') })
  await auth.authService.setPanelShiftPassword({ panel: PANEL_KEYS.actForceStaffChange, shift: 1, managerPassword: PW, password: '6193' })
  ok('رمز سوم «تعویض اجباری کارمند نشست» در شیفت ۱ کار را باز می‌کند', (await gate('shift.force-staff-change', '6193')).ok)
  ok('رمز سوم یک کار، کار دیگر را باز نمی‌کند', !(await gate('shift.close-stale-session', '6193')).ok)
  sql.prepare('DELETE FROM "AuthLockout"').run()

  console.log('\n— ۳) هفت قسمت تازه (امروز «فقط نشست مدیر»)')
  for (const key of GATE_PART_KEYS) {
    resetAll()
    const r0 = await gate(key, '')
    setLocks({ [key]: false })
    const rOff = await gate(key, '')
    setLocks({})
    sessions.notePanelUnlocked(key, 'PANEL', W1)
    const rPanel = await gate(key, '')
    const rOther = await gate(key, '', W2)
    sessions.clearPanelSessions()
    sessions.noteRemotePanelUnlocked(key, W1, () => true)
    const rRemote = await gate(key, '')
    ok(`${key}: رد با GATE_REQUIRED · قفل خاموش · رمز دوم همین قسمت · پنجرهٔ دیگر بی اثر · مجوز گوشی`,
      required(r0, key) && rOff.ok && rPanel.ok && required(rOther, key) && rRemote.ok)
  }

  console.log('\n— ۴) دستهٔ ۱ («کلیدسازی») فقط با خود مدیر')
  resetAll()
  sessions.notePanelUnlocked('settings', 'MANAGER', W1)
  const k1 = await outcome(() => inCall(W1, () => gateAction('keys.security-config', () => auth.assertManagerPassword('', 'تنظیمات امنیتی'))))
  ok('نشست مدیر بی رمز تایپی، کلیدسازی تایپی را باز نمی‌کند (رفتار امروز)', !k1.ok && !String(k1.err?.code ?? '').startsWith('GATE_REQUIRED'))
  tickets.addGateTicket(W1, 'keys.security-config', 60_000, 'REMOTE_GRANT')
  const k2 = await outcome(() => inCall(W1, () => gateAction('keys.security-config', () => auth.assertManagerPassword('', 'تنظیمات امنیتی'))))
  ok('بلیت هم کلیدسازی را باز نمی‌کند', !k2.ok)
  setLocks({ [PANEL_KEYS.settings]: false })
  const k3 = await outcome(() => inCall(W1, () => gateAction(['keys.panel-locks', 'settings.raw-sensitive'], () => auth.assertManagerPassword(PW, 'قفل‌ها'))))
  ok('فهرست با دستهٔ ۱ فقط با رمز تایپی مدیر می‌گذرد', k3.ok)
  ok('بی بلیت در پنجرهٔ دیگر هم نه (کلید ناشناس یعنی رفتار امروز)', !(await outcome(() => inCall(W2, () => gateAction('no.such.action', () => auth.assertManagerPassword('', 'ناشناس'))))).ok)
  sessions.clearPanelSessions()

  console.log('\n— ۵) بیرون از IPC رفتار عیناً امروز است')
  resetAll()
  sessions.notePanelUnlocked('settings', 'MANAGER')
  const outside = await outcome(() => gateAction('reports.sales-purge', () => auth.assertManagerPassword('', 'پاک‌سازی')))
  ok('نشست جامانده در صاحب صفر هیچ دروازه‌ای را باز نمی‌کند', !outside.ok && !outside.err?.code)
  setLocks({ 'act-sales-reports-purge': false })
  ok('قفل خاموش هم بیرون از IPC همان رفتار امروز (رمز لازم)', !(await outcome(() => gateAction('reports.sales-purge', () => auth.assertManagerPassword('', 'پاک‌سازی')))).ok)
  sessions.clearPanelSessions()

  console.log('\n— ۶) نشانگر غیرراز (§۳-۶)')
  resetAll()
  const payload = blankGateMarkers({ managerPassword: GATE_PROOF_MARKER, nested: { pin: GATE_PROOF_MARKER, list: [GATE_PROOF_MARKER, 'x'] }, keep: 'a' + GATE_PROOF_MARKER })
  ok('handle() نشانگرِ دقیق را در همهٔ فیلدها (تو در تو و آرایه) خالی می‌کند', payload.managerPassword === '' && payload.nested.pin === '' && payload.nested.list[0] === '' && payload.nested.list[1] === 'x')
  ok('رشتهٔ آمیخته دست نمی‌خورد (normalize نشانگر را برمی‌دارد)', payload.keep === 'a' + GATE_PROOF_MARKER)
  const before6 = lockoutRows()
  const m1 = await gate('reports.sales-purge', GATE_PROOF_MARKER)
  ok('نشانگر بی نشست و بی بلیت ⇒ همان «رمز لازم است» و تلاش اشتباه شمرده نمی‌شود', required(m1, 'reports.sales-purge') && lockoutRows() === before6)
  ok('نشانگر هرگز رمز مدیر نیست', !(await outcome(() => auth.authService.verify({ password: GATE_PROOF_MARKER }))).ok && lockoutRows() === before6)
  ok('رمز دومی برابر نشانگر ساخته نمی‌شود', !(await outcome(() => auth.authService.setPanelPassword({ panel: PANEL_KEYS.products, managerPassword: PW, password: GATE_PROOF_MARKER }))).ok)
  sessions.notePanelUnlocked('settings', 'MANAGER', W1)
  ok('نشانگر با نشست مدیر می‌گذرد', (await gate('reports.sales-purge', GATE_PROOF_MARKER)).ok)
  const panelEmpty = await outcome(() => inCall(W1, () => auth.assertPanelPassword(PANEL_KEYS.products, GATE_PROOF_MARKER, 'کالا')))
  ok('assertPanelPassword: نشانگر با نشست مدیر (درون IPC) پذیرفته', panelEmpty.ok && panelEmpty.value === 'MANAGER')
  sessions.clearPanelSessions()
  sessions.notePanelUnlocked(PANEL_KEYS.products, 'PANEL', W1)
  ok('assertPanelPassword: قسمتِ بازشده با رمز دوم، کار رمزدار را بی تایپ باز نمی‌کند', !(await outcome(() => inCall(W1, () => auth.assertPanelPassword(PANEL_KEYS.products, '', 'کالا')))).ok)
  sessions.clearPanelSessions()
  sessions.noteRemotePanelUnlocked(PANEL_KEYS.products, W1, () => true)
  ok('assertPanelPassword: قسمتِ بازشده با مجوز گوشی می‌پذیرد', (await outcome(() => inCall(W1, () => auth.assertPanelPassword(PANEL_KEYS.products, '', 'کالا')))).ok)
  ok('assertPanelPassword: بیرون از IPC همان رفتار امروز', !(await outcome(() => sessions.runWithPanelSessionOwner(W1, () => auth.assertPanelPassword(PANEL_KEYS.products, '', 'کالا')))).ok)
  sessions.clearPanelSessions()

  console.log('\n— ۷) یک بلیت = یک فراخوانی (بازگردانی و چاپ دوبارهٔ مدیر دو بار می‌سنجند)')
  for (const id of ['backup.restore', 'credit.reprint-manager']) {
    resetAll()
    const e = GATE_CATALOG[id]
    tickets.addGateTicket(W1, id, 60_000, 'REMOTE_GRANT')
    const twice = await outcome(() => inCall(W1, async () => {
      if (id === 'credit.reprint-manager') await gateSession(id, () => sessions.assertManagerSession('چاپ اعتبار خرید'))
      else await gateAction(id, () => auth.assertPanelPasswordStrict(e.parentPanel, '', e.titleFa))
      return gateAction(id, () => auth.assertPanelPasswordStrict(e.parentPanel, '', e.titleFa))
    }))
    ok(`${id}: یک بلیت هر دو سنجش همان فراخوانی را می‌گذراند`, twice.ok && tickets.gateTicketCount() === 0)
    ok(`${id}: فراخوانی بعدی بی بلیت رد می‌شود`, required(await gate(id, ''), id))
  }
  resetAll()
  tickets.addGateTicket(W1, 'sales.overpay-credit-above-cap', 60_000, 'REMOTE_GRANT')
  const probe = await outcome(() => inCall(W1, async () => [await gateProbe('sales.overpay-credit-above-cap'), await gateProbe('sales.overpay-credit-above-cap')]))
  ok('preverifyOverpayManager: پرسش بی رد با بلیت true، دوباره در همان فراخوانی هم true', probe.ok && probe.value[0] === true && probe.value[1] === true)
  ok('پرسش بی بلیت و بی نشست false (رد نمی‌کند)', (await outcome(() => inCall(W1, () => gateProbe('sales.overpay-credit-above-cap')))).value === false)

  console.log('\n— ۸) خط «روش تأیید» فقط برای روش‌های تازه (§۳-۹)')
  resetAll()
  const lastNote = () => seed.one('SELECT note FROM "AuditLog" ORDER BY id DESC LIMIT 1')?.note ?? null
  const writeRow = (note) => audit(db, { action: 'SALE_PURGE', entity: 'Test', note })
  await inCall(W1, async () => { await wrapped('reports.sales-purge', PW); await writeRow('ردیف امروز') })
  ok('رمز تایپی مدیر ⇒ note بی‌تغییر', lastNote() === 'ردیف امروز')
  sessions.notePanelUnlocked('settings', 'MANAGER', W1)
  await inCall(W1, async () => { await wrapped('reports.sales-purge', ''); await writeRow('ردیف با نشست') })
  ok('نشست مدیر جای رمز تایپی ⇒ «روش تأیید: نشست مدیر»', lastNote() === 'ردیف با نشست\nروش تأیید: نشست مدیر')
  await inCall(W1, async () => { await wrapped('credit.code-reveal', ''); await writeRow('نمایش کد') })
  ok('نشست مدیر در جای «فقط نشست» ⇒ بی خط تازه', lastNote() === 'نمایش کد')
  sessions.clearPanelSessions()
  setLocks({ 'act-sales-reports-purge': false })
  await inCall(W1, async () => { await wrapped('reports.sales-purge', ''); await writeRow(null) })
  ok('قفل خاموش ⇒ «روش تأیید: قفل این کار خاموش بود»', lastNote() === 'روش تأیید: قفل این کار خاموش بود')
  setLocks({})
  tickets.addGateTicket(W1, 'reports.sales-purge', 60_000, 'REMOTE_GRANT')
  await inCall(W1, async () => { await wrapped('reports.sales-purge', ''); await audit(db, { action: 'ACCESS_EVENT', entity: 'Access', after: '{}' }); await writeRow('با مجوز') })
  ok('مجوز راه دور ⇒ «روش تأیید: مجوز راه دور»', lastNote() === 'با مجوز\nروش تأیید: مجوز راه دور')
  ok('ردیف ACCESS_EVENT خط روش نمی‌گیرد', seed.one('SELECT note FROM "AuditLog" WHERE action = ? ORDER BY id DESC LIMIT 1', 'ACCESS_EVENT')?.note == null)
  ok('بیرون از فراخوانی IPC بافتی نیست', currentGateCall() === null)
} finally {
  sessions.clearPanelSessions()
  tickets.clearGateTickets()
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} بررسی موفق · ${fail} ناموفق`)
process.exit(fail ? 1 : 0)
