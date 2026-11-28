/**
 * دفتر آزمون ۴-۴۵ — کدهای یک‌بارمصرف یک دسته شوند.
 *
 *  - یک دستهٔ ۵ کدی؛ هر کد روی قسمت عادی، قسمت پولی، قسمت تازه و قفل کار یک بار کار می‌کند؛ «کلیدسازی» رد و کد مصرف نمی‌شود؛
 *  - مدت از نوع چیزی که باز می‌شود: ماژول‌های پولی و قفل‌های کار با «مدت باز ماندن ماژول‌های پولی با کد»، بقیه با
 *    «مدت باز ماندن سایر ماژول‌ها با کد»؛
 *  - کدهای مصرف‌نشدهٔ دو دستهٔ امروز (پروندهٔ دوجاییِ برنامهٔ پیشین) تا ساخت کد تازه روی همه کار می‌کنند؛ ساخت تازه یا
 *    «باطل کردن کدها» همه را باطل می‌کند؛
 *  - ردیف سابقه و پیام «حساس» یا «سایر» نمی‌نویسند؛ هر مصرف ⚠️؛ «روش تأیید: کد یک‌بارمصرف شمارهٔ n»؛
 *  - صفحه: یک جعبه (ساخت تصادفی، خودم می‌نویسم، باطل کردن کدها، شمار باقی‌مانده، برداشتن قفل) و دو مدت با فهرست‌هایشان.
 *
 * اجرا:
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-45-one-set.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-45-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const sessions = await import('../../src/main/services/panelSession.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const codes = await import('../../src/main/services/locks/oneTimeCodes.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { audit } = await import('../../src/main/services/AuditService.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { gateAction } = await import('../../src/main/services/locks/gate.ts')
const { redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { LOCK_DURATION_TITLES } = await import('../../src/main/services/locks/durations.ts')
const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { GATE_CATALOG } = await import('../../src/shared/gateCatalog.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const src = (p) => readFileSync(join(ROOT, p), 'utf8')
const db = harnessClient()
const seed = makeSeeder(db)
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
await lockIpc.setLockDurations({ managerPassword: PW, sensitiveCodeMinutes: 7, otherCodeMinutes: 12 })

const events = []
setAccessEventWriter((row) => { events.push(row) })
const eventsOf = (kind) => events.filter((e) => e.kind === kind)

let owner = 500
/** هر بار پنجرهٔ تازه تا «همین حالا باز است» پیش نیاید. */
const redeem = async (target, code, w = ++owner) => {
  try {
    return { ok: true, w, value: await sessions.runWithPanelSessionOwner(w, () => runInGateCall(w, () => redeemOneTimeCode(target, code))) }
  } catch (err) {
    return { ok: false, w, message: String(err?.message ?? err) }
  }
}
const normal = PANEL_KEYS.products, money = PANEL_KEYS.cashClose, VOID = 'credit.void'
const remaining = () => lockIpc.codesStatus().codes?.remaining ?? 0

/** پروندهٔ برنامهٔ پیشین با دو دسته، همان قالب نسخهٔ ۱ (نمک ۱۶ بایتی، scrypt) */
const OLD_SENSITIVE = ['48210937', '59302148', '60413259', '71524360', '82635471']
const OLD_OTHER = ['93746152', '30481726', '61592837', '72603948', '83714059']
function writeTwoGroupFile() {
  const group = (list, createdAt) => {
    const salt = randomBytes(16).toString('hex')
    return { salt, createdAt, rows: list.map((code, i) => ({ n: i + 1, hash: scryptSync(code, Buffer.from(salt, 'hex'), 32).toString('hex'), usedAt: null })) }
  }
  writeFileSync(join(DIR, 'one-time-codes.json'), JSON.stringify({ version: 1, sections: { sensitive: group(OLD_SENSITIVE, 1_700_000_000_000), other: group(OLD_OTHER, 1_700_000_100_000) }, fails: 0, lockedUntil: 0 }) + '\n')
  codes.resetOneTimeCodesCacheForTests()
}

