/**
 * طرح ۱۴۰۵ · موارد ۹ و ۱۰ — کاشی‌ها، آیکون‌ها و کادر توسعه‌دهنده (معماری §۴-۶ و §۸-۲ بند ۱۷).
 *
 *   node tests/audit-fixes/plan1405-dashboard-tiles.mjs
 *
 * ساختاری است (رندر واقعی Electron اجرا نمی‌شود): متن پرونده‌ها خوانده و سنجیده می‌شود.
 */
import { readFileSync } from 'node:fs'

let ok = 0
let bad = 0
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✓ ${label}`) } else { bad++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const read = (p) => readFileSync(p, 'utf8')

const dashboard = read('src/renderer/src/pages/Dashboard.tsx')
const shell = read('src/renderer/src/components/Shell.tsx')
const routes = read('src/renderer/src/main.tsx')
const icons = read('src/renderer/src/components/TileIcons.tsx')
const card = read('src/renderer/src/components/DeveloperCard.tsx')
const cardCode = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const TILE_RE = /\{ title: '([^']+)', key: '([^']*)', to: '([^']+)', color: 'bg-\[(#[0-9a-f]{6})\]', bar: 'bg-\[(#[0-9a-f]{6})\]', icon: '([a-z-]+)' \}/g
const tiles = [...dashboard.matchAll(TILE_RE)].map((m) => ({ title: m[1], key: m[2], to: m[3], color: m[4], bar: m[5], icon: m[6] }))
const tilesStart = dashboard.indexOf('= [', dashboard.indexOf('const TILES'))
const tileBlock = dashboard.slice(tilesStart, dashboard.indexOf('\n]', tilesStart))
const rawEntries = (tileBlock.match(/\{ title: '/g) ?? []).length
const nav = [...shell.matchAll(/\{ title: '([^']+)', to: '([^']+)', key: '[^']*' \}/g)].map((m) => ({ title: m[1], to: m[2] }))
const iconNames = [...icons.slice(icons.indexOf('const TILE_ICON_PATHS'), icons.indexOf('} as const')).matchAll(/^\s{2}'([a-z-]+)':/gm)].map((m) => m[1])

console.log('\n۱) فهرست کاشی‌ها')
check('هر ردیف TILES شکل کامل دارد (عنوان، کلید، مسیر، رنگ، نوار، آیکون)', tiles.length === rawEntries && tiles.length > 0, `${tiles.length}/${rawEntries}`)
check('۱۸ کاشی (۱۲ قدیمی + ۶ تازه)', tiles.length === 18, String(tiles.length))
check('«تنظیمات» آخرین کاشی است', tiles.at(-1)?.to === '/settings')
check('کاشی پنل پیامکی همان شکل قدیمی را دارد (sms-wiring)', /to: '\/sms-panel'/.test(dashboard))
check('نوع Tile فیلد icon اجباری دارد (کاشی بی آیکون typecheck را می‌شکند)', /type Tile = \{[^}]*icon: TileIconName \}/.test(dashboard))

console.log('\n۲) آیکون‌ها')
check('هر کاشی آیکون دارد', tiles.every((t) => t.icon))
check('آیکون‌ها یکتا هستند', new Set(tiles.map((t) => t.icon)).size === tiles.length)
const missing = tiles.filter((t) => !iconNames.includes(t.icon)).map((t) => t.icon)
check('هر آیکون در TileIcons.tsx تعریف شده است', missing.length === 0, missing.join(','))
check('آیکون‌ها تزئینی‌اند (aria-hidden) و بستهٔ npm تازه ندارند', /aria-hidden="true"/.test(icons) && !/from '(?!\.)/.test(icons))
check('مجوز Tabler و Simple Icons در THIRD-PARTY-LICENSES.txt', /Tabler Icons[\s\S]*MIT License/.test(read('THIRD-PARTY-LICENSES.txt')) && /Simple Icons[\s\S]*CC0/.test(read('THIRD-PARTY-LICENSES.txt')))

console.log('\n۳) پوشش منو و مسیرها')
/** مسیرهایی که عمداً کاشی ندارند (اکنون هیچ؛ هر افزودنی این‌جا با دلیل ثبت می‌شود). */
const NAV_WITHOUT_TILE = new Set([])
const navMissing = nav.filter((n) => !NAV_WITHOUT_TILE.has(n.to) && !tiles.some((t) => t.to === n.to)).map((n) => n.title)
check('منوی بالا خوانده شد', nav.length >= 18, String(nav.length))
check('هر مسیر منوی بالا کاشی دارد', navMissing.length === 0, navMissing.join('، '))
const routeMissing = tiles.filter((t) => !routes.includes(`path: '${t.to.replace(/^\//, '')}'`)).map((t) => t.to)
check('مسیر هر کاشی در main.tsx تعریف شده است', routeMissing.length === 0, routeMissing.join(','))
check('منوی بالا (Shell.tsx) آیکون نگرفت', !/TileIcon/.test(shell))

console.log('\n۴) تضاد رنگ (WCAG)')
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) }
const contrast = (h) => 1.05 / (lum(h) + 0.05)
const lowText = tiles.filter((t) => contrast(t.bar) < 4.5).map((t) => `${t.title}:${contrast(t.bar).toFixed(2)}`)
check('تضاد نوشتهٔ سفید با نوار هر کاشی دست‌کم ۴٫۵ به ۱', lowText.length === 0, lowText.join(' '))
const notDarker = tiles.filter((t) => lum(t.bar) > lum(t.color)).map((t) => t.title)
check('نوار نام از بدنهٔ کاشی تیره‌تر است', notDarker.length === 0, notDarker.join('، '))

console.log('\n۵) کادر توسعه‌دهنده')
check('نام و شمارهٔ توسعه‌دهنده', card.includes('امیرحسین معدندار') && card.includes('0919 950 4821'))
check('شماره در dir="ltr" با unicode-bidi: isolate', /dir="ltr"[^>]*\[unicode-bidi:isolate\]/.test(card))
check('فقط نمایشی: بی <a href>، بی openExternal و بی window.open', !/<a\s|href=|openExternal|window\.open/.test(cardCode))
check('نشان واتس‌اپ و تلگرام با راهنمای موشی', card.includes('این شماره در واتس‌اپ هم هست') && card.includes('این شماره در تلگرام هم هست'))
check('لوگوی کوچک از assets برنامه (نه از اینترنت، نه پروندهٔ بزرگ docs)', /assets\/branding\/arkapos-mark-128\.png/.test(card) && !/docs\/plan-assets/.test(card.replace(/\/\*\*[\s\S]*?\*\//g, '')))
check('کادر در صفحهٔ اصلی و در جریان صفحه (نه شناور)', /<DeveloperCard \/>/.test(dashboard) && !/fixed|absolute bottom/.test(dashboard.slice(dashboard.indexOf('<DeveloperCard') - 200, dashboard.indexOf('<DeveloperCard'))))

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} موفق · ${bad} ناموفق`)
process.exit(bad ? 1 : 0)
