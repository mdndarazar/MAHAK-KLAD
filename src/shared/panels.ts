/**
 * ===========================================================================
 * پنل‌های «قفل‌دار» برنامه و کلیدشان.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  قانون همیشگی پروژه — «هر ماژول جدید، یک رمز دوم اختصاصی»              ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * این یک «مورد استثنایی» نیست؛ یک **قرارداد رسمی و همیشگی این پروژه** است و
 * هر توسعه‌دهنده‌ی بعدی — چه انسان، چه یک مدل هوش مصنوعی — باید بدون این‌که
 * صاحب نرم‌افزار دوباره بخواهد، آن را رعایت کند:
 *
 *   ⇒ هر قابلیت / ماژول / صفحه / حتی هر گزینه‌ی حساسِ جدیدی که از این به بعد
 *     به این نرم‌افزار اضافه می‌شود، **باید** امکان تعریف «رمز دوم اختصاصی»
 *     داشته باشد، دقیقاً با همین الگو:
 *
 *        ۱) یک کلید جدید در `PANEL_KEYS`
 *        ۲) یک ردیف جدید در `LOCKED_PANELS` (عنوان فارسی + یک خط توضیح)
 *        ۳) پوشاندن آن صفحه/کامپوننت با `<ManagerGate panel={PANEL_KEYS.xxx} …>`
 *        ۴) تست با رمز مدیر و با رمز دوم (و بدون هیچ رمز)
 *
 *     همین چهار قدم کافی است: پنل «تنظیمات → تنظیمات رمز» خودش روی
 *     `LOCKED_PANELS` حلقه می‌زند، پس ردیف جدید بدون هیچ کد اضافه‌ای در
 *     تنظیمات ظاهر می‌شود و مدیر می‌تواند همان‌جا رمز دومش را بگذارد یا حذف کند.
 *     چک‌لیست کامل در `README.md` → «افزودن ماژول جدید: چک‌لیست» است.
 *
 * ---------------------------------------------------------------------------
 * دو قاعده‌ی ثابت و بدون استثنا:
 *   ۱) رمز مدیر (رمز اصلی) *همیشه* همه‌ی این قفل‌ها را باز می‌کند، چه رمز دوم
 *      برایشان تعریف شده باشد چه نشده باشد. مدیر همه‌کاره است.
 *   ۲) تا وقتی برای یک پنل رمز دوم تعریف و فعال نشده، رفتار همان قبل است:
 *      فقط رمز مدیر بازش می‌کند (پس «رمز دوم» همیشه اختیاری است، پیش‌فرض خاموش).
 *
 * ورود با «رمز دوم» فقط همان یک پنل را باز می‌کند و «نشست مدیر» نمی‌سازد، پس
 * کارمندِ آن بخش به بقیه‌ی پنل‌ها دسترسی پیدا نمی‌کند.
 *
 * قفل موقت: بعد از چند بار رمز اشتباه پشت‌سرهم (پیش‌فرض ۳ بار)، *همان* گیت برای
 * مدت تنظیم‌شده (پیش‌فرض ۱۰ دقیقه) قفل می‌شود و تا پایان آن مدت حتی رمز درست هم
 * پذیرفته نمی‌شود. شمارنده و زمان قفل در دیتابیس (جدول `AuthLockout`) نگه داشته
 * می‌شوند، پس بستن و باز کردن برنامه قفل را دور نمی‌زند. منطقش در
 * `src/main/services/AuthService.ts` است.
 * ===========================================================================
 */

import { GATE_ACTION_LOCK_KEYS, GATE_CATALOG, GATE_GROUPS, GATE_PART_KEYS, gateEntry, type GateCatalogEntry } from './gateCatalog'