test('one set: a code opens a normal part, a money part, a new part and an action lock, each for the duration of its type; «کلیدسازی» refused and the code not used', async () => {
  events.length = 0
  const C = await lockIpc.createCodes({ managerPassword: PW })
  assert.equal(C.codes.length, 5)
  assert.equal('section' in C, false)
  const st = lockIpc.codesStatus()
  assert.equal('sections' in st, false)
  assert.deepEqual({ ...st.codes, createdAt: 0 }, { total: 5, remaining: 5, createdAt: 0, groups: 1 })

  let r = await redeem(normal, C.codes[0].code)
  assert.ok(r.ok, r.message)
  assert.deepEqual([r.value.kind, r.value.minutes, r.value.number], ['part', 12, 1], 'a normal module: «سایر ماژول‌ها» duration')
  r = await redeem(money, C.codes[1].code)
  assert.deepEqual([r.ok, r.value?.kind, r.value?.minutes], [true, 'part', 7], 'a money module: «ماژول‌های پولی» duration')
  r = await redeem('staff', C.codes[2].code)
  assert.deepEqual([r.ok, r.value?.kind, r.value?.minutes], [true, 'part', 7], 'a new part counts as money')
  r = await redeem('keys.panel-locks', C.codes[3].code)
  assert.equal(r.ok, false)
  assert.equal(r.message, 'برای این بخش کد یک‌بارمصرف پذیرفته نمی‌شود.')
  assert.equal(remaining(), 2, '«کلیدسازی»: the code was not used')

  // قفل کار: بلیت یک‌بار با همان کد، و خط «روش تأیید» بی «حساس»
  const w = ++owner
  r = await redeem(VOID, C.codes[3].code, w)
  assert.deepEqual([r.ok, r.value?.kind, r.value?.minutes, r.value?.number], [true, 'action', 7, 4])
  assert.ok(tickets.peekGateTicket(w, VOID))
  const entry = GATE_CATALOG[VOID]
  let note = null
  await sessions.runWithPanelSessionOwner(w, () => runInGateCall(w, async () => {
    await gateAction(VOID, () => auth.assertPanelPasswordStrict(entry.parentPanel, '', entry.titleFa))
    await audit(db, { action: 'CREDIT_VOID', entity: 'StoreCredit', note: null })
    note = seed.one('SELECT note FROM "AuditLog" ORDER BY id DESC LIMIT 1')?.note
  }))
  assert.equal(note, 'روش تأیید: کد یک‌بارمصرف شمارهٔ 4')
  assert.equal(remaining(), 1)

  const used = eventsOf('CODE_USED')
  assert.equal(used.length, 4)
  assert.ok(used.every((e) => !('decision' in e)), 'no «حساس» or «سایر» in the history row')
  assert.deepEqual(used.map((e) => e.minutes), [12, 7, 7, 7])
  assert.deepEqual(eventsOf('CODES_CREATED').map((e) => [e.count, 'titleFa' in e]), [[5, false]])
  lockIpc.closeAllUnlocks()
})

