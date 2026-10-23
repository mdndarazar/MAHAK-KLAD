/**
 * ===========================================================================
 * جلسه ۴۰/۴۵ + قرارداد مالی جدید: برگشت/تعویض، تأیید پرداخت مدیر، تطبیق بانک،
 * دریافت مقداربه‌مقدار کالا، قفل سمت سرور و انبارگردانی. برای C2C، پرداخت مدیر
 * کالای همان برگشت را آزاد می‌کند؛ شاهد بانک و صندوق همچنان جدا می‌مانند.
 * ---------------------------------------------------------------------------
 * روی همان هارنس واقعی جلسه ۳۵ اجرا می‌شود: SQLite داخل خودِ Node، جدول‌ها از
 * **فایل‌های migration واقعی پروژه**، و سرویس‌های واقعی (`SalesService.ts`،
 * `CardTransferService.ts`، `PendingRestockService.ts`، `StockCountService.ts`،
 * `CashboxService.ts`، `AuthService.ts`). هیچ چیزی mock نشده؛ هر عددی که این
 * فایل می‌سنجد، همان عددی است که پنل می‌بیند.
 *
 * نکات سختی که می‌سنجد:
 *   • `pay` در C2C اقلام برگشتی همان سند را یک‌بار آزاد می‌کند؛ دفتر حق تا سند بانک جداگانه می‌ماند.
 *   • برگشت/تعویضِ غیر C2C همان لحظه موجودی را اصلاح می‌کند؛ شاهد فیزیکیِ جدا لازم نیست.
 *   • دریافت جداگانه فقط برای پرونده‌های قدیمیِ صریحاً علامت‌خورده باقی است؛
 *     لغو C2C یا تلاش تکراری موجودی را آزاد نمی‌کند.
 *   • تعویض، ویرایش/ابطال با رمز، صندوق و انبارگردانی هر کدام مرز مستقل دارند.
 *   • برگشت‌های نقدی/بی‌کسر و رفتار تاریخیِ مربوط حفظ می‌شوند.
 *
 * هر سناریو **شیفت خودش** و **کالای خودش** را دارد، پس نه عددهای مالی و نه
 * عددهای انباری سناریوها به هم نمی‌ریزند.
 * ===========================================================================
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-session40-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const { harnessClient } = await import('./harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('./harness/seed.mjs')
const { salesService } = await import('../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../src/main/services/CardTransferService.ts')
const { pendingRestockService } = await import('../src/main/services/PendingRestockService.ts')
const { returnGoodsService } = await import('../src/main/services/ReturnGoodsService.ts')
const { viewReturnEntitlement } = await import('../src/main/services/ReturnEntitlementService.ts')
const { stockCountService } = await import('../src/main/services/StockCountService.ts')
const { cashboxService } = await import('../src/main/services/CashboxService.ts')
const {
  AuditAction,
  CardTransferStatus,
  RefundMethod
} = await import('@shared/enums')
const {
  PENDING_RESTOCK_COLUMN,
  PENDING_RESTOCK_EXPLAINER,
  PENDING_RESTOCK_STOCKTAKE_NOTE,
  PENDING_RESTOCK_ALERT_DAYS,
  ageInDays,
  expectedPhysicalQty,
  itemNeedsRestock,
  pendingQtyOfItems,
  pendingRestockHeadline,
  pendingRestockLine,
  pendingRestockShiftWarning,
  pendingRestockTone,
  pendingStockNote
} = await import('@shared/pendingRestock')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate, faDigits } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

// ------------------------------------------------------------------ گزارش‌گر
let pass = 0
const failures = []
const section = (title) => console.log(`\n— ${title}`)
const ok = (name, cond, detail) => {
  if (cond) {
    pass++
    return true
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ''}`)
  console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`)
  return false
}
const eq = (name, got, want) =>
  ok(name, got === want, `دریافت ${JSON.stringify(got)} · انتظار ${JSON.stringify(want)}`)
const throwsWith = async (name, fn, needle) => {
  try {
    await fn()
    return ok(name, false, 'هیچ خطایی پرتاب نشد')
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (msg.startsWith('HARNESS:')) return ok(name, false, msg)
    return ok(name, needle ? msg.includes(needle) : true, `پیام: ${msg.split('\n')[0]}`)
  }
}

// ------------------------------------------------------------- داده‌ی پایه
const PW = DEFAULT_MANAGER_PASSWORD
const userId = seed.user('مدیر تست کار ب')
const cat = seed.category('پوشاک')
const product = seed.product('شلوار مردانه', cat)

const METHOD = {
  cash: seed.insert('PaymentMethod', { key: 'CASH', label: 'نقدی', kind: 'CASH', isActive: 1, sortOrder: 1 }),
  card: seed.insert('PaymentMethod', { key: 'CARD', label: 'کارتخوان', kind: 'CARD', isActive: 1, sortOrder: 2 })
}

const UNIT = 5_000_000
const HOUR = 3_600_000
let shiftSeq = 0
let variantSeq = 0

/** یک شیفتِ بازِ مستقل برای هر سناریو (مرز عددهای مالی) */
const makeShift = (name) =>
  seed.insert('Shift', {
    name,
    number: ++shiftSeq,
    dayJalali: toJalaliDate(new Date()),
    openedAt: Date.now() - HOUR,
    userId
  })

/** یک کالای مستقل با موجودی معلوم برای هر سناریو (مرز عددهای انباری) */
const makeVariant = (stock = 100, label) => {
  const id = seed.variant(product, label ?? `سایز ${++variantSeq}`)
  sql.prepare('UPDATE "ProductVariant" SET stock = ?, salePrice = ? WHERE id = ?').run(stock, UNIT, id)
  return id
}

const stockOf = (variantId) =>
  Number(sql.prepare('SELECT stock FROM "ProductVariant" WHERE id = ?').get(variantId).stock)
const itemsOf = (invoiceId) =>
  seed.rows('SELECT id, variantId, qty FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', invoiceId)
const returnRow = (id) => seed.one('SELECT * FROM "SaleReturn" WHERE id = ?', id)
const returnItems = (id) => seed.rows('SELECT * FROM "SaleReturnItem" WHERE returnId = ? ORDER BY id', id)
const requestRow = (id) => seed.one('SELECT * FROM "CardTransferRequest" WHERE id = ?', id)
const auditRows = (action, entityId) =>
  seed.rows('SELECT * FROM "AuditLog" WHERE action = ? AND entityId = ? ORDER BY id', action, entityId)
const movementsOf = (returnId) =>
  seed.rows(
    'SELECT * FROM "StockMovement" WHERE refType = ? AND refId = ? ORDER BY id',
    'SaleReturn',
    returnId
  )

/** فاکتورِ نقدیِ کاملاً تسویه‌شده (سقف بازپرداخت = همان مبلغ) */
const paidSale = async (shiftId, variantId, qty = 2) => {
  const inv = await salesService.create({
    userId,
    shiftId,
    lines: [{ variantId, qty, unitPrice: UNIT, discount: 0, tax: 0 }],
    payments: [{ methodId: METHOD.cash, amount: UNIT * qty }]
  })
  return { id: inv.id, receiptNo: inv.receiptNo, items: itemsOf(inv.id), total: UNIT * qty }
}

/** برگشتِ کارت‌به‌کارتِ مدیر (کالا باید معلق بماند) */
const cardToCardReturn = (invoiceId, lines, amount) =>
  salesService.createReturn({
    invoiceId,
    full: false,
    lines,
    refundMethod: RefundMethod.CARD_TO_CARD,
    refundAmount: amount,
    userId
  })

/** دریافت جداگانه فقط برای دادهٔ تاریخیِ علامت‌خورده؛ در پرونده‌های جدید باید رد شود. */
const receiveGoods = async (returnId, qty, suffix = 'confirmed') => {
  const item = seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=? ORDER BY id LIMIT 1', returnId)
  if (!item) throw new Error('قلم برگشت برای دریافت پیدا نشد')
  return returnGoodsService.receive({
    returnId, returnItemId: item.id, qty,
    eventKey: `session40-receipt-${returnId}-${suffix}`,
    witnessKind: 'SELECTED_CONFIRMED',
    witnessRef: 'انتخاب کالا و شمارش فیزیکی در فروشگاه',
    physicalConfirmed: true, actorUserId: userId
  })
}

