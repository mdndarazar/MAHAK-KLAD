/**
 * دفتر آزمون ۴-۳۷ — کادرهای رمزی که با نشست مدیر لازم نیستند، با برچسبشان دیده نمی‌شوند.
 *
 *  - کادر واقعی `PasswordField.tsx` (با esbuild ساخته و با react-dom/server کشیده می‌شود؛ فقط قلاب نشست جایگزین است):
 *    در نشست مدیر کادرِ «دروازه»ای که نشانگر نشست را دارد فقط یک نشانهٔ پنهان است (نه کادر، نه 👁)؛ `typedOnly`، کادر
 *    تایپ‌شده و بی نشست («رمز ندارم» هم) دیده می‌شوند؛
 *  - قاعدهٔ CSS یک بار در صفحه گذاشته می‌شود: برچسبی که کادر را در بر دارد، متن سادهٔ درست پیش از کادر یا پیش از پوستهٔ تنها،
 *    و پوستهٔ تنها؛
 *  - همهٔ کادرهای غیر `typedOnly` برنامه یکی از همین شکل‌ها را دارند (پس برچسب هیچ‌کدام تنها نمی‌ماند).
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-37-session-hidden.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'mahak-tl-4-37-'))
const require = createRequire(import.meta.url)

/** صفحهٔ ساختگی کمینه: فقط آنچه پرونده هنگام بار شدن برای گذاشتن قاعدهٔ CSS لازم دارد. */
const styles = []
globalThis.document = {
  getElementById: (id) => styles.find((s) => s.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (el) => { styles.push(el) } }
}
globalThis.__pf = { isManager: false }

const entry = `
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PasswordField, { SESSION_HIDDEN_CLASS, SESSION_HIDDEN_CSS } from ${JSON.stringify(join(ROOT, 'src/renderer/src/components/PasswordField.tsx'))}
import { GATE_PROOF_MARKER } from ${JSON.stringify(join(ROOT, 'src/shared/gateCatalog.ts'))}
export const render = (props) => renderToStaticMarkup(createElement(PasswordField, { onChange: () => {}, ...props }))
export { SESSION_HIDDEN_CLASS, SESSION_HIDDEN_CSS, GATE_PROOF_MARKER }
`
const bundle = join(OUT, 'bundle.cjs')
await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx', sourcefile: 'tl-4-37-entry.jsx' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') },
  plugins: [{
    name: 'session-stub',
    setup(b) {
      b.onResolve({ filter: /hooks\/useManagerSession$/ }, () => ({ path: 'session-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useManagerSession = () => ({ isManager: globalThis.__pf.isManager })', loader: 'js' }))
    }
  }]
})
const pf = require(bundle)
const as = (isManager, props) => { globalThis.__pf.isManager = isManager; return pf.render(props) }

test('in a manager session a gate field carrying the session marker is only a hidden mark: no box, no eye, no 🔑', () => {
  const html = as(true, { value: pf.GATE_PROOF_MARKER })
  assert.equal(html, `<span class="${pf.SESSION_HIDDEN_CLASS}" hidden="" aria-hidden="true"></span>`)
  assert.ok(!html.includes('<input') && !html.includes('👁') && !html.includes('🔑'))
})

test('always visible: typedOnly fields, a field the manager typed into, and every field without a session (with «رمز ندارم», or after it)', () => {
  const typed = as(true, { value: '', typedOnly: true })
  assert.ok(typed.includes('<input') && typed.includes('👁') && !typed.includes(pf.SESSION_HIDDEN_CLASS), 'typedOnly in a session')
  const own = as(true, { value: 'abc' })
  assert.ok(own.includes('<input') && !own.includes(pf.SESSION_HIDDEN_CLASS), 'typed by hand in a session')
  const plain = as(false, { value: '' })
  assert.ok(plain.includes('<input') && plain.includes('🔑') && plain.includes('👁'), 'no session: box, 🔑 and eye')
  const link = as(false, { value: pf.GATE_PROOF_MARKER })
  assert.ok(link.includes('<input') && link.includes('بی رمز: کد یک‌بارمصرف یا مجوز') && !link.includes(pf.SESSION_HIDDEN_CLASS), '«رمز ندارم» without a session stays visible')
})

test('the CSS rule is put into the page once: the wrapping label, plain text right before the field or its lone wrapper, and the lone wrapper', () => {
  assert.equal(styles.length, 1)
  assert.equal(styles[0].id, `${pf.SESSION_HIDDEN_CLASS}-css`)
  assert.equal(styles[0].textContent, pf.SESSION_HIDDEN_CSS)
  const c = pf.SESSION_HIDDEN_CLASS
  for (const rule of [`label:has(> .${c})`, `:is(div,span,label,p):not(:has(*)):has(+ .${c})`, `:is(div,span,label,p):not(:has(*)):has(+ :is(div,span) > .${c}:only-child)`, `:is(div,span):has(> .${c}:only-child)`])
    assert.ok(pf.SESSION_HIDDEN_CSS.includes(rule), rule)
  assert.match(pf.SESSION_HIDDEN_CSS, /\{display:none !important\}$/)
  // دوباره بار شدن پرونده قاعدهٔ دوم نمی‌گذارد
  delete require.cache[bundle]
  require(bundle)
  assert.equal(styles.length, 1)
})

test('every gate password field in the app has one of those shapes, so no label is left alone', () => {
  const TAG = /<(\/?)([A-Za-z][\w.]*)((?:[^<>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/gs
  const files = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [] })
  const shapes = { label: 0, text: 0, lone: 0 }, others = []
  for (const f of files(join(ROOT, 'src/renderer/src'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<PasswordField\b/g)) {
      if (/^<PasswordField\b[^>]*\btypedOnly\b/s.test(src.slice(m.index, m.index + 400))) continue
      const before = src.slice(0, m.index)
      const tags = [...before.matchAll(TAG)]
      let depth = 0, prev = null, parent = null
      for (let i = tags.length - 1; i >= 0; i--) {
        const [, closing, name, , self] = tags[i]
        if (self === '/') { if (depth === 0 && !prev) prev = { name, tag: tags[i], self: true }; continue }
        if (closing === '/') { if (depth === 0 && !prev) prev = { name, tag: tags[i] }; depth++ } else { if (depth === 0) { parent = name; break } depth-- }
      }
      const where = `${f.slice(ROOT.length)}:${before.split('\n').length}`
      if (parent === 'label' || parent === 'Field') shapes.label++
      else if (prev && !prev.self) {
        const seg = before.slice(0, prev.tag.index), open = seg.lastIndexOf(`<${prev.name}`)
        const inner = open >= 0 ? seg.slice(seg.indexOf('>', open) + 1) : '<'
        if (!inner.includes('<') && /^(div|span|label|p)$/.test(prev.name)) shapes.text++
        else others.push(`${where} after <${prev.name}> with elements`)
      } else if (!prev && /^(div|span)$/.test(parent ?? '')) shapes.lone++
      else others.push(`${where} parent <${parent}>`)
    }
  }
  assert.deepEqual(others, [], 'a gate field whose label the rule does not reach')
  assert.ok(shapes.label >= 30 && shapes.text >= 5 && shapes.lone >= 8, JSON.stringify(shapes))
})
