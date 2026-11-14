/**
 * نشست ۲۲۳ · مورد ۱۱/ب (S223-D8) — هدف گروهی «قیمت خرید» بسته است.
 *
 *     node --import ./test/harness/register.mjs tests/audit-fixes/fix-s223-item11b-purchase-target-closed.mjs
 *
 * چرا: `ProductVariant.purchasePrice` فقط باید از فاکتور خرید بیاید. تغییر گروهیِ
 * آن یک بهای ساختگی می‌سازد که ارزش جایگزینی/paperWealth را جابه‌جا می‌کند، با
 * ثبت فاکتور خرید بعدی بی‌صدا پاک می‌شود و سود تورمی لات‌های قدیمی را از بین می‌برد.
 *
 * آزمون‌ها:
 *   • پیش‌نمایش و اعمالِ PURCHASE رد می‌شوند و **هیچ** نوشتنی رخ نمی‌دهد.
 *   • قرارِ زمان‌بندی‌شدهٔ قدیمیِ PURCHASE سر ساعت اجرا نمی‌شود؛ CANCELLED می‌شود.
 *   • هدف SALE همچنان آزاد است و فقط `salePrice` را عوض می‌کند (سود تورم حفظ می‌شود).
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-s223-item11b-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'isolated.db')
process.env.HARNESS_BIGINT = '1'

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { priceAdjustService } = await import('../../src/main/services/PriceAdjustService.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('../../src/shared/receipt.ts')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const n = (v) => Number(v ?? 0)
const count = (table, where = '', args = []) =>
  n(sql.prepare(`SELECT COUNT(*) AS c FROM "${table}" ${where}`).get(...args).c)

let ok = 0
let bad = 0
const check = (label, fn) => {
  try {
    fn()
    ok++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    bad++
    console.log(`  ✗ ${label} — ${String(error?.message ?? error).split('\n')[0]}`)
  }
}
const rejectsWith = async (label, fn, pattern) => {
  try {
    await fn()
    bad++
    console.log(`  ✗ ${label} — هیچ خطایی پرتاب نشد`)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (pattern.test(message)) {
      ok++
      console.log(`  ✓ ${label}`)
    } else {
      bad++
      console.log(`  ✗ ${label} — پیام نامنتظره: ${message.split('\n')[0].slice(0, 120)}`)
    }
  }
}

// دو کالا: یکی با لات خرید واقعی (۱ میلیون) و دیگری بدون لات
const category = seed.category('دستهٔ مورد ۱۱ب')
const productA = seed.product('شلوار نیم‌بگ', category)
const variantA = seed.variant(productA, 'M')
const productB = seed.product('کالای بدون لات', category)
const variantB = seed.variant(productB, 'L')
sql.prepare(
  'UPDATE "ProductVariant" SET stock = 30, salePrice = 1500000, purchasePrice = 1000000 WHERE id = ?'
).run(variantA)
sql.prepare(
  'UPDATE "ProductVariant" SET stock = 5, salePrice = 700000, purchasePrice = 400000 WHERE id = ?'
).run(variantB)

const priceOf = (id) =>
  seed.one('SELECT salePrice, purchasePrice FROM "ProductVariant" WHERE id = ?', id)

const snapshot = () => ({
  batches: count('PriceChangeBatch'),
  items: count('PriceChangeItem'),
  audit: count('AuditLog'),
  a: priceOf(variantA),
  b: priceOf(variantB)
})

const purchaseInput = {
  scope: 'ALL',
  target: 'PURCHASE',
  kind: 'INCREASE',
  mode: 'PERCENT',
  value: 20,
  round: 1,
  minPrice: 0,
  password: DEFAULT_MANAGER_PASSWORD,
  note: 'تورم'
}

console.log('\n۱) پیش‌نمایش و اعمالِ «قیمت خرید» رد می‌شوند — بی‌هیچ نوشتنی')
{
  const before = snapshot()
  await rejectsWith('پیش‌نمایش رد می‌شود', () => priceAdjustService.preview(purchaseInput), /قیمت خرید/)
  await rejectsWith('اعمال رد می‌شود', () => priceAdjustService.apply(purchaseInput), /قیمت خرید/)
  await rejectsWith(
    'اعمال با هدف نامعتبر/کاهش هم رد می‌شود',
    () => priceAdjustService.apply({ ...purchaseInput, kind: 'DECREASE' }),
    /قیمت خرید/
  )
  const after = snapshot()
  check('هیچ دسته/قلم/سابقهٔ قیمتی ساخته نشد', () => {
    assert.equal(after.batches, before.batches)
    assert.equal(after.items, before.items)
  })
  check('بهای خرید هر دو کالا دست‌نخورده ماند', () => {
    assert.equal(n(after.a.purchasePrice), 1_000_000)
    assert.equal(n(after.b.purchasePrice), 400_000)
  })
  check('قیمت فروش هم دست‌نخورده ماند', () => {
    assert.equal(n(after.a.salePrice), 1_500_000)
    assert.equal(n(after.b.salePrice), 700_000)
  })
  check('سابقهٔ قیمتیِ تازه‌ای ثبت نشد', () => assert.equal(after.audit, before.audit))
}

console.log('\n۲) قرارِ زمان‌بندی‌شدهٔ قدیمیِ «قیمت خرید» لغو می‌شود، نه اجرا')
{
  const startAt = Date.now() - 60_000
  const batchId = seed.insert('PriceChangeBatch', {
    kind: 'INCREASE',
    mode: 'PERCENT',
    value: 20,
    target: 'PURCHASE',
    scope: 'ALL',
    roundStep: 1,
    minPrice: 0,
    title: 'قرار قدیمی قیمت خرید',
    itemCount: 0,
    deltaTotal: 0,
    at: startAt,
    atJalali: '1405/08/21',
    atTime: '10:00',
    state: 'SCHEDULED',
    startAt,
    startAtJalali: '1405/08/21',
    startAtTime: '10:00'
  })
  const itemsBefore = count('PriceChangeItem')
  await priceAdjustService.runDueSchedules(new Date())
  check('زمان‌بند برای این قرار هیچ قلم قیمتی نساخت', () => assert.equal(count('PriceChangeItem'), itemsBefore))
  check('وضعیت دسته CANCELLED شد', () => {
    assert.equal(seed.one('SELECT state FROM "PriceChangeBatch" WHERE id = ?', batchId).state, 'CANCELLED')
  })
  check('بهای خرید همچنان واقعی است', () => {
    assert.equal(n(priceOf(variantA).purchasePrice), 1_000_000)
    assert.equal(n(priceOf(variantB).purchasePrice), 400_000)
  })
  check('هیچ قیمت فروشی هم عوض نشد', () => {
    assert.equal(n(priceOf(variantA).salePrice), 1_500_000)
  })
  check('علتِ لغو در سابقه ثبت شد', () => {
    const row = seed.one(
      "SELECT note FROM \"AuditLog\" WHERE entity = 'PriceChangeBatch' ORDER BY id DESC LIMIT 1"
    )
    assert.match(String(row?.note), /بسته است|لغو/)
  })
  await rejectsWith(
    'ویرایش دامنهٔ همین دستهٔ قدیمی هم رد می‌شود',
    () => priceAdjustService.editBatch({ batchId, scope: 'ALL', password: DEFAULT_MANAGER_PASSWORD }),
    /قیمت خرید/
  )
}

console.log('\n۳) هدف «قیمت فروش» آزاد است و بهای خرید را لمس نمی‌کند')
{
  const saleInput = { ...purchaseInput, target: 'SALE', mode: 'AMOUNT', value: 500_000 }
  const preview = await priceAdjustService.preview(saleInput)
  check('پیش‌نمایش قیمت فروش خط برمی‌گرداند', () => assert.ok(Array.isArray(preview.lines) && preview.lines.length > 0))
  check('هر خط از قیمت فروش شروع می‌شود', () => {
    assert.equal(n(preview.lines[0].oldPrice), 1_500_000)
  })
  await priceAdjustService.apply(saleInput)
  const a = priceOf(variantA)
  check('قیمت فروش بالا رفت (۱٫۵M ⇒ ۲M)', () => assert.equal(n(a.salePrice), 2_000_000))
  check('بهای خرید اصلاً تکان نخورد', () => assert.equal(n(a.purchasePrice), 1_000_000))
  const batch = seed.one('SELECT target, state FROM "PriceChangeBatch" ORDER BY id DESC LIMIT 1')
  check('دسته با هدف SALE و وضعیت APPLIED ثبت شد', () => {
    assert.equal(batch.target, 'SALE')
    assert.equal(batch.state, 'APPLIED')
  })
}

await db.$disconnect?.()
console.log(`\nنتیجه: ${ok} موفق · ${bad} ناموفق`)
if (bad > 0) process.exitCode = 1
