/**
 * دفتر آزمون ۴-۱۲ — فرستادن کدهای یک‌بارمصرف تازه به تلگرام و بله، روی سرور ساختگی Bot API (loopback) با موتور واقعی پیام‌رسان:
 *  - تیک «دریافت کدهای یک‌بارمصرف» هر گیرنده: پیش‌فرض خاموش (گاوصندوق قدیمی بی این کلید)؛ روشن و خاموش کردن با خبر به همه؛
 *  - «ساخت ۵ کد تازه» ⇐ یک پیام، درجا، فقط به گیرنده‌های فعالِ تیک‌دار: «۱) …» تا «۵) …» و خط آخر «این پیام را به کسی نشان ندهید …»؛
 *  - کد هیچ‌جا نوشته نمی‌شود: نه صف و آمار صف، نه گاوصندوق، نه نشانگر، نه ردیف سابقه، نه هیچ پرونده‌ای؛
 *  - شکست دوباره فرستاده نمی‌شود و صفحهٔ کدها «نرسید» یا «معلوم نشد» می‌گیرد (حداکثر ۱۰ ثانیه برای هر گیرنده)؛
 *  - با پیام‌رسان خاموش یا بی گیرندهٔ تیک‌دار هیچ کدی نمی‌رود و ساخت کد کار می‌کند.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-12-codes-to-messenger.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mahak-tl-4-12-'))
process.env.HARNESS_DIR = ROOT
process.env.HARNESS_DB = join(ROOT, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const auth = await import('../../src/main/services/AuthService.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { createMessengerEngine } = await import('../../src/main/services/cloud/messenger/messengerEngine.ts')
const { createMessengerDb } = await import('../../src/main/services/cloud/messenger/messengerDb.ts')
const { createMessengerStore } = await import('../../src/main/services/cloud/messenger/messengerVault.ts')
const { parseMessengerSettings } = await import('../../src/main/services/cloud/messenger/messengerTypes.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')
const { faDigits } = await import('@shared/jalali')

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
harnessClient()
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })
const events = []
setAccessEventWriter((row) => { events.push(row) })

// ---------------------------------------------------------------- ذخیره‌ساز امن ساختگی و سرور ساختگی Bot API
const SECRET = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', SECRET, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]) },
  decryptString(value) { const d = createDecipheriv('aes-256-gcm', SECRET, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8') }
}
const TOKENS = { telegram: '123456789:AAHtelegramTOKENsecretVALUE0123456789', bale: '987654321:BBHbaleTOKENsecretVALUE01234567890123' }
const PREFIX = { telegram: 'tg', bale: 'bale' }
/** پاسخ هر پیام‌رسان: `ok`، `bad` (۴۰۰ از سرور)، `reset` (اتصال پس از فرستادن قطع شد ⇐ نامعلوم) و `hang` (جوابی نمی‌آید) */
const mode = { telegram: 'ok', bale: 'ok' }
const mock = { log: [], port: 0 }
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const m = /^\/(tg|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
    if (!m) return send(404, { ok: false, description: 'Not Found' })
    let params = {}
    try { params = JSON.parse(body || '{}') } catch {}
    mock.log.push({ prefix: m[1], method: m[3], params })
    if (m[3] === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, username: `${m[1]}_shop_bot` } })
    if (m[3] === 'getUpdates') return send(200, { ok: true, result: [] })
    if (m[3] === 'sendMessage') {
      if ((m[1] === 'tg' ? mode.telegram : mode.bale) === 'bad') return send(400, { ok: false, description: 'Bad Request: chat not found' })
      return send(200, { ok: true, result: { message_id: mock.log.length } })
    }
    return send(404, { ok: false, description: 'Not Found' })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { mock.port = server.address().port; resolve() }))
