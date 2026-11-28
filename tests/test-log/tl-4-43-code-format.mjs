/**
 * دفتر آزمون ۴-۴۳ — کد یک‌بارمصرف: ۸ رقم پشت سر هم، و فرق روشن با کد بازیابی.
 *
 *  - ساخت: هر کد ۸ رقم پیوسته، بی خط فاصله (صفحه و برگهٔ چاپ همان را نشان می‌دهند)؛
 *  - ورود: با خط تیره یا بی آن، رقم فارسی یا لاتین؛
 *  - ورودیِ غیر ۸ رقمی (کد بازیابیِ حرف‌دار، ۷ یا ۹ رقم): «کد یک‌بارمصرف ۸ رقم است. …»، شمرده نمی‌شود و قفل نمی‌کند؛
 *  - کد ۸ رقمیِ اشتباه همچنان شمرده می‌شود؛ ۵ اشتباه ⇒ ۱۵ دقیقه قفل (همان قاعده)؛
 *  - صفحه: نمونهٔ کادر «۸ رقم»؛ زیر دو عنوان کدهای بازیابی: «این‌ها کد یک‌بارمصرف نیستند؛ …».
 *
 * اجرا:
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-43-code-format.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-43-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const sessions = await import('../../src/main/services/panelSession.ts')
const lockIpc = await import('../../src/main/services/locks/lockIpc.ts')
const codes = await import('../../src/main/services/locks/oneTimeCodes.ts')
const auth = await import('../../src/main/services/AuthService.ts')
const { runInGateCall } = await import('../../src/main/services/locks/callContext.ts')
const { redeemOneTimeCode } = await import('../../src/main/services/locks/codeRedeem.ts')
const { setAccessEventWriter } = await import('../../src/main/services/locks/accessEvents.ts')
const { PANEL_KEYS } = await import('../../src/shared/panels.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const src = (p) => readFileSync(join(ROOT, p), 'utf8')
const PW = '58204716'
await auth.authService.changePassword({ current: DEFAULT_MANAGER_PASSWORD, next: PW })

const events = []
setAccessEventWriter((row) => { events.push(row) })
const wrongs = () => events.filter((e) => e.kind === 'CODE_WRONG').length

const FORMAT = 'کد یک‌بارمصرف ۸ رقم است. کدِ حرف‌دار کد بازیابی است و این‌جا کار نمی‌کند.'
const RECOVERY_LINE = 'این‌ها کد یک‌بارمصرف نیستند؛ فقط برای «بازیابی توقف اضطراری راه دور» به کار می‌روند.'
const FA = '۰۱۲۳۴۵۶۷۸۹'
const fa = (s) => s.replace(/[0-9]/g, (d) => FA[Number(d)])
let owner = 400
/** هر بار پنجرهٔ تازه تا «همین حالا باز است» پیش نیاید. */
const redeem = async (target, code) => {
  const w = ++owner
  try {
    return { ok: true, value: await sessions.runWithPanelSessionOwner(w, () => runInGateCall(w, () => redeemOneTimeCode(target, code))) }
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) }
  }
}
const normal = PANEL_KEYS.products

const S = await lockIpc.createCodes({ section: 'sensitive', managerPassword: PW })
const O = await lockIpc.createCodes({ section: 'other', managerPassword: PW })

test('created codes are 8 digits in a row with no hyphen; entry works with or without a hyphen, Persian or Latin digits', async () => {
  for (const c of [...S.codes, ...O.codes]) assert.match(c.code, /^[0-9]{8}$/, `code ${c.n}`)
  assert.equal(codes.formatOneTimeCode('48210937'), '48210937')
  const a = O.codes[0].code, b = O.codes[1].code
  let r = await redeem(normal, `${a.slice(0, 4)}-${a.slice(4)}`)
  assert.ok(r.ok, r.message)
  assert.equal(r.value.number, 1)
  r = await redeem(normal, fa(b))
  assert.ok(r.ok && r.value.number === 2, r.message)
  assert.equal(lockIpc.codesStatus().sections.other.remaining, 3)
})

test('a lettered (recovery) code or any entry that is not 8 digits: the clear message, never counted, never locks', async () => {
  const before = wrongs()
  for (const entry of ['K7QM-4XPT-9WRD', 'K7QM4XPT9WRD', '1234567', '123456789', '۱۲۳۴-۵۶۷', 'abcd-efgh', 'K7QM-4XPT-9WRD']) {
    const r = await redeem(normal, entry)
    assert.equal(r.ok, false)
    assert.equal(r.message, FORMAT, `entry ${entry}`)
  }
  assert.equal(wrongs(), before, 'no CODE_WRONG row')
  assert.equal(lockIpc.codesStatus().lockedMs, 0, 'seven entries, no lock')
  assert.equal(lockIpc.codesStatus().sections.other.remaining, 3, 'nothing used')
  const r = await redeem(normal, '1357-9246')
  assert.equal(r.ok, false)
  assert.match(r.message, /کد درست نیست یا برای این ماژول نیست\. \(۴ تلاش دیگر تا قفل شدن\)/, 'the counter was still at zero')
  assert.equal(wrongs(), before + 1)
})

test('an 8-digit wrong code is still counted: the fifth locks for 15 minutes; while locked a lettered code still gets the clear message', async () => {
  for (let i = 0; i < 3; i++) await redeem(normal, '13579246')
  const fifth = await redeem(normal, '1357 9246')
  assert.equal(fifth.ok, false)
  assert.match(fifth.message, /پس از ۵ تلاش اشتباه، ورود کد ۱۵ دقیقه قفل شد/)
  assert.ok(lockIpc.codesStatus().lockedMs > 0)
  const real = await redeem(normal, O.codes[2].code)
  assert.match(real.message, /قفل است/, 'a real code waits for the lock too')
  assert.equal((await redeem(normal, 'K7QM-4XPT-9WRD')).message, FORMAT)
  assert.equal(codes.clearOneTimeCodeLock(), true)
  const ok = await redeem(normal, O.codes[2].code)
  assert.ok(ok.ok && ok.value.number === 3, ok.message)
})

test('screen: the code box shows «۸ رقم»; the recovery box says they are not one-time codes under both titles; the recovery codes keep their 12 characters', () => {
  const box = src('src/renderer/src/components/OneTimeCodeBox.tsx')
  assert.ok(box.includes('placeholder="۸ رقم"'))
  assert.ok(!box.includes('۰۰۰۰-۰۰۰۰'))
  const rec = src('src/renderer/src/components/RecoveryCodesBox.tsx')
  const h2 = rec.indexOf('<h2 className="font-bold">کدهای بازیابی «توقف اضطراری کامل»</h2>')
  const shown = rec.indexOf('کدهای بازیابی — فقط همین یک بار دیده می‌شوند</div>')
  const first = rec.indexOf(RECOVERY_LINE), second = rec.indexOf(RECOVERY_LINE, first + 1)
  assert.ok(h2 > 0 && shown > h2)
  assert.ok(first > h2 && first < shown && first - h2 < 400, 'right under the box title')
  assert.ok(second > shown && second - shown < 200, 'right under the title of the shown codes')
  const settings = src('src/renderer/src/components/OneTimeCodesSettings.tsx')
  assert.ok(!settings.includes('slice(0, 4)') && settings.includes('${c.code}'), 'screen and print sheet show the code as made')
  assert.ok(src('src/main/services/cloud/hubIdentity.ts').includes('`${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`'), 'recovery codes unchanged')
})
