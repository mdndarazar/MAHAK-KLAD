/**
 * دفتر آزمون ۴-۱۰ — خانهٔ تاریخ صفحهٔ گوشی: سال، ماه و روز جدا با «/» ثابت، فقط رقم (فارسی هم)،
 * رفتن خودکار مکان‌نما، پیش‌فرض امروزِ سرور. مقدار کامل در همان خانهٔ قدیمی (پنهان) می‌نشیند،
 * پس درخواست به سرور همان قالب «1405/09/01» است.
 * آزمون ساختاری با DOM ساختگی (مثل remote-mobile-invoices-ui.mjs)؛ نه مرورگر و گوشی واقعی.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { mobileHtml, mobileJs } from '../../src/main/services/cloud/mobilePwaAssets.ts'

const IDS = ['invoice-from', 'invoice-to', 'report-from', 'report-to']

function fixture({ today = '1405/09/06' } = {}) {
  const elements = new Map()
  const focused = []
  const calls = []
  class Element {
    constructor(id = '') { this.id = id; this.hidden = false; this.value = ''; this.checked = false; this.children = []; this.events = {}; this._text = '' }
    addEventListener(event, handler) { this.events[event] = handler }
    appendChild(child) { this.children.push(child) }
    set textContent(value) { this._text = String(value); this.children = [] }
    get textContent() { return this._text }
    focus() { focused.push(this.id) }
    select() {}
    fire(event, extra = {}) { return this.events[event]({ preventDefault() {}, ...extra }) }
  }
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id) }
  for (const id of ['dashboard', 'owner-tools', 'invoice-tools', 'invoice-acl-label', 'invoice-next']) el(id).hidden = true
  const response = (value, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, json: async () => value, headers: { get: (name) => headers[name] ?? null } })
  const fetch = async (path, options = {}) => {
    calls.push({ path, options })
    if (path === '/api/session') return response({ user: { username: 'owner', role: 'OWNER' } })
    if (path === '/api/capabilities') return response({ invoices: true }, 200, today === null ? {} : { 'x-mahak-today': today })
    if (path === '/api/custody') return response({ boundary: null })
    if (path === '/api/shifts') return response({ shifts: [], hasMore: false })
    if (path === '/api/members') return response({ members: [] })
    if (path === '/api/requests') return response({ error: 'unavailable' }, 404)
    if (path === '/api/invoices') return response({ invoices: [], hasMore: false })
    throw new Error('Unexpected API ' + path)
  }
  vm.runInNewContext(mobileJs, { document: { getElementById: el, createElement: () => new Element() }, navigator: {}, fetch, console }, { timeout: 1000 })
  const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
  const type = (id, value) => { el(id).value = value; return el(id).fire('input') }
  return { el, focused, calls, flush, type }
}

await test('HTML: each date has year, month and day boxes with fixed slashes and the old id as a hidden full value', () => {
  for (const id of IDS) {
    const group = new RegExp(`<span class="jdate" dir="ltr"><input id="${id}-y" inputmode="numeric" maxlength="4"[^>]*>/<input id="${id}-m" inputmode="numeric" maxlength="2"[^>]*>/<input id="${id}-d" inputmode="numeric" maxlength="2"[^>]*><input id="${id}" type="hidden"></span>`)
    assert.match(mobileHtml, group, id)
    assert.match(mobileHtml, new RegExp(`<label for="${id}-y">`), id)
    assert.ok(!mobileHtml.includes(`id="${id}" placeholder=`), `${id}: old free-text box is gone`)
  }
  assert.ok(!mobileJs.includes('innerHTML'))
  assert.ok(!mobileJs.includes('localStorage'))
  assert.equal(mobileJs.split('setInterval(').length - 1, 1, 'no new timer')
})

await test('default is today from the server; typing only accepts digits (Persian too) and moves on by itself', async () => {
  const f = fixture()
  await f.flush()
  for (const id of IDS) {
    assert.equal(f.el(id).value, '1405/09/06', id)
    assert.deepEqual([f.el(id + '-y').value, f.el(id + '-m').value, f.el(id + '-d').value], ['1405', '09', '06'], id)
  }
  f.type('invoice-from-y', '۱۴۰۴')
  assert.equal(f.el('invoice-from-y').value, '1404')
  assert.equal(f.el('invoice-from').value, '1404/09/06')
  assert.equal(f.focused.at(-1), 'invoice-from-m', 'year full -> month')
  f.type('invoice-from-m', 'a/1')
  assert.equal(f.el('invoice-from-m').value, '1', 'letters and "/" are dropped')
  assert.equal(f.el('invoice-from').value, '1404/01/06', 'one-digit month is padded')
  f.type('invoice-from-m', '١٢')
  assert.equal(f.el('invoice-from-m').value, '12', 'Arabic-Indic digits too')
  assert.equal(f.focused.at(-1), 'invoice-from-d', 'month full -> day')
  f.type('invoice-from-d', '3')
  assert.equal(f.el('invoice-from').value, '1404/12/03')
  f.type('invoice-from-y', '14')
  assert.equal(f.el('invoice-from').value, '', 'incomplete year -> no value is sent')
  f.type('invoice-from-y', '140599')
  assert.equal(f.el('invoice-from-y').value, '1405', 'max 4 digits')
  f.el('report-to-m').value = ''
  f.el('report-to-m').fire('keydown', { key: 'Backspace' })
  assert.equal(f.focused.at(-1), 'report-to-y', 'Backspace on an empty box goes back')
})

await test('the request still sends the old "1405/09/01" format and the server is unchanged', async () => {
  const f = fixture()
  await f.flush()
  f.type('invoice-from-d', '01')
  await f.el('invoice-form').fire('submit')
  await f.flush()
  const call = f.calls.find((c) => c.path === '/api/invoices')
  assert.ok(call, 'invoice request sent')
  const body = JSON.parse(call.options.body)
  assert.equal(body.fromDay, '1405/09/01')
  assert.equal(body.toDay, '1405/09/06')
})

await test('no "today" from the server -> boxes stay empty (old behaviour, no browser calendar)', async () => {
  const f = fixture({ today: null })
  await f.flush()
  for (const id of IDS) assert.equal(f.el(id).value, '', id)
  assert.ok(!mobileJs.includes('Intl.DateTimeFormat'), 'today comes only from the server')
})

await test('server: /api/capabilities sends today in a header with the app date function; the body is unchanged', () => {
  const hub = readFileSync(new URL('../../src/main/services/cloud/mobileReadOnlyHub.ts', import.meta.url), 'utf8')
  assert.match(hub, /import \{ jalaliToday \} from '\.\.\/\.\.\/\.\.\/shared\/jalali'/)
  assert.match(hub, /res\.setHeader\('x-mahak-today',jalaliToday\(\)\)\n {10}send\(200,\{invoices:/)
  const bad = fixture({ today: '1405-09-06' })
  return bad.flush().then(() => { for (const id of IDS) assert.equal(bad.el(id).value, '', 'malformed header is ignored') })
})