/** کلید هر پنل قفل‌دار — همین رشته، کلید ذخیره‌سازی رمز دومش هم هست. */
export const PANEL_KEYS = {
  settings: 'settings',
  products: 'products',
  purchase: 'purchase',
  /** فهرست «فاکتورهای عمده» (تب دوم پنل فاکتور فروش عمده) — مخصوص حسابداری */
  wholesaleInvoices: 'wholesale-invoices',
  /** انبار مرکزی */
  secondaryStock: 'secondary-stock',
  chargesTaxPos: 'charges-tax-pos',
  chargesServicePos: 'charges-service-pos',
  chargesTaxWholesale: 'charges-tax-wholesale',
  chargesServiceWholesale: 'charges-service-wholesale',

  // ------------------------------------------------------------------------
  // پنل‌های قفل‌دارِ افزوده‌شده — طبق همان قانون بالا
  // ------------------------------------------------------------------------
  /** پنل فروش تکی (POS) */
  pos: 'pos',
  /** گزارشات فروش */
  salesReports: 'sales-reports',
  /** نشست ۳۱۸ — نمای تشخیص پل تطبیق (مودال داخل گزارشات فروش) */
  bridgeDiagnostics: 'bridge-diagnostics',
  /** تب «نسیه» داخل گزارشات فروش (فهرست بدهکاران و ثبت پرداختی) */
  salesCredit: 'sales-credit',
  /** برگشت از فروش (و تعویض کالا) */
  salesReturn: 'sales-return',
  /**
   * فقط عمل «اصلاح/ابطال» برگشت یا تعویض؛ جدا از بازکردن خودِ پنل برگشت.
   * این قفل عملیاتی در نصب تازه **روشن** است: تغییر سندی که روی کالا، انبار
   * یا پول اثر دارد نباید فقط با باز بودن صفحه‌ی برگشت ممکن شود.
   */
  salesReturnCorrection: 'sales-return-correction',
  /** بستن صندوق */
  cashClose: 'cash-close',
  /** تجمیع و انتقال */
  consolidation: 'consolidation',
  /**
   * کل ماژول «فاکتور فروش عمده» (صفحه‌ی صدور فاکتور).
   * ⚠️ این قفل کاملاً *جدا و مستقل* از `wholesaleInvoices` است: آن یکی فقط تبِ
   * «فاکتورهای عمده» (فهرست حسابداری) را می‌بندد و دست‌نخورده مانده است.
   */
  wholesaleInvoiceModule: 'wholesale-invoice-module',
  /**
   * چک‌باکس «چاپ فاکتور» در پنل فروش — یک قفل ریز داخل یک ماژول، نه یک صفحه‌ی
   * کامل. تا باز نشود، کارمند نمی‌تواند چاپ فاکتور را روشن/خاموش کند.
   */
  posPrintToggle: 'pos-print-toggle',

  // ------------------------------------------------------------------------
  // جلسه ۱۷ — پنل‌های تازه (طبق همان قرارداد بالای همین فایل)
  // ------------------------------------------------------------------------
  /** تب «درخواست‌های کارت‌به‌کارت» در گزارشات فروش — فقط مدیر (بند ۱) */
  cardTransfers: 'card-transfers',
  /** تب «عملکرد کارمندان» در گزارشات فروش (بند ۲) */
  staffPerformance: 'staff-performance',
  /** ماژول انبارگردانی: شمارش فیزیکی، مغایرت‌ها و یادآوری (بند ۴ و ۵) */
  stocktake: 'stocktake',

  // ------------------------------------------------------------------------
  // نشست پنجم — سه کلید جدید، طبق همان قانون بالا
  // ------------------------------------------------------------------------
  /**
   * بند ۳ — «تخفیف» پنل فروش: هم تخفیف روی کالا (ستون تخفیف جدول) و هم تخفیف
   * روی کل فاکتور. یک قفل ریز داخل پنل فروش: کارمند می‌تواند بفروشد ولی تا این
   * قفل باز نشود نمی‌تواند خودسرانه تخفیف بزند.
   */
  posDiscount: 'pos-discount',

  // ------------------------------------------------------------------------
  // نشست نهم — مورد ۴، طبق همان قانون بالای این فایل
  // ------------------------------------------------------------------------
  /**
   * مورد ۴ — چک‌باکس «برداشت خودکار از انبار مرکزی هنگام کمبود موجودی».
   *
   * تا این نسخه، این یک گزینه *فقط* با «نشست مدیر» باز می‌شد (برخلاف چک‌باکس
   * «چاپ فاکتور» و بخش «تخفیف» که هرکدام کلید قفل مستقل خودشان را داشتند). حالا
   * دقیقاً هم‌ارز `posPrintToggle` و `posDiscount` است: یک قفل ریز با کلید
   * مستقل، پس مدیر می‌تواند برایش رمز دوم اختصاصی بگذارد و آن را به سرشیفت یا
   * انباردار بدهد، بدون افشای رمز اصلی مدیریتی.
   *
   * همین یک کلید، هر سه محلی را که این چک‌باکس دیده می‌شود می‌پوشاند (پنل فروش،
   * فاکتور فروش عمده، تنظیمات انبار مرکزی) — چون هر سه یک تنظیم واحدند.
   */
  posCentralWithdrawToggle: 'pos-central-withdraw-toggle',
  /**
   * بند ۴ — ماژول «تخفیف و افزایش/کاهش قیمت» (تغییر گروهی قیمت کالاها).
   * حساس‌ترین ماژول برنامه است: با یک کلیک قیمت همه‌ی کالاها را عوض می‌کند.
   */
  priceAdjust: 'price-adjust',
  /**
   * بند ۸ — «انتقال به انبار فروشگاه» در ماژول انبار مرکزی.
   * تنها مسیری است که انبار مرکزی روی موجودی *واقعی* کالاهای فروشگاه اثر
   * می‌گذارد، پس قفل جدا و مستقل از خود ماژول انبار مرکزی دارد.
   */
  secondaryToStore: 'secondary-to-store',

  // ------------------------------------------------------------------------
  // جلسه ۵۵ · کار ۱ — قفل مستقل «ساخت کالای جدید هنگام انتقال»
  // ------------------------------------------------------------------------
  /**
   * «ساخت کالای جدید در انبار فروشگاه، هنگام انتقال از انبار مرکزی» (جلسه ۵۴).
   *
   * تا جلسه ۵۴ این کار **قفل پنل کالاها** (`products`) را می‌خواست، و همین یک
   * عارضه‌ی ناخواسته داشت: انباردار برای ساختن یک کالای تازه هنگام انتقال، باید
   * رمز پنل کالاها را می‌گرفت — یعنی *حذف کالا، تغییر قیمت و ورود موجودی* هم
   * یک‌جا برایش باز می‌شد. حالا این کار کلید مستقل خودش را دارد: مدیر می‌تواند
   * رمز دوم (یا رمز سوم شیفتی) همین کلید را به انباردار بدهد و پنل کالاها
   * دست‌نخورده و بسته بماند.
   *
   * ⚠️ این کلید **جایگزین** `products` در همین یک مسیر است، نه یک قفل اضافه:
   * مسیر ساخت کالای جدید هنگام انتقال، `secondaryToStore` + همین کلید را
   * می‌سنجد و دیگر هیچ‌جا سراغ `products` نمی‌رود. خودِ پنل کالاها و قفلش یک خط
   * هم عوض نشده‌اند.
   */
  secondaryToStoreNewProduct: 'secondary-to-store-new-product',

  // ------------------------------------------------------------------------
  // جلسه ۲۰ — ماژول «مدیریت اعتبار خرید» (§۲۰ سند مرجع)
  //
  // چهار کلید جدا، دقیقاً طبق قرارداد بالای همین فایل. چرا چهار تا و نه یکی؟
  // چون این سه کار سه سطح خطر کاملاً متفاوت دارند و صاحب فروشگاه باید بتواند
  // هرکدام را به آدم دیگری بدهد:
  //   • دیدن/جست‌وجو/صدور تکی    ⇒ creditManagement (حسابدار یا سرشیفت)
  //   • تولید گروهی هزاران اعتبار ⇒ creditBulkIssue  (فقط مدیر — پول چاپ کردن است)
  //   • ابطال/تعلیق/تغییر مبلغ    ⇒ creditVoid       (فقط مدیر — پاک کردن بدهی)
  //   • تنظیمات پایه‌ی کل ماژول    ⇒ creditSettings   (فقط مدیر)
  // ------------------------------------------------------------------------
  /** صفحه‌ی «مدیریت اعتبار خرید»: داشبورد، فهرست، جزئیات و صدور تکی */
  creditManagement: 'credit-management',
  /** «تنظیمات اعتبار خرید» (§۲۲): طول کد، پیشوند، قواعد هر نوع، یادآوری */
  creditSettings: 'credit-settings',
  /** «تولید گروهی» اعتبار (§۵) — یک کلیک، هزاران سند قابل خرج */
  creditBulkIssue: 'credit-bulk-issue',
  /** ابطال / تعلیق / فعال‌سازی مجدد / تغییر مبلغ‌-تاریخ‌-دفعات یک اعتبار (§۸ و §۱۱) */
  creditVoid: 'credit-void',
  /** همگام‌سازی موجودی سایت WooCommerce با انبار فروشگاه (فقط موجودی). */
  wooSync: 'woo-sync',
  /** صفحهٔ جدا «گزارش مدیریت» — نمودار و مانده؛ گزارشات فروش را لمس نمی‌کند */
  managementReports: 'management-reports',
  /** تب «سود و تورم» داخل گزارش مدیریت — قفل جدا از خودِ صفحه */
  managementProfit: 'management-profit',

  // ------------------------------------------------------------------------
  // پنل پیامکی — سه قفل، طبق قاعده‌ی «هر ماژول حساس، کلید خودش را دارد»
  // ------------------------------------------------------------------------
  /**
   * کل صفحه‌ی «پنل پیامکی»: داشبورد، صف، سابقه، قالب‌ها و ارسال دستی.
   * جدا از `smsProvider` است تا بشود به یک کارمند «ارسال دستی» داد بدون
   * این‌که کلید API فروشگاه را ببیند.
   */
  smsPanel: 'sms-panel',
  /**
   * تنظیمات اتصال به سرویس‌دهنده: انتخاب سرویس‌دهنده، سرشماره، پترن و
   * کلید API. کلید در `PanelVault` مهر می‌شود و **هرگز** به renderer
   * برنمی‌گردد؛ عوض‌کردنش علاوه بر این قفل، رمز مدیر هم می‌خواهد.
   */
  smsProvider: 'sms-provider',
  /**
   * عمل‌های برگشت‌سخت روی صف: لغو گروهی، تلاش مجدد و برگرداندن به صف.
   * لغو یک پیامِ زمان‌بندی‌شده برگشت‌پذیر است، ولی لغو گروهی می‌تواند
   * ده‌ها پیام را با یک کلیک بخواباند؛ پس قفل جدا دارد.
   */
  smsDanger: 'sms-danger',

  // ------------------------------------------------------------------------
  // طرح ۱۴۰۵ (معماری §۳-۳ و §۳-۱۰) — هفت «قسمت» تازه که امروز «فقط نشست مدیر» بودند،
  // و ۳۶ «قفل کار» (`act-*`). عنوان، گروه و رده از `gateCatalog.ts` می‌آیند.
  // ------------------------------------------------------------------------
  creditPrint: 'credit-print',
  staff: 'staff',
  staffSensitiveFile: 'staff-sensitive-file',
  custodySettings: 'custody-settings',
  custodyControlReport: 'custody-control-report',
  custodyDiscrepancyCases: 'custody-discrepancy-cases',
  custodyWorkPlans: 'custody-work-plans',
  actBackupExport: 'act-backup-export',
  actBackupSettings: 'act-backup-settings',
  actBackupNow: 'act-backup-now',
  actBackupForget: 'act-backup-forget',
  actBackupRestore: 'act-backup-restore',
  actBackupMerge: 'act-backup-merge',
  actFactoryReset: 'act-factory-reset',
  actCreditReprint: 'act-credit-reprint',
  actCreditThirdPrint: 'act-credit-third-print',
  actCreditIssueManual: 'act-credit-issue-manual',
  actCreditCodeReveal: 'act-credit-code-reveal',
  actCreditInvoiceLookup: 'act-credit-invoice-lookup',
  actPaymentsEditOpenShift: 'act-payments-edit-open-shift',
  actChequeEditCleared: 'act-cheque-edit-cleared',
  actChequeVoidCleared: 'act-cheque-void-cleared',
  actChequeVoidPending: 'act-cheque-void-pending',
  actChequeStatus: 'act-cheque-status',
  actChequeReplace: 'act-cheque-replace',
  actRefundFull: 'act-refund-full',
  actRefundCardReturn: 'act-refund-card-return',
  actRefundCardExchange: 'act-refund-card-exchange',
  actReturnAfterDeadline: 'act-return-after-deadline',
  actChargesBelowAuto: 'act-charges-below-auto',
  actPriceBelowReference: 'act-price-below-reference',
  actOverpayCreditAboveCap: 'act-overpay-credit-above-cap',
  actClosedPeriodEntry: 'act-closed-period-entry',
  actCloseStaleSession: 'act-close-stale-session',
  actForceStaffChange: 'act-force-staff-change',
  actMasterOverride: 'act-master-override',
  actCustodyOpenOutsideShift: 'act-custody-open-outside-shift',
  actAccountingPolicy: 'act-accounting-policy',
  actExchangeOverpayGuard: 'act-exchange-overpay-guard',
  actClockOffset: 'act-clock-offset',
  actShiftByClock: 'act-shift-by-clock',
  actOvertimeCap: 'act-overtime-cap',
  actSettingsManagerSections: 'act-settings-manager-sections',
  actRawSensitiveSetting: 'act-raw-sensitive-setting',
  actSalesReportsPurge: 'act-sales-reports-purge',
  actDataArchivePurge: 'act-data-archive-purge',
  actCostLedgerRebuild: 'act-cost-ledger-rebuild'
} as const

