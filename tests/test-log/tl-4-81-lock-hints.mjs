/**
 * دفتر آزمون ۴-۸۱ — هر قفل: «با رمز کدام بخش باز می‌شود» و راه کد یک‌بارمصرف و مجوز راه دور:
 *  - `gatePasswordHint` (`panels.ts`) برای هر «قفل کار» کاتالوگ نام ماژول مادر، رمز جدای همان کار یا «فقط رمز مدیر» را
 *    می‌گوید، درست به قاعدهٔ main؛
 *  - همان نوشته با دروازهٔ واقعی main (`gate:unlock` و `manager:panel:info`) سنجیده می‌شود: رمز دوم «نسیه» کار strict آن را
 *    باز می‌کند و «صفر کردن برنامه» را نه؛ رمز جدای «صفر کردن برنامه» آن را باز می‌کند و نوشته هم همان را می‌گوید؛
 *  - پنجرهٔ سراسری «باز کردن قفل» نوشته را از همین می‌سازد؛ پنجره‌های «اصلاح و ابطال برگشت / تعویض» کد و مجوز دارند و
 *    پس از باز شدن با آن‌ها همان عملیات را ادامه می‌دهند؛ قفل خاموش ⇐ بی پنجره؛ برچسب‌های مبهم نام بخش را دارند.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-81-lock-hints.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-81-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (ch, fn) => handlers.set(ch, fn)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
harnessClient()
const auth = await import('../../src/main/services/AuthService.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { GATE_CATALOG } = await import('@shared/gateCatalog')
const { PANEL_KEYS, LOCKED_PANELS, gatePasswordHint, lockName, MANAGER_ONLY_PASSWORD_HINT } = await import('@shared/panels')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
registerIpcHandlers()

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const PW = '81604725'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const win = (id) => ({ sender: { id, isDestroyed: () => false, once: () => {} } })
const ipc = (id, ch, payload) => handlers.get(ch)(win(id), payload)
const actions = Object.values(GATE_CATALOG).filter((e) => e.category === 3)
const none = () => false

test('every action lock in the catalog says exactly which password opens it, by the main rule', () => {
  assert.equal(actions.length, 53)
  const titled = new Set(LOCKED_PANELS.map((p) => p.key))
  for (const e of actions) {
    const own = (k) => k === e.lockKey
    const parent = e.origin === 'STRICT' && e.parentPanel ? e.parentPanel : null
    if (parent && parent !== e.lockKey) {
      assert.ok(titled.has(parent), `${e.id}: the parent has a lock title`)
      const p = lockName(parent)
      assert.equal(gatePasswordHint(e.id, none), `این کار با رمز بخش «${p}» باز می‌شود: رمز مدیر، یا رمز دوم یا سوم «${p}»`, e.id)
      assert.equal(gatePasswordHint(e.id, own), `رمز مدیر، یا رمز دوم یا سوم مخصوص «${lockName(e.lockKey)}»، یا رمز دوم یا سوم بخش «${p}»`, e.id)
    } else {
      assert.equal(gatePasswordHint(e.id, none), MANAGER_ONLY_PASSWORD_HINT, e.id)
      assert.equal(gatePasswordHint(e.id, own), `رمز مدیر، یا رمز دوم یا سوم مخصوص «${lockName(e.lockKey)}»`, e.id)
    }
    assert.doesNotMatch(gatePasswordHint(e.id, none), /همین کار|ماژول مادرش|همین بخش/)
  }
  assert.equal(MANAGER_ONLY_PASSWORD_HINT, 'فقط رمز مدیر (یا کد یک‌بارمصرف یا مجوز راه دور)')
  assert.equal(lockName(PANEL_KEYS.salesCredit), 'نسیه')
  // نمونهٔ خود مالک: کار چک با رمز بخش «نسیه»
  assert.ok(actions.some((e) => /چک/.test(e.titleFa) && gatePasswordHint(e.id, none).startsWith('این کار با رمز بخش «نسیه» باز می‌شود')))
})

test('the same text agrees with the real gate: the «نسیه» password opens its cheque lock but not a manager-only lock; an own password opens its lock and the read-only status names it', async () => {
  const cheque = actions.find((e) => e.parentPanel === PANEL_KEYS.salesCredit && e.lockKey !== e.parentPanel)
  assert.ok(cheque, 'a cheque lock under «نسیه»')
  const CREDIT_PW = '52937184', RESET_PW = '64018273'
  let r = await ipc(990, IPC.managerPanelSetPassword, { panel: PANEL_KEYS.salesCredit, managerPassword: PW, password: CREDIT_PW })
  assert.equal(r.ok, true, r.error)
  r = await ipc(991, IPC.gateUnlock, { id: cheque.id, password: CREDIT_PW })
  assert.equal(r.ok, true, `${cheque.id}: ${r.error}`)
  r = await ipc(992, IPC.gateUnlock, { id: 'system.factory-reset', password: CREDIT_PW })
  assert.equal(r.ok, false, 'the «نسیه» password does not open a manager-only lock')
  assert.equal(gatePasswordHint('system.factory-reset', none), MANAGER_ONLY_PASSWORD_HINT)

  r = await ipc(993, IPC.managerPanelSetPassword, { panel: 'act-factory-reset', managerPassword: PW, password: RESET_PW })
  assert.equal(r.ok, true, r.error)
  const info = await ipc(994, IPC.managerPanelInfo, undefined)
  assert.equal(info.ok, true, info.error)
  const ownKeys = new Set(info.data.filter((p) => p.enabled || (p.shifts ?? []).some((s) => s.enabled)).map((p) => p.key))
  assert.ok(ownKeys.has('act-factory-reset') && ownKeys.has(PANEL_KEYS.salesCredit))
  assert.equal(gatePasswordHint('system.factory-reset', (k) => ownKeys.has(k)), 'رمز مدیر، یا رمز دوم یا سوم مخصوص «صفر کردن برنامه»')
  r = await ipc(995, IPC.gateUnlock, { id: 'system.factory-reset', password: RESET_PW })
  assert.equal(r.ok, true, r.error)
})

test('the global «باز کردن قفل» window builds its text from the catalog and the read-only status; the generic sentence is gone', () => {
  const s = read('src/renderer/src/components/GateUnlockDialog.tsx')
  assert.match(s, /import \{ gatePasswordHint \} from '@shared\/panels'/)
  assert.match(s, /call<PanelAuthState\[\]>\(CH\.managerPanelInfo\)[\s\S]{0,200}p\.enabled \|\| \(p\.shifts \?\? \[\]\)\.some\(\(s\) => s\.enabled\)/)
  assert.match(s, /<b>\{gatePasswordHint\(entry\.id, \(key\) => ownKeys\.has\(key\)\)\}<\/b>/)
  assert.doesNotMatch(s, /ماژول مادرش|رمز دوم\/سوم همین قسمت/)
  assert.match(s, /<OneTimeCodeBox target=\{entry\.id\}[\s\S]{0,120}<RemoteRequestBox panel=\{entry\.id\} \/>/, 'code and remote stay')
})

test('the «اصلاح و ابطال برگشت / تعویض» windows get the code and remote paths, continue after them, name the lock, and never show with the lock off', () => {
  for (const [file, p] of [['src/renderer/src/pages/SalesReturn.tsx', 'correction'], ['src/renderer/src/pages/SalesReports.tsx', 'exCorrection']]) {
    const s = read(file)
    const P = p[0].toUpperCase() + p.slice(1)
    assert.match(s, new RegExp(`\\{${p}UnlockError && <p[^\\n]*\\n\\s*\\{/\\* دفتر آزمون ۴-۸۱[^\\n]*\\*/\\}\\s*<OneTimeCodeBox target=\\{PANEL_KEYS\\.salesReturnCorrection\\} />\\s*\\{remoteImplementationReady\\(\\) && <RemoteRequestBox panel=\\{PANEL_KEYS\\.salesReturnCorrection\\} />\\}`), file)
    assert.match(s, new RegExp(`useEffect\\(\\(\\) => \\{\\s*if \\(!correctionOpen \\|\\| !${p}UnlockRequest \\|\\| ${p}UnlockBusy\\) return[\\s\\S]{0,400}launch(Return|Exchange)CorrectionAction\\(request\\)\\s*// eslint-disable-next-line react-hooks/exhaustive-deps\\s*\\}, \\[correctionOpen\\]\\)`), `${file}: continues after a code or a remote approval`)
    assert.ok(s.includes('placeholder={`رمز مدیر یا رمز دوم/سوم «${lockName(PANEL_KEYS.salesReturnCorrection)}»`}'), file)
    assert.ok(s.includes('`برای باز کردن قفل این عملیات، رمز مدیر یا رمز دوم/سوم «${lockName(PANEL_KEYS.salesReturnCorrection)}» را وارد کنید (یا کد یک‌بارمصرف یا مجوز راه دور).`'), file)
    assert.match(s, /const correctionOpen = usePanelOpen\(PANEL_KEYS\.salesReturnCorrection\)/, `${file}: lock off ⇒ open ⇒ no window`)
    assert.match(s, /if \(correctionOpen\) \{\s*launch(Return|Exchange)CorrectionAction\(request\)\s*return\s*\}/, file)
    assert.ok(s.includes(`set${P}UnlockRequest(request)`), file)
  }
  assert.equal(lockName(PANEL_KEYS.salesReturnCorrection), 'اصلاح و ابطال برگشت / تعویض')
})

