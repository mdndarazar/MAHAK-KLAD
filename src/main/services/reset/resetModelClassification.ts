/**
 * طرح ۱۴۰۵ · مورد ۸ (معماری §۴-۲، طرح §۲۴-۳ مورد ۸) — جدول طبقه‌بندی «صفر کردن برنامه».
 *
 * هر جدول پایگاه داده (۸۰ مدل `schema.prisma` و جدول خام `CashCloseGuard`) در هر دو حالت یکی از این‌هاست:
 *   - `keep`          ⇒ همهٔ ردیف‌ها با همان شناسه‌ها به پایگاه تازه کپی می‌شوند؛
 *   - `keepZeroStock` ⇒ مثل `keep`، ولی موجودی فروشگاه و انبار مرکزی صفر می‌شود (فقط «فقط تراکنش‌ها»)؛
 *   - `keepSome`      ⇒ فقط ردیف‌های نام‌برده (کلیدهای `Setting` و قفل‌های رمز اشتباه بی کاربر)؛
 *   - `clear`         ⇒ هیچ ردیفی کپی نمی‌شود؛ جدول همان است که migrator خود برنامه در نصب تازه می‌سازد.
 *
 * پایگاه تازه همیشه با migrator خود برنامه ساخته می‌شود و فقط «می‌ماند»ها به آن کپی می‌شوند (هرگز حذف
 * ردیف‌به‌ردیف، هرگز `prisma migrate reset`). آزمون `plan1405-factory-reset.mjs` هر مدل و هر جدول بی‌طبقه را
 * رد می‌کند؛ خود سرویس هم پیش از جابه‌جایی، جدولِ بی‌طبقه را «شکست، هیچ چیزی پاک نشد» می‌شمارد.
 *
 * leaf است (فقط `@shared/gateCatalog`، بی import از main) تا آزمون بی بسته‌بندی سرویس‌ها بخواندش.
 */

export type ResetMode = 'transactions' | 'full'
export type ResetFate = 'keep' | 'keepZeroStock' | 'keepSome' | 'clear'

export interface ResetTableRule {
  readonly transactions: ResetFate
  readonly full: ResetFate
  /** دلیل کوتاه (برای بازبینی و سند) */
  readonly why: string
}

export const RESET_MODES: readonly ResetMode[] = Object.freeze(['transactions', 'full'])

/** جدول‌هایی که هرگز طبقه‌بندی و کپی نمی‌شوند: خود migrator و شمارندهٔ SQLite آن‌ها را می‌سازد. */
export const RESET_SYSTEM_TABLES: readonly string[] = Object.freeze(['_prisma_migrations', 'sqlite_sequence'])

const K = 'keep', C = 'clear', Z = 'keepZeroStock', S = 'keepSome'
const rule = (transactions: ResetFate, full: ResetFate, why: string): ResetTableRule => Object.freeze({ transactions, full, why })
/** داده‌ای که در «فقط تراکنش‌ها» می‌ماند و در «کامل» پاک می‌شود */
const master = (why: string) => rule(K, C, why)
/** تراکنش یا ردپای آن: در هر دو حالت پاک می‌شود */
const tx = (why: string) => rule(C, C, why)

