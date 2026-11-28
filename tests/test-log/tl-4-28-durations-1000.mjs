/**
 * دفتر آزمون ۴-۲۸ — دو مدت مجوز راه دور و دو مدت کد، هر کدام ۱ تا ۱۰۰۰ دقیقه (معماری §۳-۲؛ TL-D10):
 *  - پروندهٔ `lock-durations.json`: چهار مدت؛ پروندهٔ قدیمیِ سه‌کلیدی سالم خوانده می‌شود و «مدت مجوز راه دور» قبلی برای
 *    هر دو مدت راه دور می‌ماند؛ ۱۰۰۱، کلید کم یا ناشناس ⇒ هر چهار ۱۰؛ تغییر با رمز تایپی مدیر و پیام «۱ تا ۱۰۰۰»؛
 *  - مجوز گوشی یا ربات: قسمت معمولی مدت اول و قسمت پولی یا تازه مدت دوم را می‌گیرد (همان سیم‌کشی `CloudSyncService`)؛
 *    «قفل کار» همان یک بار است و پنجرهٔ بلیتش حداکثر ۶۰ دقیقه؛
 *  - ۱۰۰۰ دقیقه بی وقفه برای هر دو مدت مجوز و هر دو مدت کد: سقف سخت ۶۰ دقیقهٔ نشست (`panelSession.ts`) دست نخورده و
 *    نشست پیش از سقف همان لحظه بسته و دوباره باز می‌شود؛ بی تازه‌سازی، سقف می‌بندد؛ جهش ساعت، «بستن همه» یا نشستِ
 *    بسته‌شده ⇒ هرگز دوباره باز نمی‌شود؛
 *  - هاب واقعی سیاست‌های ۱۰۰۰ دقیقه‌ای رایانه را می‌پذیرد و یک هزارم ثانیه بیشتر را نه؛ تأیید گوشی همان مدت هر قسمت؛
 *  - صفحه‌ها: دو خانهٔ مدت راه دور با یک کادر رمز، «۱ تا ۱۰۰۰»؛ «وضعیت سیستم» گوشی چهار مدت.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-28-durations-1000.mjs
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance as perfHooksPerformance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-28-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const reg = await import('../../src/main/services/RemoteGrantRegistry.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const unlocks = await import('../../src/main/services/locks/unlocks.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { unlockActionWithPassword } = await import('../../src/main/services/locks/gate.ts')
const { redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const durations = await import('../../src/main/services/locks/durations.ts')
const { createGrantApprovalCoordinator } = await import('../../src/main/services/cloud/grantApprovalCoordinator.ts')
const { createExperimentalRemoteCommandIssuer } = await import('../../src/main/services/cloud/experimentalRemoteCommandIssuer.ts')
const { startExperimentalHubSupervisor } = await import('../../src/main/services/cloud/experimentalHubSupervisor.ts')
const { openCloudStateStore } = await import('../../src/main/services/cloud/cloudState.ts')
const { PHONE_REPORTS } = await import('../../src/main/services/cloud/phoneReportCatalog.ts')
const { REMOTE_PANELS } = await import('../../src/shared/enums.ts')
const { GATE_ACTION_IDS, GATE_CATALOG, GATE_PART_KEYS } = await import('../../src/shared/gateCatalog.ts')
const { LOCKED_PANELS, PANEL_KEYS, codeSectionOfPanel } = await import('../../src/shared/panels.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

const db = harnessClient()
const MIN = 60_000
const POLICY_MS = 1000 * MIN
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })

// ساعت ساختگی (یکنواخت و دیواری با هم، مثل plan1405-remote-grants)
assert.equal(perfHooksPerformance, globalThis.performance)
const realNow = performance.now.bind(performance), realDateNow = Date.now
let shift = 0, dateShift = 0
performance.now = () => realNow() + shift
Date.now = () => realDateNow() + dateShift
const advance = (ms) => { shift += ms; dateShift += ms }

const events = []
setAccessEventWriter((after) => { events.push(after) })

// همان سیم‌کشی میزبان در CloudSyncService (آزمون ۷ همان عبارت‌ها را در خود پرونده می‌سنجد)
const opened = [], ticketTtls = []
reg.initRemoteGrantRegistry({
  notePanelUnlocked: (panel, _scope, owner, allowed, ttlMs) => { opened.push({ panel, owner, ttlMs }); return unlocks.openRenewingPanel(panel, owner, allowed, ttlMs) },
  clearPanelScope: sessions.clearPanelScope, clearPanelSessions: sessions.clearPanelSessions,
  addOneShotTicket: (id, owner, ttl, memberId) => { ticketTtls.push({ id, ttl }); return tickets.addGateTicket(owner, id, ttl, 'REMOTE_GRANT', { memberId }) },
  clearOneShotTickets: (memberId) => tickets.clearGateTickets(memberId === undefined ? {} : { memberId }),
  grantDurationMs: (panel) => GATE_ACTION_IDS.includes(panel) ? durations.lockDurationMs('remoteSensitiveGrantMinutes') : durations.partDurationMs(durations.remoteDurationKey(codeSectionOfPanel(panel)))
})
const lease = reg.acquireRemoteAdmissionLease()
lease.installClaimGuard(async (claim) => claim())
lease.open()
const token = (p) => p.gt.slice(3)
const moneyPart = REMOTE_PANELS.find((key) => LOCKED_PANELS.some((p) => p.key === key && p.kind === 'part' && p.tier === 'money'))
const normalPart = PANEL_KEYS.products
const lastTtl = (panel, owner) => opened.filter((x) => x.panel === panel && x.owner === owner).at(-1)?.ttlMs
async function claimPart(panel, owner) {
  const p = reg.requestCode(panel, owner)
  assert.ok(reg.createGrant({ panel, ownerWindowId: owner, tier: 'NORMAL', mode: 'PANEL', memberId: 'member1', requestId: p.requestId, ttlMs: POLICY_MS }), `grant ${panel}`)
  assert.equal(await reg.claimRemotePanel(owner, panel, p.requestId, token(p)), true, `claim ${panel}`)
}
const setDurations = (patch) => lockIpc.setLockDurations({ managerPassword: PW, ...patch })
const inCall = (owner, fn) => sessions.runWithPanelSessionOwner(owner, () => runInGateCall(owner, fn))
/** گام‌های ۵ دقیقه‌ای با کار واقعی (بی‌کاری ۱۰ دقیقه است)؛ `renew` یعنی زمان‌سنج تازه‌سازی سر وقتش زده می‌شود. */
function walk(totalMin, checks, { renew = true, step = 5 } = {}) {
  let renewed = 0
  for (let t = step; t <= totalMin; t += step) {
    advance(step * MIN)
    if (renew) renewed += unlocks.runDueRenewalsForTests()
    for (const [panel, owner, untilMin] of checks) {
      const open = sessions.isPanelUnlocked(panel, owner)
      assert.equal(open, t < untilMin, `${panel} for window ${owner} at minute ${t}: ${open ? 'open' : 'closed'}`)
    }
  }
  return renewed
}