test('the unused codes of both groups of today work on every module until new codes are made; «باطل کردن کدها» and a new set cancel them all', async () => {
  events.length = 0
  writeTwoGroupFile()
  assert.deepEqual({ ...lockIpc.codesStatus().codes, createdAt: 0 }, { total: 10, remaining: 10, createdAt: 0, groups: 2 })
  let r = await redeem(money, OLD_OTHER[0])
  assert.deepEqual([r.ok, r.value?.kind, r.value?.minutes, r.value?.number], [true, 'part', 7, 1], 'an old «سایر» code opens a money module')
  r = await redeem(normal, OLD_SENSITIVE[1])
  assert.deepEqual([r.ok, r.value?.minutes, r.value?.number], [true, 12, 2], 'an old «حساس» code opens a normal module')
  r = await redeem(VOID, OLD_OTHER[1])
  assert.deepEqual([r.ok, r.value?.kind], [true, 'action'], 'an old «سایر» code opens an action lock')
  r = await redeem(normal, `${OLD_OTHER[0].slice(0, 4)}-${OLD_OTHER[0].slice(4)}`)
  assert.equal(r.ok, false, 'still one time each')
  assert.equal(remaining(), 7)
  assert.equal(lockIpc.codesStatus().codes.groups, 2)

  // برگرداندن کدِ همین حالا مصرف‌شده (وقتی نشست ساخته نشد) همان ردیفِ همان دسته را برمی‌گرداند
  const taken = codes.consumeOneTimeCode(OLD_OTHER[2])
  assert.deepEqual(taken, { ok: true, n: 3, slot: 'other' })
  codes.restoreOneTimeCode(taken.slot, taken.n)
  assert.equal(remaining(), 7)
  r = await redeem(normal, OLD_OTHER[2])
  assert.ok(r.ok && r.value.number === 3, r.message)
  // بلیت‌ها پر: کار با کد ساخته نمی‌شود و کدِ دستهٔ «سایر» به ردیف خودش برمی‌گردد
  for (let i = 0; i < 1000; i++) tickets.addGateTicket(20_000 + i, VOID, 60_000, 'PASSWORD')
  const left = remaining()
  r = await redeem(VOID, OLD_OTHER[3])
  assert.equal(r.message, 'باز کردن انجام نشد و کد مصرف نشد؛ دوباره تلاش کنید.')
  assert.equal(remaining(), left)
  tickets.clearGateTickets()
  r = await redeem(VOID, OLD_OTHER[3])
  assert.ok(r.ok && r.value.number === 4, r.message)

  // «باطل کردن کدها»: هر دو دسته (ورودی قدیمی `section` اثری ندارد)
  await lockIpc.revokeCodes({ section: 'sensitive', managerPassword: PW })
  assert.equal(lockIpc.codesStatus().codes, null)
  assert.equal((await redeem(normal, OLD_OTHER[4])).ok, false)
  assert.equal((await redeem(normal, OLD_SENSITIVE[3])).ok, false)

  // ساخت تازه: یک دسته، و کدهای مصرف‌نشدهٔ هر دو دستهٔ قبلی دیگر کار نمی‌کنند
  writeTwoGroupFile()
  const N = await lockIpc.createCodes({ section: 'other', managerPassword: PW })
  assert.deepEqual({ ...lockIpc.codesStatus().codes, createdAt: 0 }, { total: 5, remaining: 5, createdAt: 0, groups: 1 })
  assert.equal((await redeem(normal, OLD_OTHER[4])).ok, false)
  assert.equal((await redeem(money, OLD_SENSITIVE[4])).ok, false)
  r = await redeem(money, N.codes[0].code)
  assert.ok(r.ok && r.value.minutes === 7, r.message)
  assert.deepEqual(eventsOf('CODES_REVOKED').map((e) => 'titleFa' in e), [false])
  assert.ok(eventsOf('CODE_WRONG').every((e) => !('decision' in e)))
  await lockIpc.unlockCodes({ managerPassword: PW })
  lockIpc.closeAllUnlocks()
})