export const RESET_TABLE_RULES: Readonly<Record<string, ResetTableRule>> = Object.freeze({
  // ---- کاربران، کالاها، مشتری‌ها و تنظیمات
  User: master('کاربران و کارمندان'),
  Setting: rule(S, S, 'تنظیمات: «فقط تراکنش‌ها» همه جز ردپای کارهای پاک‌شده؛ «کامل» فقط کلیدهای نام‌برده'),
  Category: master('دسته‌ها'),
  Warehouse: master('انبار فروشگاه (تعریف)'),
  Product: master('کالاها'),
  ProductVariant: rule(Z, C, 'کالا با قیمت و بارکد؛ موجودی فروشگاه صفر می‌شود'),
  Customer: master('فهرست مشتری‌ها'),
  Supplier: master('فهرست تأمین‌کننده‌ها (مثل فهرست مشتری‌ها)'),
  PaymentMethod: master('روش‌های پرداخت (تنظیم)'),
  SecondaryWarehouse: master('انبارهای مرکزی (تعریف)'),
  SecondaryStockItem: rule(Z, C, 'کالاهای انبار مرکزی؛ موجودی صفر می‌شود'),
  PriceChangeBatch: master('تغییر قیمت گروهی و زمان‌بندی‌اش (قیمت‌ها می‌مانند، پس پایان زمان‌بندی هم باید بماند)'),
  PriceChangeItem: master('ردیف‌های همان تغییر قیمت گروهی'),
  MgmtTarget: master('هدف فروش ماهانهٔ مدیر (تنظیم)'),
  StaffProfile: master('پروندهٔ کارمند'),
  CustodyCredential: master('رمز حضانت کارمند؛ در «کامل» پاک می‌شود (طرح §۲۴-۳)'),
  ShiftPlan: master('برنامهٔ شیفت (تنظیم)'),
  ShiftPlanStaff: master('کارمندان برنامهٔ شیفت'),
  AuthLockout: rule(K, S, 'قفل موقت پس از رمز اشتباه؛ در «کامل» قفل‌های وابسته به کاربرِ پاک‌شده نمی‌مانند'),
  // ---- پیامک
  SmsProviderConfig: master('تنظیم سرویس پیامک و کلید رمزشده‌اش'),
  SmsTemplate: master('قالب‌های پیامک'),
  SmsOptOut: master('فهرست لغو ۱۱ (خواستهٔ مشتری‌ها)'),
  SmsOutbox: tx('صف پیامک خالی می‌شود'),
  SmsAttempt: tx('سابقهٔ ارسال پیامک'),
  SmsCampaign: tx('کمپین‌های پیامک (به صف بسته‌اند)'),
  // ---- همگام‌سازی سایت
  WooProductLink: master('اتصال کالا به سایت؛ همگام‌سازی خاموش می‌ماند تا مالک روشن کند'),
  WooSyncOutbox: tx('درخواست‌های ارسال‌نشده به سایت'),
  WooInboundEvent: tx('رویدادهای سایت (به گردش موجودی پاک‌شده بسته‌اند)'),
  WooApproval: tx('تأییدهای در انتظار همگام‌سازی'),
  WooSyncLog: tx('گزارش همگام‌سازی'),
  // ---- فروش، برگشت و تعویض
  SaleInvoice: tx('فاکتورهای فروش و تعویض'),
  SaleInvoiceItem: tx('ردیف فاکتور'),
  Payment: tx('پرداخت‌ها، نسیه و چک'),
  PaymentChequeStatusHistory: tx('سابقهٔ وضعیت چک'),
  SaleReturn: tx('برگشت و تعویض'),
  SaleReturnItem: tx('ردیف برگشت'),
  DiscountTransferEvent: tx('انتقال تخفیف در تعویض'),
  CreditReturnAllocation: tx('سهم اعتبار در برگشت (جدول فقط‌افزودنی؛ کپی نمی‌شود)'),
  ReturnCorrection: tx('اصلاح برگشت'),
  ReturnCorrectionEffect: tx('اثر اصلاح برگشت'),
  CardTransferRequest: tx('درخواست کارت‌به‌کارت برگشت'),
  SaleItemStockAllocation: tx('برداشت موجودی ردیف فروش'),
  // ---- خرید و موجودی
  PurchaseInvoice: tx('فاکتورهای خرید'),
  PurchaseInvoiceItem: tx('ردیف فاکتور خرید'),
  StockMovement: tx('گردش موجودی'),
  SecondaryStockLog: tx('گردش انبار مرکزی'),
  StockCountSession: tx('انبارگردانی'),
  StockCountItem: tx('ردیف انبارگردانی'),
  // ---- بهای تمام‌شده (به گردش و خریدِ پاک‌شده بسته است)
  PurchaseLot: tx('لات خرید'),
  SaleItemCost: tx('بهای ردیف فروش'),
  CostConsumption: tx('مصرف لات'),
  CostEngineState: tx('وضعیت موتور بها (شمارهٔ آخرین گردش)'),
  CostEngineLock: tx('قفل موتور بها'),
  CostEngineFailure: tx('خطاهای موتور بها'),
  // ---- صندوق، شیفت و تجمیع
  Shift: tx('شیفت‌ها'),
  CashSession: tx('بستن صندوق'),
  CashMovement: tx('جابه‌جایی صندوق'),
  Consolidation: tx('تجمیع'),
  CashCloseGuard: tx('نگهبان یکتایی بستن صندوق'),
  // ---- اعتبار خرید
  StoreCredit: tx('اعتبار خرید، کد و بارکد'),
  StoreCreditLineage: tx('زنجیرهٔ اعتبار'),
  StoreCreditDelivery: tx('تحویل اعتبار'),
  StoreCreditRedemption: tx('مصرف اعتبار'),
  StoreCreditBatch: tx('تولید گروهی اعتبار'),
  CreditReminderLog: tx('یادآوری اعتبار'),
  // ---- حضانت صندوق
  CustodySaleEvidence: tx('سند فروش حضانت'),
  CustodyState: tx('وضعیت حضانت (نصب تازه: بی نشست)'),
  CustodyShiftMeta: tx('شیفت حضانت'),
  CustodyCount: tx('شمارش حضانت'),
  CustodyEvent: tx('رویداد حضانت'),
  CustodyDisposition: tx('تصمیم حضانت'),
  CustodyHandover: tx('تحویل حضانت'),
  CustodyResolution: tx('حل اختلاف حضانت'),
  CustodyAggregateBoundary: tx('مرز جمع حضانت'),
  CustodyDiscrepancyCase: tx('پروندهٔ اختلاف حضانت'),
  CustodyDiscrepancyReview: tx('بازبینی اختلاف حضانت'),
  LegacyShiftRecovery: tx('بازیابی شیفت قدیمی'),
  LegacyShiftRecoveryItem: tx('ردیف بازیابی شیفت قدیمی'),
  LegacyShiftRecoveryReview: tx('بازبینی بازیابی شیفت قدیمی'),
  LegacyRecoveryOpeningLink: tx('پیوند بازیابی شیفت قدیمی'),
  // ---- سابقه
  AuditLog: tx('گزارش کارها؛ یک ردیف «صفر کردن» در پایگاه تازه نوشته می‌شود')
})