export type PanelKey = (typeof PANEL_KEYS)[keyof typeof PANEL_KEYS]

export interface PanelDef {
  key: PanelKey
  /** نام پنل برای نمایش در پنل تنظیمات و صفحه‌ی ورود */
  title: string
  /** یک خط توضیح این‌که این رمز دوم به چه کسی داده می‌شود */
  hint: string
  /** طرح ۱۴۰۵ §۳-۳ — «قسمت» (مجوز با مدت) یا «قفل کار» (کد و مجوز یک بار) */
  kind: PanelKind
  /** نام ماژولی که در «قفل ماژول‌ها» و گوشی زیرش می‌آید */
  group: string
  /** ردهٔ کد: عادی (۲۵ کلید)، پولی (۱۲ کلید)، حساس (۷ قسمت تازه و همهٔ قفل‌های کار) */
  tier: PanelTier
}

export type PanelKind = 'part' | 'action'
export type PanelTier = 'normal' | 'money' | 'sensitive'
type PanelBase = Omit<PanelDef, 'kind' | 'group' | 'tier'>

/**
 * فهرست کامل پنل‌های قفل‌دار، به ترتیبی که در «تنظیمات رمز» نشان داده می‌شوند.
 *
 * ⚠️ افزودن یک پنل قفل‌دار جدید = یک ردیف اینجا + یک `ManagerGate` با همان کلید.
 * این کار **اجباری** است، نه اختیاری (قانون پروژه را در بالای همین فایل ببینید).
 */