server.unref()
const fetchFor = (provider) => (url, init) => {
  if (mode[provider] === 'reset') return Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
  if (mode[provider] === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  return fetch(url, init)
}

// ---------------------------------------------------------------- گیرنده‌ها و موتور
const R1 = { id: 'aaaaaaaa4121', provider: 'telegram', chatId: 4121, name: 'مالک تلگرام', mode: 'important', active: true, inactiveReason: null, addedAt: 1, canApprove: false, canViewReports: false, receiveCodes: true }
// گاوصندوق قدیمی: کلید receiveCodes ندارد
const R2 = { id: 'bbbbbbbb4122', provider: 'telegram', chatId: 4122, name: 'حسابدار', mode: 'all', active: true, inactiveReason: null, addedAt: 1, canApprove: false }
const R3 = { id: 'cccccccc4123', provider: 'bale', chatId: 4123, name: 'مالک بله', mode: 'important', active: true, inactiveReason: null, addedAt: 1, canApprove: false, canViewReports: false, receiveCodes: true }
const R4 = { id: 'dddddddd4124', provider: 'telegram', chatId: 4124, name: 'گیرندهٔ غیرفعال', mode: 'all', active: false, inactiveReason: 'گیرنده ربات را بسته است', addedAt: 1, canApprove: false, receiveCodes: true }
const dir = join(ROOT, 'userdata'); mkdirSync(dir, { recursive: true })
const store = createMessengerStore(dir, storage)
const SETTINGS = {
  version: 1, enabled: true, includeCustomerName: false, preventSleep: false, botButtons: false,
  bots: { telegram: { token: TOKENS.telegram, username: 'tg_shop_bot', proxy: '' }, bale: { token: TOKENS.bale, username: 'bale_shop_bot', proxy: '' } },
  recipients: [R1, R2, R3, R4]
}
store.writeSettings(SETTINGS)
let clock = Date.now()
const engine = createMessengerEngine({
  dir, storage, db: createMessengerDb(),
  summary: { salesSummary: async () => ({}), staffPerformance: async () => [], abnormalDiscounts: async () => [], lastBackupAt: async () => null },
  fetchFor, baseUrls: { telegram: `http://127.0.0.1:${mock.port}/tg`, bale: `http://127.0.0.1:${mock.port}/bale` },
  now: () => clock, schedule: false, databasePath: process.env.HARNESS_DB, log: () => {}, pairPollSeconds: 0, botPollSeconds: 0
})
await engine.start()
// همان سیم‌کشی `registerMessengerHandlers` (آزمون ۵ همان عبارت را در خود پرونده می‌سنجد)
lockIpc.setOneTimeCodesSender((codes) => engine.sendOneTimeCodes(codes))

const sendsSince = (mark) => mock.log.slice(mark).filter((e) => e.method === 'sendMessage')
const codeSends = (mark) => sendsSince(mark).filter((e) => String(e.params.text).includes('🔑 کدهای یک‌بارمصرف تازه'))
const chatOf = (e) => e.params.chat_id
const filesUnder = (d) => readdirSync(d).flatMap((name) => { const p = join(d, name); return statSync(p).isDirectory() ? filesUnder(p) : [p] })
/** کد خام هیچ‌جا: هیچ پرونده‌ای زیر پوشهٔ آزمون (پایگاه، پروندهٔ کدها، صف‌ها، نشانگر)، گاوصندوق رمزگشوده، صف‌ها، نشانگر، وضعیت و ردیف‌های سابقه. */
function assertNowhere(codes, label) {
  const raw = codes.map((c) => c.code)
  for (const p of filesUnder(ROOT)) {
    const body = readFileSync(p).toString('latin1')
    assert.ok(!raw.some((c) => body.includes(c)), `${label}: a raw code in ${p}`)
  }
  const vault = store.readSettings()
  const inside = JSON.stringify([vault, [R1, R2, R3, R4].map((r) => store.readOutbox(r.id)), store.readCursor(), engine.status(), events])
  assert.ok(!raw.some((c) => inside.includes(c)), `${label}: a raw code in the vault, a queue, the cursor, the status or an access row`)
}

test('the tick «دریافت کدهای یک‌بارمصرف» is off by default and in an old vault; turning it on or off is announced to everyone and kept in the vault', async () => {
  assert.equal(parseMessengerSettings(SETTINGS).recipients.find((r) => r.id === R2.id).receiveCodes, false, 'old vault: off')
  assert.deepEqual(engine.status().recipients.map((r) => [r.id, r.receiveCodes]), [[R1.id, true], [R2.id, false], [R3.id, true], [R4.id, true]])
  let mark = mock.log.length
  await engine.setRecipientCodes(R2.id, true)
  let texts = sendsSince(mark).map((e) => e.params.text)
  assert.ok(texts.some((t) => t.includes('🔑 دریافت کدهای یک‌بارمصرف برای یک گیرنده روشن شد') && t.includes('گیرنده: حسابدار (تلگرام)')), texts.join('\n---\n'))
  assert.equal(store.readSettings().settings.recipients.find((r) => r.id === R2.id).receiveCodes, true)
  mark = mock.log.length
  await engine.setRecipientCodes(R2.id, false)
  texts = sendsSince(mark).map((e) => e.params.text)
  assert.ok(texts.some((t) => t.includes('🔑 دریافت کدهای یک‌بارمصرف برای یک گیرنده خاموش شد')))
  assert.equal(store.readSettings().settings.recipients.find((r) => r.id === R2.id).receiveCodes, false)
  mark = mock.log.length
  await engine.setRecipientCodes(R2.id, false)
  assert.equal(sendsSince(mark).length, 0, 'no change, no news')
  await assert.rejects(engine.setRecipientCodes('ffffffffffff', true))
})

test('making 5 new codes sends one message at once, only to the active ticked recipients: numbered codes, the closing line; the codes are written nowhere', async () => {
  events.length = 0
  const mark = mock.log.length
  const C = await lockIpc.createCodes({ managerPassword: PW })
  assert.deepEqual(C.sent, { delivered: 2, failed: [] })
  const sends = codeSends(mark)
  assert.deepEqual(sends.map(chatOf).sort(), [R1.chatId, R3.chatId], 'the Telegram and Bale owners; not the unticked nor the inactive recipient')
  assert.deepEqual(sends.map((e) => e.prefix).sort(), ['bale', 'tg'])
  const text = sends[0].params.text
  assert.equal(sends[1].params.text, text)
  let at = -1
  for (const c of C.codes) {
    const i = text.indexOf(`${faDigits(c.n)}) ${c.code}`)
    assert.ok(i > at, `code ${c.n} on its own numbered line, in order`)
    at = i
  }
  assert.ok(text.includes('هر کد روی همهٔ ماژول‌ها و قفل‌های کار یک بار کار می‌کند، جز «کلیدسازی».'))
  const last = text.indexOf('این پیام را به کسی نشان ندهید و برای کسی نفرستید.')
  assert.ok(last > at, 'the warning comes after the codes')
  assert.doesNotMatch(text, /حساس|سایر/)
  assert.equal(sendsSince(mark).length, 2, 'nothing else went out at once')
  assert.deepEqual(events.map((e) => [e.kind, e.count]), [['CODES_CREATED', 5]], 'the history row has only the count')
  await engine.runOnce()
  assert.equal(codeSends(mark).length, 2, 'not sent again by the queue')
  assertNowhere(C.codes, 'after a good send')
})

test('a failed send is not retried and the codes page is told: «نرسید» when refused, «معلوم نشد» when the connection broke or nothing came back within 10 seconds', async () => {
  mode.telegram = 'bad'; mode.bale = 'reset'
  let mark = mock.log.length
  const C = await lockIpc.createCodes({ managerPassword: PW })
  const byName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name))
  assert.deepEqual({ ...C.sent, failed: byName(C.sent.failed) }, { delivered: 0, failed: byName([{ provider: 'تلگرام', name: 'مالک تلگرام', uncertain: false }, { provider: 'بله', name: 'مالک بله', uncertain: true }]) })
  assert.equal(codeSends(mark).length, 1, 'one refused try to Telegram; Bale never reached the server')
  mode.telegram = 'ok'; mode.bale = 'ok'
  await engine.runOnce()
  assert.equal(codeSends(mark).length, 1, 'never sent again')
  assertNowhere(C.codes, 'after a failed send')

  mode.bale = 'hang'
  mark = mock.log.length
  const started = Date.now()
  const D = await lockIpc.createCodes({ managerPassword: PW })
  const took = Date.now() - started
  assert.ok(took >= 9_500 && took < 14_000, `the page waited about 10 seconds (${took} ms)`)
  assert.deepEqual(D.sent, { delivered: 1, failed: [{ provider: 'بله', name: 'مالک بله', uncertain: true }] })
  assert.deepEqual(codeSends(mark).map(chatOf), [R1.chatId])
  mode.bale = 'ok'
  assertNowhere(D.codes, 'after no answer')
})