const summary = () => pendingRestockService.summary()
const pendingQtyOf = (s, returnId) =>
  s.items.filter((i) => i.returnId === returnId).reduce((t, i) => t + i.qty, 0)

// ===========================================================================
section('بند ۰ · تعریف رسمی «معلق برگشتی» — توابع خالص @shared/pendingRestock')
// ===========================================================================
{
  eq('معلق یک سند = Σ(qty − restockedQty)', pendingQtyOfItems([{ qty: 3, restockedQty: 0 }, { qty: 2, restockedQty: 1 }]), 4)
  eq('قلمِ آزادشده سهمی در معلق ندارد', pendingQtyOfItems([{ qty: 2, restockedQty: 2 }]), 0)
  eq('restockedQty بیشتر از qty معلقِ منفی نمی‌سازد', pendingQtyOfItems([{ qty: 1, restockedQty: 5 }, { qty: 3, restockedQty: 0 }]), 3)
  eq('itemNeedsRestock فقط قلمِ ناتمام را true می‌کند', itemNeedsRestock({ qty: 2, restockedQty: 1 }), true)
  eq('و قلمِ تمام‌شده را false', itemNeedsRestock({ qty: 2, restockedQty: 2 }), false)
  eq('موجودی فیزیکیِ مورد انتظار = قابل‌فروش + معلق', expectedPhysicalQty(7, 2), 9)
  eq('بی‌معلق، موجودی فیزیکی همان قابل‌فروش است', expectedPhysicalQty(7, 0), 7)
  eq('سن درخواست به روز', ageInDays(Date.now() - 3 * 86_400_000 - 1000), 3)
  eq('سن نامعلوم ⇒ صفر (بدون حدس)', ageInDays(null), 0)
  eq('تُنِ بی‌معلق: none', pendingRestockTone(10, 0), 'none')
  eq('تُنِ تازه: info', pendingRestockTone(0, 1), 'info')
  eq('تُنِ سه‌روزه: warn', pendingRestockTone(3, 1), 'warn')
  eq('تُنِ هفت‌روزه: alert', pendingRestockTone(PENDING_RESTOCK_ALERT_DAYS, 1), 'alert')
  eq('خلاصه‌ی خالی هیچ کادری نمی‌سازد', pendingRestockHeadline({ totalQty: 0, returnCount: 0, pendingAmount: 0, oldestAgeDays: 0 }), null)
  ok('هشدار شیفتِ خالی هم null است', pendingRestockShiftWarning(null) === null)
  ok(
    'جمله‌ی نمونه‌ی خواسته‌ی مالک ساخته می‌شود',
    pendingRestockLine({ name: 'شلوار', qty: 2 }, faDigits).includes('در انتظار تعیین تکلیف موجودی'),
    pendingRestockLine({ name: 'شلوار', qty: 2 }, faDigits)
  )
  ok('متن انبارگردانی هم آزادسازی C2C را از دریافت فیزیکی تفکیک می‌کند',
    PENDING_RESTOCK_COLUMN.includes('پرداخت مدیر') &&
    PENDING_RESTOCK_STOCKTAKE_NOTE.includes('پرونده‌های قدیمیِ معلق') &&
    PENDING_RESTOCK_STOCKTAKE_NOTE.includes('تأیید پرداخت مدیر'))
  ok('متن توضیحی می‌گوید تأیید مدیر همان کالای C2C را برمی‌گرداند',
    PENDING_RESTOCK_EXPLAINER.includes('تأیید پرداخت مدیر') && PENDING_RESTOCK_EXPLAINER.includes('کالای برگشتیِ همین سند'))
}

// ===========================================================================
section('بند ۱ · برگشت کارت‌به‌کارت بدون پرداخت ⇒ موجودی قابل‌فروش تغییر نمی‌کند')
// ===========================================================================
let scenario1 = null
{
  const shiftId = makeShift('نشست برگشت معلق')
  const variantId = makeVariant(100, 'سایز ۳۸')
  const inv = await paidSale(shiftId, variantId, 2)
  const afterSale = stockOf(variantId)
  eq('فروش، موجودی را کم کرد (پایه‌ی مقایسه)', afterSale, 98)

  const before = await summary()
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 2 }], UNIT * 2)

  eq('سند برگشت پرچم معلق گرفت', ret.restockPending, true)
  eq('تعداد معلقِ همین سند', ret.pendingRestockQty, 2)
  eq('موجودی قابل‌فروش یک عدد هم عوض نشد', stockOf(variantId), afterSale)
  eq('هیچ حرکت انباری برای این برگشت ثبت نشد', movementsOf(ret.id).length, 0)
  eq('restockedQty اقلام صفر ثبت شد (منبع حقیقتِ تعداد)', returnItems(ret.id).every((i) => i.restockedQty === 0), true)
  eq('درخواست کارت‌به‌کارت با وضعیت «در انتظار پرداخت» ساخته شد', ret.cardTransfer.status, CardTransferStatus.PENDING)
  eq('مبلغ درخواست = مبلغ بازپرداخت', ret.cardTransfer.amount, UNIT * 2)
  ok(
    'stockNote همان لحظه راست می‌گوید (کالا به انبار نرفت)',
    requestRow(ret.cardTransfer.id).stockNote === pendingStockNote(2, faDigits),
    requestRow(ret.cardTransfer.id).stockNote
  )

  const s = await summary()
  eq('تابع مشترک، معلق را دید', pendingQtyOf(s, ret.id), 2)
  eq('معلق به تفکیک کالا (هشدار انبار/انبارگردانی)', s.byVariant[variantId], 2)
  eq('پروندهٔ جدید بدون شاهد فیزیکی حاضر فرض نمی‌شود', s.physicalByVariant[variantId] ?? 0, 0)
  eq('تعداد فاقد شاهد مستقل در خلاصه دیده می‌شود', s.unconfirmedQty - before.unconfirmedQty, 2)
  eq('نقشهٔ فیزیکیِ شمارش پروندهٔ جدید را حساب نمی‌کند', (await pendingRestockService.byVariant())[variantId] ?? 0, 0)
  eq('جمع کل معلق دو عدد بالا رفت', s.totalQty - before.totalQty, 2)
  eq('تعداد اسناد معلق یکی بالا رفت', s.returnCount - before.returnCount, 1)
  eq('مبلغ در انتظار پرداخت مدیر شمرده شد', s.pendingAmount - before.pendingAmount, UNIT * 2)
  eq('ردیف «نیازمند رسیدگی» ساخته نشد (درخواست باز است)', s.needsAttentionQty, before.needsAttentionQty)
  const row = s.items.find((i) => i.returnId === ret.id)
  eq('ردیف معلق به درخواست گره خورده است', row.requestId, ret.cardTransfer.id)
  eq('ردیف معلق شماره فیش فاکتور اصلی را دارد', row.receiptNo, inv.receiptNo)
  eq('ردیف معلق نوع عملیات را می‌گوید', row.operationKind, 'RETURN')
  eq('ردیف معلق «رد‌شده» علامت نخورده', row.canceled, false)
  ok('جملهٔ خلاصهٔ صفحه‌ها دریافت کالا را از بانک جدا می‌کند',
    (pendingRestockHeadline(s, faDigits, faDigits) ?? '').includes('در انتظار تأیید پرداخت مدیر'))

  // گزارش برگشت/تعویض (تب گزارشات فروش) همان عدد را می‌بیند
  const list = await salesService.returnList({ shiftId })
  const lrow = list.find((r) => r.id === ret.id)
  eq('گزارش برگشت: پرچم معلق', lrow.restockPending, true)
  eq('گزارش برگشت: تعداد معلق', lrow.pendingRestockQty, 2)
  eq('گزارش برگشت: هیچ عددی به انبار برنگشت', lrow.restockedQty, 0)
  eq('گزارش برگشت: روش بازپرداخت کارت‌به‌کارت', lrow.refundMethod, RefundMethod.CARD_TO_CARD)

  // بستن صندوق: کارت‌به‌کارت نه از کشو پول می‌برد و نه در کارتخوان می‌نشیند
  const exp = await cashboxService.expected({ shiftId, countedCash: UNIT * 2 })
  eq('نقد مورد انتظار = فقط پولِ همان فروش', exp.expectedCash, UNIT * 2)
  eq('کسری/اضافی صفر ماند (معلق اثری ندارد)', exp.cashDifference, 0)
  ok('هشدار شیفت برای معلق‌ها ساخته می‌شود', (pendingRestockShiftWarning(s, faDigits) ?? '').includes('کسری/اضافی'))

  scenario1 = { shiftId, variantId, inv, ret, requestId: ret.cardTransfer.id, stockAfterSale: afterSale }
}

