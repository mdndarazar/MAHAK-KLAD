/**
 * طرح ۱۴۰۵ · مرحلهٔ ۶ — کدهای یک‌بارمصرف دوقسمتی و مدت‌ها (معماری §۳-۱۵، §۳-۱۳؛ §۸-۲ بندهای ۷، ۸ و ۹).
 *
 * با همان تابع‌های واقعی AuthService، panelSession، دروازه و پروندهٔ کدها، روی پایگاه دادهٔ موقت و پوشهٔ موقت:
 *   هر کد یک بار؛ کدِ قسمت دیگر شمرده و مصرف‌نشده؛ ۵ اشتباه و قفل ۱۵ دقیقه؛ شمارندهٔ جدا از رمز مدیر؛ ساخت یک قسمت
 *   قسمت دیگر را باطل نمی‌کند؛ قاعده‌های کد دست‌نویس (۸ رقم، ساده، تکراری، برابر رمزها)؛ زنده نشدن پس از شروع دوباره
 *   و بیرون بودن از پایگاه داده؛ ⚠️ کد حساس؛ پروندهٔ خراب یعنی همه باطل؛ دو مصرف هم‌زمان یک کد؛ برداشتن قفل با رمز
 *   تایپی مدیر؛ کد روی قسمتِ از قبل باز و روی قفل خاموش مصرف نمی‌شود؛ مدت‌های ۶ و ۱۲ دقیقه و بی‌کاری یک‌پنجم؛
 *   تغییر مدت روی کد مصرف‌نشده اثر دارد و روی قفل باز نه؛ «بستن همه» نشست کد را می‌بندد و کدها را باطل نمی‌کند؛
 *   خط «روش تأیید» با شمارهٔ کد. هیچ پایگاه دادهٔ واقعی لمس نمی‌شود.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-one-time-codes.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'plan1405-codes-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const auth = await import('../../src/main/services/AuthService.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { gateAction } = await import('../../src/main/services/locks/gate.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const codes = await import('../../src/main/services/locks/oneTimeCodes.ts')
const unlocks = await import('../../src/main/services/locks/unlocks.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const { codeTargetOf, redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { writeLockDurations } = await import('../../src/main/services/locks/durations.ts')
const { audit } = await import('../../src/main/services/AuditService.ts')
const { GATE_CATALOG, GATE_ACTION_IDS, GATE_PART_KEYS } = await import('../../src/shared/gateCatalog.ts')
const { LOCKED_PANELS, PANEL_KEYS, codeSectionOfPanel } = await import('../../src/shared/panels.ts')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('../../src/shared/receipt.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
let PW = DEFAULT_MANAGER_PASSWORD
const W1 = 8101, W2 = 8102

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' · ' + extra : ''}`) }
}
const outcome = async (fn) => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } }
const inCall = (owner, fn) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, fn))
const redeem = (target, code, owner = W1) => outcome(() => inCall(owner, () => redeemOneTimeCode(target, code)))
const events = []
setAccessEventWriter((after, userId, action) => { events.push({ ...after, action }) })
const eventsOf = (kind) => events.filter((e) => e.kind === kind)
let mono = 1_000_000
unlocks.setUnlockClockForTests(() => mono)
let wall = Date.now()
codes.setCodeClockForTests(() => wall)
const managerLockoutRows = () => Number(seed.one('SELECT COUNT(*) AS n FROM "AuthLockout" WHERE failCount > 0')?.n ?? 0)
const create = (section, extra = {}) => lockIpc.createCodes({ section, managerPassword: PW, ...extra })
const plain = (list) => list.map((c) => c.code)

try {
  console.log('\n— ۰) رده‌بندی: هر کلید دقیقاً در یکی از دو قسمت؛ کارها و قسمت‌های تازه «حساس»؛ کلیدسازی و ناشناس رد')
  const sections = LOCKED_PANELS.map((p) => codeSectionOfPanel(p.key))
  ok('هر ۸۰ کلید یک قسمت دارد', sections.every((s) => s === 'sensitive' || s === 'other'))
  ok('۲۵ قسمت عادی ⇒ «سایر ماژول‌ها»', LOCKED_PANELS.filter((p) => codeSectionOfPanel(p.key) === 'other').length === 25)
  ok('۱۲ قسمت پولی ⇒ «حساس»', LOCKED_PANELS.filter((p) => p.tier === 'money').every((p) => codeSectionOfPanel(p.key) === 'sensitive') && LOCKED_PANELS.filter((p) => p.tier === 'money').length === 12)
  ok('هر ۴۸ کار هدف «حساس» و از نوع «کار»', GATE_ACTION_IDS.every((id) => { const t = codeTargetOf(id); return t && t.kind === 'action' && t.section === 'sensitive' }))
  ok('هفت قسمت تازه «حساس» و از نوع «قسمت»', GATE_PART_KEYS.every((id) => { const t = codeTargetOf(id); return t && t.kind === 'part' && t.section === 'sensitive' }))
  ok('کلیدسازی، کلید `act-*` و ناشناس هدف نیستند', [ 'keys.panel-locks', 'keys.security-config', 'act-backup-restore', 'nope', '', null ].every((x) => codeTargetOf(x) === null))
  ok('قسمت woo-sync «سایر ماژول‌ها»، کار woo.disconnect «حساس»', codeTargetOf('woo-sync')?.section === 'other' && codeTargetOf('woo.disconnect')?.section === 'sensitive')

  console.log('\n— ۱) قالب، قاعده‌های کد دست‌نویس و ساخت تصادفی')
  ok('رقم فارسی، خط تیره و فاصله یکسان', codes.normalizeOneTimeCode('۴۸۲۱-۰۹۳۷') === '48210937' && codes.normalizeOneTimeCode(' 4821 0937 ') === '48210937')
  ok('کمتر یا بیشتر از ۸ رقم یا حرف ⇒ نامعتبر', ['1234567', '123456789', '1234567a', ''].every((c) => codes.normalizeOneTimeCode(c) === null))
  ok('ساده: همه یک رقم و پشت‌سرهم', ['11111111', '12345678', '87654321', '01234567', '98765432'].every(codes.weakOneTimeCode) && !codes.weakOneTimeCode('48210937'))
  const random = codes.prepareOneTimeCodes('random', null)
  ok('ساخت تصادفی: ۵ کد ۸ رقمی، نه ساده، نه تکراری', random.length === 5 && new Set(random).size === 5 && random.every((c) => /^\d{8}$/.test(c) && !codes.weakOneTimeCode(c)))
  for (const [label, list] of [['چهار کد', ['48210937', '59302148', '60413259', '71524360']], ['ساده', ['48210937', '59302148', '60413259', '71524360', '12345678']],
    ['تکراری', ['48210937', '59302148', '60413259', '71524360', '4821-0937']], ['هفت رقم', ['4821093', '59302148', '60413259', '71524360', '82635471']]]) {
    const r = await outcome(() => create('sensitive', { mode: 'own', codes: list }))
    ok(`دست‌نویس رد: ${label}`, !r.ok && /کد|دقیقاً/.test(r.err?.message ?? ''), r.err?.message)
  }
  await auth.authService.setPanelPassword({ panel: PANEL_KEYS.products, managerPassword: PW, password: '73915264' })
  const rSecond = await outcome(() => create('other', { mode: 'own', codes: ['48210937', '59302148', '73915264', '71524360', '82635471'] }))
  ok('دست‌نویس برابر رمز دوم یک قسمت رد', !rSecond.ok && /رمزهای برنامه/.test(rSecond.err?.message ?? ''), rSecond.err?.message)
  await auth.authService.changePassword({ current: PW, next: '58204716' })
  const rManager = await outcome(() => lockIpc.createCodes({ section: 'other', managerPassword: '58204716', mode: 'own', codes: ['48210937', '58204716', '60413259', '71524360', '82635471'] }))
  ok('دست‌نویس برابر رمز مدیر رد', !rManager.ok && /رمزهای برنامه/.test(rManager.err?.message ?? ''), rManager.err?.message)
  PW = '58204716' // رمز اولیه دوباره پذیرفته نمی‌شود؛ بقیهٔ آزمون با رمز تازهٔ مدیر
  const rNoPw = await outcome(() => lockIpc.createCodes({ section: 'other', managerPassword: '', mode: 'random' }))
  ok('ساخت بی رمز تایپی مدیر رد (کلیدسازی)', !rNoPw.ok)
  const rSession = await outcome(() => inCall(W1, async () => { sessions.notePanelUnlocked('settings', 'MANAGER', W1); return lockIpc.createCodes({ section: 'other', managerPassword: '', mode: 'random' }) }))
  ok('نشست مدیر هم جای رمز تایپی را نمی‌گیرد', !rSession.ok)
  sessions.clearPanelSessions()

  console.log('\n— ۲) ساخت هر دو قسمت؛ فقط یک بار نمایش؛ فقط hash در پروندهٔ بیرون از پایگاه داده')
  const S = await create('sensitive', { mode: 'own', codes: ['48210937', '59302148', '60413259', '71524360', '82635471'] })
  const O = await create('other')
  ok('۵ کد شماره‌دار با قالب ۴-۴', S.codes.length === 5 && S.codes.every((c, i) => c.n === i + 1 && /^\d{4}-\d{4}$/.test(c.code)) && O.codes.length === 5)
  const file = readFileSync(join(DIR, 'one-time-codes.json'), 'utf8')
  ok('پرونده کد خام ندارد، فقط hash', !plain(S.codes).concat(plain(O.codes)).some((c) => file.includes(c.replace('-', ''))) && /"hash"/.test(file))
  ok('هیچ ردیف Setting یا AuditLog کد خام ندارد', !plain(S.codes).some((c) => JSON.stringify(sql.prepare('SELECT * FROM "Setting"').all()).includes(c.replace('-', '')) || JSON.stringify(sql.prepare('SELECT * FROM "AuditLog"').all()).includes(c.replace('-', ''))))
  ok('دو ردیف CODES_CREATED', eventsOf('CODES_CREATED').length === 2)
  const st0 = lockIpc.codesStatus()
  ok('وضعیت: «۵ از ۵» هر قسمت و مدت‌های پیش‌فرض ۱۰', st0.sections.sensitive.remaining === 5 && st0.sections.other.remaining === 5 && st0.sensitiveCodeMinutes === 10 && st0.otherCodeMinutes === 10)
  const dup = await outcome(() => create('other', { mode: 'own', codes: ['48210937', '93746152', '60413258', '71524369', '82635470'] }))
  ok('دست‌نویس برابر کد فعال قسمت دیگر رد', !dup.ok && /قسمت دیگر/.test(dup.err?.message ?? ''), dup.err?.message)

  console.log('\n— ۳) مصرف: قسمت عادی با «سایر»، پولی و تازه و کار با «حساس»؛ کدِ قسمت دیگر شمرده و مصرف‌نشده')
  const products = PANEL_KEYS.products, cashClose = PANEL_KEYS.cashClose
  let r = await redeem(products, S.codes[0].code)
  ok('کد حساس روی قسمت عادی رد با «برای این ماژول نیست»', !r.ok && /برای این ماژول نیست/.test(r.err?.message ?? ''))
  ok('… و مصرف نشد', lockIpc.codesStatus().sections.sensitive.remaining === 5)
  r = await redeem(products, O.codes[0].code)
  ok('کد «سایر» قسمت عادی را باز کرد (مدت ۱۰)', r.ok && r.value.kind === 'part' && r.value.minutes === 10 && r.value.number === 1)
  ok('نشست نگهبان‌دار همان پنجره، نه پنجرهٔ دیگر', sessions.isPanelUnlocked(products, W1) && !sessions.isPanelUnlocked(products, W2) && sessions.isGuardedPanelOpen(products, W1))
  r = await redeem(products, O.codes[0].code, W2)
  ok('هر کد فقط یک بار (پنجرهٔ دیگر هم نه)', !r.ok)
  r = await redeem(cashClose, O.codes[1].code)
  ok('کد «سایر» روی قسمت پولی رد', !r.ok && lockIpc.codesStatus().sections.other.remaining === 4)
  r = await redeem(cashClose, S.codes[0].code)
  ok('کد حساس قسمت پولی را باز کرد', r.ok && r.value.section === 'sensitive')
  r = await redeem('staff', S.codes[1].code)
  ok('کد حساس قسمت تازهٔ «کارمندان» را باز کرد', r.ok && r.value.kind === 'part')
  r = await redeem('credit.void', O.codes[2].code)
  ok('کد «سایر» روی قفل کار رد', !r.ok)
  r = await redeem('keys.panel-locks', S.codes[2].code)
  ok('کلیدسازی با کد رد (پیش‌فرض رد) و کد مصرف نشد', !r.ok && lockIpc.codesStatus().sections.sensitive.remaining === 3)
  const usedEvents = eventsOf('CODE_USED')
  ok('CODE_USED با شمارهٔ کد، پنجره و قسمت (بی کد خام)', usedEvents.length === 3 && usedEvents.every((e) => e.number >= 1 && e.windowNo === W1 && (e.decision === 'حساس' || e.decision === 'سایر ماژول‌ها')) && !JSON.stringify(events).includes(S.codes[0].code.replace('-', '')))
  ok('CODE_WRONG برای هر اشتباه', eventsOf('CODE_WRONG').length >= 3)

  console.log('\n— ۴) قفل کار: بلیت یک‌بار با کد حساس، فقط همان پنجره، با خط «روش تأیید»')
  lockIpc.closeAllUnlocks()
  sql.prepare('DELETE FROM "AuthLockout"').run()
  const voidEntry = GATE_CATALOG['credit.void']
  r = await redeem('credit.void', S.codes[2].code)
  ok('کد حساس ⇒ بلیت یک‌بار (کار)', r.ok && r.value.kind === 'action' && tickets.peekGateTicket(W1, 'credit.void') && !tickets.peekGateTicket(W2, 'credit.void'))
  r = await redeem('credit.void', S.codes[3].code)
  ok('با بلیت زنده، کد دوم مصرف نمی‌شود', !r.ok && lockIpc.codesStatus().sections.sensitive.remaining === 2)
  let note = null
  const g1 = await outcome(() => inCall(W1, async () => {
    await gateAction('credit.void', () => auth.assertPanelPasswordStrict(voidEntry.parentPanel, '', voidEntry.titleFa))
    const row = await audit(db, { action: 'CREDIT_VOID', entity: 'StoreCredit', note: null })
    note = seed.one('SELECT note FROM "AuditLog" ORDER BY id DESC LIMIT 1')?.note
    return row
  }))
  ok('دروازه با بلیت کد گذشت', g1.ok, g1.err?.message)
  ok('خط «روش تأیید: کد یک‌بارمصرف حساس شمارهٔ ۳»', note === 'روش تأیید: کد یک‌بارمصرف حساس شمارهٔ 3', String(note))
  const g2 = await outcome(() => inCall(W1, () => gateAction('credit.void', () => auth.assertPanelPasswordStrict(voidEntry.parentPanel, '', voidEntry.titleFa))))
  ok('فراخوانی بعدی بی بلیت رد (یک بار)', !g2.ok && g2.err?.code === 'GATE_REQUIRED:credit.void')

  console.log('\n— ۵) قسمتِ از قبل باز، قفل خاموش، و «روش تأیید» درون قسمت بازشده با کد')
  sessions.notePanelUnlocked('settings', 'MANAGER', W1)
  r = await redeem(PANEL_KEYS.stocktake, O.codes[1].code)
  ok('با نشست مدیر: «همین حالا باز است» و کد مصرف نشد', !r.ok && /همین حالا باز است/.test(r.err?.message ?? '') && lockIpc.codesStatus().sections.other.remaining === 4)
  sessions.clearPanelSessions()
  seed.setting(SETTING_KEYS.panelLocks, { [PANEL_KEYS.stocktake]: false })
  r = await redeem(PANEL_KEYS.stocktake, O.codes[1].code)
  ok('قفل خاموش: «کد لازم نیست» و مصرف نشد', !r.ok && /خاموش/.test(r.err?.message ?? '') && lockIpc.codesStatus().sections.other.remaining === 4)
  seed.setting(SETTING_KEYS.panelLocks, {})
  r = await redeem(PANEL_KEYS.stocktake, O.codes[1].code)
  ok('کد «سایر» شمارهٔ ۲ انبارگردانی را باز کرد', r.ok && r.value.number === 2)
  r = await redeem(PANEL_KEYS.stocktake, O.codes[2].code)
  ok('روی همان قسمتِ بازشده با کد، کد دیگر مصرف نمی‌شود', !r.ok && lockIpc.codesStatus().sections.other.remaining === 3)
  let partNote = null
  await inCall(W1, async () => {
    await auth.assertPanelPassword(PANEL_KEYS.stocktake, '', 'زمان‌بندی انبارگردانی')
    await audit(db, { action: 'STOCKTAKE_SCHEDULE', entity: 'Stocktake', note: null })
    partNote = seed.one('SELECT note FROM "AuditLog" ORDER BY id DESC LIMIT 1')?.note
  })
  ok('رمز داخل قسمتِ بازشده با کد بی تایپ، با «روش تأیید: کد یک‌بارمصرف شمارهٔ ۲»', partNote === 'روش تأیید: کد یک‌بارمصرف شمارهٔ 2', String(partNote))

  console.log('\n— ۶) مدت‌ها: ۶ دقیقه برای «حساس»، ۱۲ برای «سایر»؛ بی‌کاری یک‌پنجم (کمینه ۳)؛ تغییر روی قفل باز اثر ندارد')
  lockIpc.closeAllUnlocks()
  await lockIpc.setLockDurations({ managerPassword: PW, sensitiveCodeMinutes: 6, otherCodeMinutes: 12 })
  r = await redeem(cashClose, S.codes[3].code)
  ok('کد حساس با مدت ۶', r.ok && r.value.minutes === 6)
  let open = true
  for (let i = 0; i < 6; i++) { mono += 59_000; open = open && sessions.isPanelUnlocked(cashClose, W1) }
  ok('۵:۵۴ با استفاده‌های پیاپی هنوز باز', open)
  mono += 7_000
  ok('پس از ۶ دقیقه بسته (حتی با استفاده)', !sessions.isPanelUnlocked(cashClose, W1))
  r = await redeem(products, O.codes[2].code)
  ok('کد «سایر» با مدت ۱۲', r.ok && r.value.minutes === 12)
  await lockIpc.setLockDurations({ managerPassword: PW, otherCodeMinutes: 1 })
  mono += 2 * 60_000 + 50_000
  ok('تغییر مدت به ۱، قفل بازِ ۱۲ دقیقه‌ای را نمی‌بندد (۲:۵۰ بی‌کار، هنوز باز)', sessions.isPanelUnlocked(products, W1))
  mono += 3 * 60_000 + 1_000
  ok('بی‌کاری ۳ دقیقه (یک‌پنجمِ ۱۲، کمینه ۳) آن را بست', !sessions.isPanelUnlocked(products, W1))
  r = await redeem(products, O.codes[3].code)
  ok('کد مصرف‌نشده با مدت تازه (۱ دقیقه) باز شد', r.ok && r.value.minutes === 1)
  mono += 61_000
  ok('مدت ۱ دقیقه: بسته (قاعدهٔ بی‌کاری اثری ندارد)', !sessions.isPanelUnlocked(products, W1))
  sessions.applyPanelSessionTtlMinutes(2)
  await lockIpc.setLockDurations({ managerPassword: PW, sensitiveCodeMinutes: 60 })
  r = await redeem('staff', S.codes[4].code)
  mono += 9 * 60_000
  ok('بی‌کاری عمومی پنل (۲ دقیقه) نشست کد ۶۰ دقیقه‌ای را نمی‌بندد؛ بی‌کاری خودش ۱۰ دقیقه است', r.ok && sessions.isPanelUnlocked('staff', W1))
  mono += 10 * 60_000 + 1_000
  ok('… و پس از ۱۰ دقیقه کار نکردن بسته', !sessions.isPanelUnlocked('staff', W1))
  sessions.applyPanelSessionTtlMinutes(5)
  await lockIpc.setLockDurations({ managerPassword: PW, sensitiveCodeMinutes: 10, otherCodeMinutes: 10 })

  console.log('\n— ۷) ۵ اشتباه ⇒ ۱۵ دقیقه قفل؛ شمارندهٔ جدا از رمز مدیر؛ برداشتن قفل با رمز تایپی مدیر')
  const sensitiveBefore = lockIpc.codesStatus().sections.sensitive
  const O2 = await create('other')
  const sensitiveAfter = lockIpc.codesStatus().sections.sensitive
  ok('ساخت «سایر» کدهای «حساس» را باطل نکرد', sensitiveAfter.total === 5 && sensitiveAfter.remaining === sensitiveBefore.remaining && sensitiveAfter.createdAt === sensitiveBefore.createdAt)
  ok('ساخت تازهٔ «سایر» همهٔ کدهای قبلی همان قسمت را باطل کرد', lockIpc.codesStatus().sections.other.remaining === 5 && !(await redeem(PANEL_KEYS.purchase, O.codes[4].code)).ok)
  ok('مصرف موفق شمارندهٔ اشتباه را صفر می‌کند', (await redeem(PANEL_KEYS.stocktake, O2.codes[4].code)).ok)
  lockIpc.closeAllUnlocks()
  const beforeLock = managerLockoutRows()
  for (let i = 0; i < 4; i++) await redeem(products, '1357-9246')
  r = await redeem(products, '1357-9246')
  ok('پنجمین اشتباه قفل کرد (پیام ۱۵ دقیقه)', !r.ok && /۱۵ دقیقه قفل/.test(r.err?.message ?? ''), r.err?.message)
  ok('ردیف AUTH_LOCKOUT ثبت شد', events.some((e) => e.action === 'AUTH_LOCKOUT' && e.kind === 'ONE_TIME_CODES'))
  const lockedRemaining = lockIpc.codesStatus().sections.other.remaining
  r = await redeem(products, O2.codes[0].code)
  ok('در قفل، کد درست هم پذیرفته نمی‌شود و مصرف نمی‌شود', !r.ok && /قفل است/.test(r.err?.message ?? '') && lockIpc.codesStatus().sections.other.remaining === lockedRemaining)
  ok('شمارندهٔ رمز مدیر دست نخورد', managerLockoutRows() === beforeLock)
  ok('رمز مدیر همچنان کار می‌کند', (await outcome(() => auth.assertManagerPassword(PW, 'آزمون'))).ok)
  codes.resetOneTimeCodesCacheForTests()
  ok('قفل پس از شروع دوباره هم می‌ماند (روی پرونده)', lockIpc.codesStatus().lockedMs > 14 * 60_000)
  const unlockNoPw = await outcome(() => lockIpc.unlockCodes({ managerPassword: '' }))
  ok('برداشتن قفل بی رمز تایپی رد', !unlockNoPw.ok)
  await lockIpc.unlockCodes({ managerPassword: PW })
  r = await redeem(products, O2.codes[0].code)
  ok('پس از برداشتن قفل به دست مدیر، کد درست کار کرد', r.ok)
  ok('ردیف CODES_UNLOCKED', eventsOf('CODES_UNLOCKED').length === 1)
  lockIpc.closeAllUnlocks()
  for (let i = 0; i < 5; i++) await redeem(products, '1357-9246')
  wall += 15 * 60_000 + 1000
  r = await redeem(products, O2.codes[1].code)
  ok('پس از ۱۵ دقیقه قفل خودش برداشته می‌شود', r.ok)

  console.log('\n— ۸) دو مصرف هم‌زمان یک کد؛ زنده نشدن پس از شروع دوباره؛ «بستن همه» کدها را باطل نمی‌کند')
  lockIpc.closeAllUnlocks()
  const [a, b] = await Promise.all([redeem(PANEL_KEYS.purchase, O2.codes[2].code, W1), redeem(PANEL_KEYS.purchase, O2.codes[2].code, W2)])
  ok('از دو پنجرهٔ هم‌زمان فقط یکی موفق', [a, b].filter((x) => x.ok).length === 1)
  codes.resetOneTimeCodesCacheForTests()
  r = await redeem(PANEL_KEYS.secondaryStock, O2.codes[2].code, W2)
  ok('پس از شروع دوباره، کد مصرف‌شده زنده نمی‌شود', !r.ok)
  const remainingBefore = lockIpc.codesStatus().sections.other.remaining
  lockIpc.closeAllUnlocks({ cancelFuture: true })
  ok('«بستن همه» نشست‌های کد را بست', !sessions.isPanelUnlocked(PANEL_KEYS.purchase, W1) && !sessions.isPanelUnlocked(PANEL_KEYS.purchase, W2) && unlocks.guardedParts().length === 0)
  ok('… و هیچ کدی را باطل نکرد', lockIpc.codesStatus().sections.other.remaining === remainingBefore)

  console.log('\n— ۹) باطل کردن یک قسمت (کلیدسازی)؛ پروندهٔ خراب یعنی همه باطل، با ⚠️ یک بار')
  const rv = await outcome(() => lockIpc.revokeCodes({ section: 'other', managerPassword: '' }))
  ok('باطل کردن بی رمز تایپی رد', !rv.ok)
  await lockIpc.revokeCodes({ section: 'other', managerPassword: PW })
  ok('«سایر» باطل شد، «حساس» ماند', lockIpc.codesStatus().sections.other === null && lockIpc.codesStatus().sections.sensitive.total === 5)
  r = await redeem(products, O2.codes[3].code)
  ok('کد باطل‌شده کار نمی‌کند', !r.ok)
  const S2 = await create('sensitive')
  writeFileSync(join(DIR, 'one-time-codes.json'), '{"version":1,"sections":{"sensitive":{"salt":"zz"}}}')
  codes.resetOneTimeCodesCacheForTests()
  const brokenBefore = eventsOf('CODES_FILE_BROKEN').length
  r = await redeem(cashClose, S2.codes[0].code)
  const r2 = await redeem(cashClose, S2.codes[1].code)
  ok('پروندهٔ خراب: هیچ کدی پذیرفته نمی‌شود (هرگز «همه باز»)', !r.ok && !r2.ok && !sessions.isPanelUnlocked(cashClose, W1))
  ok('⚠️ «پروندهٔ کدها خراب بود» فقط یک بار', eventsOf('CODES_FILE_BROKEN').length === brokenBefore + 1)
  ok('وضعیت «خراب» برای صفحهٔ مدیر', lockIpc.codesStatus().broken === true)
  const fresh = await create('sensitive')
  r = await redeem(cashClose, fresh.codes[0].code)
  ok('ساخت تازه پروندهٔ خراب را جایگزین کرد و کد کار کرد', r.ok && lockIpc.codesStatus().broken === false && existsSync(join(DIR, 'one-time-codes.json')))
} finally {
  unlocks.setUnlockClockForTests(null)
  codes.setCodeClockForTests(null)
  await db.$disconnect?.()
}

console.log(`\nplan1405-one-time-codes: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
