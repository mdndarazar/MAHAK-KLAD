/**
 * طرح ۱۴۰۵ · مرحلهٔ ۳ — آزمون‌های واحد پیام‌رسان (معماری §۴-۱ و §۸-۲ بند ۱۳).
 *
 * فهرست ثابت فیلدها در برابر نام‌های ممنوع، لایهٔ دوم پاک‌سازی، شکستن و بسته‌بندی پیام، خط ثابت «روش تأیید»،
 * جدول سه گزینه، دسته‌بندی پاسخ‌های Bot API روی loopback (۴۲۹، ۴۰۳، ۴۰۹، ۴۰۱، ۴۰۰، ۵xx، اتصال‌نشده) بی نشت کلید،
 * خواندن سخت‌گیر تنظیمات (fail-closed)، پیش‌فرض خاموش، قلاب بکاپ فقط در سطح اول، و سیم‌کشی IPC (دستهٔ ۱).
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-messenger-units.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const { EVENT_FIELDS, FORBIDDEN_FIELD_NAMES, parseMethodLine, pick, auditPageToEvents, emptyLookups } = await import('../../src/main/services/cloud/messenger/messengerEvents.ts')
const { scrubText, splitText, packItems, renderItem, fmtDuration } = await import('../../src/main/services/cloud/messenger/messengerFormat.ts')
const T = await import('../../src/main/services/cloud/messenger/messengerTypes.ts')
const { createBotApi, redactSecret } = await import('../../src/main/services/cloud/messenger/messengerAdapters.ts')
const { createMessengerStore } = await import('../../src/main/services/cloud/messenger/messengerVault.ts')
const { setDesktopBackupHooks, withDesktopBackupCoordination } = await import('../../src/main/services/cloud/desktopBackupCoordination.ts')
const { gateMethodNoteLine, GATE_METHOD_LABELS } = await import('@shared/gateCatalog')
const { IPC } = await import('@shared/ipc')

test('the fixed field allowlist never names a forbidden field; `pick` returns only allowed keys', () => {
  for (const [action, fields] of Object.entries(EVENT_FIELDS)) {
    for (const f of fields) assert.equal(FORBIDDEN_FIELD_NAMES.includes(f), false, `${action}.${f} is forbidden`)
  }
  const row = { action: 'SALE_CREATE', after: JSON.stringify({ receiptNo: 9, grandTotal: 5, returnCode: 'QVPV52', phone: '09120000001', note: 'x', code: 'ABC' }) }
  assert.deepEqual(pick(row), { receiptNo: 9, grandTotal: 5 })
  assert.deepEqual(pick({ action: 'UNKNOWN_ACTION', after: '{"amount":1}' }), {}, 'unknown types expose nothing')
  assert.deepEqual(pick({ action: 'SALE_CREATE', after: 'not json' }), {})
})

test('the messenger never reads phone, credit code, barcode or return-code columns, and never copies `note`', () => {
  const dbSrc = read('src/main/services/cloud/messenger/messengerDb.ts')
  for (const col of ['phone', 'code', 'legacyCode', 'returnCode', 'holderPhone', 'passwordHash', 'reference', 'chequeNo']) {
    assert.equal(new RegExp(`[{ ,]${col}: true`).test(dbSrc), false, `messengerDb selects ${col}`)
  }
  // `note` فقط از AuditLog خوانده می‌شود، برای خط ثابت «روش تأیید»؛ هرگز در پیام کپی نمی‌شود (پایین)
  assert.equal((dbSrc.match(/note: true/g) ?? []).length, 1, 'note is selected only by the AuditLog page reader')
  const ev = read('src/main/services/cloud/messenger/messengerEvents.ts')
  const uses = ev.match(/\.note\b/g) ?? []
  assert.deepEqual(uses, ['.note'], 'only parseMethodLine(row.note) reads the note column')
  assert.match(ev, /parseMethodLine\(row\.note\)/)
  for (const f of ['src/main/services/cloud/messenger/messengerEngine.ts', 'src/main/services/cloud/messenger/messengerFormat.ts', 'src/main/services/cloud/messenger/messengerSummary.ts']) {
    assert.equal(/\.note\b/.test(read(f)), false, `${f} reads note`)
  }
  const ctx = { offsetHours: 0, threshold: 100_000, includeCustomerName: false, data: emptyLookups() }
  const events = auditPageToEvents([{ id: 1, at: Date.now(), userId: null, action: 'SALE_CREATE', entity: 'SaleInvoice', entityId: 1, after: JSON.stringify({ receiptNo: 1, grandTotal: 1000, paidTotal: 1000 }), note: 'یادداشت آزاد با شماره 09121112233 و نام' }], ctx, { closeShiftIds: [] })
  assert.equal(events.length, 1)
  assert.equal(JSON.stringify(events).includes('یادداشت آزاد'), false)
})

test('second-layer scrub: mobile numbers (Latin, Persian, +98) and token-like strings are removed; amounts stay', () => {
  const text = 'تماس 09121234567 یا ۰۹۱۲۱۲۳۴۵۶۷ یا +989121234567 · کلید 123456789:AAHtelegramTOKENsecretVALUE0123456789 · مبلغ ۹۱۲٬۰۰۰٬۰۰۰ ریال · فاکتور ۹۱۲'
  const out = scrubText(text, ['SECRET-XYZ'])
  for (const bad of ['09121234567', '۰۹۱۲۱۲۳۴۵۶۷', '+989121234567', 'AAHtelegram']) assert.equal(out.includes(bad), false, bad)
  assert.ok(out.includes('۹۱۲٬۰۰۰٬۰۰۰ ریال') && out.includes('فاکتور ۹۱۲'))
  assert.equal(scrubText('x SECRET-XYZ y', ['SECRET-XYZ']), 'x [حذف شد] y')
  assert.equal(redactSecret('fetch https://api/bot123456789:AAHtelegramTOKENsecretVALUE0123456789/sendMessage failed', '123456789:AAHtelegramTOKENsecretVALUE0123456789').includes('AAHtelegram'), false)
})

test('packing: events in order, each with its own time and code, within the limit; long text is split', () => {
  const now = Date.now()
  const item = (i, extra = {}) => ({ code: `A-${i}`, at: now - i * 1000, title: `🧾 فروش · فاکتور ${i}`, lines: ['جمع: ۱۰۰ ریال'], important: false, maybeDup: false, sale: true, day: null, ...extra })
  const items = Array.from({ length: 50 }, (_, i) => item(i + 1))
  const packed = packItems(items, now, 1000)
  assert.ok(packed.count > 1 && packed.count < 50)
  assert.ok(packed.texts[0].length <= 1000)
  assert.ok(packed.texts[0].indexOf('A-1\n') < packed.texts[0].indexOf('A-2\n'), 'in order')
  const notice = packItems(items, now, 1000, '⚠️ ۳ پیام منقضی شد')
  assert.ok(notice.texts[0].startsWith('⚠️ ۳ پیام منقضی شد'), 'expired notice goes first')
  const single = packItems([item(1), item(2, { single: true })], now, 4096)
  assert.equal(single.count, 1, 'a «single» item (after a 400) is sent alone')
  const long = splitText(Array.from({ length: 400 }, (_, i) => `خط ${i}`).join('\n'), 300)
  assert.ok(long.length > 1 && long.every((p) => p.length <= 300))
  const late = renderItem(item(1, { at: now - 10 * 60_000, maybeDup: true, important: true }), now)
  assert.match(late, /^⚠️ 🧾/); assert.match(late, /🕒 ارسال با تأخیر/); assert.match(late, /ممکن است تکراری باشد/)
  assert.equal(renderItem(item(1, { title: '⚠️ صندوق بسته نشد', important: true }), now).startsWith('⚠️ ⚠️'), false, 'no double warning')
  assert.equal(fmtDuration(0), 'کمتر از یک دقیقه'); assert.equal(fmtDuration(130 * 60_000), '۲ ساعت و ۱۰ دقیقه')
})

test('method line: only the fixed label is read; the longest label wins; number and window are parsed', () => {
  for (const key of Object.keys(GATE_METHOD_LABELS)) {
    const parsed = parseMethodLine(`متن آزاد 0912\n${gateMethodNoteLine(key, { number: 3, windowNo: 7 })}`)
    assert.deepEqual(parsed, { method: key, number: 3, windowNo: 7 }, key)
  }
  assert.deepEqual(parseMethodLine(gateMethodNoteLine('SENSITIVE_CODE')), { method: 'SENSITIVE_CODE', number: null, windowNo: null })
  assert.equal(parseMethodLine('روش: کد یک‌بارمصرف'), null)
  assert.equal(parseMethodLine(null), null)
})

test('three options: all / handover / important; system notices reach everyone', () => {
  const ev = (f) => ({ important: false, handover: false, system: false, ...f })
  const cases = [[ev({}), [true, false, false]], [ev({ important: true }), [true, false, true]], [ev({ handover: true }), [true, true, false]], [ev({ system: true }), [true, true, true]]]
  for (const [e, want] of cases) assert.deepEqual(['all', 'handover', 'important'].map((m) => T.eventForMode(e, m)), want)
})

test('defaults are off; settings parsing is strict (fail-closed); proxy and token shapes', () => {
  const d = T.defaultMessengerSettings()
  assert.deepEqual([d.enabled, d.includeCustomerName, d.preventSleep, d.botButtons, d.recipients.length], [false, false, false, false, 0])
  assert.deepEqual(T.parseMessengerSettings(JSON.parse(JSON.stringify(d))), d)
  assert.equal(T.parseMessengerSettings({ ...d, extra: 1 }) !== null, true, 'unknown top-level keys are ignored only if the known ones are valid')
  assert.equal(T.parseMessengerSettings({ ...d, version: 2 }), null)
  assert.equal(T.parseMessengerSettings({ ...d, bots: { whatsapp: {} } }), null)
  assert.equal(T.parseMessengerSettings({ ...d, bots: { bale: { token: '123456:ABCDEFGHIJKLMNOPQRSTUV', username: 'b', proxy: 'socks5://127.0.0.1:1' } } }), null, 'bale never has a proxy')
  assert.equal(T.parseMessengerSettings({ ...d, recipients: [{ id: 'x' }] }), null)
  assert.equal(T.normalizeProxy(''), ''); assert.equal(T.normalizeProxy('socks5://127.0.0.1:10808'), 'socks5://127.0.0.1:10808')
  assert.equal(T.normalizeProxy('http://127.0.0.1:99999'), null); assert.equal(T.normalizeProxy('ftp://x:1'), null); assert.equal(T.normalizeProxy('socks5://a b:1'), null)
  assert.equal(T.validBotToken('123456789:AAHtelegramTOKENsecretVALUE0123456789'), true); assert.equal(T.validBotToken('123:short'), false)
  assert.match(T.newPairCode(), /^[A-HJ-NP-Z2-9]{8}$/)
})

test('Bot API outcomes on loopback: 429 retry_after, 403, 409, 401, 400, 5xx uncertain, refused unsent; no token leak', async () => {
  const TOKEN = '123456789:AAHtelegramTOKENsecretVALUE0123456789'
  const replies = [[200, { ok: true, result: { message_id: 1 } }], [429, { ok: false, parameters: { retry_after: 7 } }], [403, { ok: false, description: 'Forbidden' }], [409, { ok: false, description: 'Conflict' }], [401, { ok: false, description: `Unauthorized ${TOKEN}` }], [400, { ok: false, description: 'Bad Request: message is too long' }], [502, { ok: false, description: 'Bad Gateway' }]]
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { const [s, b] = replies.shift(); res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const api = createBotApi('bale', TOKEN, (u, i) => fetch(u, i), `http://127.0.0.1:${port}`)
  const kinds = []
  for (let i = 0; i < 7; i++) kinds.push(await api.sendMessage(1, 'x'))
  await new Promise((r) => { server.close(r); server.closeAllConnections() })
  assert.deepEqual(kinds.map((k) => k.kind), ['ok', 'retry', 'forbidden', 'conflict', 'unauthorized', 'bad', 'uncertain'])
  assert.equal(kinds[1].afterMs, 7000)
  assert.equal(JSON.stringify(kinds).includes('AAHtelegram'), false, 'token never in results')
  // درگاهی که هرگز به آن وصل نشده‌ایم (اتصال keep-alive کهنه «نامعلوم» است، نه «نرفت»)
  const deadPort = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const refused = await createBotApi('telegram', TOKEN, (u, i) => fetch(u, i), `http://127.0.0.1:${deadPort}`).sendMessage(1, 'x')
  assert.equal(refused.kind, 'unsent')
  assert.equal(JSON.stringify(refused).includes('AAHtelegram'), false)
})

test('vault: unavailable secure storage is not «broken» and never touches the file; writes are 0o600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahak-plan1405-vault-'))
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() }
  const store = createMessengerStore(dir, storage)
  store.writeSettings(T.defaultMessengerSettings())
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'messenger.vault')).mode & 0o777, 0o600)
  assert.equal(store.readSettings().state, 'ok')
  const before = readFileSync(join(dir, 'messenger.vault'))
  const blind = createMessengerStore(dir, { ...storage, isEncryptionAvailable: () => false })
  assert.equal(blind.readSettings().state, 'unavailable')
  assert.throws(() => blind.writeSettings(T.defaultMessengerSettings()), /Secure storage unavailable/)
  assert.deepEqual(readFileSync(join(dir, 'messenger.vault')), before)
  const identity = createMessengerStore(dir, { ...storage, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() })
  assert.throws(() => identity.writeSettings(T.defaultMessengerSettings()), /Secure storage failed/, 'a no-op protector is refused')
  writeFileSync(join(dir, 'messenger-outbox-probe'), 'x')
  assert.deepEqual(store.readOutbox('aaaaaaaaaaaa').items, [], 'missing outbox reads as empty')
})

test('backup hooks run once per top-level restore or merge (not for the nested merge), and never change its result', async () => {
  const calls = []
  setDesktopBackupHooks({ before: () => calls.push('before'), after: (o) => calls.push(`after:${o.ok}:${o.result?.mode ?? '-'}`) })
  const result = await withDesktopBackupCoordination(async () => {
    const inner = await withDesktopBackupCoordination(async () => 'nested')
    return { mode: 'merge', inner }
  })
  assert.deepEqual(result, { mode: 'merge', inner: 'nested' })
  await assert.rejects(withDesktopBackupCoordination(async () => { throw new Error('boom') }), /boom/)
  setDesktopBackupHooks({ before: () => { throw new Error('hook') }, after: () => { throw new Error('hook') } })
  assert.equal(await withDesktopBackupCoordination(async () => 7), 7, 'a failing hook never breaks the backup')
  setDesktopBackupHooks(undefined)
  assert.deepEqual(calls, ['before', 'after:true:merge', 'before', 'after:false:-'])
})

test('wiring: channels exist, category-1 changes need the typed manager password, local window only, start from registerIpc', () => {
  const ipcSrc = read('src/main/services/cloud/messenger/messengerIpc.ts')
  const channels = Object.entries(IPC).filter(([k]) => k.startsWith('messenger'))
  assert.equal(channels.length, 12)
  for (const [key] of channels) assert.ok(ipcSrc.includes(`IPC.${key},`), `handler for ${key}`)
  for (const key of ['messengerStatus', 'messengerPairCancel', 'messengerTest']) assert.match(ipcSrc, new RegExp(`handle\\(IPC\\.${key}, null,`), `${key} changes nothing`)
  const changing = channels.map(([k]) => k).filter((k) => !['messengerStatus', 'messengerPairCancel', 'messengerTest'].includes(k))
  for (const key of changing) assert.match(ipcSrc, new RegExp(`handle\\(IPC\\.${key}, (ACTION|'[^']+'),`), `${key} requires the manager password`)
  assert.match(ipcSrc, /if \(!isLocalAppFrame\(event\)\) return failure\('FORBIDDEN'/)
  assert.match(ipcSrc, /auth\.assertManagerPassword\(password, action\)/)
  const main = read('src/main/ipc/index.ts')
  assert.match(main, /try \{ registerMessengerHandlers\(\) \} catch/)
  assert.equal(read('src/main/index.ts').includes('messenger'), false, 'src/main/index.ts is untouched')
  const runtime = read('src/main/services/cloud/messenger/messengerRuntime.ts')
  assert.match(runtime, /if \(!e\.store\.vaultExists\(\)\) return/, 'no vault ⇒ no timer, connection or hook')
  assert.match(runtime, /mode: 'direct'/, 'bale goes direct (no proxy)')
  const preload = read('src/preload/index.ts')
  assert.match(preload, /\.\.\.Object\.values\(IPC\)/, 'the preload allowlist already covers new IPC channels')
})