// ===========================================================================
section('بند ۲ · `pay` بدون تأیید مدیر و با رمز غلط ⇒ رد، و هیچ چیزی عوض نمی‌شود')
// ===========================================================================
{
  const { variantId, ret, requestId, stockAfterSale } = scenario1
  await throwsWith(
    'فراخوانی `pay` بدون رمز مدیر رد می‌شود (قفل سمت سرور)',
    () => cardTransferService.pay({ id: requestId, userId }),
    'تأیید مدیر'
  )
  eq('بعد از رد شدن، موجودی قابل‌فروش دست‌نخورده است', stockOf(variantId), stockAfterSale)
  eq('و وضعیت درخواست همان «در انتظار پرداخت» است', requestRow(requestId).status, CardTransferStatus.PENDING)
  eq('و سند برگشت همچنان معلق است', returnRow(ret.id).restockPending, 1)

  await throwsWith(
    'رمز غلط هم رد می‌شود',
    () => cardTransferService.pay({ id: requestId, managerPassword: 'غلط-غلط', userId }),
    ''
  )
  eq('رمز غلط هیچ کالایی آزاد نکرد', stockOf(variantId), stockAfterSale)
  eq('رمز غلط هیچ حرکت انباری نساخت', movementsOf(ret.id).length, 0)
  await throwsWith(
    'لغو بدون رمز مدیر هم رد می‌شود (همان گیت)',
    () => cardTransferService.cancel({ id: requestId, reason: 'تست', userId }),
    'تأیید مدیر'
  )
}

// ===========================================================================
section('بند ۳ · تأیید پرداخت مدیر، کالای همان درخواست C2C را فوراً برمی‌گرداند؛ بانک مستقل می‌ماند')
// ===========================================================================
{
  const { variantId, ret, requestId, stockAfterSale } = scenario1
  await throwsWith('دریافت فیزیکی پیش از پرداخت راه آزادسازی C2C نیست',
    () => receiveGoods(ret.id, 1, 'c2c-physical-before-pay'), 'کارت‌به‌کارت فقط با تأیید پرداخت مدیر')
  eq('پیش از پرداخت، موجودی کارت‌به‌کارت تغییر نکرد', stockOf(variantId), stockAfterSale)
  eq('تلاش فیزیکی، رسیدی نساخت', seed.count('ReturnGoodsReceipt', 'returnId = ?', ret.id), 0)
  const beforeSum = await summary()
  const paid = await cardTransferService.pay({ id: requestId, managerPassword: PW, userId })

  eq('وضعیت پرداخت مدیر ثبت شد', paid.status, CardTransferStatus.PAID)
  eq('تأیید پرداخت مدیر همهٔ کالای برگشتی همان سند را آزاد کرد', paid.releasedQty, 2)
  eq('موجودی همان لحظه دو عدد بالا رفت', stockOf(variantId), stockAfterSale + 2)
  eq('یک حرکت انباری به سند برگشت گره خورد', movementsOf(ret.id).length, 1)
  eq('حرکت پرداخت مدیر دقیقاً دو عدد است', Number(movementsOf(ret.id)[0].delta), 2)
  eq('restockedQty بعد از پرداخت برابر qty شد', returnItems(ret.id).every((i) => i.restockedQty === i.qty), true)
  eq('پرچم معلق بعد از پرداخت برداشته شد', returnRow(ret.id).restockPending, 0)
  ok('متن درخواست تعداد کل برگشتی و سهم آزادشده با پرداخت مدیر را می‌گوید',
    requestRow(requestId).stockNote.includes('کالای برگشتی از این سند به موجودی قابل‌فروش برگشت') &&
      requestRow(requestId).stockNote.includes('تأیید پرداخت مدیر همین درخواست'))
  eq('تعداد کل آزادشده در درخواست همان تعداد همین برگشت است',
    requestRow(requestId).stockReleasedQty, 2)
  ok('تاریخ آزادسازی کالا با پرداخت مدیر ثبت شد', requestRow(requestId).stockReleasedAt != null)
  const claim = await viewReturnEntitlement(ret.id)
  eq('دفتر حق نتیجهٔ بانک را نامعلوم نگه داشت', claim.state, 'UNKNOWN_BANK')
  eq('رزرو حق نقدی همچنان کامل است', claim.cashReserved, UNIT * 2)
  eq('پول بدون سند بانک پرداخت‌شده فرض نشد', claim.cashPaid, 0)

  const pending = await summary()
  eq('کالای همین درخواست پس از پرداخت دیگر معلق نیست', pendingQtyOf(pending, ret.id), 0)
  eq('درخواستِ پرداخت‌شده از جمع مبالغ باز خارج شد', beforeSum.pendingAmount - pending.pendingAmount, UNIT * 2)
  const payLog = auditRows(AuditAction.CARD_TRANSFER_PAID, requestId)
  ok('AuditLog اعلام مدیر نتیجهٔ بانک را UNKNOWN ثبت می‌کند',
    JSON.parse(payLog.at(-1)?.after ?? '{}').bankEvidenceState === 'UNKNOWN_BANK')
  eq('AuditLog تعداد کالایی را که پرداخت مدیر آزاد کرد ثبت می‌کند',
    JSON.parse(payLog.at(-1)?.after ?? '{}').releasedQty, 2)
  eq('رویداد آزادسازی به همان سند برگشت ثبت شد',
    seed.count('AuditLog', 'action = ? AND entity = ? AND entityId = ?',
      AuditAction.CARD_TRANSFER_RESTOCK, 'SaleReturn', ret.id), 1)

  await throwsWith('پرداخت دوبارهٔ همان درخواست رد می‌شود',
    () => cardTransferService.pay({ id: requestId, managerPassword: PW, userId }), 'قبلاً پرداخت شده')
  await throwsWith('دریافت فیزیکی بعد از آزادسازی کامل راه دوباره‌افزودن کالا نیست',
    () => returnGoodsService.receive({ returnId: ret.id,
      returnItemId: seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=?', ret.id).id,
      qty: 2, eventKey: 'session40-after-manager-payment-duplicate', witnessKind: 'SELECTED_CONFIRMED',
      witnessRef: 'رسید تکراری', physicalConfirmed: true, actorUserId: userId }), 'تغییر کرده')
  eq('تلاش دوم موجودی را دوباره زیاد نکرد', stockOf(variantId), stockAfterSale + 2)
  eq('درخواست مقدار آزادشدهٔ مدیر را نگه داشت', requestRow(requestId).stockReleasedQty, 2)
  eq('تطبیق بانکی همچنان مستقل از پرداخت مدیر است', (await viewReturnEntitlement(ret.id)).cashReserved, UNIT * 2)
  eq('تأیید پرداخت هیچ گردش نقدی نساخت',
    seed.count('CashMovement', 'refType = ? AND refId = ?', 'SaleReturn', ret.id), 0)
}