test('vague password labels now name their section', () => {
  const vague = /رمز دوم همین پنل|رمز دوم\/سوم این عملیات|رمز دوم\/سوم همین بخش|رمز دوم این بخش|رمز دوم همین بخش|رمز دوم همین عمل|رمز دوم (اختصاصی )?همین گزینه/
  for (const f of ['components/CardTransferPanel.tsx', 'pages/CategoryCharges.tsx', 'components/BridgeDiagnosticsModal.tsx', 'pages/SalesReturn.tsx', 'pages/SalesReports.tsx',
    'pages/Pos.tsx', 'components/AutoCentralPasswordBox.tsx', 'components/StockSourceModal.tsx']) {
    assert.doesNotMatch(read(`src/renderer/src/${f}`), vague, f)
  }
  const card = read('src/renderer/src/components/CardTransferPanel.tsx')
  assert.equal((card.match(/رمز مدیر یا رمز دوم\/سوم «\{lockName\(PANEL_KEYS\.cardTransfers\)\}»/g) ?? []).length, 3)
  assert.ok(read('src/renderer/src/pages/CategoryCharges.tsx').includes('title={`رمز مدیر یا رمز دوم/سوم «${label}»`}'))
  const bridge = read('src/renderer/src/components/BridgeDiagnosticsModal.tsx')
  assert.ok(bridge.includes('رمز دوم/سوم «{lockName(PANEL_KEYS.bridgeDiagnostics)}».'))
  assert.ok(bridge.includes('placeholder={`رمز مدیر / رمز دوم یا سوم «${lockName(PANEL_KEYS.bridgeDiagnostics)}»`}'))
  assert.equal(lockName(PANEL_KEYS.cardTransfers), 'پرداخت‌های مدیر — کارت‌به‌کارت')
  const pos = read('src/renderer/src/pages/Pos.tsx')
  assert.equal((pos.match(/رمز دوم\/سوم «\$\{lockName\(PANEL_KEYS\.posPrintToggle\)\}»/g) ?? []).length, 2, 'print toggle box and its message')
  assert.ok(read('src/renderer/src/components/AutoCentralPasswordBox.tsx').includes('title={`رمز مدیر یا رمز دوم/سوم «${lockName(PANEL_KEYS.posCentralWithdrawToggle)}»؛ بعد از هر تلاش پاک می‌شود`}'))
  const stock = read('src/renderer/src/components/StockSourceModal.tsx')
  assert.equal((stock.match(/رمز دوم\/سوم «\$\{lockName\(PANEL_KEYS\.posCentralWithdrawToggle\)\}»/g) ?? []).length, 2, 'stock source label and hint (the server checks the same lock)')
  assert.ok(read('src/renderer/src/pages/SalesReports.tsx').includes('رمز مدیر یا رمز دوم/سوم «{lockName(PANEL_KEYS.salesReturnCorrection)}» را می‌پذیرد.'), 'the exchange-void hint names its lock')
})
