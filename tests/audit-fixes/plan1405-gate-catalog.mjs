/**
 * طرح ۱۴۰۵ — منبع حقیقت قفل‌ها (معماری §۳-۳ و §۳-۱۰؛ §۸-۲ بند ۱).
 *
 * هر کلید قفل `kind`، `group` و `tier` دارد؛ هر شناسهٔ کار کلید معتبر دارد؛ هر کلید در دقیقاً یکی از دو ردهٔ کد
 * («سایر ماژول‌ها» برای عادی، «حساس» برای پولی، قسمت‌های تازه و قفل‌های کار) است؛ کلید بی‌رده رد می‌شود؛ تابع‌های
 * فهرست‌ساز فقط شناسهٔ کاتالوگ می‌دهند؛ REMOTE_PANELS = ۴۴ قسمت + ۴۸ کار = ۹۲ سیاست؛ و هیچ سقفی (فرزند هاب،
 * ناظر هاب، approvalPanels، صفحهٔ گوشی) کمتر از شمار سیاست‌ها نیست.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-gate-catalog.mjs
 */
import { readFileSync } from 'node:fs'

const catalog = await import('../../src/shared/gateCatalog.ts')
const panels = await import('../../src/shared/panels.ts')
const { REMOTE_PANELS, AuditAction } = await import('../../src/shared/enums.ts')
const { GATE_CATALOG, GATE_ACTION_IDS, GATE_PART_KEYS, GATE_ACTION_LOCK_KEYS } = catalog
const { LOCKED_PANELS, PANEL_KEYS } = panels

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' · ' + extra : ''}`) }
}
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

console.log('\n— ۱) کلیدها: ۸۰ ردیف، سه فیلد، رده‌ها')
const keys = LOCKED_PANELS.map((p) => p.key)
ok('۸۰ کلید یکتا، برابر PANEL_KEYS', keys.length === 80 && new Set(keys).size === 80 && Object.values(PANEL_KEYS).length === 80)
ok('هر ردیف kind، group و tier دارد', LOCKED_PANELS.every((p) => ['part', 'action'].includes(p.kind) && typeof p.group === 'string' && p.group && ['normal', 'money', 'sensitive'].includes(p.tier) && p.title && p.hint))
const count = (f, v) => LOCKED_PANELS.filter((p) => p[f] === v).length
ok('۲۵ عادی، ۱۲ پولی، ۴۳ حساس', count('tier', 'normal') === 25 && count('tier', 'money') === 12 && count('tier', 'sensitive') === 43)
ok('۴۴ قسمت، ۳۶ قفل کار', count('kind', 'part') === 44 && count('kind', 'action') === 36)
const MONEY = ['cash-close', 'consolidation', 'sales-credit', 'sales-return', 'sales-return-correction', 'card-transfers', 'pos-discount', 'price-adjust', 'credit-management', 'credit-bulk-issue', 'credit-void', 'credit-settings']
ok('۱۲ کلید پولی همان فهرست طرح‌اند', MONEY.every((k) => LOCKED_PANELS.find((p) => p.key === k)?.tier === 'money') && count('tier', 'money') === MONEY.length)
ok('هفت قسمت تازه «حساس»اند', GATE_PART_KEYS.length === 7 && GATE_PART_KEYS.every((k) => LOCKED_PANELS.find((p) => p.key === k)?.tier === 'sensitive'))
ok('همهٔ قفل‌های کار «حساس»اند', LOCKED_PANELS.filter((p) => p.kind === 'action').every((p) => p.tier === 'sensitive'))
const codeTier = (p) => (p.tier === 'normal' ? 'OTHER' : 'SENSITIVE')
ok('هر کلید در دقیقاً یکی از دو ردهٔ کد است', LOCKED_PANELS.every((p) => ['OTHER', 'SENSITIVE'].includes(codeTier(p))) && LOCKED_PANELS.filter((p) => codeTier(p) === 'OTHER').length === 25)
ok('کلید بی‌رده رد می‌شود (نه قفل تازه، نه کلید گوشی)', panels.normalizePanelKey('act-no-such') === null && !REMOTE_PANELS.includes('act-no-such') && panels.parsePanelLocks({ 'act-no-such': false })['act-no-such'] === undefined)
ok('«تنظیمات» خاموش‌شدنی است و هیچ قفلی «همیشه روشن» نیست', panels.ALWAYS_LOCKED_PANELS.length === 0 && panels.parsePanelLocks({ settings: false }).settings === false)

console.log('\n— ۲) کاتالوگ: ۴۸ شناسهٔ کار روی ۳۶ کلید تازه و ۵ کلید استثنا')
const actions = Object.values(GATE_CATALOG).filter((e) => e.category === 3)
ok('۴۸ شناسهٔ کار؛ همان GATE_ACTION_IDS', actions.length === 48 && GATE_ACTION_IDS.length === 48 && actions.every((e) => GATE_ACTION_IDS.includes(e.id)))
ok('هر شناسهٔ کار کلید معتبر در panels.ts دارد', actions.every((e) => keys.includes(e.lockKey)))
ok('۳۶ کلید act-* یکتا، هر کدام یک ردیف «قفل کار»', GATE_ACTION_LOCK_KEYS.length === 36 && GATE_ACTION_LOCK_KEYS.every((k) => LOCKED_PANELS.find((p) => p.key === k)?.kind === 'action'))
const EXC = ['credit-void', 'credit-bulk-issue', 'credit-settings', 'sms-provider', 'woo-sync']
ok('پنج کلید استثنا «قسمت» می‌مانند و ۱۲ کار رویشان است', EXC.every((k) => LOCKED_PANELS.find((p) => p.key === k)?.kind === 'part') && actions.filter((e) => EXC.includes(e.lockKey)).length === 12)
ok('strictها ماژول مادر معتبر دارند (۱۶ «مادر» + ۴ استثنای strict)', actions.filter((e) => e.origin === 'STRICT').every((e) => keys.includes(e.parentPanel)) && actions.filter((e) => e.origin === 'STRICT' && e.parentPanel !== e.lockKey).length === 16)
ok('سه کلید policy همان سه ردیف «سیاست حسابداری»اند', actions.filter((e) => e.lockKind === 'policy').map((e) => e.id).sort().join() === ['period.closed-entry', 'sales.overpay-credit-above-cap', 'sales.price-below-reference'].join())
ok('هفت قسمت تازه دستهٔ ۲ و «فقط نشست» امروزند', GATE_PART_KEYS.every((k) => GATE_CATALOG[k]?.category === 2 && GATE_CATALOG[k].origin === 'SESSION' && GATE_CATALOG[k].lockKey === k))
ok('نشانه‌های دستهٔ ۱ کلید قفل ندارند', Object.values(GATE_CATALOG).filter((e) => e.category === 1).every((e) => e.lockKey === '' && e.id.startsWith('keys.')))

console.log('\n— ۳) تابع‌های فهرست‌ساز فقط شناسهٔ کاتالوگ می‌دهند')
const helperOut = [
  catalog.rawSettingGateIds('panel.locks'), catalog.rawSettingGateIds('security.config'), catalog.rawSettingGateIds('time.official'),
  catalog.rawSettingGateIds('shift.config', '{"byTime":false}', '{"byTime":true,"overtimeMaxMinutes":30,"x":1}'),
  catalog.rawSettingGateIds('accounting.policy', '{"lockClosedPeriods":true}', '{"lockClosedPeriods":false}'),
  catalog.rawSettingGateIds('credit.settings'), catalog.rawSettingGateIds('sale.defaults'),
  catalog.settingsSaveGateIds({ security: true, clockOffset: true, shift: ['settings.shift-by-clock'], other: true }), catalog.settingsSaveGateIds({}),
  catalog.staffSaveGateIds(true), catalog.staffSaveGateIds(false), catalog.backupApplyGateIds('merge'), catalog.backupApplyGateIds('replace'),
  catalog.creditPrintGateIds(true), catalog.creditPrintGateIds(false),
  catalog.accountingPolicyGateIds({ storeCreditLimit: 0 }, { storeCreditLimit: 5 }), catalog.accountingPolicyGateIds({ cashDifferenceThreshold: 1 }, { cashDifferenceThreshold: 2 })
].flat()
ok('هر خروجی در کاتالوگ است', helperOut.every((id) => GATE_CATALOG[id]), helperOut.filter((id) => !GATE_CATALOG[id]).join(','))
ok('امنیتی و panel.locks دستهٔ ۱‌اند', GATE_CATALOG[catalog.rawSettingGateIds('panel.locks')[0]].category === 1 && GATE_CATALOG[catalog.rawSettingGateIds('security.config')[0]].category === 1)
ok('شیفت: سوییچ ساعت و سقف اضافه‌کاری کار جدای خودشان را می‌خواهند (اصل «ج»)', catalog.shiftChangeGateIds({ byTime: false, overtimeMaxMinutes: 0 }, { byTime: true, overtimeMaxMinutes: 30 }, 'R').join() === 'settings.shift-by-clock,settings.overtime-cap')
ok('سه کلید قفل «سیاست حسابداری» دستهٔ ۱، بقیه قفل کار', catalog.accountingPolicyGateIds({ lockClosedPeriods: true, cashDifferenceThreshold: 1 }, { lockClosedPeriods: false, cashDifferenceThreshold: 2 }).join() === 'keys.accounting-lock-switches,settings.accounting-policy')
ok('ذخیرهٔ خام اعتبار هرگز آسان‌تر از مسیر رسمی نیست', catalog.rawSettingGateIds('credit.settings').includes('credit.settings-save'))
ok('نقش «مدیر» و رمز شخصی تأیید دستهٔ ۱', GATE_CATALOG[catalog.staffSaveGateIds(true)[0]].category === 1)

console.log('\n— ۴) راه دور: ۹۲ سیاست و هیچ سقفی کمتر از آن')
const policies = REMOTE_PANELS.length
ok('REMOTE_PANELS = ۴۴ کلید قسمت + ۴۸ شناسهٔ کار = ۹۲', policies === 92 && REMOTE_PANELS.filter((k) => keys.includes(k)).length === 44 && GATE_ACTION_IDS.every((id) => REMOTE_PANELS.includes(id)))
ok('قسمت‌های REMOTE_PANELS همه kind=part‌اند و کلیدهای act-* در آن نیستند', REMOTE_PANELS.filter((k) => keys.includes(k)).every((k) => LOCKED_PANELS.find((p) => p.key === k).kind === 'part'))
const child = read('src/main/services/cloud/experimentalHubChild.ts')
const supervisor = read('src/main/services/cloud/experimentalHubSupervisor.ts')
const hub = read('src/main/services/cloud/mobileReadOnlyHub.ts')
const pwa = read('src/main/services/cloud/mobilePwaAssets.ts')
const capOf = (text, re) => Number((re.exec(text) ?? [])[1] ?? 0)
const caps = {
  child: capOf(child, /approval\.panels\.length>(\d+)/),
  supervisor: capOf(supervisor, /Object\.keys\(options\.approval\.policies\)\.length>(\d+)/),
  approvalPanels: capOf(hub, /approvalPanels:[^\n]*\.slice\(0,(\d+)\)/),
  pwa: capOf(pwa, /approvalPanels=data\.approvalPanels[^\n]*?\.slice\(0,(\d+)\)/)
}
ok(`هیچ سقفی کمتر از ${policies} سیاست نیست (${JSON.stringify(caps)})`, Object.values(caps).every((c) => c >= policies && c === 128))
const host = read('src/main/services/CloudSyncService.ts')
ok('خط سیاست‌ها همان شکل و دو جفت، سقف ۶۰ دقیقه', /const POLICIES = Object\.fromEntries\(PANELS\.map\(/.test(host) && /SENSITIVE_MONEY' as const,mode:'ONE_SHOT' as const,ttlMs:3_600_000/.test(host) && /NORMAL' as const,mode:'PANEL' as const,ttlMs:3_600_000/.test(host))

console.log('\n— ۵) دو عضو تازهٔ AuditAction')
ok('ACCESS_EVENT و FACTORY_RESET', AuditAction.ACCESS_EVENT === 'ACCESS_EVENT' && AuditAction.FACTORY_RESET === 'FACTORY_RESET')

console.log(`\n${fail ? '✗' : '✓'} ${pass} بررسی موفق · ${fail} ناموفق`)
process.exit(fail ? 1 : 0)