const BASE_PANELS: readonly PanelBase[] = [
  {
    key: PANEL_KEYS.wholesaleInvoices,
    title: 'فاکتورهای فروش عمده (فهرست)',
    hint: 'رمز حسابداری: دیدن فهرست فاکتورهای عمده، پرداختی‌ها/اقساط و چک‌ها، بدون دانستن رمز مدیر.'
  },
  {
    key: PANEL_KEYS.wholesaleInvoiceModule,
    title: 'ماژول فاکتور فروش عمده (صدور فاکتور)',
    hint: 'قفل کل صفحه‌ی صدور فاکتور عمده — مستقل از قفل فهرست فاکتورها.'
  },
  { key: PANEL_KEYS.pos, title: 'پنل فروش (POS تکی)', hint: 'قفل صفحه‌ی فروش خرده؛ رمز دومش را به فروشنده‌ی همان شیفت بدهید.' },
  {
    key: PANEL_KEYS.posPrintToggle,
    title: 'چک‌باکس «چاپ فاکتور» پنل فروش',
    hint: 'قفل ریز: روشن/خاموش کردن چاپ فاکتور در پنل فروش، بدون قفل کردن کل پنل فروش.'
  },
  {
    key: PANEL_KEYS.cardTransfers,
    title: 'پرداخت‌های مدیر — کارت‌به‌کارت (تب گزارشات فروش)',
    hint:
      'بررسی و ثبت «پرداخت شد» برای بازپرداخت‌های کارت‌به‌کارت — فقط مدیر. ' +
      '⚠️ بازگرداندن کالای برگشتی به موجودی قابل‌فروش هم با همین قفل انجام می‌شود؛ ' +
      'کالای یک برگشت/تعویضِ کارت‌به‌کارت تا زدن «پرداخت شد» (یا رد/لغو با تأیید صریح) در همین ' +
      'پنل، معلق می‌ماند و در هیچ صفحه‌ی دیگری دکمه‌ی آزادسازی ندارد. این قفل هم در صفحه و هم در خود برنامه سنجیده می‌شود.'
  },
  {
    key: PANEL_KEYS.staffPerformance,
    title: 'عملکرد کارمندان (تب گزارشات فروش)',
    hint: 'فروش، تخفیف، برگشت و اعتبار خرید هر کارمند در یک نگاه.'
  },
  {
    key: PANEL_KEYS.stocktake,
    title: 'انبارگردانی (شمارش فیزیکی و مغایرت‌ها)',
    hint: 'ثبت شمارش فیزیکی قفسه، گزارش مغایرت نیازمند بررسی و یادآوری انبارگردانی.'
  },
  { key: PANEL_KEYS.salesReports, title: 'گزارشات فروش', hint: 'سرجمع و جزئیات فروش، برگشت‌ها و تعویض‌ها — مثلاً برای حسابدار.' },
  {
    key: PANEL_KEYS.bridgeDiagnostics,
    title: 'نمای تشخیص پل تطبیق',
    hint:
      'نمای تحلیلی «پل تطبیق» گزارشات فروش (ردیف منبع مغایرت و یادداشت مدیر). ' +
      'باز کردنش همیشه رمز می‌خواهد و چیزی را تغییر نمی‌دهد.'
  },
  {
    key: PANEL_KEYS.managementReports,
    title: 'گزارش مدیریت',
    hint: 'نمودار روند، مقایسهٔ فروشنده، کالای مانده و کم‌فروش — جدا از گزارشات فروش. رمز دومش را به صاحب مغازه بدهید.'
  },
  {
    key: PANEL_KEYS.wooSync,
    title: 'همگام‌سازی موجودی سایت',
    hint:
      'اتصال WooCommerce فقط برای تعداد موجودی. این قفل اجازه‌ی اتصال/قطع و اعمال موجودی سایت را می‌دهد؛ قیمت، سفارش، مشتری و گزارش فروش سایت وارد برنامه نمی‌شود.'
  },
  {
    key: PANEL_KEYS.managementProfit,
    title: 'سود و تورم (تب گزارش مدیریت)',
    hint:
      'سود واقعی خرید و سود جایگزینی. قفل جدا از خودِ گزارش مدیریت است تا حسابدار روند فروش را ببیند ولی حاشیه و فی خرید را نبیند. ' +
      'رمز دومش را فقط به صاحب مغازه بدهید.'
  },
  {
    key: PANEL_KEYS.salesCredit,
    title: 'نسیه (تب گزارشات فروش)',
    hint: 'فهرست فاکتورهای تسویه‌نشده و ثبت پرداختی نسیه — قفل جدا از خود گزارشات.'
  },
  { key: PANEL_KEYS.salesReturn, title: 'برگشت از فروش و تعویض کالا', hint: 'ثبت برگشت و تعویض کالا (حساس؛ مستقیم روی موجودی و پول اثر دارد).' },
  {
    key: PANEL_KEYS.salesReturnCorrection,
    title: 'اصلاح و ابطال برگشت / تعویض',
    hint:
      'قفل ریزِ عملیات اصلاح یا ابطال، جدا از خود پنل برگشت. در نصب تازه روشن است و رمز مدیر یا رمز دوم اختصاصی این عمل می‌خواهد؛ فقط مدیر می‌تواند آگاهانه آن را خاموش کند. اصلاح روزهای گذشته همچنان گیت سخت مدیر خودش را دارد.'
  },
  { key: PANEL_KEYS.cashClose, title: 'بستن صندوق', hint: 'بستن صندوق و پایان شیفت؛ رمز دومش را به سرشیفت بدهید.' },
  { key: PANEL_KEYS.consolidation, title: 'تجمیع و انتقال', hint: 'قطعی‌کردن کسر انبار روز — معمولاً فقط مدیر یا انباردار مسئول.' },
  { key: PANEL_KEYS.settings, title: 'تنظیمات', hint: 'کل تنظیمات برنامه (قالب فاکتور، چاپ، بکاپ، رمزها).' },
  { key: PANEL_KEYS.products, title: 'کالاها', hint: 'تعریف و حذف کالا و ورود موجودی — مثلاً برای انباردار.' },
  { key: PANEL_KEYS.purchase, title: 'فاکتور خرید', hint: 'ثبت فاکتور خرید (افزایش موجودی انبار).' },
  { key: PANEL_KEYS.secondaryStock, title: 'انبار مرکزی', hint: 'انبارهای ذخیره/شعبه‌ها، انتقال بین انبارها و تاریخچه‌شان.' },
  {
    key: PANEL_KEYS.posDiscount,
    title: 'تخفیف پنل فروش (کالا + کل فاکتور)',
    hint: 'قفل ریز: تا باز نشود فروشنده نمی‌تواند تخفیف بزند. مقدار مجاز تخفیف را مدیر در ماژول «تغییر قیمت گروهی (تخفیف، افزایش و کاهش قیمت)» تعیین می‌کند.'
  },
  {
    key: PANEL_KEYS.posCentralWithdrawToggle,
    title: 'چک‌باکس «برداشت خودکار از انبار مرکزی»',
    hint: 'قفل ریز — دو اختیار با یک رمز: ۱) روشن/خاموش کردن تیک «برداشت خودکار از انبار مرکزی» (در پنل فروش، فاکتور عمده و تنظیمات انبار مرکزی)، ۲) انتخاب انبار مبدأ کسر هنگام کمبود موجودی در پنل فروش تکی (وقتی تیک خاموش است). همین رمز دوم هر دو را باز می‌کند؛ رمز دومش را به سرشیفت یا انباردار بدهید، بدون دادن رمز مدیر.'
  },
  {
    key: PANEL_KEYS.priceAdjust,
    title: 'تغییر قیمت گروهی (تخفیف، افزایش و کاهش قیمت)',
    hint: 'تغییر گروهی قیمت کالاها (همه / یک دسته / کالاهای انتخابی) و سیاست تخفیف پنل فروش — حساس‌ترین ماژول، معمولاً فقط مدیر.'
  },
  {
    key: PANEL_KEYS.secondaryToStore,
    title: 'انتقال از انبار مرکزی به انبار فروشگاه',
    hint:
      'تنها مسیری که انبار مرکزی موجودی واقعی کالاهای فروشگاه را زیاد می‌کند؛ قفل جدا از خود ماژول انبار مرکزی. ' +
      'این رمز فقط انتقال به کالایی که از قبل در فروشگاه هست را باز می‌کند و اجازه‌ی ساختن کالای تازه نمی‌دهد؛ ' +
      'برای آن، ردیف بعدی («ساخت کالای جدید هنگام انتقال از انبار مرکزی») رمز جدا دارد.'
  },
  {
    key: PANEL_KEYS.secondaryToStoreNewProduct,
    title: 'ساخت کالای جدید هنگام انتقال از انبار مرکزی',
    hint:
      'همین رمز فقط اجازه‌ی ساختن کالا/واریانت تازه هنگام انتقال از انبار مرکزی را می‌دهد و پنل «کالاها» را ' +
      'باز نمی‌کند (پس حذف کالا، تغییر قیمت و ورود موجودی همچنان بسته می‌ماند). رمز دومش را به انباردار بدهید ' +
      'بی آن‌که رمز پنل کالاها را به او بدهید. تفاوتش با ردیف بالا: آن یکی انتقال به کالای موجود است، این یکی ' +
      'ساخت کالای جدید هنگام همان انتقال. هر دو قفل با هم سنجیده می‌شوند و رمز مدیر هر دو را باز می‌کند.'
  },
  { key: PANEL_KEYS.chargesTaxPos, title: 'عوارض و مالیات · پنل فروش', hint: 'درصد عوارض و مالیات فروش خرده.' },
  { key: PANEL_KEYS.chargesServicePos, title: 'حق سرویس · پنل فروش', hint: 'حق سرویس فروش خرده.' },
  {
    key: PANEL_KEYS.chargesTaxWholesale,
    title: 'عوارض و مالیات · فاکتور فروش عمده',
    hint: 'درصد عوارض و مالیات فاکتور عمده.'
  },
  {
    key: PANEL_KEYS.chargesServiceWholesale,
    title: 'حق سرویس · فاکتور فروش عمده',
    hint: 'حق سرویس فاکتور عمده.'
  },
  {
    key: PANEL_KEYS.creditManagement,
    title: 'مدیریت اعتبار خرید',
    hint: 'داشبورد اعتبارها، فهرست و جست‌وجو، جزئیات و سابقه‌ی هر اعتبار، و صدور تکی اعتبار برای مشتری/شرکت.'
  },
  {
    key: PANEL_KEYS.creditBulkIssue,
    title: 'تولید گروهی اعتبار خرید',
    hint: 'ساختن چند صد/چند هزار اعتبار با یک عملیات — عملاً چاپ پول فروشگاه؛ معمولاً فقط مدیر.'
  },
  {
    key: PANEL_KEYS.creditVoid,
    title: 'ابطال و تغییر اعتبار خرید',
    hint: 'ابطال، تعلیق، فعال‌سازی مجدد و تغییر مبلغ/تاریخ/دفعات یک اعتبار — هر تغییر با مقدار قبل/بعد در سابقه ثبت می‌شود.'
  },
  {
    key: PANEL_KEYS.creditSettings,
    title: 'تنظیمات اعتبار خرید',
    hint: 'طول و الفبای کد، پیشوند، مدت اعتبار و دفعات مصرف پیش‌فرض هر نوع، قواعد تولید گروهی، بارکد و یادآوری.'
  },
  /**
   * پنل پیامکی — سه ردیف.
   *
   * ⚠️ این ماژول **جدا از** همه‌ی بقیه است: نه فروش را می‌خواند، نه اعتبار را
   * عوض می‌کند، نه به گزارش مدیریت/گزارشات فروش/بستن صندوق وصل است. تنها
   * کاری که می‌کند «فرستادن پیام» است — و در بدترین حالت (سرویس‌دهنده‌ی
   * خراب، اینترنت قطع) صف می‌ماند و بقیه‌ی برنامه هیچ اثری نمی‌بیند.
   */
  {
    key: PANEL_KEYS.smsPanel,
    title: 'پنل پیامکی',
    hint:
      'داشبورد ارسال، صف و سابقه‌ی پیام‌ها، قالب‌های متن و ارسال دستی. رمز دومش را می‌توانید به کسی بدهید ' +
      'که فقط پیام بفرستد و به کلید API فروشگاه دسترسی نداشته باشد.'
  },
  {
    key: PANEL_KEYS.smsProvider,
    title: 'اتصال سرویس‌دهنده‌ی پیامک',
    hint:
      'انتخاب سرویس‌دهنده (sms.ir / کاوه‌نگار)، سرشماره، شناسه‌ی پترن و کلید API. کلید با گاوصندوق همین ' +
      'دستگاه مهر می‌شود و هرگز در دیتابیس خام نمی‌نشیند. عوض‌کردن کلید علاوه بر این قفل، رمز مدیر هم می‌خواهد.'
  },
  {
    key: PANEL_KEYS.smsDanger,
    title: 'عملیات حساس صف پیامک (لغو گروهی و تلاش مجدد)',
    hint:
      'لغو گروهی پیام‌های ارسال‌نشده، برگرداندن به صف و تلاش مجدد دستی. لغو یک پیام برگشت‌پذیر است، ' +
      'ولی لغو گروهی می‌تواند یک‌جا صدها پیام زمان‌بندی‌شده را بخواباند — پس قفل جدا دارد.'
  }
]

