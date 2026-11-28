/**
 * طرح ۱۴۰۵ · کار کوچک ۴ (بخش ۷ طرح؛ تأیید مالک: «پیام فارسی روشن»).
 *
 * اگر فایل LICENSE کنار node.exe نباشد، `tools/build-remote-hub.mjs` با پیام فارسی و انگلیسی و **همان دستورِ**
 * `INSTALL-WINDOWS-CMD.md` می‌ایستد (exit 1)؛ ساخت چیزی از اینترنت نمی‌گیرد. این شاخه فقط روی ویندوز اجرا می‌شود،
 * پس این آزمون متن را می‌سنجد، نه اجرای ویندوزی را.
 *
 *   node --import ./test/harness/register.mjs tests/audit-fixes/plan1405-build-license-message.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const script = readFileSync(new URL('../../tools/build-remote-hub.mjs', import.meta.url), 'utf8')
const guide = readFileSync(new URL('../../INSTALL-WINDOWS-CMD.md', import.meta.url), 'utf8')

let checks = 0
const ok = (label, cond) => {
  assert.ok(cond, label)
  checks++
  console.log(`  ✓ ${label}`)
}

const literal = script.match(/const NODE_LICENSE_COMMAND = String\.raw`([^`]*)`/)
ok('دستور در یک ثابت String.raw آمده است', !!literal)
const fromGuide = guide.slice(guide.indexOf('Packaging Node license is missing')).match(/```cmd\n(node -e "[^\n]+)\n```/)
ok('راهنمای نصب همان بند و دستور را دارد', !!fromGuide)
ok('دستور ساخت حرف‌به‌حرف همان دستور راهنمای نصب است', literal[1] === fromGuide[1])
ok('دستور فقط از github.com رسمی Node می‌خواند و آغاز متن را می‌سنجد',
  literal[1].includes('https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=') && literal[1].includes('Node.js is licensed for use as follows:'))

const branch = script.slice(script.indexOf('if (!existsSync(license)) {'), script.indexOf('const runtimeDir'))
ok('شاخهٔ «LICENSE نیست» وجود دارد', branch.length > 100)
ok('عبارت انگلیسی قبلی (که راهنما به آن اشاره می‌کند) هنوز چاپ می‌شود', branch.includes("'ERROR: Packaging Node license is missing: ' + license"))
ok('پیام فارسی علت و راه حل را می‌گوید', branch.includes('فایل LICENSE کنار node.exe نیست') && branch.includes('BUILD-WINDOWS.cmd را دوباره بزنید') && branch.includes('INSTALL-WINDOWS-CMD.md'))
ok('خط انگلیسی راه حل هم هست (اگر cmd حروف فارسی را نشان ندهد)', branch.includes('Fix: run this command in this Administrator CMD'))
ok('خود دستور چاپ می‌شود و ساخت با کد ۱ می‌ایستد', branch.includes('NODE_LICENSE_COMMAND,') && branch.includes('process.exit(1)'))
ok('ساخت چیزی دریافت نمی‌کند (fetch فقط درون متن دستور است)', !/\bfetch\(/.test(script.replace(literal[0], '')))
ok('throw خام قبلی رفت', !script.includes("throw new Error('Packaging Node license is missing')"))

console.log(`\nplan1405 build license message: ${checks} PASS · 0 FAIL`)
