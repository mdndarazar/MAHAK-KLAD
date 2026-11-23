/**
 * طرح ۱۴۰۵ — شش کار «موجودی سایت» پشت دروازهٔ مرکزی (معماری §۳-۷؛ §۸-۲ بند ۱۹).
 *
 * هندلرهای واقعی IPC (با ماک الکترون s129 و پایگاه دادهٔ موقت) بی رمز صدا زده می‌شوند، مثل رابط تازه که دیگر
 * پنجرهٔ پرسش مرورگر ندارد. برای هر کار: قسمت باز ولی بی مجوز ⇒ رد با `GATE_REQUIRED:<شناسه>`؛ نشست مدیر ⇒ دروازه
 * رد نمی‌کند؛ بلیت یک‌بار (مجوز راه دور) ⇒ یک بار و مصرف می‌شود؛ کلید استثنای `woo-sync` خاموش ⇒ بی رمز. خطای بعدی
 * خود سرویس (نبود اتصال آزمایشی) دروازه نیست و فقط این‌جا جدا شمرده می‌شود.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-woo-gate.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'plan1405-woo-gate-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
register('./support/s129-hooks.mjs', import.meta.url)

const mock = await import('./support/s129-electron-mock.mjs')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 190522, isDestroyed: () => false, once: () => {} }

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const sessions = await import('../../src/main/services/panelSession.ts')
const tickets = await import('../../src/main/services/locks/tickets.ts')
const { IPC } = await import('../../src/shared/ipc.ts')
const { SETTING_KEYS } = await import('../../src/shared/receipt.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')

const db = harnessClient()
const seed = makeSeeder(db)
registerIpcHandlers()
const invoke = (channel, payload) => {
  const fn = handlers.get(channel)
  assert.ok(fn, `handler for ${channel}`)
  return fn({ sender }, payload)
}

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' · ' + extra : ''}`) }
}

/** شش کار، با همان payload رابط (رمز هرگز فرستاده نمی‌شود؛ managerPassword: null) */
const ACTIONS = [
  ['woo.connect-initial', IPC.wooLinkCreate, { variantId: 1, wooProductId: 1, decision: 'WOO_WINS', managerPassword: null }],
  ['woo.reconnect', IPC.wooLinksResumeApply, { linkId: 1, managerPassword: null }],
  ['woo.disconnect', IPC.wooLinksUnlink, { linkId: 1, managerPassword: null }],
  ['woo.parked-process', IPC.wooParkedRetry, { managerPassword: null }],
  ['woo.decision', IPC.wooApprovalResolve, { approvalId: 1, decision: 'APPROVE', managerPassword: null }],
  ['woo.bulk-link', IPC.wooLinksResumeProductMahak, { linkId: 1, managerPassword: null }]
]
const gateCode = (r) => (r && r.ok === false && typeof r.code === 'string' && r.code.startsWith('GATE_REQUIRED:') ? r.code : null)
const reset = () => {
  sessions.clearPanelSessions()
  tickets.clearGateTickets()
  seed.setting(SETTING_KEYS.panelLocks, {})
}

try {
  for (const [id, channel, payload] of ACTIONS) {
    console.log(`\n— ${id}`)
    reset()
    sessions.notePanelUnlocked(PANEL_KEYS.wooSync, 'PANEL', sender.id)
    const denied = await invoke(channel, payload)
    ok('قسمت «موجودی سایت» باز، بی مجوز ⇒ رد با GATE_REQUIRED همین کار', gateCode(denied) === `GATE_REQUIRED:${id}`, JSON.stringify(denied).slice(0, 200))

    tickets.addGateTicket(sender.id, id, 60_000, 'REMOTE_GRANT')
    const withTicket = await invoke(channel, payload)
    ok('بلیت یک‌بار (مجوز راه دور) ⇒ دروازه رد نمی‌کند و بلیت مصرف می‌شود', !gateCode(withTicket) && tickets.gateTicketCount() === 0, JSON.stringify(withTicket).slice(0, 200))
    ok('فراخوانی بعدی بی بلیت دوباره رد می‌شود', gateCode(await invoke(channel, payload)) === `GATE_REQUIRED:${id}`)

    reset()
    sessions.notePanelUnlocked('settings', 'MANAGER', sender.id)
    const withSession = await invoke(channel, payload)
    ok('نشست مدیر همین پنجره ⇒ بی رمز، دروازه رد نمی‌کند', !gateCode(withSession), JSON.stringify(withSession).slice(0, 200))

    reset()
    seed.setting(SETTING_KEYS.panelLocks, { [PANEL_KEYS.wooSync]: false })
    const lockOff = await invoke(channel, payload)
    ok('کلید استثنای woo-sync خاموش ⇒ بی رمز (قسمت و کارهایش)', !gateCode(lockOff), JSON.stringify(lockOff).slice(0, 200))
  }
} finally {
  reset()
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} بررسی موفق · ${fail} ناموفق`)
process.exit(fail ? 1 : 0)