// ===========================================================================
section('بند ۴ · آزادسازی یکجای قدیمی برای پروندهٔ جدید مسدود؛ رسید کالا idempotent')
// ===========================================================================
{
  const shiftId = makeShift('نشست دریافت تکرارناپذیر')
  const variantId = makeVariant(50, 'سایز ۴۰')
  const inv = await paidSale(shiftId, variantId, 1)
  const base = stockOf(variantId)
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 1 }], UNIT)

  await throwsWith('سرویس قدیمی نمی‌تواند دفتر حق جدید را دور بزند',
    () => pendingRestockService.releaseReturnStock(db, {
      returnId: ret.id, userId, reason: 'تلاش آزادسازی بدون شاهد'
    }), 'فقط با تأیید پرداخت مدیر')
  eq('تلاش قدیمی، هیچ موجودی‌ای نساخت', stockOf(variantId), base)
  eq('سند همچنان معلق است', returnRow(ret.id).restockPending, 1)
  const itemId = seed.one('SELECT id FROM "SaleReturnItem" WHERE returnId=?', ret.id).id
  await throwsWith('رسید فیزیکی مسیر آزادسازی برگشت C2C نیست',
    () => returnGoodsService.receive({ returnId: ret.id, returnItemId: itemId,
      qty: 1, eventKey: `session40-c2c-receipt-${ret.id}`, witnessKind: 'SELECTED_CONFIRMED',
      witnessRef: 'کالای تحویل‌شده', physicalConfirmed: true, actorUserId: userId }),
    'کارت‌به‌کارت فقط با تأیید پرداخت مدیر')
  eq('رسید فیزیکی برای C2C ساخته نشد', seed.count('ReturnGoodsReceipt', 'returnId = ?', ret.id), 0)
  eq('پیش از تأیید مدیر موجودی هنوز معلق است', stockOf(variantId), base)
  const paid = await cardTransferService.pay({ id: ret.cardTransfer.id, managerPassword: PW, userId })
  eq('پرداخت مدیر تمام کالای همین درخواست را آزاد کرد', paid.releasedQty, 1)
  eq('کالا پس از پرداخت همان لحظه وارد موجودی شد', stockOf(variantId), base + 1)
  await throwsWith('پرداخت دوباره موجودی را دو بار زیاد نمی‌کند',
    () => cardTransferService.pay({ id: ret.cardTransfer.id, managerPassword: PW, userId }), 'قبلاً پرداخت شده')
  eq('درخواست تکراری موجودی بیشتری نساخت', stockOf(variantId), base + 1)

  await throwsWith('سند ناموجود در مسیر قدیمی بی‌صدا آزاد نمی‌شود',
    () => pendingRestockService.releaseReturnStock(db, { returnId: 999_999, userId, reason: 'سند ناموجود' }),
    'پیدا نشد')
  const zero = await pendingRestockService.releaseReturnStock(db, { returnId: 0, userId, reason: 'شناسه‌ی خالی' })
  eq('شناسه‌ی خالی هیچ کاری نمی‌کند', zero.releasedQty, 0)
  eq('و alreadyDone برمی‌گرداند', zero.alreadyDone, true)

  // شبیه‌سازی افزایشیِ یک سند تاریخی: درخواست و برگشت واقعاً وجود دارند ولی
  // ReturnEntitlement تازه برای دادهٔ قدیمی جعل نشده است. هیچ سندی حذف نمی‌شود.
  const oldShift = makeShift('نشست پروندهٔ تاریخی')
  const oldVariant = makeVariant(10, 'معلق قدیمی')
  const oldSale = await paidSale(oldShift, oldVariant, 1)
  const afterOldSale = stockOf(oldVariant)
  const oldReturnId = seed.insert('SaleReturn', {
    invoiceId: oldSale.id, total: UNIT, returnedAt: Date.now(),
    returnedAtJalali: toJalaliDate(new Date()), userId, shiftId: oldShift,
    refundMethod: RefundMethod.CARD_TO_CARD, refundAmount: UNIT, restockPending: true,
    // Policy cap exists on this legacy-shaped row, but its separate entitlement ledger is absent.
    creditReturnPolicyVersion: 1, realMoneyRefundAmount: UNIT
  })
  seed.insert('SaleReturnItem', {
    returnId: oldReturnId, saleItemId: oldSale.items[0].id,
    variantId: oldVariant, qty: 1, unitPrice: UNIT, lineTotal: UNIT, restockedQty: 0
  })
  const oldRequestId = seed.insert('CardTransferRequest', {
    returnId: oldReturnId, kind: 'REQUEST', status: CardTransferStatus.PENDING,
    // ردیف تاریخیِ قدیمی operationKind نداشت؛ هنوز به برگشت معتبر خودش متصل است.
    sourceInvoiceId: oldSale.id, sourceReceiptNo: oldSale.receiptNo,
    amount: UNIT, returnTotal: UNIT, invoiceTotal: UNIT, userId, shiftId: oldShift
  })
  eq('دادهٔ تاریخی دفتر حقِ ساختگی ندارد', seed.count('ReturnEntitlement', 'returnId = ?', oldReturnId), 0)
  eq('فقط معلقِ قدیمی در انتظار فیزیکی شمارش می‌شود',
    (await pendingRestockService.byVariant())[oldVariant], 1)
  const oldPaid = await cardTransferService.pay({ id: oldRequestId, managerPassword: PW, userId })
  eq('مسیر تاریخی به شرط رمز، همان یک کالا را آزاد کرد', oldPaid.releasedQty, 1)
  eq('موجودی قدیمی تنها یک واحد برگشت', stockOf(oldVariant), afterOldSale + 1)
  eq('درخواست تاریخی تعداد آزادشده را حفظ کرد', requestRow(oldRequestId).stockReleasedQty, 1)
  eq('پروندهٔ جدید همچنان از همین تابع عبور نمی‌کند', stockOf(variantId), base + 1)
}

// ===========================================================================
section('بند ۵ · برگشت نقدی در همان تراکنش کالا را به موجودی برمی‌گرداند')
// ===========================================================================
{
  const shiftId = makeShift('نشست برگشت نقدی')
  const variantId = makeVariant(30, 'سایز ۴۲')
  const inv = await paidSale(shiftId, variantId, 2)
  const base = stockOf(variantId)
  const before = await summary()

  const ret = await salesService.createReturn({
    invoiceId: inv.id,
    full: false,
    lines: [{ saleItemId: inv.items[0].id, qty: 1 }],
    refundMethod: RefundMethod.CASH,
    refundAmount: UNIT,
    userId
  })
  eq('برگشت نقدی معلق نمی‌شود', ret.restockPending, false)
  eq('کالا همان لحظه به انبار برگشت', stockOf(variantId), base + 1)
  eq('restockedQty برابر qty ثبت شد', returnItems(ret.id)[0].restockedQty, 1)
  eq('درخواست کارت‌به‌کارتی ساخته نشد', ret.cardTransfer, null)
  const s = await summary()
  eq('در فهرست معلق‌ها نیامد', pendingQtyOf(s, ret.id), 0)
  eq('جمع معلق‌ها دست‌نخورده ماند', s.totalQty, before.totalQty)

  const exp = await cashboxService.expected({ shiftId })
  eq('بازپرداخت نقدی از نقد مورد انتظار کم شد (رفتار قبلی)', exp.expectedCash, UNIT * 2 - UNIT)
}

