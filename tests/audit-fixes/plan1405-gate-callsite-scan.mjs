/**
 * طرح ۱۴۰۵ — اسکن جاهای فراخوانی دروازه (معماری §۳-۵ و §۸-۲ بند ۲).
 *
 * هر فراخوانی گیت در `src/` شمرده می‌شود و باید دقیقاً در یکی از این دسته‌ها باشد:
 *   ۱) «پوشانده‌شده»: درون gateAction/gateSession با شناسه‌ای که در gateCatalog.ts هست؛
 *   ۲) «هویت و کلیدسازی» (§۳-۱۰ دستهٔ ۱ و §۳-۱۱)؛
 *   ۳) «شناخته‌شده و بی‌تغییر» (assertPanelPassword، گیت‌های خواندنی، ورود)؛
 *   ۴) «در انتظار پوشاندن» — فقط تا پایان مرحلهٔ ۵؛ پس از آن باید خالی باشد.
 * فراخوانی تازه‌ای که در هیچ دسته‌ای نیست، یا شمارهٔ ناهمخوان، تست را می‌شکند.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-gate-callsite-scan.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const catalogModule = await import('../../src/shared/gateCatalog.ts')
const { GATE_CATALOG } = catalogModule
/** تابع‌های فهرست‌ساز کاتالوگ (نامشان با GateIds تمام می‌شود؛ §۳-۱۰ زیر جدول دستهٔ ۱) */
const GATE_ID_HELPERS = new Set(Object.keys(catalogModule).filter((k) => k.endsWith('GateIds') && typeof catalogModule[k] === 'function'))

/** مرحلهٔ ۵ تمام شد: هیچ «در انتظار پوشاندن»ی مجاز نیست. */
const PENDING_ALLOWED = false

const GATES = ['assertManagerPassword', 'assertPanelPasswordStrict', 'assertManagerSession', 'assertPanelPassword',
  'assertPanelUnlocked', 'assertPanelUnlockedStrict', 'verifyManagerCorrectionApproval']
const LOGIN = ['authService.verify', 'authService.verifyPanel']

/**
 * فهرست جاهای فراخوانی بی‌پوشش (کامیت شروع `cd09533`)، به تفکیک پرونده و تابع:
 * { identity, known, pending }. با هر پوشاندن در مرحلهٔ ۵، عدد pending کم می‌شود.
 */
const EXPECTED = JSON.parse(readFileSync(new URL('../plan-1405/gate-callsite-inventory.json', import.meta.url), 'utf8'))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** متن بی‌توضیح (طول و شکستن خط همان می‌ماند تا جای فراخوانی‌ها دقیق بماند). */
function stripComments(src) {
  let out = ''
  let i = 0
  let mode = null // 'line' | 'block' | quote char | 'tpl'
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (mode === null) {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = null; out += c } else out += ' '; i++; continue }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = null; out += '  '; i += 2 } else { out += c === '\n' ? c : ' '; i++ } continue }
    // درون رشته: محتوا را نگه می‌داریم (برای خواندن شناسهٔ gateAction)
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === mode) mode = null
    out += c; i++
  }
  return out
}

/** تعریف تابع یا متد (نه فراخوانی): `function name(`، یا `name(...)` که پس از پرانتز بسته `{` یا `:` می‌آید و پیش از آن در همان خط جز export/async چیزی نیست. */
function isDefinition(text, start, openParen) {
  const lineStart = text.lastIndexOf('\n', start) + 1
  const head = text.slice(lineStart, start)
  if (/function\s+$/.test(head)) return true
  if (!/^\s*(?:export\s+)?(?:async\s+)?$/.test(head)) return false
  let depth = 0, i = openParen
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') { depth--; if (depth === 0) break }
  }
  const after = text.slice(i + 1).match(/^\s*(\S)/)
  return !!after && (after[1] === '{' || after[1] === ':')
}

