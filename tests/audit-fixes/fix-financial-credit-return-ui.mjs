/* Render the B/E handoff UI, not a mock of its labels. The separate service
 * test exercises the real print/delivery IPC targets and guarded mutation.
 * node tests/audit-fixes/fix-financial-credit-return-ui.mjs
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { pathToFileURL } from 'node:url'

const outfile = join(process.cwd(), '.arena', 'credit-handoff-ssr.mjs')
const replacementOut = join(process.cwd(), '.arena', 'credit-replacement-ssr.mjs')
process.once('exit', () => { rmSync(outfile, { force: true }); rmSync(replacementOut, { force: true }) })
await build({
  entryPoints: ['src/renderer/src/components/CreditOpportunityHandoff.tsx'],
  outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  tsconfig: 'tsconfig.json', external: ['react', 'react/jsx-runtime']
})
globalThis.window = { api: { channels: { returnCreditPrint: 'return:credit:print',
  returnCreditDeliver: 'return:credit:deliver' } } }
const { default: CreditOpportunityHandoff } = await import(pathToFileURL(outfile).href)
assert.equal(renderToStaticMarkup(createElement(CreditOpportunityHandoff, { credits: [] })), '')
const html = renderToStaticMarkup(createElement(CreditOpportunityHandoff, {
  credits: [{ creditId: 17, amount: 60, status: 'PENDING_DELIVERY' }]
}))
assert.match(html, /رمز مدیر برای چاپ و تحویل/)
assert.match(html, /نام خانوادگی \(اختیاری\)/)
assert.match(html, /تلفن \(اختیاری؛ نه مدرک مالکیت\/مجوز پیامک\)/)
assert.match(html, /چاپ تحت نظر مدیر/)
assert.match(html, /ثبت تحویل واقعی/)
assert.match(html, /چاپ شکست‌خورده یا نتیجهٔ نامعلوم کد را خودکار فعال نمی‌کند/)
assert.match(html, /نام.*تحویل|شرح شاهد تحویل واقعی/)
assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 2,
  'printing and delivery are locked without a manager password and witness')
assert.doesNotMatch(html, /storeCreditCode|barcode|شماره موبایل الزامی است/)
console.log('✓ B/E UI SSR: optional holder fields; print and delivery locked; witness separate from print')

await build({ entryPoints: ['src/renderer/src/components/LostCreditReplacement.tsx'],
  outfile: replacementOut, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  tsconfig: 'tsconfig.json', external: ['react', 'react/jsx-runtime'] })
const { default: LostCreditReplacement } = await import(pathToFileURL(replacementOut).href)
const props = { credit: { id: 6, status: 'ACTIVE', remaining: 200, sourceInvoiceId: 42 },
  onOpenSuccessor: () => {}, onRefresh: () => {} }
const unrecovered = renderToStaticMarkup(createElement(LostCreditReplacement, props))
assert.match(unrecovered, /جست‌وجوی نام یا تلفن، مالکیت را اثبات نمی‌کند/)
assert.match(unrecovered, /بررسی مدیر برای جایگزینی کد گم‌شده/)
const recovered = renderToStaticMarkup(createElement(LostCreditReplacement, {
  ...props, credit: { ...props.credit, status: 'CANCELED' },
  replacement: { originalCreditId: 6, successorCreditId: 7, transferredAmount: 200 }
}))
assert.match(recovered, /مشاهدهٔ جانشین و وضعیت چاپ\/تحویل شاهددار/)
assert.doesNotMatch(recovered, /بررسی مدیر برای جایگزینی کد گم‌شده/)
console.log('✓ recovery UI SSR: only manager review for eligible original; canceled original links existing successor')