/**
 * طرح ۱۴۰۵ §۳-۳ — رده‌بندی ۳۷ کلید امروز: [گروه، رده]. همه «قسمت»اند؛ پنج کلید استثنا
 * (credit-void، credit-bulk-issue، credit-settings، sms-provider، woo-sync) هم قسمت‌اند و هم کلید
 * روشن/خاموش و رمز دوم/سوم کارهای خودشان (۲۵-۱۱). کلید بی‌رده در آزمون کاتالوگ رد می‌شود.
 */
const PG = Object.freeze({
  wholesale: 'فاکتور فروش عمده', sales: GATE_GROUPS.sales, reports: GATE_GROUPS.reports, stock: 'کالا و انبار',
  management: GATE_GROUPS.management, woo: GATE_GROUPS.woo, salesCredit: GATE_GROUPS.salesCredit,
  returns: GATE_GROUPS.returns, cashClose: GATE_GROUPS.cashClose, consolidation: 'تجمیع و انتقال',
  settings: GATE_GROUPS.settings, purchase: 'فاکتور خرید', price: 'تخفیف و تغییر قیمت',
  charges: GATE_GROUPS.charges, credit: GATE_GROUPS.credit, sms: GATE_GROUPS.sms
} as const)
const BASE_CLASS: Readonly<Record<string, readonly [string, PanelTier]>> = Object.freeze({
  'wholesale-invoices': [PG.wholesale, 'normal'], 'wholesale-invoice-module': [PG.wholesale, 'normal'],
  pos: [PG.sales, 'normal'], 'pos-print-toggle': [PG.sales, 'normal'], 'card-transfers': [PG.reports, 'money'],
  'staff-performance': [PG.reports, 'normal'], stocktake: [PG.stock, 'normal'], 'sales-reports': [PG.reports, 'normal'],
  'bridge-diagnostics': [PG.reports, 'normal'], 'management-reports': [PG.management, 'normal'],
  'woo-sync': [PG.woo, 'normal'], 'management-profit': [PG.management, 'normal'],
  'sales-credit': [PG.salesCredit, 'money'], 'sales-return': [PG.returns, 'money'],
  'sales-return-correction': [PG.returns, 'money'], 'cash-close': [PG.cashClose, 'money'],
  consolidation: [PG.consolidation, 'money'], settings: [PG.settings, 'normal'], products: [PG.stock, 'normal'],
  purchase: [PG.purchase, 'normal'], 'secondary-stock': [PG.stock, 'normal'], 'pos-discount': [PG.sales, 'money'],
  'pos-central-withdraw-toggle': [PG.sales, 'normal'], 'price-adjust': [PG.price, 'money'],
  'secondary-to-store': [PG.stock, 'normal'], 'secondary-to-store-new-product': [PG.stock, 'normal'],
  'charges-tax-pos': [PG.charges, 'normal'], 'charges-service-pos': [PG.charges, 'normal'],
  'charges-tax-wholesale': [PG.charges, 'normal'], 'charges-service-wholesale': [PG.charges, 'normal'],
  'credit-management': [PG.credit, 'money'], 'credit-bulk-issue': [PG.credit, 'money'],
  'credit-void': [PG.credit, 'money'], 'credit-settings': [PG.credit, 'money'],
  'sms-panel': [PG.sms, 'normal'], 'sms-provider': [PG.sms, 'normal'], 'sms-danger': [PG.sms, 'normal']
})

