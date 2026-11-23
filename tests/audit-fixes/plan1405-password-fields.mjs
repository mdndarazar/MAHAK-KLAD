/**
 * طرح ۱۴۰۵ — رده‌بندی کادرهای رمز (معماری §۳-۶ و §۳-۷؛ §۸-۲ بندهای ۲، ۴ و ۱۹).
 *
 * هر `<PasswordField` و هر `type="password"` خام در `src/renderer` باید دقیقاً در یکی از این فهرست‌ها باشد:
 *   «دروازه» (نشانگر و 🔑 «رمز ندارم»)، «typedOnly» (کلیدسازی، رمز تازه، هویت، رازِ غیرِرمز)، «خام هویتی»،
 *   «خام کلیدسازی»، «خام دروازهٔ نگه‌داشته» (با دلیل) و «بیرون از دروازه». کادر تازهٔ بی‌رده تست را می‌شکند.
 * به‌علاوه: هیچ `window.prompt` در رابط نیست (موجودی سایت)، و منطق نشانگر PasswordField (فقط بی typedOnly، کادر
 * دست‌خورده نشانگر نمی‌فرستد) سر جایش است. آزمون ساختاری است؛ رفتار main در plan1405-gate-decision.mjs است.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-password-fields.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' · ' + extra : ''}`) }
}

/** فهرست رده‌ها: پرونده (نسبت به src/renderer/src) ← مقدارهای value={...} همان کادرها */
const EXPECTED = {
  gate: {
    'components/AutoCentralPasswordBox.tsx': ['box.password'], 'components/BridgeDiagnosticsModal.tsx': ['password'],
    'components/CardTransferPanel.tsx': ['payPassword', 'cancelPassword', 'adjPassword'], 'components/CreditForms.tsx': ['value.managerPassword', 'password'],
    'components/InvoicePaymentsModal.tsx': ['chequePw', 'lockPw', 'chequePw'], 'components/NewStoreProductModal.tsx': ['toStorePw', 'newProductPw'],
    'components/OverpayFlowDialogs.tsx': ['pw', 'reprintPw'], 'components/ProductFormModal.tsx': ['password'], 'components/ReturnEditModal.tsx': ['editPw'],
    'components/ShiftSessionModal.tsx': ['managerPassword'], 'components/StockAdjustModal.tsx': ['password'], 'components/StockSourceModal.tsx': ['password'],
    'components/StocktakeReminderBadge.tsx': ['pw'], 'components/returns/CardPosOverrideDialog.tsx': ['password'], 'pages/CategoryCharges.tsx': ['chargePw'],
    'pages/ManagementReports.tsx': ['mgrPass'], 'pages/Pos.tsx': ['printPw'], 'pages/PriceAdjust.tsx': ['adjustPw'], 'pages/Products.tsx': ['purgePw'],
    'pages/PurchaseInvoice.tsx': ['purchasePw'], 'pages/SalesInvoice.tsx': ['chargePw'],
    'pages/SalesReports.tsx': ['exCorrectionUnlockPassword', 'exVoidAuthPassword', 'exCorrectionAuthPassword'],
    'pages/SalesReturn.tsx': ['lockPw', 'creditLimitPw', 'managerPw', 'fullRefundPw', 'correctionUnlockPassword', 'correctionAuthPassword', 'voidAuthPassword'],
    'pages/SecondaryStock.tsx': ['toStorePw'],
    'pages/Settings.tsx': ['bundlePw', 'discountPw', 'discountTransferPw', 'byTimePw', 'custDelPw', 'policyPw', 'timePw', 'backupGatePw', 'panelManagerPw', 'slimManagerPw', 'applyPassword'],
    'pages/SmsPanel.tsx': ['pw'], 'pages/Stocktake.tsx': ['schedulePw']
  },
  typedOnly: {
    'components/GateUnlockDialog.tsx': ['password'], 'components/ManagerGate.tsx': ['password'],
    'components/MessengerSettings.tsx': ['password', 'tokens[p]'], 'pages/Pos.tsx': ['saleOperatorPassword'],
    // کلید API پیامک رمز دروازه نیست (رازِ غیرِرمز)؛ اجازهٔ جدای مالک ۱۴۰۵/۰۹/۰۲
    'pages/SmsPanel.tsx': ['form.apiKey'],
    'pages/Settings.tsx': ['curPw', 'newPw', 'newPw2', 'securityPw', 'panelManagerPw', 'panelManagerPw', "panelPw[panel.key] ?? ''", "shiftPw[id] ?? ''", 'staffCorrectionApprovalPw']
  },
  rawIdentity: {
    'components/CustodyAdminChip.tsx': ['temporaryPin'],
    'components/CustodyChip.tsx': ['temporaryPassword', 'newPassword', 'repeatNewPassword', 'password', 'password', 'password', 'managerPassword', 'password', 'password', 'password'],
    'components/RemoteRequestBox.tsx': ['recoveryPassword', 'recoveryPin'],
    'pages/SalesReports.tsx': ['exVoidApproverPassword', 'exCorrectionApproverPassword'], 'pages/SalesReturn.tsx': ['correctionApproverPassword', 'voidApproverPassword']
  },
  rawKeymaking: {
    'components/RemoteGrantControls.tsx': ['password'], 'pages/RemoteLink.tsx': ['password', 'passwordAgain', 'pin', 'pinAgain', 'managerPassword']
  },
  // صفحه رمز خالی را خودش رد نمی‌کند، پس نشست و بلیت بی ویرایش کار می‌کنند؛ fix-s143:84 همین کادر خام را می‌سنجد
  rawGateKept: { 'pages/CreditManagement.tsx': ['issueManagerPw', 'issueManagerPw'] },
  outside: { 'pages/WooSync.tsx': ['token'] }
}