test('messages: each code use is ⚠️ and says neither «حساس» nor «سایر» (old history rows too); wrong code, new codes and canceled codes without «بخش»', () => {
  const AT = Date.UTC(2026, 10, 28, 9, 30)
  const data = emptyLookups(); data.users.set(5, 'علی')
  const row = (id, after, userId = null) => ({ id, at: AT, userId, action: 'ACCESS_EVENT', entity: 'Access', entityId: null, after: JSON.stringify(after), note: null })
  const list = auditPageToEvents([
    row(1, { kind: 'CODE_USED', titleFa: 'کالاها', number: 2, windowNo: 1, minutes: 12 }),
    row(2, { kind: 'CODE_USED', titleFa: 'کالاها', number: 3, windowNo: 1, minutes: 12, decision: 'سایر ماژول‌ها' }),
    row(3, { kind: 'CODE_USED', titleFa: 'بستن صندوق', number: 1, windowNo: 2, minutes: 7, decision: 'حساس' }),
    row(4, { kind: 'CODE_WRONG', titleFa: 'کالاها', windowNo: 1 }),
    row(5, { kind: 'CODES_CREATED', count: 5 }, 5),
    row(6, { kind: 'CODES_REVOKED' }, 5)
  ], { offsetHours: 0, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] })
  assert.equal(list.length, 6)
  const [fresh, oldOther, oldSensitive, wrong, made, revoked] = list
  for (const e of [fresh, oldOther, oldSensitive]) {
    assert.ok(e.title.startsWith('🔑 کد یک‌بارمصرف مصرف شد · '), e.title)
    assert.equal(e.important, true)
  }
  assert.deepEqual(fresh.lines, ['قفل: کالاها · شمارهٔ ۲ · پنجرهٔ ۱', 'تا ۱۲ دقیقه'])
  assert.deepEqual(oldOther.lines, ['قفل: کالاها · شمارهٔ ۳ · پنجرهٔ ۱', 'تا ۱۲ دقیقه'])
  assert.deepEqual(oldSensitive.lines, ['قفل: بستن صندوق · شمارهٔ ۱ · پنجرهٔ ۲', 'تا ۷ دقیقه'])
  assert.ok(wrong.title.startsWith('🔑 کد یک‌بارمصرف اشتباه وارد شد'))
  assert.deepEqual(made.lines, ['تعداد: ۵', 'کاربر: علی'])
  assert.deepEqual(revoked.lines, ['کاربر: علی'])
  for (const e of list) assert.doesNotMatch(`${e.title}\n${e.lines.join('\n')}`, /حساس|سایر|قسمت:|بخش:/, e.title)
})

test('screen: one box with the five controls; two durations named by module type, each with its list; the print sheet and the phone status use the new names', () => {
  const ui = src('src/renderer/src/components/OneTimeCodesSettings.tsx')
  for (const label of ['ساخت ۵ کد تازه (تصادفی)', 'خودم می‌نویسم…', 'باطل کردن کدها', 'برداشتن قفل کدها', 'ثبت همین ۵ کد'])
    assert.equal(ui.split(`>${label}</button>`).length - 1, 1, `one «${label}» button (one box)`)
  assert.match(ui, /\{faDigits\(st\.remaining\)\} از \{faDigits\(st\.total\)\} کد باقی است/)
  assert.match(ui, /call<Created>\(CH\.locksCodesCreate, \{ mode, managerPassword: password,/)
  assert.match(ui, /call\(CH\.locksCodesRevoke, \{ managerPassword: password \}\)/)
  assert.doesNotMatch(ui, /باطل کردن کدهای این قسمت|TITLES\[|OneTimeCodeSection|section\('/)
  const moneyBox = ui.indexOf('مدت باز ماندن ماژول‌های پولی با کد (۱ تا ۱۰۰۰ دقیقه)')
  const otherBox = ui.indexOf('مدت باز ماندن سایر ماژول‌ها با کد (۱ تا ۱۰۰۰ دقیقه)')
  const moneyList = ui.indexOf('<KindHelpList label="ماژول‌های پولی و حساس" items={lists.sensitive} />')
  const otherList = ui.indexOf('<KindHelpList label="ماژول‌های معمولی" items={lists.normal} />')
  assert.ok(moneyBox > 0 && moneyList > moneyBox && otherBox > moneyList && otherList > otherBox, 'each duration with its own list')
  assert.match(ui, /<h3>کدهای یک‌بارمصرف<\/h3>/)
  assert.match(ui, /کدهای یک‌بارمصرف — فقط همین یک بار دیده می‌شوند/)
  assert.deepEqual([LOCK_DURATION_TITLES.sensitiveCodeMinutes, LOCK_DURATION_TITLES.otherCodeMinutes], ['مدت باز ماندن ماژول‌های پولی با کد', 'مدت باز ماندن سایر ماژول‌ها با کد'])
  assert.match(src('src/main/services/cloud/phoneReports.ts'), /title: LOCK_DURATION_TITLES\[key\]/)
})