test('the durations file: four durations of 1 to 1000; the old three-key file keeps its remote duration for both; 1001, a missing or an unknown key => all four 10; a ticket window stays at most 60', () => {
  const file = join(DIR, 'lock-durations.json')
  writeFileSync(file, JSON.stringify({ sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25 }))
  assert.deepEqual(durations.readLockDurations(), { sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25, remoteSensitiveGrantMinutes: 25 }, 'old file: the previous remote duration for both')
  const all1000 = { sensitiveCodeMinutes: 1000, otherCodeMinutes: 1000, remoteGrantMinutes: 1000, remoteSensitiveGrantMinutes: 1000 }
  durations.writeLockDurations(all1000)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), all1000)
  assert.deepEqual(durations.readLockDurations(), all1000)
  const tens = { sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 10, remoteSensitiveGrantMinutes: 10 }
  for (const key of durations.LOCK_DURATION_KEYS) {
    writeFileSync(file, JSON.stringify({ ...all1000, [key]: 1001 }))
    assert.deepEqual(durations.readLockDurations(), tens, `${key} = 1001 => all four 10`)
  }
  for (const bad of [{ ...all1000, extra: 5 }, { sensitiveCodeMinutes: 5 }, { ...all1000, remoteGrantMinutes: 0 }, { ...all1000, otherCodeMinutes: 1.5 }]) {
    writeFileSync(file, JSON.stringify(bad))
    assert.deepEqual(durations.readLockDurations(), tens, JSON.stringify(bad))
  }
  durations.writeLockDurations(all1000)
  assert.throws(() => durations.writeLockDurations({ ...all1000, remoteSensitiveGrantMinutes: 1001 }), /Invalid lock durations/)
  assert.deepEqual(durations.readLockDurations(), all1000, 'a refused write leaves the file')
  durations.writeLockDurations({ sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25, remoteSensitiveGrantMinutes: 25 }, 'a three-key write is stored as four keys')
  durations.writeLockDurations(all1000)
  assert.equal(durations.partDurationMs('remoteSensitiveGrantMinutes'), 1000 * MIN)
  assert.equal(durations.lockDurationMs('remoteSensitiveGrantMinutes'), 60 * MIN, 'a one-time ticket window stays at most 60 minutes')
  assert.equal(durations.lockDurationMs('sensitiveCodeMinutes'), 60 * MIN)
  assert.equal(durations.remoteDurationKey(codeSectionOfPanel(normalPart)), 'remoteGrantMinutes')
  assert.equal(durations.remoteDurationKey(codeSectionOfPanel(moneyPart)), 'remoteSensitiveGrantMinutes')
  assert.equal(durations.remoteDurationKey(codeSectionOfPanel(GATE_PART_KEYS[0])), 'remoteSensitiveGrantMinutes', 'a new part is money and sensitive')
  assert.equal(durations.remoteDurationKey(null), 'remoteSensitiveGrantMinutes')
  assert.deepEqual(Object.values(durations.LOCK_DURATION_TITLES).slice(2), ['مدت مجوز راه دور — ماژول‌های معمولی', 'مدت مجوز راه دور — ماژول‌های پولی و حساس'])
})