const walk = (d, out = []) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f, out); else if (/\.tsx?$/.test(n)) out.push(f) } return out }
const found = { gate: {}, typedOnly: {}, raw: {} }
const add = (bucket, file, value) => ((found[bucket][file] ??= []).push(value))
const root = 'src/renderer/src'
let prompts = []
for (const f of walk(root)) {
  const t = readFileSync(f, 'utf8'), rel = relative(root, f).split('\\').join('/')
  for (const m of t.matchAll(/<PasswordField\b/g)) {
    const tag = t.slice(m.index, t.indexOf('/>', m.index))
    add(/\btypedOnly\b/.test(tag) ? 'typedOnly' : 'gate', rel, ((/value=\{([^}]*)\}/.exec(tag) ?? [])[1] ?? '?').trim())
  }
  for (const m of t.matchAll(/<input\b/g)) {
    const tag = t.slice(m.index, t.indexOf('/>', m.index))
    if (/type="password"/.test(tag)) add('raw', rel, ((/value=\{([^}]*)\}/.exec(tag) ?? [])[1] ?? '?').trim())
  }
  if (/window\.prompt\s*\(|(?<![A-Za-z0-9_.$])prompt\s*\(/.test(t)) prompts.push(rel)
}
const norm = (map) => JSON.stringify(Object.keys(map).sort().map((k) => [k, [...map[k]].sort()]))
const merge = (...maps) => { const out = {}; for (const m of maps) for (const [k, v] of Object.entries(m)) (out[k] ??= []).push(...v); return out }

console.log('\n— ۱) رده‌بندی همهٔ کادرهای رمز')
ok('کادرهای «دروازه» دقیقاً همین فهرست‌اند', norm(found.gate) === norm(EXPECTED.gate), norm(found.gate))
ok('کادرهای typedOnly دقیقاً همین فهرست‌اند', norm(found.typedOnly) === norm(EXPECTED.typedOnly), norm(found.typedOnly))
ok('ورودی‌های خام فقط هویتی، کلیدسازی، دروازهٔ نگه‌داشته یا بیرون از دروازه‌اند',
  norm(found.raw) === norm(merge(EXPECTED.rawIdentity, EXPECTED.rawKeymaking, EXPECTED.rawGateKept, EXPECTED.outside)), norm(found.raw))
const total = [found.gate, found.typedOnly, found.raw].reduce((s, m) => s + Object.values(m).reduce((a, v) => a + v.length, 0), 0)
ok(`شمار کل کادرها ${total}`, total === 93)

console.log('\n— ۲) «موجودی سایت»: هیچ پنجرهٔ prompt در رابط نیست (§۳-۷)')
ok('هیچ window.prompt یا prompt() در src/renderer', prompts.length === 0, prompts.join(','))
const woo = readFileSync(`${root}/pages/WooSync.tsx`, 'utf8')
ok('شش کار موجودی سایت بی رمز صدا زده می‌شوند', !/askManagerPassword/.test(woo) && (woo.match(/managerPassword\b/g) ?? []).length === 7 && /const managerPassword = null/.test(woo))

console.log('\n— ۳) منطق نشانگر در PasswordField (§۳-۶)')
const pf = readFileSync(`${root}/components/PasswordField.tsx`, 'utf8')
ok('نشانگر از کاتالوگ مشترک می‌آید (U+2063 سه‌تایی)', /import \{ GATE_PROOF_MARKER \} from '@shared\/gateCatalog'/.test(pf))
ok('typedOnly هرگز نشانگر نمی‌فرستد و 🔑 ندارد', /const gated = !typedOnly && typeof value === 'string' && typeof onChange === 'function'/.test(pf) && /\{gated && !isManager && !marked && \(/.test(pf))
ok('فقط کادر دست‌نخورده با نشست مدیر نشانگر می‌گیرد؛ پایان نشست آن را خالی می‌کند', /if \(isManager && value === '' && !touched\.current\)/.test(pf) && /!isManager && value === GATE_PROOF_MARKER && source\.current === 'session'/.test(pf))
ok('نخستین حرف تایپ‌شده جای نشانگر را می‌گیرد (کادر دست‌خورده)', /onChange=\{\(e\) => \{ touched\.current = true; source\.current = null; onChange\?\.\(e\) \}\}/.test(pf) && /value=\{value === GATE_PROOF_MARKER \? '' : value\}/.test(pf))
const api = readFileSync(`${root}/lib/api.ts`, 'utf8')
ok('api.ts رد GATE_REQUIRED را رویداد سراسری می‌کند', /GATE_REQUIRED_EVENT = 'mahak-gate-required'/.test(api) && /dispatchEvent\(new CustomEvent\(GATE_REQUIRED_EVENT/.test(api))
const shell = readFileSync(`${root}/components/Shell.tsx`, 'utf8')
ok('پنجرهٔ سراسری یک بار در Shell', (shell.match(/<GateUnlockDialog \/>/g) ?? []).length === 1)

console.log(`\n${fail ? '✗' : '✓'} ${pass} بررسی موفق · ${fail} ناموفق`)
process.exit(fail ? 1 : 0)