// ===========================================================================
section('بند ۶ · تعویض با مابه‌التفاوت کارت‌به‌کارت')
// ===========================================================================
{
  const shiftId = makeShift('نشست تعویض کارت‌به‌کارت')
  const backVariant = makeVariant(20, 'برگشتی ۴۴')
  const repVariant = makeVariant(20, 'جایگزین ارزان')
  sql.prepare('UPDATE "ProductVariant" SET salePrice = ? WHERE id = ?').run(UNIT / 2, repVariant)

  const inv = await paidSale(shiftId, backVariant, 2)
  const backBase = stockOf(backVariant)
  const repBase = stockOf(repVariant)

  const ex = await salesService.createExchange({
    invoiceId: inv.id,
    lines: [{ saleItemId: inv.items[0].id, qty: 2 }],
    replacements: [{ variantId: repVariant, qty: 1 }],
    refundMode: 'CARD_TO_CARD',
    userId
  })

  eq('مابه‌التفاوت به نفع مشتری است', ex.diff, UNIT / 2 - UNIT * 2)
  eq('تعهد کارت‌به‌کارت ساخته شد', ex.cardToCard, UNIT * 2 - UNIT / 2)
  eq('کالای برگشتی معلق ماند', ex.restockPending, true)
  eq('تعداد معلق سند تعویض', ex.pendingRestockQty, 2)
  eq('کالای برگشتی به موجودی قابل‌فروش اضافه نشد', stockOf(backVariant), backBase)
  eq('کالای جایگزین همان لحظه از انبار کم شد (نباید عوض شود)', stockOf(repVariant), repBase - 1)

  const s = await summary()
  eq('معلق تعویض در تابع مشترک دیده شد', pendingQtyOf(s, ex.returnId), 2)
  eq('نوع عملیاتِ ردیف معلق EXCHANGE است', s.items.find((i) => i.returnId === ex.returnId).operationKind, 'EXCHANGE')
  ok(
    'stockNote می‌گوید جایگزین کم شد ولی برگشتی معلق است',
    (requestRow(ex.cardTransfer.id).stockNote ?? '').includes('جایگزین همان لحظه از انبار کم شد'),
    requestRow(ex.cardTransfer.id).stockNote
  )

  const exList = await salesService.exchangeList({ shiftId })
  const exRow = exList.rows.find((r) => r.returnId === ex.returnId)
  ok('تب تعویض این سند را می‌بیند', !!exRow, 'ردیف تعویض پیدا نشد')

  // تأیید پرداخت مدیر، برگشتی همین تعویض را آزاد می‌کند؛ جایگزین از قبل کسر شده بود.
  const paid = await cardTransferService.pay({ id: ex.cardTransfer.id, managerPassword: PW, userId })
  eq('پرداخت مدیر دو کالای برگشتی را آزاد کرد', paid.releasedQty, 2)
  eq('برگشتی همان لحظه به موجودی برگشت', stockOf(backVariant), backBase + 2)
  eq('جایگزین با پرداخت مدیر تغییر نکرد', stockOf(repVariant), repBase - 1)
  eq('معلقِ سند تعویض پس از پرداخت صفر شد', pendingQtyOf(await summary(), ex.returnId), 0)
  eq('تطبیق بانکی تعویض همچنان مستقل است', (await viewReturnEntitlement(ex.returnId)).state, 'UNKNOWN_BANK')
  ok('یادداشت درخواست، کسر جایگزین و برگشت همان اقلام را ثبت می‌کند',
    requestRow(ex.cardTransfer.id).stockNote.includes('کالای جایگزین طبق سند تعویض از موجودی کسر شد') &&
      requestRow(ex.cardTransfer.id).stockNote.includes('تأیید پرداخت مدیر'))
  await throwsWith('دریافت فیزیکی پس از پرداخت دوباره کالا اضافه نمی‌کند',
    () => receiveGoods(ex.returnId, 2, 'exchange-after-payment'), 'تغییر کرده')
  eq('آزمون رسید دوم موجودی را دوباره زیاد نکرد', stockOf(backVariant), backBase + 2)
  eq('جایگزین پس از رسید دوم هم بدون تغییر ماند', stockOf(repVariant), repBase - 1)
  const s2 = await summary()
  eq('معلقِ سند تعویض بعد از پرداخت صفر شد', pendingQtyOf(s2, ex.returnId), 0)
}

// ===========================================================================
section('بند ۷ · fixture تعویض تاریخی با مابه‌التفاوت مثبت ⇒ آزادسازی قدیمی حفظ شود')
// ===========================================================================
{
  const shiftId = makeShift('نشست تعویض بی‌بدهی')
  const backVariant = makeVariant(20, 'برگشتی ارزان')
  const repVariant = makeVariant(20, 'جایگزین گران')
  sql.prepare('UPDATE "ProductVariant" SET salePrice = ? WHERE id = ?').run(UNIT * 2, repVariant)

  const inv = await paidSale(shiftId, backVariant, 1)
  const backBase = stockOf(backVariant)
  const repBase = stockOf(repVariant)
  const before = await summary()

  const ex = await salesService.createExchange({
    invoiceId: inv.id,
    lines: [{ saleItemId: inv.items[0].id, qty: 1 }],
    replacements: [{ variantId: repVariant, qty: 1 }],
    refundMode: 'CARD_TO_CARD',
    methodId: METHOD.cash,
    userId
  }, { goodsReceiptRequired: false })

  ok('مابه‌التفاوت به نفع فروشگاه است', ex.diff > 0, String(ex.diff))
  eq('هیچ تعهد کارت‌به‌کارتی ساخته نشد', ex.cardToCard, 0)
  eq('درخواست پرداخت مدیر ساخته نشد', ex.cardTransfer, null)
  eq('کالای برگشتی همان لحظه آزاد شد (نه معلقِ همیشگی)', stockOf(backVariant), backBase + 1)
  eq('پرچم معلق روی پاسخ برداشته شد', ex.restockPending, false)
  eq('تعداد معلق صفر برگشت', ex.pendingRestockQty, 0)
  eq('پرچم معلق روی رکورد هم برداشته شد', returnRow(ex.returnId).restockPending, 0)
  eq('کالای جایگزین از انبار کم شد', stockOf(repVariant), repBase - 1)
  const s = await summary()
  eq('هیچ معلقی جا نماند', s.totalQty, before.totalQty)
}

// ===========================================================================
section('بند ۸ · رد/لغو درخواست: با و بدون آزادسازی کالا')
// ===========================================================================
{
  // ---- ۸-الف: لغو بدون آزادسازی ⇒ کالا معلق و «نیازمند رسیدگی» ----
  const shiftA = makeShift('نشست لغو بی‌آزادسازی')
  const vA = makeVariant(20, 'سایز ۴۶')
  const invA = await paidSale(shiftA, vA, 1)
  const baseA = stockOf(vA)
  const retA = await cardToCardReturn(invA.id, [{ saleItemId: invA.items[0].id, qty: 1 }], UNIT)

  await throwsWith(
    'لغو بدون دلیل رد می‌شود (سابقه باید خودگویا باشد)',
    () => cardTransferService.cancel({ id: retA.cardTransfer.id, reason: '  ', managerPassword: PW, userId }),
    'دلیل'
  )

  const canceled = await cardTransferService.cancel({
    id: retA.cardTransfer.id,
    reason: 'مدیر پرداخت را نپذیرفت',
    managerPassword: PW,
    userId
  })
  eq('وضعیت لغو شد', canceled.status, CardTransferStatus.CANCELED)
  eq('رکورد حذف/بازنویسی نشد (دلیل ثبت شد)', requestRow(retA.cardTransfer.id).cancelReason, 'مدیر پرداخت را نپذیرفت')
  eq('لغو به‌خودی‌خود کالا را برنگرداند', stockOf(vA), baseA)
  eq('و پاسخ صریح گفت کالا معلق مانده', canceled.stillPending, true)
  const sA = await summary()
  eq('کالا هنوز در فهرست معلق‌هاست', pendingQtyOf(sA, retA.id), 1)
  ok('ردیفِ «نیازمند رسیدگی» ساخته شد', sA.needsAttentionQty >= 1, String(sA.needsAttentionQty))
  eq('ردیف معلق برچسب رد/لغو خورد', sA.items.find((i) => i.returnId === retA.id).canceled, true)
  eq('مبلغِ درخواستِ لغوشده دیگر «در انتظار پرداخت» شمرده نمی‌شود', sA.items.find((i) => i.returnId === retA.id).requestId, retA.cardTransfer.id)
  ok(
    'stockNote لغو بانکی را از رسید فیزیکی جدا می‌کند',
    (requestRow(retA.cardTransfer.id).stockNote ?? '').includes('لغو درخواست نه پرداخت بانک را ثابت می‌کند') &&
      (requestRow(retA.cardTransfer.id).stockNote ?? '').includes('کالای برگشتی هنوز معلق است'),
    requestRow(retA.cardTransfer.id).stockNote
  )
  eq('لغوِ بدون شاهد، حق نقدی را UNKNOWN نگه می‌دارد', (await viewReturnEntitlement(retA.id)).state, 'UNKNOWN_BANK')

  // ---- ۸-ب: لغو C2C، حتی با releaseStock یا دریافت فیزیکی، موجودی را آزاد نمی‌کند ----
  await throwsWith('لغو با پرچم آزادسازی نمی‌تواند قاعدهٔ پرداخت مدیر را دور بزند',
    () => cardTransferService.cancel({ id: retA.cardTransfer.id,
      reason: 'تلاش آزادسازی کالای C2C', releaseStock: true, managerPassword: PW, userId }),
    'فقط تأیید پرداخت مدیر')
  await throwsWith('رسید فیزیکی جداگانه پس از لغو هم مسیر C2C را دور نمی‌زند',
    () => receiveGoods(retA.id, 1, 'after-cancel'), 'کارت‌به‌کارت فقط با تأیید پرداخت مدیر')
  eq('لغو و رسید جداگانه، موجودی را تغییر ندادند', stockOf(vA), baseA)
  eq('رسید جداگانه‌ای ثبت نشد', seed.count('ReturnGoodsReceipt', 'returnId = ?', retA.id), 0)
  eq('پرچم معلق باقی ماند', returnRow(retA.id).restockPending, 1)
  const sB = await summary()
  eq('پس از لغو همچنان در فهرست معلق‌هاست', pendingQtyOf(sB, retA.id), 1)
  eq('لغو و رسید، بانکِ نامعلوم را قطعی نکردند', (await viewReturnEntitlement(retA.id)).state, 'UNKNOWN_BANK')

  await throwsWith(
    'درخواست پرداخت‌شده لغو نمی‌شود',
    async () => {
      const shiftC = makeShift('نشست لغو بعد از پرداخت')
      const vC = makeVariant(10, 'سایز ۴۸')
      const invC = await paidSale(shiftC, vC, 1)
      const retC = await cardToCardReturn(invC.id, [{ saleItemId: invC.items[0].id, qty: 1 }], UNIT)
      await cardTransferService.pay({ id: retC.cardTransfer.id, managerPassword: PW, userId })
      await cardTransferService.cancel({ id: retC.cardTransfer.id, reason: 'تلاش برای لغو', managerPassword: PW, userId })
    },
    'بدون تطبیق بانک'
  )
}