test('lockDurations:set with the typed manager password: each of the four takes 1000; 1001 is refused with «۱ تا ۱۰۰۰» and nothing changes; the old file keeps the second remote duration', async () => {
  durations.writeLockDurations({ sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 25 })
  const d = await setDurations({ remoteGrantMinutes: 30 })
  assert.deepEqual(d, { sensitiveCodeMinutes: 7, otherCodeMinutes: 12, remoteGrantMinutes: 30, remoteSensitiveGrantMinutes: 25 })
  const all1000 = { sensitiveCodeMinutes: 1000, otherCodeMinutes: 1000, remoteGrantMinutes: 1000, remoteSensitiveGrantMinutes: 1000 }
  assert.deepEqual(await setDurations(all1000), all1000)
  for (const key of durations.LOCK_DURATION_KEYS) {
    await assert.rejects(() => setDurations({ [key]: 1001 }), (err) => err.message.includes('بین ۱ تا ۱۰۰۰ دقیقه') && err.message.includes(durations.LOCK_DURATION_TITLES[key]))
    assert.deepEqual(durations.readLockDurations(), all1000, `${key}: nothing changed`)
  }
  await assert.rejects(() => lockIpc.setLockDurations({ managerPassword: '', remoteSensitiveGrantMinutes: 20 }))
  assert.equal(durations.readLockDurations().remoteSensitiveGrantMinutes, 1000, 'no change without the typed manager password')
  events.length = 0
  await setDurations({ remoteSensitiveGrantMinutes: 20 })
  assert.deepEqual(events.filter((e) => e.kind === 'DURATIONS_CHANGED').map((e) => [e.titleFa, e.minutes]), [['مدت مجوز راه دور — ماژول‌های پولی و حساس', 20]])
})

test('policy caps: the coordinator, the command issuer and the registry take 1000 minutes and refuse one millisecond more', () => {
  const coordinator = (ttlMs) => createGrantApprovalCoordinator({ key: Buffer.alloc(32, 7), storeId: 'store_1', policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs } }, now: () => 1, isPaused: () => false, mayApprove: () => true })
  assert.ok(coordinator(POLICY_MS))
  assert.throws(() => coordinator(POLICY_MS + 1), /Invalid local approval policy/)
  const issuer = (ttlMs) => createExperimentalRemoteCommandIssuer({ key: Buffer.alloc(32, 8), storeId: 'store_1', policies: { products: { tier: 'NORMAL', mode: 'PANEL', ttlMs } },
    identity: { canApprove: () => false, authorize: () => null }, pending: () => [], send: async () => false })
  assert.ok(issuer(POLICY_MS))
  assert.throws(() => issuer(POLICY_MS + 1), /Invalid issuer policy/)
  for (const [ttlMs, ok] of [[POLICY_MS + 1, false], [POLICY_MS, true]]) {
    const p = reg.requestCode(normalPart, 9001)
    const g = reg.createGrant({ panel: normalPart, ownerWindowId: 9001, tier: 'NORMAL', mode: 'PANEL', memberId: 'member1', requestId: p.requestId, ttlMs })
    assert.equal(!!g, ok, `registry ${ttlMs}`)
    reg.cancelForWindow(9001)
  }
})