/** ۴۷ ردیف تازه (۷ قسمت + ۴۰ قفل کار؛ چهار قفل کار از دفتر آزمون، دستهٔ ۳)، همه «حساس»؛ عنوان و گروه از همان کاتالوگ. */
const PLAN1405_ROWS: readonly PanelDef[] = [
  ...GATE_PART_KEYS.map((key): PanelDef => ({
    key: key as PanelKey, title: GATE_CATALOG[key].titleFa, kind: 'part', group: GATE_CATALOG[key].group, tier: 'sensitive',
    hint: `رمز دوم این قسمت را فقط به کسی بدهید که باید «${GATE_CATALOG[key].titleFa}» را ببیند یا تغییر دهد.`
  })),
  ...GATE_ACTION_LOCK_KEYS.map((key): PanelDef => {
    const row = Object.values(GATE_CATALOG).find((e) => e.lockKey === key) as GateCatalogEntry
    return {
      key: key as PanelKey, title: row.titleFa, kind: 'action', group: row.group, tier: 'sensitive',
      hint: row.lockKind === 'policy'
        ? 'قفل یک کار؛ روشن/خاموش در «سیاست حسابداری». رمز دوم/سوم هر بار تایپ می‌شود؛ کد حساس یا مجوز راه دور یک بار.'
        : 'قفل یک کار: رمز دوم/سوم آن هر بار تایپ می‌شود؛ کد حساس یا مجوز راه دور فقط یک بار آن را باز می‌کند.'
    }
  })
]

/**
 * فهرست کامل کلیدهای قفل (۸۴ کلید)، به ترتیبی که در «تنظیمات رمز» نشان داده می‌شوند.
 * هر ردیف `kind`، `group` و `tier` دارد (طرح ۱۴۰۵ §۳-۳).
 */
export const LOCKED_PANELS: readonly PanelDef[] = Object.freeze([
  ...BASE_PANELS.map((p): PanelDef => {
    const [group, tier] = BASE_CLASS[p.key] ?? ['', 'normal']
    return { ...p, kind: 'part', group, tier }
  }),
  ...PLAN1405_ROWS
])

/**
 * مورد ۴ — متن گیت چک‌باکس «برداشت خودکار از انبار مرکزی».
 * یک تنظیم واحد در سه محل (پنل فروش، فاکتور فروش عمده، تنظیمات انبار مرکزی) ⇒
 * یک قفل و یک متن، در یک جا نوشته می‌شود تا هر سه‌جا یکسان بماند.
 */
export const CENTRAL_WITHDRAW_GATE = {
  title: 'چک‌باکس «برداشت خودکار از انبار مرکزی»',
  reason:
    'روشن/خاموش کردن «برداشت خودکار از انبار مرکزی» با رمز باز می‌شود: رمز مدیر، یا رمز دوم اختصاصی همین گزینه. بقیه‌ی این صفحه باز است و کار عادی انجام می‌شود؛ وضعیت فعلی این گزینه هم روی فاکتورها همان است که مدیر تعیین کرده.'
} as const

