/**
 * دفتر آزمون ۴-۵۳ و ۴-۵۴ — «پنل فروش» در نصب تازه بی قفل؛ قفل بی‌کاری فقط نشست‌های رمزی را می‌بندد؛ «باز کردن فوری قفل
 * رمز اشتباه». همه از راه کانال‌های واقعی main (`registerIpcHandlers`) و سرویس‌های واقعی، روی پایگاه موقت:
 *  - پیکربندی خالی ⇐ «پنل فروش» باز و ۸۳ کلید دیگر قفل؛ پیکربندی ذخیره‌شده (همیشه همهٔ کلیدها) همان می‌ماند؛ جایگزین پیش از
 *    خواندن یا هنگام خطا (`allLockedConfig`) همه را قفل می‌داند؛
 *  - بی‌کاری (`managerLogout` با `idle`) فقط نشست مدیر و رمز دوم و سوم را می‌بندد؛ بخش بازشده با کد یا مجوز زمان‌بندی‌شده
 *    می‌ماند؛ «خروج مدیر» دستی همه را می‌بندد؛ پنجرهٔ دیگر دست نمی‌خورد؛
 *  - «پنل فروش» بازشده با رمز خودش یا رمز مدیر روی همان صفحه با بی‌کاری و گذشت زمان بسته نمی‌شود، فقط با «خروج مدیر»؛
 *  - دکمهٔ مدیر قفل‌های رمز اشتباه را باز و در سابقه ثبت می‌کند؛ PIN صندوق و قفل کدهای یک‌بارمصرف دست نمی‌خورند.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-53-pos-idle.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-53-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

// کانال‌های واقعی main با رویداد یک پنجرهٔ برنامه
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (ch, fn) => handlers.set(ch, fn)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const db = harnessClient()
const seed = makeSeeder(db)
const panels = await import('../../src/shared/panels.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const unlocks = await import('../../src/main/services/locks/unlocks.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { DEFAULT_MANAGER_PASSWORD, SETTING_KEYS } = await import('@shared/receipt')
registerIpcHandlers()

const { PANEL_KEYS, LOCKED_PANELS, allLockedConfig, parsePanelLocks, isPanelLockEnabled } = panels
const POS = PANEL_KEYS.pos
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const PW = '58204716', POS_PW = '73915264', PRODUCTS_PW = '62048391'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const events = []
setAccessEventWriter((row, userId) => { events.push({ ...row, userId }) })
const status = (id) => sessions.panelSessionStatus(id)
const open = (panel, id) => sessions.isPanelUnlocked(panel, id)

test('a fresh install: «پنل فروش» has no lock and the other 83 keys are locked; a saved map keeps its choice; the fallback stays fully locked', async () => {
  const fresh = parsePanelLocks(null)
  assert.equal(Object.keys(fresh).length, LOCKED_PANELS.length)
  assert.equal(fresh[POS], false)
  assert.deepEqual(Object.entries(fresh).filter(([k, v]) => k !== POS && v !== true), [])
  assert.deepEqual(parsePanelLocks({}), fresh)
  assert.deepEqual(parsePanelLocks('{not json'), fresh)
  assert.ok(Object.values(allLockedConfig()).every((v) => v === true), 'the stand-in before loading and on errors still locks everything')
  assert.equal(isPanelLockEnabled(parsePanelLocks(JSON.stringify(allLockedConfig())), POS), true, 'a map saved before (all keys) keeps «پنل فروش» locked')

  // روی پایگاه تازه: بی رمز از دروازهٔ واقعی می‌گذرد
  assert.equal(isPanelLockEnabled(await auth.readPanelLocks(), POS), false)
  await sessions.runWithPanelSessionOwner(700, () => auth.assertPanelPassword(POS, '', 'فروش'))
  const locks = (await ipc(700, IPC.managerPanelLocks)).data
  assert.equal(locks.locks[POS], false)

  // مدیر قفلش را روشن می‌کند ⇐ ذخیره همهٔ کلیدها را می‌نویسد و از این پس قفل است
  const set = await ipc(700, IPC.managerPanelLocksSet, { managerPassword: PW, locks: { [POS]: true } })
  assert.equal(set.ok, true, set.error)
  const stored = JSON.parse(seed.one('SELECT value FROM "Setting" WHERE key = ?', SETTING_KEYS.panelLocks).value)
  assert.equal(Object.keys(stored).length, LOCKED_PANELS.length)
  assert.equal(stored[POS], true)
  assert.equal(isPanelLockEnabled(await auth.readPanelLocks(), POS), true)
  await assert.rejects(sessions.runWithPanelSessionOwner(701, () => auth.assertPanelPassword(POS, '', 'فروش')))
})

test('idle closes only password sessions: the manager and a second password close; parts opened by a code or a scheduled grant stay; manual logout closes all; another window is untouched', async () => {
  const W = 801, OTHER = 802
  const C = await lockIpc.createCodes({ managerPassword: PW })
  const code = await sessions.runWithPanelSessionOwner(W, () => runInGateCall(W, () => redeemOneTimeCode(PANEL_KEYS.cashClose, C.codes[0].code)))
  assert.equal(code.kind, 'part')
  assert.ok(unlocks.openGuardedPart(W, PANEL_KEYS.purchase, { source: 'SCHEDULED', method: 'SCHEDULED_GRANT', grantId: 'tl-4-54', ttlMs: 60 * 60_000, idle: false }))
  sessions.notePanelUnlocked(PANEL_KEYS.products, 'PANEL', W)
  sessions.notePanelUnlocked(PANEL_KEYS.settings, 'MANAGER', W)
  sessions.notePanelUnlocked(PANEL_KEYS.products, 'PANEL', OTHER)
  assert.equal(status(W).manager, true)

  const r = await ipc(W, IPC.managerLogout, { idle: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.session.manager, false)
  assert.deepEqual(r.data.session.panels, [PANEL_KEYS.cashClose, PANEL_KEYS.purchase].sort())
  assert.equal(open(PANEL_KEYS.cashClose, W), true, 'opened with a one-time code: its own time and idle rule')
  assert.equal(open(PANEL_KEYS.purchase, W), true, 'scheduled grant: only at its end')
  assert.equal(open(PANEL_KEYS.products, W), false, 'second password: closed by idle')
  assert.equal(open(PANEL_KEYS.settings, W), false, 'manager session: closed by idle')
  assert.equal(open(PANEL_KEYS.products, OTHER), true, 'another window is untouched')

  const manual = await ipc(W, IPC.managerLogout)
  assert.equal(manual.ok, true)
  assert.deepEqual([manual.data.session.manager, manual.data.session.panels], [false, []], '«خروج مدیر» closes everything, as before')
  assert.equal(open(PANEL_KEYS.cashClose, W), false)
  lockIpc.closeAllUnlocks()
  sessions.clearPanelSessions(OTHER)
})

test('«پنل فروش» opened with its own password or the manager password on its screen survives idle and time; manual logout closes it; a manager login elsewhere does not keep it', async () => {
  const set = await ipc(810, IPC.managerPanelSetPassword, { panel: POS, managerPassword: PW, password: POS_PW })
  assert.equal(set.ok, true, set.error)
  assert.equal((await ipc(810, IPC.managerPanelSetPassword, { panel: PANEL_KEYS.products, managerPassword: PW, password: PRODUCTS_PW })).ok, true)

  // رمز خود پنل فروش
  let v = await ipc(811, IPC.managerPanelVerify, { panel: POS, password: POS_PW })
  assert.deepEqual([v.ok, v.data?.scope], [true, 'PANEL'], v.error)
  assert.equal((await ipc(811, IPC.managerPanelVerify, { panel: PANEL_KEYS.products, password: PRODUCTS_PW })).data?.scope, 'PANEL')
  const realNow = Date.now
  Date.now = () => realNow() + 3 * sessions.panelSessionTtlMs()
  try {
    assert.equal(open(PANEL_KEYS.products, 811), false, 'a normal second-password session ends with time, as before')
    assert.equal(open(POS, 811), true, '«پنل فروش» does not')
  } finally { Date.now = realNow }
  await ipc(811, IPC.managerLogout, { idle: true })
  assert.equal(open(POS, 811), true, 'idle does not close «پنل فروش»')
  await ipc(811, IPC.managerLogout)
  assert.equal(open(POS, 811), false, '«خروج مدیر» closes it')

  // رمز مدیر روی صفحهٔ پنل فروش ⇐ نشست مدیر با بی‌کاری می‌رود، پنل فروش می‌ماند
  v = await ipc(812, IPC.managerPanelVerify, { panel: POS, password: PW })
  assert.deepEqual([v.ok, v.data?.scope], [true, 'MANAGER'], v.error)
  const idle = await ipc(812, IPC.managerLogout, { idle: true })
  assert.deepEqual([idle.data.session.manager, idle.data.session.panels], [false, [POS]])
  assert.equal(open(PANEL_KEYS.products, 812), false)
  assert.equal(open(POS, 812), true)
  await ipc(812, IPC.managerLogout)

  // ورود مدیر از صفحهٔ ورود (نه از پنل فروش) ⇐ پس از بی‌کاری پنل فروش یک بار رمز می‌خواهد
  assert.equal((await ipc(813, IPC.managerVerify, { password: PW })).ok, true)
  assert.equal(open(POS, 813), true)
  await ipc(813, IPC.managerLogout, { idle: true })
  assert.equal(open(POS, 813), false)
})

test('«باز کردن فوری قفل رمز اشتباه»: typed manager password; password locks open at once and a history row is written; the cash-desk PIN and the one-time code lock stay', async () => {
  const W = 820
  for (let i = 0; i < 3; i++) await sessions.runWithPanelSessionOwner(W, () => auth.assertPanelPassword(PANEL_KEYS.products, `wrong-${i}11`, 'آزمون')).catch(() => undefined)
  const locked = await sessions.runWithPanelSessionOwner(W, () => auth.assertPanelPassword(PANEL_KEYS.products, PRODUCTS_PW, 'آزمون')).then(() => null, (e) => e.message)
  assert.match(String(locked), /قفل/, 'three wrong passwords lock that entry point, even for the right one')
  const future = new Date(Date.now() + 9 * 60_000)
  await db.authLockout.upsert({ where: { gate: 'custody-pin:9' }, update: { failCount: 0, lockedUntil: future }, create: { gate: 'custody-pin:9', failCount: 0, lockedUntil: future, lockCount: 1 } })
  await db.authLockout.upsert({ where: { gate: 'manager-correction:9' }, update: { failCount: 1, lockedUntil: null }, create: { gate: 'manager-correction:9', failCount: 1, lockedUntil: null, lockCount: 0 } })
  const C = await lockIpc.createCodes({ managerPassword: PW })
  for (let i = 0; i < 5; i++) await sessions.runWithPanelSessionOwner(830, () => runInGateCall(830, () => redeemOneTimeCode(PANEL_KEYS.products, '13579246'))).catch(() => undefined)
  assert.ok(lockIpc.codesStatus().lockedMs > 0)

  events.length = 0
  let r = await ipc(W, IPC.managerPasswordLocksClear, {})
  assert.equal(r.ok, false, 'no typed password')
  r = await ipc(W, IPC.managerPasswordLocksClear, { managerPassword: 'wrong-73' })
  assert.equal(r.ok, false, 'a wrong password')
  assert.equal(events.filter((e) => e.kind === 'PASSWORD_LOCKS_CLEARED').length, 0)
  r = await ipc(W, IPC.managerPasswordLocksClear, { managerPassword: PW })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.cleared, 2, 'the «کالاها» entry point and the correction approval')
  await sessions.runWithPanelSessionOwner(W, () => auth.assertPanelPassword(PANEL_KEYS.products, PRODUCTS_PW, 'آزمون'))
  const pin = seed.one('SELECT lockedUntil FROM "AuthLockout" WHERE gate = ?', 'custody-pin:9')
  assert.ok(pin?.lockedUntil, 'the cash-desk PIN lock is separate and stays')
  assert.ok(lockIpc.codesStatus().lockedMs > 0, 'the one-time code lock is separate and stays')
  const row = events.filter((e) => e.kind === 'PASSWORD_LOCKS_CLEARED')
  assert.deepEqual(row.map((e) => e.count), [2])
  await lockIpc.unlockCodes({ managerPassword: PW })
  void C

  const data = emptyLookups(); data.users.set(5, 'مدیر')
  const [ev] = auditPageToEvents([{ id: 1, at: Date.UTC(2026, 10, 28, 9, 0), userId: 5, action: 'ACCESS_EVENT', entity: 'Access', entityId: null, after: JSON.stringify({ kind: 'PASSWORD_LOCKS_CLEARED', count: 2 }), note: null }],
    { offsetHours: 0, threshold: 0, includeCustomerName: false, data }, { closeShiftIds: [] })
  assert.ok(ev.title.startsWith('🔓 قفل رمز اشتباه به دست مدیر باز شد · '))
  assert.deepEqual(ev.lines, ['نقطه‌های ورود رمز: ۲', 'کاربر: مدیر'])
  assert.equal(ev.important, true)
})

test('screens and wiring: the idle path asks Main for an idle logout and reads the truth back (full logout if that fails); manual logout is unchanged; the button sits by the lockout settings with the same typed password', () => {
  const hook = read('src/renderer/src/hooks/useManagerSession.tsx')
  assert.match(hook, /await call\(CH\.managerLogout, \{ idle: true \}\)\s*\n\s*await syncFromMain\(\)/)
  assert.match(hook, /catch \{\s*\n\s*await logout\(\)\.catch\(\(\) => undefined\)/)
  assert.match(hook, /if \(Date\.now\(\) - lastActivity\.current >= idleMs\) void idleLogout\(\)/)
  assert.match(hook, /await call\(CH\.managerLogout\)\n/, 'manual logout: same call as before')
  const settings = read('src/renderer/src/pages/Settings.tsx')
  assert.match(settings, /call<\{ cleared: number \}>\(CH\.managerPasswordLocksClear, \{ managerPassword: securityPw \}\)/)
  assert.match(settings, />\s*باز کردن فوری قفل رمز اشتباه\s*</)
  assert.ok(settings.search(/>\s*باز کردن فوری قفل رمز اشتباه\s*</) > settings.indexOf('رمز و امنیت — قفل موقت بعد از رمز اشتباه'), 'in the lockout section')
})