// ===========================================================================
section('بند ۹ · حذف برگشتِ معلق ⇒ بی‌حرکت انباری، درخواست لغو می‌شود')
// ===========================================================================
{
  const shiftId = makeShift('نشست حذف برگشت معلق')
  const variantId = makeVariant(20, 'سایز ۵۰')
  const inv = await paidSale(shiftId, variantId, 2)
  const base = stockOf(variantId)
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 2 }], UNIT * 2)
  eq('پیش‌فرض: کالا معلق است', stockOf(variantId), base)

  // نشست ۶۴ · بند ۴-۲۲ — «حذف» = ابطال با دلیل؛ سند با مهر باطل می‌ماند
  const del = await salesService.returnDelete({
    id: ret.id, userId, reason: 'ثبت اشتباه برگشت', panelPassword: PW,
    overrideReason: 'ابطال مشروط برگشت قبل از اعلام بانک و دریافت کالا'
  })
  eq('حذف، هیچ چیزی از انبار کم نکرد (دو بار کم/اضافه نشد)', stockOf(variantId), base)
  eq('تعداد برگشت‌خورده‌ی گزارش حذف صفر است', del.reversedQty, 0)
  eq('سند برگشت باطل شد (نه حذف فیزیکی)', returnRow(ret.id)?.voidedAt != null, true)
  eq('درخواست بی‌مرجع، لغو شد (رکورد مالی حذف نشد)', requestRow(ret.cardTransfer.id).status, CardTransferStatus.CANCELED)
  ok(
    'دلیل لغو، ابطال سند مرجع را می‌گوید',
    (requestRow(ret.cardTransfer.id).cancelReason ?? '').includes('باطل'),
    requestRow(ret.cardTransfer.id).cancelReason
  )
  const s = await summary()
  eq('هیچ معلقی از این سند نماند', s.byVariant[variantId] ?? 0, 0)
}

// ===========================================================================
section('بند ۱۰ · ویرایش برگشتِ معلق ⇒ درِ پشتی بسته است')
// ===========================================================================
{
  const shiftId = makeShift('نشست ویرایش برگشت معلق')
  const variantId = makeVariant(20, 'سایز ۵۲')
  const inv = await paidSale(shiftId, variantId, 3)
  const base = stockOf(variantId)
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 3 }], UNIT * 3)

  const upd = await salesService.returnUpdate({
    id: ret.id,
    lines: [{ saleItemId: inv.items[0].id, qty: 1 }],
    panelPassword: PW,
    overrideReason: 'اصلاح مقدار درخواستِ باز قبل از اعلام یا دریافت',
    userId
  })
  eq('مبلغ سند اصلاح شد', upd.total, UNIT)
  eq('ویرایش هیچ کالایی به موجودی قابل‌فروش برنگرداند', stockOf(variantId), base)
  eq('هیچ حرکت انباری ساخته نشد', movementsOf(ret.id).length, 0)
  eq('restockedQty اقلامِ تازه هم صفر است', returnItems(ret.id).every((i) => i.restockedQty === 0), true)
  eq('سند همچنان معلق است', returnRow(ret.id).restockPending, 1)
  const s = await summary()
  eq('معلق با تعداد جدید حساب شد', pendingQtyOf(s, ret.id), 1)

  eq('حق نقدیِ باز همراه با ویرایش مقدار اصلاح شد', (await viewReturnEntitlement(ret.id)).cashReserved, UNIT)
  // پرداخت مدیر آزادسازی می‌کند، اما فقط تعداد نهاییِ پس از ویرایش.
  const paid = await cardTransferService.pay({ id: ret.cardTransfer.id, managerPassword: PW, userId })
  eq('تأیید پرداخت فقط یک قلمِ نهایی را آزاد کرد', paid.releasedQty, 1)
  eq('موجودی یک عدد بالا رفت، نه سه عدد اولیه', stockOf(variantId), base + 1)
  eq('ویرایش مقدار با پرداخت مدیر هم معلق نماند', returnRow(ret.id).restockPending, 0)
  await throwsWith('دریافت فیزیکی دوباره همان قلم را اضافه نمی‌کند',
    () => receiveGoods(ret.id, 1, 'edited-qty-after-manager-payment'), 'تغییر کرده')
  eq('تلاش دوباره پس از پرداخت موجودی را تغییر نداد', stockOf(variantId), base + 1)
}