const KEY_SET = new Set<string>(LOCKED_PANELS.map((p) => p.key))

/** ورودی ناشناس → کلید پنل معتبر، یا null. */
export function normalizePanelKey(raw: unknown): PanelKey | null {
  const key = String(raw ?? '').trim()
  return KEY_SET.has(key) ? (key as PanelKey) : null
}

/** نام نمایشی یک پنل (کلید ناشناس = همان کلید). */
export function panelTitle(key: string): string {
  return LOCKED_PANELS.find((p) => p.key === key)?.title ?? key
}

/**
 * طرح ۱۴۰۵ §۳-۱۵ (۲۵-۱۰) — قسمت کد یک‌بارمصرف هر کلید قفل: فقط «قسمت»های عادی با کد «سایر ماژول‌ها»؛
 * قسمت‌های پولی، قسمت‌های تازه و همهٔ قفل‌های کار با کد «حساس». کلید ناشناس ⇒ null («پیش‌فرض رد»).
 * متن پرانتزهای دو قسمت در تب «رمز مدیر و خروج» هم از همین ساخته می‌شود تا متن و رفتار جدا نشوند.
 */
export type OneTimeCodeSection = 'sensitive' | 'other'
export function codeSectionOfPanel(key: string): OneTimeCodeSection | null {
  const p = LOCKED_PANELS.find((x) => x.key === key)
  if (!p) return null
  return p.kind === 'part' && p.tier === 'normal' ? 'other' : 'sensitive'
}

/**
 * دفتر آزمون ۴-۳۰ — نوع قفل در پیام‌ها، از همان مرز کدها و مدت‌ها (۴-۲۸): شناسهٔ کار کاتالوگ یا کلید «قفل کار» ⇒ «کار
 * یک‌باره»؛ قسمتی که کدش «سایر ماژول‌ها»ست ⇒ «ماژول معمولی»؛ هر قسمت دیگر (پولی، تازه یا ناشناس) ⇒ «ماژول پولی و حساس».
 * نشانهٔ رنگی هر نوع جداست.
 */
export type LockKind = 'action' | 'normal' | 'sensitive'
export const LOCK_KIND_TITLES: Readonly<Record<LockKind, string>> = Object.freeze({ action: 'کار یک‌باره', normal: 'ماژول معمولی', sensitive: 'ماژول پولی و حساس' })
export const LOCK_KIND_SIGNS: Readonly<Record<LockKind, string>> = Object.freeze({ action: '🔴', normal: '🟢', sensitive: '🟠' })
export function lockKindOf(key: string): LockKind {
  if (gateEntry(key)?.category === 3 || LOCKED_PANELS.some((p) => p.key === key && p.kind === 'action')) return 'action'
  return codeSectionOfPanel(key) === 'other' ? 'normal' : 'sensitive'
}

/**
 * ===========================================================================
 * بند ۱ — «مدیریت قفل رمز دوم به‌صورت ماژولار» (تنظیمات → رمز → قفل ماژول‌ها)
 *
 * تا این نسخه، هر پنلی که در `LOCKED_PANELS` بود *همیشه* قفل بود و راهی برای
 * باز گذاشتنش وجود نداشت. حالا مدیر می‌تواند برای هر ماژول جداگانه بگوید
 * «قفلش لازم نیست» — مثلاً فروشگاهی که فقط یک نفر پشت سیستم است و نمی‌خواهد
 * هر بار برای «گزارشات فروش» رمز بزند.
 *
 * قواعد ثابت و بدون استثنا:
 *   ۱) **پیش‌فرض همه‌چیز قفل است.** نبودن کلید در تنظیمات = قفل. مقدار خراب یا
 *      نصفه‌نیمه هم = قفل. هیچ مسیری وجود ندارد که «سکوت تنظیمات» به معنی
 *      «قفل باز» تفسیر شود؛ پس یک فایل تنظیمات پاک‌شده، برنامه را باز نمی‌کند.
 *   ۲) تغییر این تنظیم **رمز مدیر** می‌خواهد، نه رمز دوم پنل تنظیمات. وگرنه
 *      کارمندی که رمز دوم «تنظیمات» را دارد می‌توانست قفل همه‌ی پنل‌ها را
 *      بردارد و کل برنامه را باز کند.
 *   ۳) قانون همیشگی پروژه دست‌نخورده است: هر ماژول جدید **باید** کلید و
 *      `ManagerGate` خودش را داشته باشد. این تنظیم فقط اجازه می‌دهد مدیر آن قفل
 *      را — آگاهانه — خاموش کند؛ جای نساختن قفل را نمی‌گیرد.
 *   ۴) خودِ «تنظیمات» قابل باز گذاشتن نیست (`ALWAYS_LOCKED`). دلیلش امنیتی و
 *      عمدی است: داخل همین پنل، «بازگردانی بکاپ»، «حذف گزارشات» و «سبک‌سازی
 *      دیتابیس» هست. اگر قفلش برداشته شود، هر کسی که پشت سیستم بنشیند می‌تواند
 *      داده‌ی فروشگاه را جایگزین یا پاک کند و مدیر هم دیگر جایی برای برگرداندن
 *      قفل ندارد. بقیه‌ی ۱۹ پنل آزادند.
 * ===========================================================================
 */

/**
 * کلید ذخیره‌سازی این سیاست روی جدول Setting، در `SETTING_KEYS.panelLocks`
 * (src/shared/receipt.ts) است — همان‌جایی که بقیه‌ی کلیدهای تنظیمات هستند.
 */
/**
 * پنل‌هایی که قفلشان *قابل برداشتن نیست* (قاعده‌ی ۴ بالا).
 * طرح ۱۴۰۵ (۲۵-۱۱، اصل «د»): همهٔ قفل‌ها خاموش‌شدنی‌اند، از جمله «تنظیمات»؛ پس فهرست خالی است.
 * کارهای خطرناک داخل تنظیمات (بازگردانی، ادغام، پاک‌سازی، صفر کردن) هر کدام «قفل کار» جدای خودشان را
 * دارند و با خاموش شدن قفل «تنظیمات» خاموش نمی‌شوند (§۳-۱، «جدا بودن»).
 */
export const ALWAYS_LOCKED_PANELS: readonly string[] = []