/** ستون موجودی جدول‌های `keepZeroStock` (فروشگاه و انبار مرکزی). */
export const ZERO_STOCK_COLUMNS: Readonly<Record<string, string>> = Object.freeze({ ProductVariant: 'stock', SecondaryStockItem: 'qty' })

/**
 * «کامل»: فقط همین کلیدهای `Setting` به پایگاه تازه می‌روند (معماری §۴-۲؛ طرح §۲۵-۱۰ بند «ج»)، به‌علاوهٔ شش فیلد
 * چاپ `credit.settings` روی تنظیمات پیش‌فرض اعتبار. `credit.sellerReprintSeenAt` و `shift.config` نمی‌مانند.
 */
export const FULL_KEEP_SETTING_KEYS: readonly string[] = Object.freeze([
  'manager.auth', 'panel.auth', 'panel.locks', 'security.config', 'backup.config', 'backup.imports',
  'receipt.template', 'label.template', 'credit.certificatePrinter'
])
export const CREDIT_SETTINGS_KEY = 'credit.settings'
export const CREDIT_PRINT_FIELDS = Object.freeze(['paper', 'customWidthMm', 'customHeightMm', 'printFontPx', 'printMarginXMm', 'printMarginYMm'] as const)

/**
 * «فقط تراکنش‌ها»: همهٔ تنظیمات می‌مانند، جز این ردپاهای کارهای پاک‌شده که در جدول `Setting` نشسته‌اند و به
 * شناسهٔ ردیف‌های پاک‌شده اشاره می‌کنند (مکان‌نماهای موتور بها، فهرست بستن هشدار نسیه، و شمارندهٔ «تازه»ی تب
 * «چاپ دوباره»). نماندنشان یعنی همان حالت نصب تازه برای همین چند ردپا.
 */
export const TRANSACTION_STATE_SETTING_KEYS: readonly string[] = Object.freeze([
  'mgmt.reconcileCursor', 'mgmt.reconcilePage', 'mgmt.pendingReprice', 'mgmt.reconcileError', 'mgmt.lastReprice',
  'debtReminder.log', 'credit.sellerReprintSeenAt'
])

/** شمارندهٔ فیش فروش (`receiptNo.ts`): در «فقط تراکنش‌ها» تا بیشینهٔ فیش‌های پیشین جلو می‌رود و ادامه می‌یابد. */
export const RECEIPT_SEQ_SETTING_KEY = 'sale.receiptSeq'
/** تنظیم همگام‌سازی سایت: در «فقط تراکنش‌ها» با `enabled: false` می‌ماند تا مالک خودش روشن کند. */
export const WOO_CONFIG_SETTING_KEY = 'woo.sync.config.v1'

/** «کامل»: قفل‌های رمز اشتباهِ وابسته به کاربر (کاربران پاک می‌شوند و شناسه‌ها از نو شروع می‌شوند) نمی‌مانند. */
export const USER_BOUND_LOCKOUT_PREFIXES: readonly string[] = Object.freeze(['custody-pin:'])

/** شمارش‌های پیش‌نمایش و رسید (معماری §۴-۲ بند ۱ و ۱۱)؛ فقط جدول‌هایی که در همان حالت پاک می‌شوند می‌آیند. */
export const RESET_HEADLINES: readonly { table: string; label: string }[] = Object.freeze([
  { table: 'SaleInvoice', label: 'فاکتور فروش و تعویض' },
  { table: 'SaleReturn', label: 'برگشت و تعویض' },
  { table: 'Payment', label: 'پرداخت، نسیه و چک' },
  { table: 'PurchaseInvoice', label: 'فاکتور خرید' },
  { table: 'StoreCredit', label: 'اعتبار خرید' },
  { table: 'Shift', label: 'شیفت' },
  { table: 'CashSession', label: 'بستن صندوق' },
  { table: 'Consolidation', label: 'تجمیع' },
  { table: 'StockMovement', label: 'گردش موجودی' },
  { table: 'SmsOutbox', label: 'پیامک صف' },
  { table: 'AuditLog', label: 'گزارش کار' },
  { table: 'ProductVariant', label: 'کالا' },
  { table: 'Category', label: 'دسته' },
  { table: 'Customer', label: 'مشتری' },
  { table: 'Supplier', label: 'تأمین‌کننده' },
  { table: 'User', label: 'کاربر و کارمند' },
  { table: 'CustodyCredential', label: 'رمز حضانت' }
])

export function resetFate(table: string, mode: ResetMode): ResetFate | null {
  const r = Object.prototype.hasOwnProperty.call(RESET_TABLE_RULES, table) ? RESET_TABLE_RULES[table] : null
  return r ? r[mode] : null
}

/** تأیید تایپی «صفر» (معماری §۴-۲): همان تابع رابط، از `@shared/gateCatalog`. */
export { normalizeResetConfirm, RESET_CONFIRM_WORD, resetConfirmMatches } from '@shared/gateCatalog'