test('remote grants by part: a normal part takes the first duration and a money part the second; an action stays one time with a window of at most 60 minutes', async () => {
  await setDurations({ remoteGrantMinutes: 90, remoteSensitiveGrantMinutes: 20 })
  await claimPart(normalPart, 101)
  await claimPart(moneyPart, 101)
  assert.equal(lastTtl(normalPart, 101), 90 * MIN, 'normal part: 90 minutes')
  assert.equal(lastTtl(moneyPart, 101), 20 * MIN, 'money part: 20 minutes')
  // بی‌کاری مدت ۲۰ دقیقه یک‌پنجم آن (۴ دقیقه) است؛ گام ۲ دقیقه
  walk(20, [[normalPart, 101, 999], [moneyPart, 101, 20]], { step: 2 })
  assert.equal(walk(70, [[normalPart, 101, 70]]), 1, 'the 90-minute part was reopened once, before the 60-minute cap; closed at 90 minutes')
  // قفل کار: مدت پولی و حساس ۱۰۰۰ است، اما بلیت همان یک بار و حداکثر ۶۰ دقیقه
  await setDurations({ remoteSensitiveGrantMinutes: 1000 })
  const action = 'credit.void'
  const p = reg.requestCode(action, 102)
  assert.ok(reg.createGrant({ panel: action, ownerWindowId: 102, tier: 'SENSITIVE_MONEY', mode: 'ONE_SHOT', memberId: 'member1', requestId: p.requestId, ttlMs: POLICY_MS }))
  assert.equal(await reg.claimRemotePanel(102, action, p.requestId, token(p)), true)
  assert.equal(ticketTtls.at(-1).ttl, 60 * MIN, 'one-shot ticket window 60 minutes')
  assert.equal(sessions.isPanelUnlocked('credit-void', 102), false, 'an action grant opens no part')
  advance(59 * MIN)
  assert.ok(tickets.peekGateTicket(102, action), 'the one-time ticket is still there at 59 minutes')
  advance(2 * MIN)
  assert.equal(tickets.peekGateTicket(102, action), null, 'and gone after 60 minutes')
})