// ===========================================================================
section('بند ۱۱ · انبارگردانی: C2C تا پرداخت مدیر وارد موجودی فروش‌پذیر نمی‌شود')
// ===========================================================================
{
  const shiftId = makeShift('نشست انبارگردانی معلق')
  const variantId = makeVariant(10, 'شلوار انبارگردانی')
  const inv = await paidSale(shiftId, variantId, 2)
  const sellable = stockOf(variantId) // ۸
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 2 }], UNIT * 2)
  eq('موجودی قابل‌فروش هنوز هشت است', stockOf(variantId), sellable)
  const pendingBeforeCount = await summary()
  eq('هشدار کالای دریافت‌نشده برقرار است', pendingQtyOf(pendingBeforeCount, ret.id), 2)
  eq('دو کالای C2C پرداخت‌نشده در انتظار موجودی فیزیکی لحاظ نمی‌شوند',
    pendingBeforeCount.physicalByVariant[variantId] ?? 0, 0)

  // اگر شمارش قفسه دو کالای C2C را پیش از تأیید پرداخت اضافه کند، سیستم آن را
  // «اضافه»ی نیازمند بررسی نشان می‌دهد؛ نباید موجودی فروش‌پذیر را حدس بزند.
  const submitted = await stockCountService.submit({
    items: [{ variantId, countedQty: sellable + 2 }], userId, userName: 'مدیر تست کار ب'
  })
  eq('snapshot فقط کالای قابل‌فروش و معلقِ تاریخی را می‌شمارد', submitted.pendingRestockQty, 0)
  eq('افزودن دو کالای پرداخت‌نشده به شمارش مغایرت می‌سازد', submitted.mismatchedCount, 1)
  const item = seed.one('SELECT * FROM "StockCountItem" WHERE sessionId = ?', submitted.id)
  eq('ستون خام diffQty دست‌نخورده ماند', item.diffQty, 2)
  eq('snapshot این شمارش کالای ندیده را به موجودی اضافه نکرد', item.pendingRestockQty, 0)

  const list = await stockCountService.list({})
  const lrow = list.find((r) => r.id === submitted.id)
  eq('فهرست شمارش‌ها همان یک مغایرت را نشان می‌دهد', lrow.mismatchedCount, 1)
  eq('و تعداد C2C پرداخت‌نشده را به فروش‌پذیر اضافه نمی‌کند', lrow.pendingRestockQty, 0)
  const disc = await stockCountService.discrepancy({})
  const drow = disc.rows.find((r) => r.variantId === variantId)
  eq('گزارش مغایرت فقط معلقِ فیزیکیِ قدیمی را جمع می‌کند', drow.pendingRestockQty, 0)
  eq('فیزیکی مورد انتظار بدون شاهد، فقط قابل‌فروش است', drow.expectedPhysicalQty, sellable)
  eq('دو کالای اضافی برای بررسی باقی می‌ماند', drow.diffAtCountWithPending, 2)
  eq('diff خام با تفاضل فیزیکی یکسان است', drow.diffAtCount, 2)
  eq('این ردیف نیازمند بررسی علامت خورد', drow.needsReview, true)
  eq('بدون شاهد، معلقِ فیزیکی علامت نمی‌خورد', drow.hasPending, false)
  eq('معلق زندهٔ فیزیکیِ قدیمی از پروندهٔ جدید جداست',
    disc.pendingRestockQty, Object.values((await summary()).physicalByVariant ?? {}).reduce((n, q) => n + q, 0))

  const correct = await stockCountService.submit({ items: [{ variantId, countedQty: sellable }], userId })
  eq('شمارش واقعی بدون کالای دریافت‌نشده مغایرت ندارد', correct.mismatchedCount, 0)
  const shift2 = makeShift('نشست ردیف معلق جدیدِ بی‌شمارش')
  const v2 = makeVariant(10, 'کالای بی‌شمارش')
  const inv2 = await paidSale(shift2, v2, 1)
  const ret2 = await cardToCardReturn(inv2.id, [{ saleItemId: inv2.items[0].id, qty: 1 }], UNIT)
  const disc2 = await stockCountService.discrepancy({ onlyMismatched: true })
  eq('کالای بی‌شمارشِ جدید، حضور فیزیکیِ خیالی به گزارش مغایرت نمی‌افزاید',
    disc2.rows.some((r) => r.variantId === v2), false)
  eq('اما کالای بی‌شاهد در هشدارِ معلق پنهان نمی‌شود', pendingQtyOf(await summary(), ret2.id), 1)

  // snapshot تاریخیِ شمارش پس از آزادسازی مدیر ثابت می‌ماند؛ دریافت دوباره رد می‌شود.
  await cardTransferService.pay({ id: ret.cardTransfer.id, managerPassword: PW, userId })
  eq('تأیید پرداخت مدیر نتیجهٔ شمارش ثبت‌شده را تغییر نداد',
    seed.one('SELECT pendingRestockQty FROM "StockCountItem" WHERE sessionId = ?', submitted.id).pendingRestockQty, 0)
  await throwsWith('رسید پس از آزادسازی مدیر نمی‌تواند موجودی را دوباره زیاد کند',
    () => receiveGoods(ret.id, 2, 'stocktake-after-count'), 'تغییر کرده')
  eq('تلاش رسید تکراری snapshot ثبت‌شده را بازنویسی نکرد',
    seed.one('SELECT pendingRestockQty FROM "StockCountItem" WHERE sessionId = ?', submitted.id).pendingRestockQty, 0)
  await throwsWith('لغو با آزادسازی ضمنی برای کالای ندیده رد می‌شود',
    () => cardTransferService.cancel({ id: ret2.cardTransfer.id,
      reason: 'پایان سناریو انبارگردانی', releaseStock: true, managerPassword: PW, userId }),
    'فقط تأیید پرداخت مدیر')
  eq('رد آزادسازی بدون پرداخت، معلق C2C را حفظ کرد', pendingQtyOf(await summary(), ret2.id), 1)
}

// ===========================================================================
section('بند ۱۲ · معلق‌ها و پول: هیچ اثری روی صندوق و سرجمع فروش ندارند')
// ===========================================================================
{
  const shiftId = makeShift('نشست مالیِ معلق')
  const variantId = makeVariant(20, 'سایز ۵۴')
  const inv = await paidSale(shiftId, variantId, 2)
  const before = await cashboxService.expected({ shiftId, countedCash: UNIT * 2 })
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 1 }], UNIT)
  const after = await cashboxService.expected({ shiftId, countedCash: UNIT * 2 })

  eq('نقد مورد انتظار عوض نشد (پولی از کشو بیرون نرفت)', after.expectedCash, before.expectedCash)
  eq('کسری/اضافی عوض نشد', after.cashDifference, before.cashDifference)
  eq('ردیف «دریافتی به حساب مدیرِ» کار الف صفر ماند (دو مفهوم جدا)', after.managerAccountReceived, 0)
  eq('انتظار کارتخوان عوض نشد', after.components.cardExpected, before.components.cardExpected)

  const outOf = await cardTransferService.outOfSales({})
  ok('کارت‌به‌کارت در بلوک «خارج از فروش» دیده می‌شود', outOf.rows.some((r) => r.returnId === ret.id))
  ok('و متنش می‌گوید در سرجمع فروش نمی‌آید', outOf.note.includes('سرجمع فروش'))

  // پرداخت مدیر، کالای همان C2C را آزاد می‌کند ولی هیچ پولی به صندوق اضافه/کم نمی‌کند.
  const stockBeforePayment = stockOf(variantId)
  const paid = await cardTransferService.pay({ id: ret.cardTransfer.id, managerPassword: PW, userId })
  eq('پرداخت مدیر کالای برگشتی همان سند را برگرداند', paid.releasedQty, 1)
  eq('موجودی دقیقاً یک عدد برگشتی بالا رفت', stockOf(variantId), stockBeforePayment + 1)
  const paidView = await cashboxService.expected({ shiftId, countedCash: UNIT * 2 })
  eq('بعد از پرداخت مدیر هم نقد مورد انتظار همان است', paidView.expectedCash, before.expectedCash)
  eq('و کسری/اضافی همان', paidView.cashDifference, before.cashDifference)
}

