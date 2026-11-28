/**
 * طرح ۱۴۰۵ · مورد ۱۱ — نگهبان بسته‌بندی ArkaPOS (معماری §۴-۵ و §۸-۲ بند ۱۷).
 *
 *   node tests/audit-fixes/plan1405-arkapos-packaging.mjs
 *
 * نام نمایشی، آیکون، Publisher و متن میان‌بر عوض می‌شوند؛ شناسه‌های درونی که پوشهٔ داده
 * (`%APPDATA%\mahak-pos`)، پوشهٔ نصب، GUID نصب و نام exe را تعیین می‌کنند همان می‌مانند.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let ok = 0
let bad = 0
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✓ ${label}`) } else { bad++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

console.log('\n۱) شناسه‌های درونی (دست نمی‌خورند)')
check("name === 'mahak-pos' (پوشهٔ داده و پوشهٔ نصب)", pkg.name === 'mahak-pos', pkg.name)
check("build.appId === 'ir.shop.mahakpos' (GUID نصب)", pkg.build?.appId === 'ir.shop.mahakpos', pkg.build?.appId)
check("build.executableName === 'MahakPOS' (نام exe و بررسی CI)", pkg.build?.executableName === 'MahakPOS', pkg.build?.executableName)
check('productName سطح بالا نیست (پوشهٔ داده را عوض می‌کرد)', !('productName' in pkg))

console.log('\n۲) نام نمایشی و آیکون')
check("build.productName === 'ArkaPOS'", pkg.build?.productName === 'ArkaPOS', pkg.build?.productName)
check("author (Publisher) === 'ArkaPOS'", pkg.author === 'ArkaPOS', pkg.author)
check("description (متن میان‌بر) === 'ArkaPOS — فروش و انبارداری'", pkg.description === 'ArkaPOS — فروش و انبارداری', pkg.description)
check("build.win.icon === 'branding/arkapos.ico'", pkg.build?.win?.icon === 'branding/arkapos.ico', pkg.build?.win?.icon)
const ico = readFileSync('branding/arkapos.ico')
const count = ico.readUInt16LE(4)
const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256)
check('ICO معتبر (نوع ۱)', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1)
check('ICO اندازهٔ ۲۵۶ دارد (لازم برای electron-builder)', sizes.includes(256), sizes.join(','))
check('ICO اندازه‌های کوچک ۱۶ تا ۴۸ را دارد', [16, 24, 32, 48].every((s) => sizes.includes(s)), sizes.join(','))
check('عنوان پنجره در index.html «ArkaPOS» است', /<title>ArkaPOS<\/title>/.test(readFileSync('src/renderer/index.html', 'utf8')))

console.log('\n۳) هیچ‌جا پوشهٔ داده دستی عوض نمی‌شود')
const offenders = []
const walk = (dir) => {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n)
    if (statSync(f).isDirectory()) walk(f)
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(n) && /setPath\(\s*['"]userData['"]/.test(readFileSync(f, 'utf8'))) offenders.push(f)
  }
}
walk('src')
check("هیچ app.setPath('userData', …) در src نیست", offenders.length === 0, offenders.join(','))
check('عنوان پیش‌فرض src/main/index.ts دست نخورده است (عنوان از index.html می‌آید)', /show:\s*false/.test(readFileSync('src/main/index.ts', 'utf8')))

console.log('\n۴) راهنمای نصب')
const guide = readFileSync('INSTALL-WINDOWS-CMD.md', 'utf8') + readFileSync('INSTALL-WINDOWS-CMD.txt', 'utf8')
check('نام تازهٔ نصب‌کننده (ArkaPOS Setup 0.1.0.exe) در هر دو راهنما', (guide.match(/ArkaPOS Setup 0\.1\.0\.exe/g) ?? []).length >= 2)
check('فرمان سنجش پوشهٔ نصب و داده پیش از نصب (انتظار mahak-pos)', /%LOCALAPPDATA%\\Programs/.test(guide) && /mahak-pos/.test(guide))

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} موفق · ${bad} ناموفق`)
process.exit(bad ? 1 : 0)