test('with the messenger off, or no ticked recipient, no code goes out and making codes still works', async () => {
  await engine.setEnabled(false)
  let mark = mock.log.length
  let C = await lockIpc.createCodes({ managerPassword: PW })
  assert.equal(C.codes.length, 5)
  assert.deepEqual(C.sent, { delivered: 0, failed: [] })
  assert.equal(codeSends(mark).length, 0)
  await engine.setEnabled(true)
  await engine.setRecipientCodes(R1.id, false)
  await engine.setRecipientCodes(R3.id, false)
  mark = mock.log.length
  C = await lockIpc.createCodes({ managerPassword: PW })
  assert.deepEqual(C.sent, { delivered: 0, failed: [] })
  assert.equal(codeSends(mark).length, 0)
  lockIpc.setOneTimeCodesSender(null)
  C = await lockIpc.createCodes({ managerPassword: PW })
  assert.deepEqual(C.sent, { delivered: 0, failed: [] }, 'no messenger wired (as in tests): nothing to send')
  lockIpc.setOneTimeCodesSender(async () => { throw new Error('messenger broke') })
  C = await lockIpc.createCodes({ managerPassword: PW })
  assert.equal(C.codes.length, 5, 'a broken sender never undoes making the codes')
  assert.deepEqual(C.sent, { delivered: 0, failed: [] })
  lockIpc.setOneTimeCodesSender((codes) => engine.sendOneTimeCodes(codes))
})