test('1000 minutes without a break: a normal and a money part at 1000 are closed and reopened before each 60-minute cap; without the reopen the cap still closes; a clock jump, «close all» or a closed session never reopens', async () => {
  await setDurations({ remoteGrantMinutes: 1000, remoteSensitiveGrantMinutes: 1000 })
  await claimPart(normalPart, 201)
  await claimPart(moneyPart, 201)
  assert.equal(lastTtl(normalPart, 201), 1000 * MIN)
  assert.equal(lastTtl(moneyPart, 201), 1000 * MIN)
  const renewed = walk(995, [[normalPart, 201, 999], [moneyPart, 201, 999]])
  assert.equal(renewed, 36, 'each part reopened 18 times (minutes 55, 110, … 990)')
  advance(5 * MIN + 1000)
  assert.equal(sessions.isPanelUnlocked(normalPart, 201), false, 'closed at 1000 minutes')
  assert.equal(sessions.isPanelUnlocked(moneyPart, 201), false)
  assert.equal(unlocks.runDueRenewalsForTests(), 0)

  // بی تازه‌سازی: سقف سخت ۶۰ دقیقه همان است، با این‌که مجوز هنوز معتبر است
  await claimPart(normalPart, 202)
  walk(55, [[normalPart, 202, 999]], { renew: false })
  advance(5 * MIN + 1000)
  assert.equal(sessions.isPanelUnlocked(normalPart, 202), false, 'the 60-minute hard cap closes the session')
  assert.equal(reg.isGrantActiveForWindow(normalPart, 202), true, 'while the grant itself is still valid')
  assert.equal(unlocks.runDueRenewalsForTests(), 0, 'a session closed by the cap is never rebuilt')
  assert.equal(sessions.isPanelUnlocked(normalPart, 202), false)
  reg.cancelForWindow(202)

  // جهش ساعت دیواری (جلو یا عقب) ⇒ بی تازه‌سازی
  for (const [owner, jump] of [[203, 10 * MIN], [204, -10 * MIN]]) {
    await claimPart(normalPart, owner)
    walk(50, [[normalPart, owner, 999]])
    dateShift += jump
    advance(5 * MIN)
    assert.equal(unlocks.runDueRenewalsForTests(), 0, `clock jump ${jump / MIN} minutes: no reopen`)
    assert.equal(sessions.isPanelUnlocked(normalPart, owner), true)
    advance(5 * MIN + 1000)
    assert.equal(sessions.isPanelUnlocked(normalPart, owner), false, 'the cap closes it')
    reg.cancelForWindow(owner)
  }

  // «بستن همه» ⇒ بسته و هرگز دوباره باز
  await claimPart(normalPart, 205)
  walk(30, [[normalPart, 205, 999]])
  lockIpc.closeAllUnlocks()
  walk(30, [[normalPart, 205, 0]])
  assert.equal(unlocks.runDueRenewalsForTests(), 0)

  // نشست مدیر همان پنجره باز است ⇒ تازه‌سازی به بعد می‌افتد و پس از بسته شدن آن، پیش از سقف انجام می‌شود
  await claimPart(normalPart, 206)
  walk(50, [[normalPart, 206, 999]])
  sessions.applyPanelSessionTtlMinutes(30)
  try {
    sessions.notePanelUnlocked('settings', 'MANAGER', 206)
    advance(5 * MIN)
    assert.equal(sessions.panelSessionStatus(206).manager, true)
    assert.equal(unlocks.runDueRenewalsForTests(), 0, 'postponed while the manager session of the same window is open')
    sessions.clearPanelScope('__manager__', 206)
    assert.equal(sessions.panelSessionStatus(206).manager, false)
    advance(1 * MIN)
    assert.equal(unlocks.runDueRenewalsForTests(), 1, 'reopened before the cap once the manager session is gone')
    // تازه‌سازی بی‌کاری را تمدید نمی‌کند (نگهبان بی تمدید)؛ کار واقعی بعدی باید در همان ۱۰ دقیقهٔ بی‌کاری باشد
    assert.equal(sessions.isPanelUnlocked(normalPart, 206), true, 'used right after the reopen')
  } finally { sessions.applyPanelSessionTtlMinutes(5) }
  assert.equal(walk(60, [[normalPart, 206, 999]]), 1)
  reg.cancelForWindow(206)
  assert.equal(sessions.isPanelUnlocked(normalPart, 206), false)
})

test('codes at 1000 minutes: codes of the one set open a money part and a normal part, each for its own duration, stay open with use and are reopened before the cap; an action stays one time, its window at most 60 minutes', async () => {
  const C = await lockIpc.createCodes({ managerPassword: PW })
  await setDurations({ sensitiveCodeMinutes: 1000, otherCodeMinutes: 90 })
  const money = await inCall(301, () => redeemOneTimeCode(moneyPart, C.codes[0].code))
  const normal = await inCall(301, () => redeemOneTimeCode(normalPart, C.codes[1].code))
  assert.deepEqual([money.kind, money.minutes, normal.kind, normal.minutes], ['part', 1000, 'part', 90])
  const renewed = walk(995, [[moneyPart, 301, 999], [normalPart, 301, 90]])
  assert.equal(renewed, 18 + 1, 'the 1000-minute code session reopened 18 times, the 90-minute one once')
  advance(5 * MIN + 1000)
  assert.equal(sessions.isPanelUnlocked(moneyPart, 301), false, 'closed at 1000 minutes')
  await setDurations({ otherCodeMinutes: 1000 })
  const normal1000 = await inCall(302, () => redeemOneTimeCode(normalPart, C.codes[2].code))
  assert.equal(normal1000.minutes, 1000)
  assert.equal(walk(995, [[normalPart, 302, 999]]), 18)
  advance(5 * MIN + 1000)
  assert.equal(sessions.isPanelUnlocked(normalPart, 302), false)
  // قفل کار با کد: یک بار، پنجرهٔ حداکثر ۶۰ دقیقه و همین عدد در پیام «تا … دقیقه»
  const action = 'credit.void'
  const once = await inCall(303, () => redeemOneTimeCode(action, C.codes[3].code))
  assert.deepEqual([once.kind, once.minutes], ['action', 60])
  assert.ok(tickets.peekGateTicket(303, action).expiresAt - performance.now() <= 60 * MIN)
  // راه رمز پنجرهٔ قفل کار (gate.ts) هم با مدت «حساس» ۱۰۰۰ همان حداکثر ۶۰ دقیقه را می‌گوید
  const managerAction = 'return.after-deadline'
  assert.equal(GATE_CATALOG[managerAction].origin, 'MANAGER_PASSWORD')
  const viaPassword = await inCall(304, () => unlockActionWithPassword(managerAction, PW))
  assert.equal(viaPassword.minutes, 60)
  assert.ok(tickets.peekGateTicket(304, managerAction).expiresAt - performance.now() <= 60 * MIN)
  lockIpc.closeAllUnlocks()
})