// ===========================================================================
section('بند ۱۳ · برگشت فوری و فاکتور بدون کسر موجودی معلق کاذب نمی‌سازند')
// ===========================================================================
{
  const shiftId = makeShift('نشست داده‌ی قدیمی')
  const variantId = makeVariant(20, 'سایز قدیمی')
  const inv = await paidSale(shiftId, variantId, 2)
  const base = stockOf(variantId)

  // برگشت نقدی فوری: restockedQty = qty، مثل دادهٔ پیش از جلسهٔ ۴۰.
  const legacy = await salesService.createReturn({
    invoiceId: inv.id,
    full: false,
    lines: [{ saleItemId: inv.items[0].id, qty: 1 }],
    refundMethod: RefundMethod.CASH,
    refundAmount: UNIT,
    userId
  }, { goodsReceiptRequired: false })
  eq('برگشت نقدی فوری پرچم معلق ندارد', returnRow(legacy.id).restockPending, 0)
  const s = await summary()
  eq('و در هیچ شکلی معلق شمرده نمی‌شود', pendingQtyOf(s, legacy.id), 0)
  eq('موجودی هم همان لحظه برگشته بود', stockOf(variantId), base + 1)

  // فاکتور بدون کسر موجودی: `restockedQty = 0` ولی معلق نیست (تله‌ی تعریف)
  const wholesale = await salesService.create({
    userId,
    shiftId,
    deductInventory: false,
    lines: [{ variantId, qty: 1, unitPrice: UNIT, discount: 0, tax: 0 }],
    payments: [{ methodId: METHOD.cash, amount: UNIT }]
  })
  const wItems = itemsOf(wholesale.id)
  const stockBefore = stockOf(variantId)
  const noDeduct = await salesService.createReturn({
    invoiceId: wholesale.id,
    full: false,
    lines: [{ saleItemId: wItems[0].id, qty: 1 }],
    refundMethod: RefundMethod.CARD_TO_CARD,
    refundAmount: UNIT,
    userId
  })
  eq('فاکتور بدون کسر موجودی هیچ‌وقت معلق نمی‌شود', noDeduct.restockPending, false)
  eq('restockedQty صفر است ولی معنایش «کالایی در کار نیست» است', returnItems(noDeduct.id)[0].restockedQty, 0)
  eq('موجودی انبار دست‌نخورده ماند', stockOf(variantId), stockBefore)
  const s2 = await summary()
  eq('و در فهرست معلق‌ها نیامد (کسری کاذب انبارگردانی ساخته نشد)', pendingQtyOf(s2, noDeduct.id), 0)
}

// ===========================================================================
section('بند ۱۴ · یادآوری بر اساس سن درخواست')
// ===========================================================================
{
  const shiftId = makeShift('نشست سن درخواست')
  const variantId = makeVariant(20, 'سایز کهنه')
  const inv = await paidSale(shiftId, variantId, 1)
  const ret = await cardToCardReturn(inv.id, [{ saleItemId: inv.items[0].id, qty: 1 }], UNIT)

  const fresh = await summary()
  eq('درخواست تازه سنش صفر است', fresh.items.find((i) => i.returnId === ret.id).ageDays, 0)

  const nineDaysAgo = Date.now() - 9 * 86_400_000
  sql.prepare('UPDATE "CardTransferRequest" SET createdAt = ? WHERE id = ?').run(nineDaysAgo, ret.cardTransfer.id)

  const aged = await summary()
  eq('سن درخواست از روی تاریخ ثبت حساب شد', aged.items.find((i) => i.returnId === ret.id).ageDays, 9)
  eq('قدیمی‌ترین سنِ خلاصه هم به‌روز شد', aged.oldestAgeDays, 9)
  eq('تُنِ هشدار به «alert» رسید', pendingRestockTone(aged.oldestAgeDays, aged.totalQty), 'alert')
  ok(
    'هشدار بستن شیفت عقب‌افتادگی را می‌گوید',
    (pendingRestockShiftWarning(aged, faDigits) ?? '').includes('عقب افتاده'),
    pendingRestockShiftWarning(aged, faDigits)
  )
  ok(
    'خلاصه‌ی بالای صفحه‌ها سن قدیمی‌ترین را می‌گوید',
    (pendingRestockHeadline(aged, faDigits, faDigits) ?? '').includes('قدیمی‌ترین درخواست'),
    pendingRestockHeadline(aged, faDigits, faDigits)
  )
  ok('ردیف‌ها از قدیمی‌ترین مرتب شده‌اند', aged.items[0].returnId === ret.id, String(aged.items[0]?.returnId))
}

// ===========================================================================
section('بند ۱۵ · درخواست C2C نامرتبط نمی‌تواند کالای برگشت دیگری را آزاد کند')
// ===========================================================================
{
  const shiftId = makeShift('نشست جلوگیری از پرداخت نامرتبط')
  const targetVariant = makeVariant(10, 'برگشت هدف')
  const otherVariant = makeVariant(10, 'درخواست دیگر')
  const targetInvoice = await paidSale(shiftId, targetVariant, 1)
  const otherInvoice = await paidSale(shiftId, otherVariant, 1)
  const target = await cardToCardReturn(targetInvoice.id, [{ saleItemId: targetInvoice.items[0].id, qty: 1 }], UNIT)
  const other = await cardToCardReturn(otherInvoice.id, [{ saleItemId: otherInvoice.items[0].id, qty: 1 }], UNIT)
  const targetStock = stockOf(targetVariant)
  const otherStock = stockOf(otherVariant)

  await throwsWith('پرداخت C2Cِ سند دیگر، برای آزادسازی این برگشت پذیرفته نمی‌شود',
    () => pendingRestockService.releaseReturnStock(db, {
      returnId: target.id, managerPaymentRequestId: other.cardTransfer.id,
      requestId: other.cardTransfer.id, userId, reason: 'درخواست نامرتبط'
    }), 'متصل به همین برگشت/تعویض')
  eq('برگشت هدف پس از رد درخواست نامرتبط همچنان معلق است', returnRow(target.id).restockPending, 1)
  eq('موجودی هدف با پرداخت نامرتبط تغییر نکرد', stockOf(targetVariant), targetStock)
  eq('موجودی سند دیگر هم با تلاش ردشده تغییر نکرد', stockOf(otherVariant), otherStock)
  eq('درخواست نامرتبط هنوز پرداخت نشده است', requestRow(other.cardTransfer.id).status, CardTransferStatus.PENDING)

  // حتی اگر یک ردیف پرداخت به اشتباه به برگشت غیر C2C وصل شده باشد، مجوز پرداخت مدیر کافی نیست.
  const nonC2CVariant = makeVariant(10, 'برگشت غیر C2C')
  const nonC2CInvoice = await paidSale(shiftId, nonC2CVariant, 1)
  const nonC2CReturnId = seed.insert('SaleReturn', {
    invoiceId: nonC2CInvoice.id, total: UNIT, returnedAt: Date.now(),
    returnedAtJalali: toJalaliDate(new Date()), userId, shiftId,
    kind: 'RETURN', refundMethod: RefundMethod.CASH, refundAmount: UNIT,
    restockPending: true, goodsReceiptRequired: true,
    creditReturnPolicyVersion: 1, realMoneyRefundAmount: UNIT
  })
  seed.insert('SaleReturnItem', {
    returnId: nonC2CReturnId, saleItemId: nonC2CInvoice.items[0].id,
    variantId: nonC2CVariant, qty: 1, unitPrice: UNIT, lineTotal: UNIT, restockedQty: 0
  })
  const misplacedRequestId = seed.insert('CardTransferRequest', {
    returnId: nonC2CReturnId, kind: 'REQUEST', status: CardTransferStatus.PENDING,
    operationKind: 'RETURN', sourceInvoiceId: nonC2CInvoice.id,
    amount: UNIT, returnTotal: UNIT, invoiceTotal: UNIT, userId, shiftId
  })
  const nonC2CStock = stockOf(nonC2CVariant)
  await throwsWith('ردیف مدیرِ وصل‌شده به برگشت نقدی، مجوز آزادسازی C2C نیست',
    () => pendingRestockService.releaseReturnStock(db, {
      returnId: nonC2CReturnId, managerPaymentRequestId: misplacedRequestId,
      requestId: misplacedRequestId, userId, reason: 'درخواست پرداخت نامعتبر'
    }), 'پرداخت نامرتبط با کارت‌به‌کارت')
  eq('برگشت غیر C2C پس از رد، معلق باقی ماند', returnRow(nonC2CReturnId).restockPending, 1)
  eq('موجودی برگشت غیر C2C تغییر نکرد', stockOf(nonC2CVariant), nonC2CStock)
}

// --------------------------------------------------------------------- پایان
console.log(`\nسوییت کار ب (کالای در انتظار تأیید مدیر · جلسه ۴۰/۴۵): ${pass} PASS · ${failures.length} FAIL`)
if (failures.length) {
  console.log('\nناموفق‌ها:')
  for (const f of failures) console.log(`  • ${f}`)
}
console.log(`دیتابیس تست: ${process.env.HARNESS_DB}`)
process.exit(failures.length ? 1 : 0)