test('screens and wiring: the tick in the recipient settings, through the same password channel; the codes page shows «نرسید», «معلوم نشد» and the hint; the sender only sends', () => {
  const ui = read('src/renderer/src/components/MessengerSettings.tsx')
  assert.match(ui, /checked=\{r\.receiveCodes === true\} disabled=\{busy \|\| needPassword\}/)
  assert.match(ui, /run\(CH\.messengerRecipientUpdate, \{ id: r\.id, receiveCodes: e\.target\.checked \}/)
  assert.match(ui, /دریافت کدهای یک‌بارمصرف/)
  const ipc = read('src/main/services/cloud/messenger/messengerIpc.ts')
  assert.match(ipc, /setOneTimeCodesSender\(\(codes\) => messengerEngine\(\)\.sendOneTimeCodes\(codes\)\)/)
  const branch = ipc.slice(ipc.indexOf('handle(IPC.messengerRecipientUpdate, ACTION'), ipc.indexOf('handle(IPC.messengerRecipientRemove'))
  assert.match(branch, /typeof input\.receiveCodes === 'boolean'[\s\S]*setRecipientCodes\(input\.id, input\.receiveCodes\)/, 'same channel, same manager password (ACTION)')
  const codesUi = read('src/renderer/src/components/OneTimeCodesSettings.tsx')
  assert.match(codesUi, /معلوم نشد به \$\{f\.provider\} رسید یا نه/)
  assert.match(codesUi, /به \$\{f\.provider\} نرسید/)
  assert.match(codesUi, /تیک «دریافت کدهای یک‌بارمصرف» را بزنید/)
  const engineSrc = read('src/main/services/cloud/messenger/messengerEngine.ts')
  assert.match(engineSrc, /addedAt: now\(\), canApprove: false, canViewReports: false, receiveCodes: false/, 'a newly paired recipient starts with the tick off')
  const fn = engineSrc.slice(engineSrc.indexOf('sendOneTimeCodes: async'), engineSrc.indexOf('botPollOnce:'))
  assert.ok(fn.length > 200)
  assert.doesNotMatch(fn, /enqueue|appendItems|writeOutbox|readOutbox|writeCursor|persist\(|noteAccessEvent|log\('[^']*', /, 'no queue, no file, no history; the log line has no details')
})

test('the real recipient-update channel saves the tick only with the typed manager password; registering the messenger hands its sender to code making', async () => {
  // همان کانال واقعی `messengerIpc.ts` با رویداد یک پنجرهٔ برنامه، روی گاوصندوق جای برنامه (پیام‌رسان خاموش، پس هیچ حلقه‌ای راه نمی‌افتد)
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, fn) => { handlers.set(channel, fn) }
  Object.assign(electron.safeStorage, storage)
  electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  const frame = { url: 'http://localhost:5173/' }
  const event = { sender: { id: 41, isDestroyed: () => false, once: () => {}, mainFrame: frame }, senderFrame: frame }
  const { registerMessengerHandlers } = await import('../../src/main/services/cloud/messenger/messengerIpc.ts')
  const { IPC } = await import('@shared/ipc')
  registerMessengerHandlers()
  const appStore = createMessengerStore(ROOT, storage)
  appStore.writeSettings({ ...SETTINGS, enabled: false })
  const update = (payload) => handlers.get(IPC.messengerRecipientUpdate)(event, payload)
  const tickOf = () => appStore.readSettings().settings.recipients.find((r) => r.id === R2.id).receiveCodes
  let r = await update({ id: R2.id, receiveCodes: true })
  assert.deepEqual([r.ok, r.code], [false, 'MANAGER_PASSWORD'], 'no typed password')
  r = await update({ id: R2.id, receiveCodes: true, managerPassword: 'wrong-7319' })
  assert.deepEqual([r.ok, r.code], [false, 'MANAGER_PASSWORD'], 'a wrong password')
  assert.equal(tickOf(), false)
  r = await update({ id: R2.id, receiveCodes: true, managerPassword: PW })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(tickOf(), true)
  assert.equal(r.data.recipients.find((x) => x.id === R2.id).receiveCodes, true, 'the settings page sees the tick')
  r = await update({ id: R2.id, receiveCodes: false, managerPassword: PW })
  assert.equal(r.ok, true)
  assert.equal(tickOf(), false)
  // سیم‌کشی واقعی: فرستندهٔ کدها حالا موتور برنامه است (این‌جا خاموش، پس چیزی نمی‌رود)
  const mark = mock.log.length
  const C = await lockIpc.createCodes({ managerPassword: PW })
  assert.deepEqual(C.sent, { delivered: 0, failed: [] })
  assert.equal(codeSends(mark).length, 0)
})