/**
 * پوشاندن: شناسهٔ متنی (`'credit.void'`)، یا فهرستی از یک تابع کاتالوگ (`backupApplyGateIds(mode)`)، یا متغیری که
 * نامش با GateIds تمام می‌شود و در همان پرونده از یک تابع کاتالوگ پر شده است (`const rawGateIds = rawSettingGateIds(`).
 */
const WRAP = /(gateAction|gateSession)\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*GateIds)(\((?:[^()]|\([^()]*\))*\))?)\s*,\s*(?:async\s*)?\(\)\s*=>\s*(?:await\s+)?$/
const found = {} // file -> fn -> { unwrapped, wrapped: [ids] }
const problems = []
for (const file of walk('src')) {
  const rel = relative('.', file).split('\\').join('/')
  const text = stripComments(readFileSync(file, 'utf8'))
  const names = [...GATES.map((g) => ({ name: g, re: new RegExp(`(?<![A-Za-z0-9_.$])${g}\\s*\\(`, 'g') })),
    ...LOGIN.map((g) => ({ name: g, re: new RegExp(`${g.replace('.', '\\.')}\\s*\\(`, 'g') }))]
  for (const { name, re } of names) {
    let m
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 240), m.index)
      if (isDefinition(text, m.index, m.index + m[0].length - 1)) continue
      const slot = ((found[rel] ??= {})[name] ??= { unwrapped: 0, wrapped: [] })
      const w = before.match(WRAP)
      if (!w) { slot.unwrapped++; continue }
      if (w[2]) { slot.wrapped.push(w[2]); continue }
      const helper = w[4] ? w[3] : (new RegExp(`const ${w[3]} = [^\\n]*?([A-Za-z_$][\\w$]*GateIds)\\(`).exec(text) ?? [])[1]
      if (helper && GATE_ID_HELPERS.has(helper)) slot.wrapped.push(`<${helper}>`)
      else problems.push(`${rel}: ${name} wrapped with «${w[3]}» that is not filled from a gateCatalog *GateIds helper`)
    }
  }
}

let wrappedTotal = 0, unwrappedTotal = 0, pendingTotal = 0
for (const [file, fns] of Object.entries(found)) {
  for (const [fn, slot] of Object.entries(fns)) {
    wrappedTotal += slot.wrapped.length
    unwrappedTotal += slot.unwrapped
    for (const id of slot.wrapped) if (!id.startsWith('<') && !GATE_CATALOG[id]) problems.push(`${file}: ${fn} wrapped with unknown gate id «${id}»`)
    const exp = EXPECTED[file]?.[fn]
    if (!exp) { if (slot.unwrapped) problems.push(`${file}: ${fn} ×${slot.unwrapped} unclassified gate call`); continue }
    const want = (exp.identity ?? 0) + (exp.known ?? 0) + (exp.pending ?? 0)
    pendingTotal += exp.pending ?? 0
    if (slot.unwrapped !== want) problems.push(`${file}: ${fn} unwrapped ${slot.unwrapped} != expected ${want} (identity ${exp.identity ?? 0}, known ${exp.known ?? 0}, pending ${exp.pending ?? 0})`)
    if (!PENDING_ALLOWED && exp.pending) problems.push(`${file}: ${fn} still has ${exp.pending} pending call(s) after stage 5`)
  }
}
for (const [file, fns] of Object.entries(EXPECTED)) {
  for (const [fn, exp] of Object.entries(fns)) {
    const want = (exp.identity ?? 0) + (exp.known ?? 0) + (exp.pending ?? 0)
    if (want && !found[file]?.[fn]) problems.push(`${file}: ${fn} expected ${want} call(s), found none`)
  }
}

console.log(`gate call sites: wrapped ${wrappedTotal} · unwrapped ${unwrappedTotal} (pending ${pendingTotal}) · catalog ${Object.keys(GATE_CATALOG).length} ids`)
if (problems.length) {
  console.log(`✗ ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  • ${p}`)
  process.exit(1)
}
console.log('✓ every gate call site is classified')