test('screens and wiring: two remote-duration boxes with one typed password field and «۱ تا ۱۰۰۰»; codes «۱ تا ۱۰۰۰»; the phone status shows four durations; CloudSyncService reads each part with its own key', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8')
  const controls = read('src/renderer/src/components/RemoteGrantControls.tsx')
  assert.equal((controls.match(/type="password"/g) ?? []).length, 1, 'one password field for both boxes')
  assert.match(controls, /key: 'remoteGrantMinutes', title: 'ماژول‌های معمولی'/)
  assert.match(controls, /key: 'remoteSensitiveGrantMinutes', title: 'ماژول‌های پولی و حساس'/)
  assert.match(controls, /مدت مجوز راه دور — \{b\.title\} \(۱ تا ۱۰۰۰ دقیقه\)/)
  assert.match(controls, /valueOf\(key\) <= 1000/)
  assert.doesNotMatch(controls, /۱ تا ۶۰/)
  const codesUi = read('src/renderer/src/components/OneTimeCodesSettings.tsx')
  assert.match(codesUi, /مدت باز ماندن ماژول‌های پولی با کد \(۱ تا ۱۰۰۰ دقیقه\)/)
  assert.match(codesUi, /مدت باز ماندن سایر ماژول‌ها با کد \(۱ تا ۱۰۰۰ دقیقه\)/)
  assert.match(codesUi, /n <= 1000\)\) throw new Error\('هر مدت باید عددی صحیح بین ۱ تا ۱۰۰۰ دقیقه باشد\.'\)/)
  assert.equal(PHONE_REPORTS.status.pageSize, 4)
  assert.match(PHONE_REPORTS.status.caption, /^چهار مدت/)
  const host = read('src/main/services/CloudSyncService.ts')
  assert.ok(host.includes("grantDurationMs:(panel)=>GATE_ACTION_IDS.includes(panel) ? lockDurationMs('remoteSensitiveGrantMinutes') : partDurationMs(remoteDurationKey(codeSectionOfPanel(panel)))"), 'the same reader as this test')
  assert.ok(host.includes('notePanelUnlocked:(panel,_scope,owner,allowed,ttlMs)=>{const done=openRenewingPanel(panel,owner,allowed,ttlMs);'), 'the same renewing session as this test')
  const bridge = read('src/main/services/cloud/botRemoteBridge.ts')
  assert.match(bridge, /const POLICY_TTL_MS = 60_000_000\n/, 'the bot approval has the same 1000-minute policy cap')
  assert.match(read('src/main/services/panelSession.ts'), /const GUARDED_MAX_MS = 60 \* 60_000\n/, 'the 60-minute hard cap of a guarded session is untouched')
})