/**
 * ===========================================================================
 * پنل‌هایی که **فقط** با رمز مدیر باز می‌شوند (رمز دوم/سوم برایشان بی‌اثر است)
 * ---------------------------------------------------------------------------
 * نشست ۱۸۳ این فهرست را با «تنظیمات» پر کرد، چون از داخل آن پنل می‌شود قفل
 * بقیه‌ی بخش‌ها را برداشت. نشست ۱۸۷ به‌دستور صریح مالک آن استثنا را برداشت:
 * ماژول تنظیمات هم مثل بقیه‌ی ماژول‌ها رمز دوم و رمز سومِ شیفت می‌گیرد.
 * «هیچ ضرری ندارد و تصمیم با خود مدیر است که قفل بگذارد یا نگذارد.»
 *
 * ایمنی باقی‌مانده (عمداً دست‌نخورده):
 *   • `ALWAYS_LOCKED_PANELS` — قفلِ ورود به صفحه‌ی تنظیمات خاموش نمی‌شود؛
 *     یعنی *یک* رمز (مدیر / دوم / سوم) همیشه لازم است.
 *   • تعریف/حذف رمز دوم و سوم، و تغییر «قفل ماژول‌ها»، همچنان **رمز مدیر**
 *     می‌خواهند (`setPanelPassword` / `setPanelShiftPassword` / `setPanelLocks`).
 *     دارنده‌ی رمز دوم تنظیمات فقط همان صفحه را باز می‌کند، نه سیاست کل سیستم را.
 *
 * فهرست خالی یعنی هیچ پنلی از رمز دوم/سوم محروم نیست. helper پایین برای
 * سازگاری با تست‌ها و صدازننده‌های قدیمی مانده است.
 * ===========================================================================
 */
export const MANAGER_ONLY_PANELS: readonly string[] = []

/** این پنل فقط با رمز مدیر باز می‌شود (رمز دوم/سوم برایش بی‌اثر است)؟ */
export function isManagerOnlyPanel(panel: string | null | undefined): boolean {
  const key = normalizePanelKey(panel)
  return !!key && MANAGER_ONLY_PANELS.includes(key)
}

/** این پنل از فهرست استثناهاست (قفلش همیشه روشن است)؟ */
export function isAlwaysLocked(panel: string): boolean {
  return ALWAYS_LOCKED_PANELS.includes(panel)
}

/**
 * سیاست قفل: `{ '<کلید پنل>': false }` یعنی «قفل این ماژول خاموش است».
 * هر کلیدی که اینجا نباشد یا مقدارش `true` باشد ⇒ قفل روشن (پیش‌فرض).
 */
export type PanelLockConfig = Record<string, boolean>

/**
 * پیکربندی پیش‌فرض قفل‌ها: همه‌ی ماژول‌ها و عملیات حساس قفل‌اند. به‌ویژه
 * «اصلاح/ابطال برگشت و تعویض» از این قاعده استثنا ندارد؛ مدیر فقط با تنظیم
 * آگاهانه می‌تواند یک قفل را خاموش کند.
 */
export function allLockedConfig(): PanelLockConfig {
  const out: PanelLockConfig = {}
  for (const p of LOCKED_PANELS) out[p.key] = true
  return out
}

/**
 * خواندن ایمن سیاست قفل.
 * ورودی خراب، رشته‌ی بی‌ربط، کلید ناشناس یا مقدار غیر‌بولین ⇒ نادیده گرفته
 * می‌شود و همان پیش‌فرض «قفل» می‌ماند. فقط و فقط مقدار *دقیقاً* `false` روی یک
 * کلید معتبر، قفل را خاموش می‌کند.
 */
export function parsePanelLocks(raw: unknown): PanelLockConfig {
  const out = allLockedConfig()
  let obj: any = raw
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj)
    } catch {
      return out
    }
  }
  if (!obj || typeof obj !== 'object') return out
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const panel = normalizePanelKey(key)
    if (!panel) continue
    if (isAlwaysLocked(panel)) continue
    out[panel] = value !== false
  }
  return out
}

/** قفل این پنل روشن است؟ (ورودی نامعتبر یا ناشناس ⇒ بله، روشن). */
export function isPanelLockEnabled(cfg: PanelLockConfig | null | undefined, panel: string): boolean {
  if (isAlwaysLocked(panel)) return true
  const key = normalizePanelKey(panel)
  if (!key) return true
  return cfg?.[key] !== false
}

/** چند پنل قفلشان خاموش است (برای نمایش خلاصه در تنظیمات و نوار بالا). */
export function openPanelCount(cfg: PanelLockConfig | null | undefined): number {
  return LOCKED_PANELS.filter((p) => !isPanelLockEnabled(cfg, p.key)).length
}

/**
 * ---------------------------------------------------------------------------
 * «گیت»های قفل موقت (بخش ۲).
 *
 * هر نقطه‌ی ورود رمز یک شناسه‌ی مستقل دارد تا شمارنده‌ی تلاش ناموفق و زمان قفلش
 * جدا نگه داشته شود: رمز اشتباه زدن روی پنل کالاها نباید بستن صندوق را هم قفل
 * کند. صفحه‌ی ورود رمز مدیر (`useManagerSession.login` → `manager:verify`) گیت
 * مخصوص خودش را دارد.
 * ---------------------------------------------------------------------------
 */
export const MANAGER_GATE = '__manager__'

/**
 * جلسه ۲۰ · §۸ — گیت «ورود کد اعتبار خرید».
 *
 * حدس‌زدن کد اعتبار دقیقاً همان حمله‌ی «رمز اشتباه پشت‌سرهم» است: کسی جلوی
 * صندوق می‌ایستد و کد بعد از کد می‌زند تا به یک اعتبار زنده بخورد. پس **سیستم
 * جدیدی ساخته نشد**؛ همین کد از همان جدول `AuthLockout` و همان
 * `securityConfig` (تعداد تلاش مجاز + دقیقه‌ی قفل) استفاده می‌کند و فقط یک
 * شناسه‌ی گیت مستقل دارد تا کد اشتباه زدنِ فروشنده، پنل‌ها را قفل نکند.
 */
export const CREDIT_CODE_GATE = '__credit_code__'

/** شناسه‌ی گیت یک پنل (همان کلید پنل) یا گیت رمز مدیر. */
export function gateIdOf(panel?: string | null): string {
  const key = normalizePanelKey(panel)
  return key ?? MANAGER_GATE
}

/** نام فارسی یک گیت برای پیام‌ها. */
export function gateTitle(gate: string): string {
  if (gate === MANAGER_GATE) return 'ورود رمز مدیر'
  if (gate === CREDIT_CODE_GATE) return 'ورود کد اعتبار خرید'
  return panelTitle(gate)
}