test('loopback: the real hub takes the desktop 1000-minute policies and refuses one millisecond more; a phone approval opens each part for its own duration and an action ticket for at most 60 minutes', async () => {
  // هاب و امضای تأیید با ساعت واقعی کار می‌کنند؛ همهٔ مجوزها و نشست‌های آزمون‌های پیش بسته و ساعت واقعی برمی‌گردد.
  lockIpc.closeAllUnlocks()
  sessions.clearPanelSessions()
  lease.release()
  performance.now = realNow; Date.now = realDateNow; shift = 0; dateShift = 0
  const childFile = join(DIR, 'hub.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../../src/main/services/cloud/experimentalHubChild.ts', import.meta.url))], outfile: childFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const desktopPolicies = Object.fromEntries(REMOTE_PANELS.map((panel) => [panel, GATE_ACTION_IDS.includes(panel)
    ? { tier: 'SENSITIVE_MONEY', mode: 'ONE_SHOT', ttlMs: 60_000_000 } : { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60_000_000 }]))
  const start = async (policies, label) => {
    const hubDir = join(DIR, `hub-${label}`), stateDir = join(DIR, `state-${label}`); mkdirSync(hubDir)
    const state = openCloudStateStore(stateDir)
    state.save({ version: 1, storeId: 'store_test', epoch: '12345678-1234-4123-8123-123456789abc', lastAcked: 0, anchorHash: '', restoreMarker: null }); state.initializeRevocationLedger(); state.initializeGrantReplayLedger()
    try {
      const hub = await startExperimentalHubSupervisor({ nodeExecutable: process.execPath, childFile, directory: hubDir, origin: 'https://store.example', owner: { username: 'owner', password: 'owner-test-password', pin: '746392' }, auditKey: Buffer.alloc(32, 1), snapshotMaxAgeMs: 5000,
        reader: { latestBoundaryTotals: async () => null, openShiftsPage: async () => [], auditPage: async () => [] }, state, readRestoreMarker: async () => null, timeoutMs: 8000,
        revocation: { key: Buffer.alloc(32, 2) }, approval: { key: Buffer.alloc(32, 3), policies } })
      return { hub, state }
    } catch (error) { state.close(); throw error }
  }
  const send = (hub, method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ hostname: '127.0.0.1', port: hub.mobilePort, path, method, headers: { host: 'store.example', origin: 'https://store.example', 'x-mahak-request': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject); req.end(data)
  })
  let running = null
  try {
    running = await start(desktopPolicies, 'desktop')
    const { hub } = running
    const login = await send(hub, 'POST', '/api/login', { username: 'owner', password: 'owner-test-password' })
    assert.equal(login.status, 200)
    const approveFromPhone = async (panel, owner) => {
      const p = reg.requestCode(panel, owner)
      let seen = false
      for (let i = 0; i < 50 && !seen; i++) {
        seen = (await send(hub, 'GET', '/api/requests', undefined, login.cookie)).body.requests?.some((x) => x.requestId === p.requestId)
        if (!seen) await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(seen, `${panel} reached the phone`)
      assert.equal((await send(hub, 'POST', '/api/approve', { requestId: p.requestId, code: p.code, pin: '746392' }, login.cookie)).status, 200)
      assert.equal(await reg.claimRemotePanel(owner, panel, p.requestId, token(p)), true)
    }
    await setDurations({ remoteGrantMinutes: 90, remoteSensitiveGrantMinutes: 20 })
    await approveFromPhone(normalPart, 401)
    await approveFromPhone(moneyPart, 401)
    assert.equal(lastTtl(normalPart, 401), 90 * MIN, 'phone approval of a normal part: 90 minutes')
    assert.equal(lastTtl(moneyPart, 401), 20 * MIN, 'phone approval of a money part: 20 minutes')
    assert.equal(sessions.isPanelUnlocked(normalPart, 401) && sessions.isPanelUnlocked(moneyPart, 401), true)
    await setDurations({ remoteSensitiveGrantMinutes: 1000 })
    await approveFromPhone('credit.void', 402)
    assert.equal(ticketTtls.at(-1).ttl, 60 * MIN, 'phone approval of an action: one ticket, at most 60 minutes')
    await hub.stop(); running.state.close(); running = null
    await assert.rejects(() => start({ ...desktopPolicies, [normalPart]: { tier: 'NORMAL', mode: 'PANEL', ttlMs: 60_000_001 } }, 'over'))
  } finally {
    if (running) { await running.hub.stop().catch(() => undefined); running.state.close() }
    reg.revokeAll()
    tickets.clearGateTickets()
  }
})

after(async () => {
  await db.$disconnect?.()
  rmSync(DIR, { recursive: true, force: true })
})
