import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { call, CH } from '../lib/api'
// نشست ۳۱۶ — جداکننده‌ی هزارگانِ زنده در ورودی «مبلغ بازپرداخت» (state همچنان رقمِ خام)
import { digitsOnly, groupThousands } from '../lib/moneyInput'
// نشست ۲۲۲ · فاز ۳ — نقطه‌ی مشترک چاپ (پرسش/بی‌پرس + چاپگر)
import { printWith } from '../lib/printFlow'
import { isUnknownPrintMessage } from '../lib/printErrors'
import { useBarcodeScanner, useFieldScanDetector } from '../hooks/useBarcodeScanner'
import ConfirmDialog from '../components/ConfirmDialog'
import PasswordField from '../components/PasswordField'
import OverpayFlowDialogs, { printOverpayCredit, type OverpayCreditPrintProblem } from '../components/OverpayFlowDialogs'
import {
  isOverpayWarning,
  needsManagerPassword,
  overpayFlowStart,
  overpayFlowAskPassword,
  overpayCreditFlash,
  type OverpayFlowState,
  type OverpayRequest
} from '@shared/overpayFlow'
import ReturnEditModal from '../components/ReturnEditModal'
import JalaliDateInput from '../components/JalaliDateInput'
import VariantSearchBox, { type VariantSearchBoxHandle } from '../components/VariantSearchBox'
import { useCharges } from '../hooks/useCharges'
import { faDigits, money, jalaliToday, isValidJalaliDate, parseGroupedInteger } from '@shared/jalali'
import { returnValueOf, isReturnableStatus } from '@shared/returnValue'
import { discountTransferExplanation } from '@shared/discountTransfer'
import type { ExchangeSaleResult, ReturnLookup, ReturnLookupItem, CardPosOverrideInput } from '@shared/types'
import InvoiceFinanceBadge from '../components/returns/InvoiceFinanceBadge'
import SmartSettlementPanel from '../components/returns/SmartSettlementPanel'
import ReturnCreditHandoffActions from '../components/returns/ReturnCreditHandoffActions'
import CardPosOverrideDialog from '../components/returns/CardPosOverrideDialog'
import { useReturnGuidance } from '../hooks/useReturnGuidance'
import { usePanelLock, usePanelOpen } from '../hooks/usePanelLocks'
import { useManagerSession } from '../hooks/useManagerSession'
import { PANEL_KEYS } from '@shared/panels'

/**
 * ===================== برگشت از فروش و تعویض کالا =====================
 * جریان کار (همان چیزی که در فروشگاه اتفاق می‌افتد):
 *
 *   ۱) مشتری رسید را می‌آورد. کاربر کد برگشت یا شمارهٔ فیش را وارد می‌کند — یا بارکد
 *      روی رسید را با بارکدخوان اسکن می‌کند (بدون تایپ).
 *   ۲) سیستم روش پیدا کردن، وجود کد و مهلت آن را جداگانه نشان می‌دهد؛ تاریخ‌ها
 *      با قاعدهٔ پایان روز تهران بررسی می‌شوند و مهلت نامعلوم/گذشته اجازهٔ ثبت نمی‌دهد.
 *   ۳) کاربر تعداد برگشتی هر قلم را می‌گذارد (کامل یا جزئی) و ثبت می‌کند؛
 *      همان تعداد به موجودی انبار برمی‌گردد (حرکت انبار SALE_RETURN، قطعی).
 *
 * ---------------------------- تعویض کالا (بخش ۶) ----------------------------
 * با روشن کردن چک‌باکس «تعویض کالا»، زیر جدول اقلام یک بخش «کالای جایگزین» باز
 * می‌شود که *همان سه روش پنل فروش* را دارد: اسکن بارکد (بارکدخوان در همین صفحه
 * فعال است)، جست‌وجوی نام، و تایپ کد کالا — به‌علاوه‌ی دکمه‌ی «همه کالاها».
 * کنار هر قلم برگشتی هم دکمه‌ی «+ جایگزین» هست که همان کادر را فوکوس می‌کند و
 * می‌گوید جایگزین کدام قلم در حال انتخاب است.
 *
 * «مابه‌التفاوت» زنده و همان لحظه حساب می‌شود (جمع کالای جایگزین − جمع کالای
 * برگشتی) و روی صفحه سه حالتش روشن نوشته می‌شود:
 *   • مثبت ⇒ مشتری می‌پردازد و روش پرداخت باید صریح انتخاب شود.
 *   • منفی ⇒ بدهی فاکتور و اعتبار منشأدار جداگانه حساب می‌شوند؛ اگر وجه واقعی باقی بماند،
 *     فروشنده باید روش تسویه را صریح انتخاب کند (هیچ اعتبار/روش پیش‌فرضی صادر نمی‌شود).
 *   • صفر یا نبود وجه واقعی برای تسویه ⇒ روش تسویه لازم نیست.
 * دکمه‌ی «ثبت تعویض کالا» کانال IPC `sale:exchange:create` را صدا می‌زند و کل
 * کار (برگشت + سند تعویض + تسویه + صدور بارکد) در یک تراکنش سمت main انجام
 * می‌شود؛ این صفحه هیچ محاسبه‌ی مالی‌ای را «تصمیم» نمی‌گیرد، فقط نمایش می‌دهد.
 * بعد از ثبت، دکمه‌ی «چاپ سند تعویض» (کانال `print:exchange`) همان‌جا می‌آید.
 *
 * کالای حذف‌شده از انبار:
 *   اگر کالای یک قلم از فهرست کالاهای انبار حذف شده باشد، پیام روشن
 *   «این کالا از موجودی انبار حذف شده است» نمایش داده می‌شود و آن قلم به‌طور
 *   خودکار برگشت نمی‌خورد. فقط با تیک زدن «رسیدگی دستی» (تایید آگاهانه‌ی
 *   کاربر) برگشتش ثبت می‌شود. کالایی که رکوردش کلاً از سیستم رفته باشد، در هیچ
 *   حالتی برگشت خودکار نمی‌خورد (فقط هشدار).
 *
 * ویرایش و حذف یک برگشت ثبت‌شده:
 *   هر ردیف فهرست برگشت‌ها دو دکمه دارد. «ویرایش» فرم اصلاح تعداد/اقلام همان
 *   برگشت را باز می‌کند و «حذف» بعد از یک تاییدیه، آن برگشت را باطل می‌کند و
 *   اثرش روی موجودی انبار کامل برگردانده می‌شود. هر دو، همان سرویس‌های آماده‌ی
 *   فروش را صدا می‌زنند (منطق موجودی سمت main است، نه اینجا).
 *
 * IPC: sale:byReturnCode · sale:return · sale:return:list · sale:return:get ·
 *      sale:return:update · sale:return:delete · print:invoice ·
 *      sale:exchange:create · print:exchange · payment:methods
 * =========================================================
 */

interface QtyMap {
  [saleItemId: number]: number
}

/** عملیاتی که فقط پس از بازشدن قفل مستقل اصلاح/ابطال اجرا می‌شود. */
type ReturnCorrectionAction = 'EDIT' | 'VOID' | 'RECONCILE'
type PendingReturnCorrectionAction = { action: ReturnCorrectionAction; row: any }

interface Method {
  id: number
  key: string
  label: string
  kind: string
}

const returnLookupInput = (value: Pick<ReturnLookup, 'lookupKind' | 'returnCode' | 'receiptNo'>): string =>
  value.lookupKind === 'RETURN_CODE' && value.returnCode
    ? value.returnCode
    : String(value.receiptNo)

/** یک قلم «جایگزین» در فرم تعویض کالا (همان شکل ردیف سبد پنل فروش). */
interface RepLine {
  variantId: number
  code: string
  barcode: string
  name: string
  qty: number
  unitPrice: number
  /**
   * ---------------------- بند ۱۸ سند مرجع (جلسه ۱۶) ----------------------
   * قیمت *واقعیِ* ثبت‌شده‌ی کالا (`variant.salePrice`) در لحظه‌ی انتخاب.
   *
   * چرا نگه داشته می‌شود؟ چون قیمت کالای جایگزین همیشه از همین عدد شروع می‌کند و
   * تغییر دستی‌اش فقط با رمز مدیر ممکن است. فروشنده‌ای که کالای برگشتیِ ۳
   * میلیونی را با کالایی که قیمت واقعی‌اش ۱ میلیون است ولی روی صفر گذاشته
   * تعویض کند، ۳ میلیون اعتبار خرید می‌گیرد و در گزارش هیچ چیز غیرعادی دیده
   * نمی‌شود. با داشتن «قیمت واقعی» کنار «قیمت واردشده»، هم صفحه اختلاف را
   * فریاد می‌زند و هم `AuditLog` سمت main هر دو عدد را ثبت می‌کند.
   */
  realPrice: number
  discount: number
  /** موجودی لحظه‌ی انتخاب — فقط برای هشدار زودهنگام کمبود موجودی */
  stock: number
  /** نشست ۱۵۸ (Y16) — دسته‌ی کالا برای عوارض/حق سرویس (سرور از دیتابیس دوباره می‌سنجد) */
  categoryId: number | null
}

/** بند ۱۱ — چهار روش بازپرداخت برگشت ساده. هیچ‌کدام پیش‌فرض نیست. */
type RefundMethodValue = 'CASH' | 'CARD' | 'STORE_CREDIT' | 'CARD_TO_CARD' | 'NONE'

const REFUND_CHOICES: { value: RefundMethodValue; title: string; hint: string }[] = [
  {
    value: 'CASH',
    title: 'بازپرداخت نقدی',
    hint: 'پول از کشوی صندوق بیرون می‌رود و در «بستن صندوق» از موجودی انتظاری کم می‌شود.'
  },
  {
    value: 'CARD',
    title: 'بازپرداخت کارتی',
    hint: 'به کارت مشتری برگشت؛ روی کارت‌خوان اثر دارد، ولی از کشوی صندوق پولی بیرون نمی‌رود.'
  },
  {
    value: 'STORE_CREDIT',
    title: 'بارکد اعتبار خرید بعدی',
    hint: 'هیچ نقدی جابه‌جا نمی‌شود؛ یک بدهی ما به مشتری ثبت و بارکد یک‌بارمصرف صادر می‌شود.'
  },
  /**
   * ---------------------- جلسه ۱۷ · بند ۱ ----------------------
   * یک مسیر **کاملاً جدا** از گزینه‌ی «بازپرداخت کارتی» بالا.
   *   • «کارتی» = تسویه‌ی *فوری* با دستگاه کارت‌خوان خودِ فروشگاه (دست‌نخورده).
   *   • «کارت‌به‌کارت توسط مدیر» = هیچ پرداختی همین حالا انجام نمی‌شود؛ فقط یک
   *     «درخواست پرداخت» با وضعیت «در انتظار پرداخت» ساخته می‌شود و مدیر بعداً
   *     از تب «درخواست‌های کارت‌به‌کارت» گزارشات فروش آن را تأیید می‌کند.
   * این مبلغ نه از کشوی صندوق خارج می‌شود و نه در سرجمع فروش می‌آید.
   */
  {
    value: 'CARD_TO_CARD',
    title: 'کارت‌به‌کارت توسط مدیر (در انتظار پرداخت)',
    hint: 'پرداخت فوری انجام نمی‌شود: یک درخواست پرداخت به فاکتور، برگشت، شیفت و کارمند ثبت‌کننده وصل می‌شود و مدیر آن را از گزارشات فروش تأیید می‌کند. کارت‌خوان فروشگاه و کشوی صندوق هیچ اثری نمی‌گیرند.'
  },
  {
    value: 'NONE',
    title: 'بدون بازپرداخت (فقط بدهی مشتری کم شود)',
    hint: 'برای فاکتور نسیه‌ی پرداخت‌نشده: طلب ما کم می‌شود و هیچ پولی جابه‌جا نمی‌گردد.'
  }
]

/** بند ۱۲ — سه گزینه‌ی *متقابلاً انحصاری* تسویه‌ی مابه‌التفاوت منفی تعویض. */
const EXCHANGE_REFUND_CHOICES: { value: 'CASH' | 'CARD' | 'STORE_CREDIT' | 'CARD_TO_CARD'; title: string; hint: string }[] = [
  { value: 'CASH', title: 'بازپرداخت نقدی', hint: 'پول از کشوی صندوق بیرون می‌رود (یک بازپرداخت واقعی ثبت می‌شود).' },
  { value: 'CARD', title: 'بازپرداخت کارتی', hint: 'به کارت مشتری برگشت؛ از کشو پولی بیرون نمی‌رود.' },
  { value: 'STORE_CREDIT', title: 'صدور اعتبار خرید', hint: 'بارکد یک‌بارمصرف صادر می‌شود؛ اثر نقدی صفر.' },
  { value: 'CARD_TO_CARD', title: 'کارت‌به‌کارت توسط مدیر', hint: 'پرداخت فوری انجام نمی‌شود؛ درخواست پرداخت برای تایید مدیر ثبت می‌شود.' }
]

/** نشست ۲ · C1 — ارزش برگشت هر قلم، دقیقاً همان فرمول main (سهم واقعی پرداختی مشتری) */
const returnValueFor = (i: ReturnLookupItem, q: number) => returnValueOf(i.netLineValue ?? 0, i.qty, i.returnedQty, q)

const canReturn = (i: ReturnLookupItem) => i.stockState !== 'MISSING' && i.remainingQty > 0

export default function SalesReturn() {
  const nav = useNavigate()
  /**
   * اصلاح/ابطال یک قفل عملیاتی مستقل دارد: باز بودن خودِ صفحه‌ی برگشت مجوز
   * تغییر سند قبلی نیست. تا بارگیری سیاست هم fail-closed می‌مانیم.
   */
  const correctionOpen = usePanelOpen(PANEL_KEYS.salesReturnCorrection)
  const { loaded: correctionLockLoaded } = usePanelLock(PANEL_KEYS.salesReturnCorrection)
  const { unlockPanel } = useManagerSession()
  const [correctionUnlockRequest, setCorrectionUnlockRequest] = useState<PendingReturnCorrectionAction | null>(null)
  const [correctionUnlockPassword, setCorrectionUnlockPassword] = useState('')
  const [correctionUnlockBusy, setCorrectionUnlockBusy] = useState(false)
  const [correctionUnlockError, setCorrectionUnlockError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [lookup, setLookup] = useState<ReturnLookup | null>(null)
  const [qty, setQty] = useState<QtyMap>({})
  const [allowRemoved, setAllowRemoved] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [printing, setPrinting] = useState(false)
  const printingRef = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmForce, setConfirmForce] = useState<string | null>(null)
  const [history, setHistory] = useState<any[]>([])
  /** null یعنی فروشنده هنوز انتخاب نکرده؛ با حق مثبت، سرور از ثبت نهایی جلوگیری می‌کند. */
  const [refundMethod, setRefundMethod] = useState<RefundMethodValue | null>(null)
  /** خالی = کل مبلغ برگشت (همان پیش‌فرض سمت سرور) */
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReference, setRefundReference] = useState('')
  const [refundNote, setRefundNote] = useState('')
  const [managerFullRefund, setManagerFullRefund] = useState(false)
  const [fullRefundPw, setFullRefundPw] = useState('')
  const [fullRefundReason, setFullRefundReason] = useState('')
  /** نتیجه‌ی برگشت ساده‌ی تازه ثبت‌شده — برای دکمه‌ی «چاپ رسید برگشت» (بند ۱۳) */
  const [retResult, setRetResult] = useState<any | null>(null)
  /** نشست ۱۸۹ · بند ۴-۳۵ — فلو چهارمرحله‌ای اضافه‌دریافت ساخته‌شده با برگشت */
  const [overpayFlow, setOverpayFlow] = useState<OverpayFlowState | null>(null)
  const [overpayReq, setOverpayReq] = useState<OverpayRequest>({})
  const [issuedOverpayCredit, setIssuedOverpayCredit] = useState<any | null>(null)
  const issuedOverpayCreditOpenRef = useRef(false)
  const [overpayCreditPrinting, setOverpayCreditPrinting] = useState(false)
  const [overpayCreditPrintProblem, setOverpayCreditPrintProblem] = useState<OverpayCreditPrintProblem>(null)
  /**
   * بند ۱۲ — تسویه‌ی مابه‌التفاوت *منفی* تعویض؛ بدون پیش‌فرض ضمنی.
   * جلسه ۱۷ · بند ۱ — گزینه‌ی چهارم «کارت‌به‌کارت توسط مدیر» هم اضافه شد و
   * عمداً یک مقدار *جدا* است، نه حالتی از `CARD`.
   */
  const [exRefundMode, setExRefundMode] = useState<'CASH' | 'CARD' | 'STORE_CREDIT' | 'CARD_TO_CARD' | null>(null)
  /** خالی یعنی کل سهم وجه واقعی نقدی؛ مبلغ کمتر، مانده را به اعتبار عادی تبدیل می‌کند. */
  const [exRefundPayoutAmount, setExRefundPayoutAmount] = useState('')
  /**
   * بند ۱۸ — قفل قیمت دستیِ کالای جایگزین. تا این قفل با رمز مدیر باز نشود،
   * کادرهای قیمت غیرفعال‌اند و همیشه همان `variant.salePrice` را نشان می‌دهند.
   */
  const [priceOverrideOn, setPriceOverrideOn] = useState(false)
  const [managerPw, setManagerPw] = useState('')
  /**
   * بند ۱۷ — قفل دوره‌ی بسته‌شده. سرور با یک پیام روشن رد می‌کند؛ این دو فیلد
   * *فقط بعد از همان پیام* روی صفحه می‌آیند تا کاربر عادی حتی نبیندشان.
   */
  const [lockNeeded, setLockNeeded] = useState(false)
  const [lockPw, setLockPw] = useState('')
  const [lockReason, setLockReason] = useState('')
  /** گیت سقف اعتبار مستقل از مجوز قیمت دستی/دوره؛ فقط پس از پیام سرور نمایش داده می‌شود. */
  const [creditLimitNeeded, setCreditLimitNeeded] = useState(false)
  const [creditLimitPw, setCreditLimitPw] = useState('')
  /** نشست ۳۱۹ — تأیید مدیر برای بازپرداخت کارتی (کارت‌خوان) */
  const [cardPosDialog, setCardPosDialog] = useState(false)
  const [cardPosOverride, setCardPosOverride] = useState<CardPosOverrideInput | null>(null)
  const guidance = useReturnGuidance(lookup, qty)
  // ---- بخش ۶: تعویض کالا ----
  /** حالت تعویض روشن است؟ (خاموش = همان برگشت ساده‌ی همیشگی، دست‌نخورده) */
  const [exchangeMode, setExchangeMode] = useState(false)
  const [reps, setReps] = useState<RepLine[]>([])
  const [methods, setMethods] = useState<Method[]>([])
  const [methodId, setMethodId] = useState<number | null>(null)
  /** پرداخت مثبت تعویض با دو ردیف واقعی نقد و کارت، نه یک پرداخت مصنوعی. */
  const [exSplitPayment, setExSplitPayment] = useState(false)
  const [exSplitCash, setExSplitCash] = useState('')
  const [exCreditCode, setExCreditCode] = useState('')
  const [exCreditVerifiedCode, setExCreditVerifiedCode] = useState<string | null>(null)
  const [exCreditInfo, setExCreditInfo] = useState<any | null>(null)
  const [exFundingPreview, setExFundingPreview] = useState<any | null>(null)
  const [exFundingPreviewBusy, setExFundingPreviewBusy] = useState(false)
  const [exFundingPreviewError, setExFundingPreviewError] = useState<string | null>(null)
  const [discountTransferOption, setDiscountTransferOption] = useState<'NO' | 'YES' | 'YES_ZERO' | null>(null)
  const [exCreditPreview, setExCreditPreview] = useState<any | null>(null)
  const [exCreditPreviewBusy, setExCreditPreviewBusy] = useState(false)
  const [exCreditBusy, setExCreditBusy] = useState(false)
  const [exCreditError, setExCreditError] = useState<string | null>(null)
  const exchangeRequestKeyRef = useRef<string | null>(null)
  const exchangeRequestSignatureRef = useRef<string | null>(null)
  const [exSplitCard, setExSplitCard] = useState('')
  const [exSplitCashMethodId, setExSplitCashMethodId] = useState<number | null>(null)
  const [exSplitCardMethodId, setExSplitCardMethodId] = useState<number | null>(null)
  /** کمبود موجودی کالای جایگزین از انبار مرکزی برداشته شود؟ */
  const [repAutoCentral, setRepAutoCentral] = useState(false)
  /** جایگزینِ کدام قلم برگشتی در حال انتخاب است (فقط یک راهنمای روی صفحه) */
  const [repFor, setRepFor] = useState<string | null>(null)
  /** نتیجه‌ی تعویضِ تازه ثبت‌شده (کد بارکد اعتبار + دکمه‌ی چاپ سند) */
  const [exResult, setExResult] = useState<
    | (ExchangeSaleResult & {
        cashReceived?: number
        exchangeCreditApplied?: number
        /** جلسه ۱۷ · بند ۱ — درخواست کارت‌به‌کارتی که همین تعویض ساخته است */
        cardTransfer?: { id: number; amount: number; status: string } | null
      })
    | null
  >(null)
  const [confirmExchange, setConfirmExchange] = useState<string | null>(null)
  const [repModalOpen, setRepModalOpen] = useState(false)
  // ---- فهرست برگشت‌ها: بازه‌ی تاریخ + ویرایش/حذف هر ردیف ----
  const [histFrom, setHistFrom] = useState(jalaliToday())
  const [histTo, setHistTo] = useState(jalaliToday())
  const [editId, setEditId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  /** نشست ۶۴ · بند ۴-۲۲ — «حذف» = ابطال با دلیل اجباری (سند می‌ماند) */
  const [voidReason, setVoidReason] = useState('')
  /**
   * قفل پیش‌فرضِ اصلاح/ابطال. در روز/دوره‌ی بسته همین فیلد باید رمز مدیر
   * باشد؛ در روز جاری رمز مدیر یا رمز دوم اختصاصی این عمل کافی است.
   */
  const [voidAuthPassword, setVoidAuthPassword] = useState('')
  /** برای روزهای بعد/دوره‌بسته: مدیر مشخص + رمز شخصی همان مدیر (نه رمز سراسری). */
  const [voidApproverUserId, setVoidApproverUserId] = useState<number | null>(null)
  const [voidApproverPassword, setVoidApproverPassword] = useState('')
  const [voidManagers, setVoidManagers] = useState<{ id: number; name: string; role: string; isActive: boolean; hasCorrectionApprovalPassword?: boolean }[]>([])
  const [voidReasonErr, setVoidReasonErr] = useState<string | null>(null)
  /** دفتر جبرانیِ مستقل برای برگشتی که پول/اعتبارش واقعاً تعیین‌تکلیف شده است. */
  const [correctionTarget, setCorrectionTarget] = useState<any | null>(null)
  const [correctionReason, setCorrectionReason] = useState('')
  const [correctionAuthPassword, setCorrectionAuthPassword] = useState('')
  const [correctionApproverUserId, setCorrectionApproverUserId] = useState<number | null>(null)
  const [correctionApproverPassword, setCorrectionApproverPassword] = useState('')
  const [correctionCash, setCorrectionCash] = useState('')
  const [correctionCard, setCorrectionCard] = useState('')
  const [correctionCardReference, setCorrectionCardReference] = useState('')
  const [correctionCreditOutcome, setCorrectionCreditOutcome] = useState('NONE')
  const [correctionNote, setCorrectionNote] = useState('')
  const [correctionErr, setCorrectionErr] = useState<string | null>(null)
  const [correctionBusy, setCorrectionBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const repSearchRef = useRef<VariantSearchBoxHandle>(null)
  const scan = useFieldScanDetector()

  useEffect(() => {
    inputRef.current?.focus()
    call<Method[]>(CH.paymentMethods)
      .then((list) => {
        // Tender selection is a per-transaction seller decision; never preselect
        // the first active method (including the cash/card split fields).
        setMethods(list ?? [])
      })
      .catch(() => setMethods([]))
  }, [])

  const flash = (m: string) => {
    setMsg(m)
    setErr(null)
    window.setTimeout(() => setMsg((c) => (c === m ? null : c)), 10000)
  }

  /** مدیرهای فعال فقط برای مسیرهای دیرهنگام/دوره‌بسته خوانده می‌شوند. */
  const loadCorrectionManagers = () => {
    void call<{
      rows?: { id: number; name: string; role: string; isActive: boolean; hasCorrectionApprovalPassword?: boolean }[]
    }>(CH.staffDirectory, { includeInactive: false })
      .then((res) => setVoidManagers((res?.rows ?? []).filter((u) => u.role === 'MANAGER' && u.isActive)))
      .catch(() => setVoidManagers([]))
  }

  /** فقط پس از گیت، مودال/دیالوگِ تغییر واقعی باز می‌شود. */
  const launchReturnCorrectionAction = (request: PendingReturnCorrectionAction) => {
    const { action, row } = request
    if (action === 'EDIT') {
      setEditId(row.id)
      return
    }
    if (action === 'VOID') {
      setVoidReason('')
      setVoidAuthPassword('')
      setVoidApproverUserId(null)
      setVoidApproverPassword('')
      setVoidReasonErr(null)
      setDeleteTarget(row)
      loadCorrectionManagers()
      return
    }
    setCorrectionReason('')
    setCorrectionAuthPassword('')
    setCorrectionApproverUserId(null)
    setCorrectionApproverPassword('')
    setCorrectionCash('')
    setCorrectionCard('')
    setCorrectionCardReference('')
    setCorrectionCreditOutcome(row.storeCreditReference ? 'REMAINS_ACTIVE' : 'NONE')
    setCorrectionNote('')
    setCorrectionErr(null)
    setCorrectionTarget(row)
    loadCorrectionManagers()
  }

  /**
   * 🔒 درخواست کاربر: با قفل روشن، فرم تغییر هرگز زودتر از احراز هویت باز
   * نمی‌شود. پیام، مسیر درست را نشان می‌دهد؛ «فرم بسته بود ولی بعداً در سرور
   * رد شد» برای عملیات مالی تجربه‌ی امن یا قابل‌فهمی نیست.
   */
  const requestReturnCorrectionAction = (action: ReturnCorrectionAction, row: any) => {
    if (!correctionLockLoaded) {
      setMsg(null)
      setErr('وضعیت قفل اصلاح و ابطال هنوز در حال بررسی است. چند لحظه صبر کنید و دوباره تلاش کنید؛ تا آن زمان هیچ فرم تغییری باز نمی‌شود.')
      return
    }
    const request = { action, row }
    if (correctionOpen) {
      launchReturnCorrectionAction(request)
      return
    }
    setCorrectionUnlockError(null)
    setCorrectionUnlockPassword('')
    setCorrectionUnlockRequest(request)
  }

  /** همان گیت استاندارد برنامه: رمز مدیر، رمز دوم، یا رمز سومِ شیفت جاری. */
  const unlockReturnCorrectionAction = async () => {
    const request = correctionUnlockRequest
    const password = correctionUnlockPassword.trim()
    if (!request) return
    if (!password) {
      setCorrectionUnlockError('برای باز کردن قفل این عملیات، رمز مدیر یا رمز دوم/سوم همین بخش را وارد کنید.')
      return
    }
    setCorrectionUnlockBusy(true)
    setCorrectionUnlockError(null)
    try {
      await unlockPanel(PANEL_KEYS.salesReturnCorrection, password)
      setCorrectionUnlockRequest(null)
      setCorrectionUnlockPassword('')
      launchReturnCorrectionAction(request)
    } catch (e: any) {
      setCorrectionUnlockError(String(e?.message ?? 'رمز پذیرفته نشد.'))
      setCorrectionUnlockPassword('')
    } finally {
      setCorrectionUnlockBusy(false)
    }
  }

  const printIssuedOverpayCredit = async (credit: any | null, opts?: { reprintPassword?: string }) => {
    if (overpayCreditPrinting) return
    setOverpayCreditPrinting(true)
    setOverpayCreditPrintProblem(null)
    try {
      // نشست ۳۱۶ — چاپِ اولِ صدور بدون رمز؛ چاپ دوباره ⇒ reprint:true + رمز (سرور strict می‌سنجد)
      const problem = await printOverpayCredit(
        credit,
        opts?.reprintPassword ? { reprint: true, password: opts.reprintPassword } : undefined
      )
      if (problem) {
        if (issuedOverpayCreditOpenRef.current) setOverpayCreditPrintProblem(problem)
        else setErr(problem.msg)
      }
    } finally {
      setOverpayCreditPrinting(false)
    }
  }

  /** پیدا کردن فاکتور با کد (تایپ‌شده یا اسکن‌شده). */
  const lookupCode = useCallback(async (raw: string) => {
    const value = raw.trim()
    if (!value) return
    setBusy(true)
    setErr(null)
    try {
      const res = await call<ReturnLookup>(CH.saleByReturnCode, { code: value })
      setLookup(res)
      // Settlement/tender choices are explicit for each new lookup, never inherited.
      setMethodId(null)
      setExSplitPayment(false)
      setExSplitCashMethodId(null)
      setExSplitCardMethodId(null)
      setExRefundMode(null)
      setExRefundPayoutAmount('')
      // هیچ قلمی تیک‌خورده نیست تا کاربر آگاهانه تعداد بگذارد
      setQty({})
      setAllowRemoved(false)
      setNote('')
      setCode(returnLookupInput(res))
      scan.reset()
      if (res.warnings.length) setErr(res.warnings.join('\n'))
    } catch (e: any) {
      setLookup(null)
      setErr(e.message)
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** افزودن یک کالای جایگزین (اگر بود، فقط تعدادش زیاد می‌شود). */
  const addRep = useCallback((v: any) => {
    if (!v) return
    setErr(null)
    setReps((prev) => {
      const i = prev.findIndex((l) => l.variantId === v.id)
      if (i >= 0) {
        const copy = [...prev]
        copy[i] = { ...copy[i], qty: copy[i].qty + 1 }
        return copy
      }
      return [
        ...prev,
        {
          variantId: v.id,
          code: v.code ?? '',
          barcode: v.barcode ?? '',
          name: `${v.product?.name ?? ''}${v.size ? ' سایز ' + v.size : ''}${v.color ? ' - ' + v.color : ''}`,
          qty: 1,
          // بند ۱۸ — قیمت همیشه از خودِ کالا می‌آید، نه از ورودی دستی
          unitPrice: Math.max(0, Math.round(v.salePrice ?? 0)),
          realPrice: Math.max(0, Math.round(v.salePrice ?? 0)),
          discount: 0,
          stock: v.stock ?? 0,
          categoryId: v.product?.categoryId ?? null
        }
      ]
    })
    setRepFor(null)
  }, [])

  /** مسیر بارکدخوان فیزیکی برای کالای جایگزین: تطبیق کامل بارکد. */
  const addRepByBarcode = useCallback(
    async (barcode: string) => {
      try {
        const v = await call<any>(CH.variantByBarcode, { barcode })
        repSearchRef.current?.clear()
        if (!v) return setErr(`کالایی با بارکد ${faDigits(barcode)} پیدا نشد`)
        addRep(v)
      } catch (e: any) {
        setErr(e.message)
      }
    },
    [addRep]
  )

  /**
   * بارکدخوان سراسری این صفحه، *دو کاره* است:
   *   • در حالت عادی: اسکن بارکد رسید ⇒ پیدا کردن فاکتور.
   *   • در حالت تعویض و وقتی فاکتور پیدا شده: اسکن ⇒ افزودن کالای جایگزین.
   * پس فروشنده در همان جریان کار، بدون هیچ کلیکی، کالای جایگزین را اسکن می‌کند.
   */
  useBarcodeScanner(
    useCallback(
      (scanned: string) => {
        if (exchangeMode && lookup) return void addRepByBarcode(scanned)
        setCode(scanned)
        void lookupCode(scanned)
      },
      [exchangeMode, lookup, addRepByBarcode, lookupCode]
    ),
    { enabled: !confirmForce && !confirmExchange && editId == null && !deleteTarget && !repModalOpen }
  )

  const checkExchangeCredit = useCallback(async () => {
    const code = exCreditCode.trim()
    setExCreditError(null)
    setExCreditInfo(null)
    setExCreditVerifiedCode(null)
    if (!code) return setExCreditError('بارکد اعتبار را وارد یا اسکن کنید.')
    setExCreditBusy(true)
    try {
      const row = await call<any>(CH.storeCreditLookup, { code })
      setExCreditInfo(row)
      setExCreditVerifiedCode(code)
    } catch (e: any) {
      setExCreditError(String(e?.message ?? 'بررسی بارکد اعتبار ناموفق بود.'))
    } finally {
      setExCreditBusy(false)
    }
  }, [exCreditCode])

  const loadHistory = useCallback(async () => {
    if (!isValidJalaliDate(histFrom) || !isValidJalaliDate(histTo)) return
    try {
      setHistory(await call<any[]>(CH.saleReturnList, { fromJalali: histFrom, toJalali: histTo }))
    } catch {
      setHistory([])
    }
  }, [histFrom, histTo])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const items = lookup?.items ?? []
  const deadlineBlocked = !!lookup && (lookup.expiryState === 'EXPIRED' || lookup.expiryState === 'UNPROVEN')
  /** وضعیت فاکتور و مهلت هر دو در main هم دوباره بررسی می‌شوند؛ UI فقط زودتر هشدار می‌دهد. */
  const lookupLocked = !!lookup && (!isReturnableStatus(lookup.status) || deadlineBlocked)
  const lookupExpiryLabel = !lookup
    ? '—'
    : lookup.expiryState === 'VALID'
      ? lookup.expiresAtJalali == null
        ? 'بدون انقضا — کد معتبر است'
        : `${lookup.daysLeft == null ? '' : `${faDigits(lookup.daysLeft)} روز مانده`} (تا ${faDigits(lookup.expiresAtJalali)})`
      : lookup.expiryState === 'EXPIRED'
        ? `منقضی شده${lookup.expiresAtJalali ? ` · تا ${faDigits(lookup.expiresAtJalali)}` : ''}`
        : lookup.expiryState === 'UNPROVEN'
          ? 'مهلت در سابقه ثبت نشده؛ ثبت مسدود است'
          : 'برای این فاکتور کدی صادر نشده'
  const selected = useMemo(
    () => items.filter((i) => (qty[i.saleItemId] ?? 0) > 0),
    [items, qty]
  )
  const totals = useMemo(() => {
    const count = selected.length
    const q = selected.reduce((s, i) => s + (qty[i.saleItemId] ?? 0), 0)
    const amount = selected.reduce((s, i) => s + returnValueFor(i, qty[i.saleItemId] ?? 0), 0)
    return { count, qty: q, amount }
  }, [selected, qty])

  /**
   * مابه‌التفاوت زنده‌ی تعویض. عیناً همان فرمول سمت main
   * (`saleTotals` + `createExchange`): جمع اقلام جایگزین منهای تخفیف ردیف‌ها،
   * منهای ارزش کالای برگشتی. هیچ عدد جداگانه‌ای اینجا ساخته نمی‌شود.
   */
  /**
   * نشست ۱۵۸ (Y16) — عوارض/حق سرویس کالای جایگزین با همان تابع مشترک computeCharges و
   * تنظیمات کانال فاکتور اصلی (lookup.chargeScope)؛ سرور همین عدد را دوباره می‌سنجد و
   * اختلاف را رد می‌کند. خرده ⇒ عوارض روی ردیف؛ عمده ⇒ عوارض سطح فاکتور.
   */
  const posCharges = useCharges('pos')
  const wholesaleCharges = useCharges('wholesale')
  const exScope: 'pos' | 'wholesale' = lookup?.chargeScope === 'wholesale' ? 'wholesale' : 'pos'
  const exChargeHook = exScope === 'wholesale' ? wholesaleCharges : posCharges
  const exCharges = useMemo(
    () =>
      exChargeHook.compute(
        reps.map((l) => ({
          categoryId: l.categoryId ?? null,
          lineNet: Math.max(0, l.unitPrice * l.qty - Math.min(l.discount, l.unitPrice * l.qty)),
          qty: l.qty
        }))
      ),
    [exChargeHook, reps]
  )
  const exTotals = useMemo(() => {
    const goods = reps.reduce((s, l) => s + l.unitPrice * l.qty, 0)
    const discount = reps.reduce((s, l) => s + Math.min(l.discount, l.unitPrice * l.qty), 0)
    const tax = exCharges.taxTotal
    const service = exCharges.serviceTotal
    const exchangeTotal = Math.max(0, goods - discount + tax + service)
    return { goods, discount, tax, service, exchangeTotal, diff: exchangeTotal - totals.amount, qty: reps.reduce((s, l) => s + l.qty, 0) }
  }, [reps, totals.amount, exCharges])

  // Server-side read-only preview accounts for the source credit scope, expiry,
  // earlier returns and the actual money provenance. The create call rechecks
  // the same result in its own transaction and rolls back if it changed.
  useEffect(() => {
    if (!exchangeMode || !lookup || !selected.length || !reps.length) {
      setExFundingPreview(null)
      setExFundingPreviewBusy(false)
      setExFundingPreviewError(null)
      return
    }
    let alive = true
    setExFundingPreview(null)
    setExFundingPreviewBusy(true)
    setExFundingPreviewError(null)
    const timer = window.setTimeout(() => {
      call<any>(CH.saleExchangePreview, {
        invoiceId: lookup.invoiceId,
        lines: selected.map((item) => ({ saleItemId: item.saleItemId, qty: qty[item.saleItemId] ?? 0 })),
        replacements: reps.map((line, index) => ({
          variantId: line.variantId,
          qty: line.qty,
          unitPrice: line.unitPrice,
          discount: Math.max(0, Math.round(line.discount)),
          tax: exScope === 'pos' ? exCharges.taxPerLine[index] ?? 0 : 0
        })),
        invoiceTax: exScope === 'wholesale' ? exCharges.taxTotal : 0,
        serviceCharge: exCharges.serviceTotal,
        // NO is only a neutral preview baseline until the seller explicitly chooses; it is not selected in the UI.
        discountTransferOption: discountTransferOption ?? undefined,
        /**
         * مورد ۳ — مبلغ جزئیِ نقد/کارت هم به سرور می‌رود تا همان‌جا (با همان
         * plan پشتوانه و منشأ پرداخت) بگوید چه مقدار وجه خارج می‌شود و چه مقدار
         * به بارکد اعتبار خرید تبدیل می‌شود. خالی = کل سهم وجه واقعی.
         */
        refundAmount: exRefundPayoutAmount.trim() === ''
          ? undefined
          : Number(exRefundPayoutAmount.replace(/[^0-9]/g, ''))
      }).then((preview) => {
        if (!alive) return
        setExFundingPreview(preview)
        setExFundingPreviewError(preview.ok ? null : preview.error ?? 'پیش‌نمایش مابه‌التفاوت ممکن نشد.')
      }).catch((error: any) => {
        if (alive) setExFundingPreviewError(String(error?.message ?? 'پیش‌نمایش مابه‌التفاوت ناموفق بود.'))
      }).finally(() => alive && setExFundingPreviewBusy(false))
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [exchangeMode, lookup, selected, qty, reps, exCharges, exScope, discountTransferOption, exRefundPayoutAmount])

  const exSettlementDiff = exFundingPreview?.ok === true
    ? Math.round(Number(exFundingPreview.effectiveDiff ?? exTotals.diff))
    : exTotals.diff
  const effectiveExchangeTotal = Number(exFundingPreview?.exchangeTotal ?? exTotals.exchangeTotal)
  const effectiveTaxTotal = exFundingPreview?.replacementTaxes
    ? (exFundingPreview.replacementTaxes as number[]).reduce((sum, tax) => sum + Number(tax ?? 0), 0) + Number(exFundingPreview.invoiceTax ?? 0)
    : exTotals.tax
  const effectiveServiceCharge = Number(exFundingPreview?.serviceCharge ?? exTotals.service)
  const historicalTransferAmount = Number(exFundingPreview?.discountTransfer?.selectedAmount ?? 0)
  const discountTransferOptions: any[] = exFundingPreview?.discountTransfer?.options ?? []
  const discountTransferChoice = (option: 'NO' | 'YES' | 'YES_ZERO') =>
    discountTransferOptions.find((row) => row.option === option)
  const discountTransferNeedsChoice = Boolean(exFundingPreview?.discountTransfer && discountTransferOption == null)
  const discountTransferSettlementSummary = (row: any) => {
    if (!row) return null
    const effectiveDiff = Math.round(Number(row.effectiveDiff ?? 0))
    return (
      <span className="mt-2 block rounded bg-white/80 p-2 text-xs leading-6 text-slate-700">
        <span className="block font-semibold">
          مبلغ لازم از مشتری: {money(Math.max(0, effectiveDiff))} ریال
        </span>
        <span className="block">
          وجه واقعی قابل‌تسویه به مشتری: {money(Number(row.realMoneyRefund ?? 0))} ریال
          {' · '}کاهش بدهی فاکتور مبدأ: {money(Number(row.debtReduction ?? 0))} ریال
        </span>
        <span className="block">
          اعتبار مبدأ جداگانه: {money(Number(row.sourceCreditRestoration ?? 0))} ریال
          {Number(row.sourceCreditClosedExpired ?? 0) > 0 &&
            <> · اعتبار منقضیِ بسته‌شونده: {money(Number(row.sourceCreditClosedExpired))} ریال</>}
        </span>
      </span>
    )
  }

  useEffect(() => {
    const yes = exFundingPreview?.discountTransfer?.options?.find((option: any) => option.option === 'YES')
    if (discountTransferOption === 'YES' && yes && !yes.enabled) setDiscountTransferOption(null)
  }, [exFundingPreview, discountTransferOption])

  useEffect(() => {
    const code = exCreditCode.trim()
    if (!code || exCreditVerifiedCode !== code || !exCreditInfo || !exFundingPreview?.ok || exSettlementDiff <= 0) {
      setExCreditPreview(null)
      setExCreditPreviewBusy(false)
      return
    }
    let alive = true
    setExCreditPreview(null)
    setExCreditPreviewBusy(true)
    const lines = reps.map((line, index) => ({
      variantId: line.variantId,
      qty: line.qty,
      categoryId: line.categoryId ?? null,
      lineTotal: Math.max(
        0,
        line.unitPrice * line.qty - Math.min(line.discount, line.unitPrice * line.qty) +
          (exScope === 'pos' ? Math.max(0, Math.round(exFundingPreview.replacementTaxes?.[index] ?? exCharges.taxPerLine[index] ?? 0)) : 0)
      )
    }))
    call<any>(CH.creditPreview, {
      code,
      applicable: exSettlementDiff,
      invoiceTotal: Number(exFundingPreview.exchangeTotal ?? exTotals.exchangeTotal),
      requested: null,
      customerId: lookup?.customerId ?? null,
      lines
    })
      .then((preview) => {
        if (!alive) return
        setExCreditPreview(preview)
        setExCreditError(preview.ok ? null : preview.error ?? 'این اعتبار روی اقلام جایگزین قابل استفاده نیست.')
      })
      .catch((e: any) => {
        if (alive) setExCreditError(String(e?.message ?? 'پیش‌نمایش مصرف اعتبار ناموفق بود.'))
      })
      .finally(() => alive && setExCreditPreviewBusy(false))
    return () => {
      alive = false
    }
  }, [exCreditCode, exCreditVerifiedCode, exCreditInfo, exFundingPreview, exSettlementDiff, exTotals.exchangeTotal, reps, exScope, exCharges, lookup?.customerId])

  const exCreditRemaining = Math.max(0, Number(exCreditInfo?.amount ?? 0) - Number(exCreditInfo?.usedAmount ?? 0))
  const exCreditAppliedPreview =
    exCreditVerifiedCode && exCreditVerifiedCode === exCreditCode.trim() && exCreditPreview?.ok === true
      ? Math.min(exSettlementDiff, Math.max(0, Number(exCreditPreview.applied ?? 0)))
      : 0
  const exCashDuePreview = Math.max(0, exSettlementDiff - exCreditAppliedPreview)

  const repShort = useMemo(() => reps.filter((l) => l.qty > l.stock), [reps])
  const cashMethods = useMemo(() => methods.filter((method) => method.kind === 'CASH'), [methods])
  const cardMethods = useMemo(() => methods.filter((method) => method.kind === 'CARD'), [methods])
  /** مثل POS: اعشار/منفی/حرف هرگز با حذف‌شدن کاراکترها به مبلغ دیگری تبدیل نمی‌شوند. */
  const exSplitCashAmount = useMemo(() => parseGroupedInteger(exSplitCash), [exSplitCash])
  const exSplitCardAmount = useMemo(() => parseGroupedInteger(exSplitCard), [exSplitCard])
  const exSplitTotal = useMemo(() => {
    if (exSplitCashAmount == null || exSplitCardAmount == null) return null
    const total = exSplitCashAmount + exSplitCardAmount
    return Number.isSafeInteger(total) ? total : null
  }, [exSplitCashAmount, exSplitCardAmount])
  /** بند ۱۸ — قلم‌هایی که قیمتشان دستی از قیمت واقعی کالا جدا شده است. */
  const priceChanged = useMemo(() => reps.filter((l) => l.unitPrice !== l.realPrice), [reps])

  const removedSelected = selected.filter((i) => i.stockState === 'REMOVED')
  const isFull = useMemo(
    () => !!items.length && items.every((i) => (qty[i.saleItemId] ?? 0) >= i.remainingQty && i.remainingQty > 0),
    [items, qty]
  )

  const setQtyFor = (i: ReturnLookupItem, v: number) =>
    setQty((p) => ({ ...p, [i.saleItemId]: Math.max(0, Math.min(Math.round(v || 0), i.remainingQty)) }))

  const selectAll = () => {
    const next: QtyMap = {}
    for (const i of items) if (canReturn(i)) next[i.saleItemId] = i.remainingQty
    setQty(next)
  }
  const clearAll = () => setQty({})

  const patchRep = (variantId: number, patch: Partial<RepLine>) =>
    setReps((p) => p.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)))
  const removeRep = (variantId: number) => setReps((p) => p.filter((l) => l.variantId !== variantId))

  /** فوکوس روی کادر انتخاب کالای جایگزین (دکمه‌ی «+ جایگزین» هر قلم برگشتی). */
  const focusRep = (forName?: string | null) => {
    if (!exchangeMode) setExchangeMode(true)
    setRepFor(forName ?? null)
    window.setTimeout(() => repSearchRef.current?.focus(), 0)
  }

  const doSubmit = useCallback(
    async (force: boolean, req: OverpayRequest = {}) => {
      if (!lookup) return
      setConfirmForce(null)
      setOverpayReq(req)
      if (!selected.length) return setErr('تعداد برگشتی حداقل یک قلم را بزرگ‌تر از صفر بگذارید.')
      if (refundMethod === 'NONE' && refundNote.trim().length < 3)
        return setErr('برای انتخاب صریح «بدون بازپرداخت»، دلیل مشتری حداقل ۳ نویسه باشد.')
      // انتخاب‌نشده با «بدون بازپرداخت» فرق دارد: سرور فقط در صورت داشتن حق
      // قابل‌پرداخت درخواست را متوقف می‌کند؛ هیچ پول/اعتبار/موجودی خودکار ثبت نمی‌شود.
      // انصراف صریح باید با NONE و دلیل ثبت شود.
      if (managerFullRefund && !fullRefundPw.trim())
        return setErr('برای بازپرداخت مبلغ کاملِ بدون کسر تخفیف، رمز مدیر را وارد کنید.')
      if (managerFullRefund && fullRefundReason.trim().length < 3)
        return setErr('برای بازپرداخت مبلغ کاملِ بدون کسر تخفیف، دلیل مدیر حداقل ۳ نویسه باشد.')
      if (removedSelected.length && !allowRemoved)
        return setErr(
          'این کالا از موجودی انبار حذف شده است:\n' +
            removedSelected.map((i) => `• ${i.name}`).join('\n') +
            '\nبرگشت خودکار انجام نمی‌شود. برای ثبت برگشت این قلم(ها)، گزینه‌ی «رسیدگی دستی» را تیک بزنید.'
        )
      setBusy(true)
      try {
        const res = await call<any>(CH.saleReturn, {
          invoiceId: lookup.invoiceId,
          full: isFull,
          lines: selected.map((i) => ({ saleItemId: i.saleItemId, qty: qty[i.saleItemId] ?? 0 })),
          note: note.trim() || undefined,
          allowRemoved: allowRemoved || undefined,
          force: force || undefined,
          // سه حالت از هم جدا هستند: انتخاب‌نشده، روش واقعی، یا انصراف صریح با دلیل.
          refundMethod: refundMethod ?? undefined,
          refundDecision: refundMethod == null ? 'UNSELECTED' : refundMethod === 'NONE' ? 'DECLINED' : 'METHOD',
          refundAmount: refundAmount.trim() === '' ? undefined : Math.max(0, Math.round(Number(refundAmount.replace(/[^0-9]/g, '')) || 0)),
          managerFullRefund: managerFullRefund || undefined,
          refundReference: refundReference.trim() || undefined,
          refundNote: refundNote.trim() || undefined,
          cardPosOverride: refundMethod === 'CARD' ? cardPosOverride : undefined,
          // رمز دریافت‌شده در دیالوگ اضافه‌دریافت فقط مجوز سقف صدور اعتبار است؛
          // آن را با رمز قفل دوره/بازپرداخت کامل یکی نمی‌کنیم.
          ...Object.fromEntries(Object.entries(req).filter(([key]) => key !== 'managerPassword')),
          overpayManagerPassword: req.managerPassword || undefined,
          // ---- بند ۱۷: فقط وقتی دوره بسته است و کاربر رمز/دلیل داده ----
          managerPassword: (managerFullRefund ? fullRefundPw : lockPw).trim() || undefined,
          overrideReason: (managerFullRefund ? fullRefundReason : lockReason).trim() || undefined
        })
        setOverpayFlow(null)
        setOverpayReq({})
        setRetResult(res)
        setLockNeeded(false)
        setLockPw('')
        setLockReason('')
        setCreditLimitNeeded(false)
        setCreditLimitPw('')
        flash(
          `برگشت از فروش فاکتور شماره ${faDigits(res.receiptNo)} ثبت شد · ` +
            `${faDigits(totals.qty)} عدد · ${money(res.total)} ریال · ` +
            (res.restocked
              ? `${faDigits(res.restockedQty)} عدد به موجودی انبار برگشت`
              : 'این فاکتور بدون کسر از موجودی بود، پس موجودی تغییر نکرد') +
            (res.fullyReturned ? ' · وضعیت فاکتور: برگشت کامل' : ' · وضعیت فاکتور: برگشت جزئی') +
            (res.refundNote ? `\n${res.refundNote}` : '') +
            (res.storeCreditReference ? ` · ${res.storeCreditReference} صادر شد` : '') +
            (res.overpayCredit?.id
              ? ` · ${overpayCreditFlash(res.overpayCredit, money, faDigits)}`
              : res.overpayAmount > 0
                ? ` · مبلغ اضافه‌ی دریافتی: ${money(res.overpayAmount)} ریال (ردیف «دریافت پول اضافه»)`
                : '')
        )
        if (res.overpayCredit?.id) {
          issuedOverpayCreditOpenRef.current = true
          setIssuedOverpayCredit(res.overpayCredit)
          await printIssuedOverpayCredit(res.overpayCredit)
        }
        await lookupCode(returnLookupInput(lookup))
        await loadHistory()
      } catch (e: any) {
        const message = String(e.message ?? '')
        // پیام «بیشتر از تعداد قابل برگشت» یک هشدار قابل‌تایید است، نه دیوار
        if (message.includes('تایید کنید تا انجام شود')) setConfirmForce(message)
        else if (isOverpayWarning(message))
          setOverpayFlow(overpayFlowStart(message, {
            entryKind: 'CASH', methodKind: 'CASH',
            // The new decision marker means an unselected/declined method is
            // never an implicit credit request; the dialog asks separately.
            autoCredit: false
          }))
        else if (needsManagerPassword(message) && req.overpayAsCredit)
          setOverpayFlow(
            overpayFlowAskPassword({ step: 'submit', message: null, eligible: true, request: req }, message)
          )
        else {
          // بند ۱۷ — دوره بسته است: دو فیلد «رمز مدیر» و «دلیل» روی صفحه می‌آیند
          if (message.includes('دوره بسته شده است') || message.includes('دوره‌ی بسته')) setLockNeeded(true)
          setErr(message)
        }
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      lookup, selected, qty, note, allowRemoved, isFull, totals.qty, removedSelected.length,
      refundMethod, refundAmount, refundReference, refundNote, managerFullRefund, fullRefundPw, fullRefundReason,
      lockPw, lockReason, loadHistory, lookupCode
    ]
  )

  /**
   * ------------------------- ثبت تعویض کالا (بخش ۶) -------------------------
   * یک فراخوانی، یک تراکنش سمت main: برگشت اقلام + سند تعویض + تسویه‌ی
   * مابه‌التفاوت + صدور بارکد اعتبار (اگر ما بدهکار شده باشیم).
   */
  const doExchange = useCallback(
    async (force: boolean) => {
      if (!lookup) return
      setConfirmExchange(null)
      if (!selected.length) return setErr('برای تعویض، تعداد حداقل یک «کالای برگشتی» را بزرگ‌تر از صفر بگذارید.')
      if (!reps.length) return setErr('برای تعویض، حداقل یک «کالای جایگزین» انتخاب کنید (اسکن بارکد، جست‌وجوی نام یا کد).')
      if (exFundingPreviewBusy) return setErr('پیش‌نمایش پشتوانهٔ پول/اعتبار هنوز کامل نشده است؛ لحظه‌ای صبر کنید.')
      if (exFundingPreview?.ok !== true)
        return setErr(exFundingPreviewError || 'پیش‌نمایش پشتوانهٔ مابه‌التفاوت ممکن نشد؛ تعویض نهایی نمی‌شود.')
      if (exFundingPreview.discountTransfer && discountTransferOption == null)
        return setErr('برای تخفیف تاریخی، پیش از ثبت تعویض یکی از سه گزینهٔ انتقال را انتخاب کنید.')
      /** در مابه‌التفاوت منفی، انتخاب‌نکردن روش هرگز به معنی صدور خودکار اعتبار نیست. */
      const requestedPayout = exRefundPayoutAmount.trim() === ''
        ? undefined
        : Number(exRefundPayoutAmount.replace(/[^0-9]/g, ''))
      const splitPreview = exFundingPreview?.ok === true ? (exFundingPreview as any).settlementSplit : null
      if (splitPreview?.overRequested)
        return setErr(
          `مبلغ پرداختی (${money(Number(splitPreview.requestedPayout ?? 0))} ریال) از سهم وجه واقعیِ قابل‌پرداخت ` +
            `(${money(Number(splitPreview.moneySurplus ?? 0))} ریال) بیشتر است؛ ابتدا مبلغ را اصلاح کنید.`
        )
      if (splitPreview?.invalidReason) return setErr(String(splitPreview.invalidReason))
      if (exSettlementDiff < 0 && (exRefundMode === 'CASH' || exRefundMode === 'CARD') && requestedPayout != null &&
        (!Number.isSafeInteger(requestedPayout) || requestedPayout < 0 || requestedPayout > -exSettlementDiff))
        return setErr(`مبلغ پرداختی باید نامنفی و از اختلاف کل (${money(-exSettlementDiff)} ریال) بیشتر نباشد؛ سقف سهم وجه واقعی جداگانه در سرور کنترل می‌شود.`)
      if (creditLimitNeeded && !creditLimitPw.trim())
        return setErr('برای عبور از سقف صدور اعتبار در تعویض، رمز اختصاصی همین مجوز را وارد کنید.')
      if (exSettlementDiff > 0 && exCreditCode.trim() && exCreditVerifiedCode !== exCreditCode.trim())
        return setErr('برای مصرف اعتبار، ابتدا همان بارکد را با دکمه‌ی «بررسی اعتبار» اعتبارسنجی کنید.')
      if (exSettlementDiff > 0 && exCreditCode.trim() && exCreditPreviewBusy)
        return setErr('پیش‌نمایش محدودیت‌های اعتبار هنوز کامل نشده است؛ لحظه‌ای صبر کنید.')
      if (exSettlementDiff > 0 && exCreditCode.trim() && exCreditPreview?.ok !== true)
        return setErr(exCreditError || 'اعتبار روی این تعویض قابل استفاده نیست.')
      if (exSettlementDiff > 0 && exCashDuePreview > 0 && !exSplitPayment && !methodId)
        return setErr('برای دریافت مابه‌التفاوت، روش پرداخت را صریح انتخاب کنید؛ هیچ روش پیش‌فرضی انتخاب نمی‌شود.')
      if (exSettlementDiff > 0 && exCashDuePreview > 0 && exSplitPayment) {
        if (!exSplitCashMethodId || !exSplitCardMethodId)
          return setErr('برای پرداخت ترکیبی، یک روش فعال نقدی و یک روش فعال کارتی انتخاب کنید.')
        if (exSplitCashAmount == null || exSplitCardAmount == null || exSplitTotal == null)
          return setErr('مبلغ نقد یا کارت معتبر نیست؛ فقط عدد صحیح ریالیِ بدون اعشار، منفی یا حرف وارد کنید.')
        if (exSplitCashAmount <= 0 || exSplitCardAmount <= 0 || exSplitTotal !== exCashDuePreview)
          return setErr(`جمع سهم نقد و کارت پس از اعتبار باید دقیقاً ${money(exCashDuePreview)} ریال باشد و هر دو سهم مثبت باشند.`)
      }
      if (priceOverrideOn && !managerPw.trim())
        return setErr(
          'قیمت دستیِ کالای جایگزین باز است و رمز مدیر وارد نشده.\n' +
            'یا رمز مدیر را بنویسید، یا قفل قیمت دستی را ببندید تا قیمت‌ها به قیمت واقعی کالا برگردند.'
        )
      if (removedSelected.length && !allowRemoved)
        return setErr(
          'این کالا از موجودی انبار حذف شده است:\n' +
            removedSelected.map((i) => `• ${i.name}`).join('\n') +
            '\nبرای ثبت تعویض این قلم(ها)، گزینه‌ی «رسیدگی دستی» را تیک بزنید.'
        )
      setBusy(true)
      try {
        const requestLines = selected.map((i) => ({ saleItemId: i.saleItemId, qty: qty[i.saleItemId] ?? 0 }))
        const requestReplacements = reps.map((line, index) => ({
          variantId: line.variantId,
          qty: line.qty,
          unitPrice: line.unitPrice,
          discount: Math.max(0, Math.round(line.discount)),
          tax: exFundingPreview.replacementTaxes?.[index] ?? (exCharges.taxPerLine[index] != null && exScope === 'pos' ? exCharges.taxPerLine[index] : 0)
        }))
        const requestSignature = JSON.stringify({
          invoiceId: lookup.invoiceId, lines: requestLines, replacements: requestReplacements,
          invoiceTax: exFundingPreview.invoiceTax ?? (exScope === 'wholesale' ? exCharges.taxTotal : 0), serviceCharge: exFundingPreview.serviceCharge ?? exCharges.serviceTotal,
          expectedSettlementDiff: exSettlementDiff, discountTransferOption,
          expectedDiscountTransferAmount: Number(exFundingPreview.discountTransfer?.selectedAmount ?? 0),
          note: note.trim() || undefined, allowRemoved: allowRemoved || undefined, force: force || undefined,
          exchangeCreditCode: exCreditCode.trim() || undefined, methodId,
          splitPayment: exSettlementDiff > 0 && exCashDuePreview > 0 && exSplitPayment ? true : undefined,
          payments: exSettlementDiff > 0 && exCashDuePreview > 0 && exSplitPayment
            ? [{ methodId: exSplitCashMethodId, amount: exSplitCashAmount, destination: 'CASH' }, { methodId: exSplitCardMethodId, amount: exSplitCardAmount, destination: 'CARD' }]
            : undefined,
          autoCentralWithdraw: repAutoCentral || undefined,
          refundMode: exSettlementDiff < 0 ? exRefundMode : undefined,
          exchangeSettlementDecision: exSettlementDiff < 0 ? (exRefundMode ? 'METHOD' : 'UNSELECTED') : undefined,
          refundAmount: exSettlementDiff < 0 && (exRefundMode === 'CASH' || exRefundMode === 'CARD') ? requestedPayout : undefined,
          cardPosOverride: exRefundMode === 'CARD' ? cardPosOverride : undefined
        })
        if (exchangeRequestSignatureRef.current !== requestSignature) exchangeRequestKeyRef.current = null
        exchangeRequestSignatureRef.current = requestSignature
        const exchangeRequestIdempotencyKey = exchangeRequestKeyRef.current ??= globalThis.crypto.randomUUID()
        const exchangeIdempotencyKey = exCreditCode.trim() ? exchangeRequestIdempotencyKey : undefined
        const res = await call<
          ExchangeSaleResult & {
            cashReceived?: number
            exchangeCreditApplied?: number
            cardTransfer?: { id: number; amount: number; status: string } | null
          }
        >(
          CH.saleExchangeCreate,
          {
            invoiceId: lookup.invoiceId,
            lines: requestLines,
            replacements: requestReplacements,
            invoiceTax: exFundingPreview.invoiceTax ?? (exScope === 'wholesale' ? exCharges.taxTotal : 0),
            serviceCharge: exFundingPreview.serviceCharge ?? exCharges.serviceTotal,
            expectedSettlementDiff: exSettlementDiff,
            note: note.trim() || undefined,
            allowRemoved: allowRemoved || undefined,
            force: force || undefined,
            // بارکد اعتبار، اگر وارد شده باشد، ابتدا تا سقف اختلاف مصرف می‌شود؛ فقط باقی‌مانده نقد/کارت است.
            exchangeCreditCode: exCreditCode.trim() || undefined,
            idempotencyKey: exchangeIdempotencyKey,
            requestIdempotencyKey: exchangeRequestIdempotencyKey,
            discountTransferOption,
            expectedDiscountTransferAmount: Number(exFundingPreview.discountTransfer?.selectedAmount ?? 0),
            methodId: exSettlementDiff > 0 && exCashDuePreview > 0 && !exSplitPayment ? methodId : null,
            splitPayment: exSettlementDiff > 0 && exCashDuePreview > 0 && exSplitPayment ? true : undefined,
            payments:
              exSettlementDiff > 0 && exCashDuePreview > 0 && exSplitPayment
                ? [
                    { methodId: exSplitCashMethodId!, amount: exSplitCashAmount!, destination: 'CASH' },
                    { methodId: exSplitCardMethodId!, amount: exSplitCardAmount!, destination: 'CARD' }
                  ]
                : undefined,
            autoCentralWithdraw: repAutoCentral || undefined,
            // ---- بند ۱۲: تسویه‌ی مابه‌التفاوت منفی (انتخاب انحصاری کاربر) ----
            refundMode: exSettlementDiff < 0 ? exRefundMode : undefined,
            exchangeSettlementDecision: exSettlementDiff < 0 ? (exRefundMode ? 'METHOD' : 'UNSELECTED') : undefined,
            refundAmount:
              exSettlementDiff < 0 && (exRefundMode === 'CASH' || exRefundMode === 'CARD') ? requestedPayout : undefined,
            cardPosOverride: exRefundMode === 'CARD' ? cardPosOverride : undefined,
            // مجوز قیمت/دوره از گیت اختصاصی سقف اعتبار جداست.
            managerPassword: (priceOverrideOn ? managerPw.trim() : lockPw.trim()) || undefined,
            storeCreditManagerPassword: creditLimitPw.trim() || undefined,
            overrideReason: lockReason.trim() || undefined
          }
        )
        setExResult(res)
        exchangeRequestKeyRef.current = null
        exchangeRequestSignatureRef.current = null
        setDiscountTransferOption('YES')
        setExCreditCode('')
        setExCreditVerifiedCode(null)
        setExCreditInfo(null)
        setExCreditPreview(null)
        setExCreditPreviewBusy(false)
        setExCreditError(null)
        setReps([])
        setQty({})
        setRepFor(null)
        setExRefundMode(null)
        setExRefundPayoutAmount('')
        setExSplitPayment(false)
        setExSplitCash('')
        setExSplitCard('')
        setMethodId(null)
        setExSplitCashMethodId(null)
        setExSplitCardMethodId(null)
        setPriceOverrideOn(false)
        setManagerPw('')
        setLockNeeded(false)
        setLockPw('')
        setLockReason('')
        flash(
          `تعویض کالا ثبت شد · سند تعویض شماره ${faDigits(res.exchangeReceiptNo)} · ` +
            `کالای برگشتی ${money(res.returnTotal)} ریال · کالای جایگزین ${money(res.exchangeTotal)} ریال · ` +
            (res.diff > 0
              ? `${res.barcodeCreditApplied ? `${money(res.barcodeCreditApplied)} ریال اعتبار غیرنقدی مصرف شد` : ''}` +
                `${res.barcodeCreditApplied && res.cashDue ? ' · ' : ''}` +
                `${res.cashDue ? `${money(res.cashDue)} ریال از مشتری دریافت شد` : res.barcodeCreditApplied ? 'مابه‌التفاوت کامل با اعتبار تسویه شد' : `${money(res.diff)} ریال از مشتری دریافت شد`}`
              : res.diff < 0
                ? `${res.sourceCreditRestoredAmount ? `${money(res.sourceCreditRestoredAmount)} ریال اعتبارِ منشأدارِ غیرنقدی برگشت` : ''}` +
                  `${res.sourceCreditRestoredAmount && (res.payoutAmount || res.newStoreCreditAmount) ? ' · ' : ''}` +
                  `${res.payoutAmount ? `${money(res.payoutAmount)} ریال ` +
                    (res.refundMode === 'CASH' ? 'نقد از صندوق پرداخت شد' : 'به کارت برگشت') : ''}` +
                  `${res.payoutAmount && res.newStoreCreditAmount ? ' · ' : ''}` +
                  `${res.newStoreCreditAmount ? `${money(res.newStoreCreditAmount)} ریال بارکد اعتباری عادی برای مانده صادر شد` : ''}` +
                  `${!res.payoutAmount && !res.newStoreCreditAmount && res.refundMode === 'CARD_TO_CARD' ? `${money(res.cardTransfer?.amount ?? res.realMoneyRefundAmount ?? 0)} ریال در انتظار پرداخت مدیر است` : ''}` +
                  `${!res.payoutAmount && !res.newStoreCreditAmount && res.refundMode !== 'CARD_TO_CARD' ? 'از وجه واقعی مبلغی برای پرداخت باقی نماند' : ''}`
                : 'مابه‌التفاوت صفر بود') +
            /**
             * جلسه ۵۰ · مرحله ۱-ب — «کالای جایگزین از کدام انبار آمد».
             * متن را سرور می‌سازد (همان جمله‌ای که در سابقه‌ی سند و ستون گزارش
             * هم نشسته)، پس پنل عددی حساب نمی‌کند و سه جا یک جمله می‌گویند.
             * خالی بودنش = کاملاً از انبار فروشگاه کم شد (مثل قبل).
             */
            (res.centralWithdrawText ? '\n' + res.centralWithdrawText : '') +
            (res.stockWarnings?.length ? '\n' + res.stockWarnings.join('\n') : '')
        )
        await lookupCode(returnLookupInput(lookup))
        await loadHistory()
      } catch (e: any) {
        const message = String(e.message ?? '')
        if (message.includes('تایید کنید تا انجام شود')) setConfirmExchange(message)
        else {
          if (message.includes('دوره بسته شده است') || message.includes('دوره‌ی بسته')) setLockNeeded(true)
          if (message.includes('سقف') && message.includes('تایید مدیر لازم دارد')) setCreditLimitNeeded(true)
          setErr(message)
        }
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      lookup, selected, qty, reps, note, allowRemoved, exSettlementDiff, methodId, exSplitPayment, exSplitCashAmount,
      exSplitCardAmount, exSplitTotal, exSplitCashMethodId, exSplitCardMethodId, repAutoCentral, exCharges, exScope,
      removedSelected.length, exRefundMode, exRefundPayoutAmount, exCreditCode, exCreditVerifiedCode, exCreditPreview, exCreditPreviewBusy,
      exCreditError, exCashDuePreview, exFundingPreview, exFundingPreviewBusy, exFundingPreviewError, discountTransferOption, priceOverrideOn,
      managerPw, lockPw, lockReason, creditLimitNeeded, creditLimitPw, loadHistory, lookupCode
    ]
  )

  /**
   * ---------------------- بند ۱۳ — رسید چاپیِ «برگشت از فروش» ----------------------
   * خواهرِ `print:exchange`. محتوایش سمت main در `returnReceiptHtml` ساخته می‌شود
   * (شماره‌ی سند، فاکتور اصلی، تاریخ/ساعت دقیق، مشتری، اقلام، مبلغ و **روش
   * بازپرداخت**). رسید برگشت عمداً کد قابل‌مصرف ندارد؛ گواهی بارکد جدا چاپ
   * می‌شود و چاپ آن نیز به‌تنهایی تحویل/فعال‌سازی اعتبار نیست.
   */
  const printReturn = useCallback(async (returnId: number) => {
    if (printingRef.current) return
    printingRef.current = true
    setPrinting(true)
    try {
      /** فاز ۳ — مسیر مشترک چاپ؛ انصراف = لغو قطعی و بی‌صدا. */
      const res = await printWith('INVOICE', (deviceName, opts) =>
        call(CH.printReturn, { returnId, deviceName, silent: opts?.silent })
      )
      if (res === 'CANCELLED') return
      flash('رسید برگشت از فروش برای چاپ فرستاده شد')
    } catch (e: any) {
      setErr(
        isUnknownPrintMessage(e)
          ? `معلوم نیست رسید برگشت چاپ شده باشد: ${e.message} قبل از چاپ دوباره خروجی چاپگر را ببینید.`
          : `چاپ رسید برگشت انجام نشد: ${e.message}`
      )
    } finally {
      printingRef.current = false
      setPrinting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** چاپ «سند تعویض» (قالب exchangeReceiptHtml سمت main). */
  const printExchange = useCallback(async (returnId: number) => {
    if (printingRef.current) return
    printingRef.current = true
    setPrinting(true)
    try {
      let outcome: any = null
      const res = await printWith('INVOICE', async (deviceName, opts) => {
        outcome = await call(CH.printExchange, { returnId, deviceName, silent: opts?.silent })
        return outcome
      })
      if (res === 'CANCELLED') return
      flash('سند تعویض برای چاپ فرستاده شد' + (outcome?.warnings?.length ? `\n${outcome.warnings.join('\n')}` : ''))
    } catch (e: any) {
      setErr(
        isUnknownPrintMessage(e)
          ? `معلوم نیست سند تعویض چاپ شده باشد: ${e.message} قبل از چاپ دوباره خروجی چاپگر را ببینید.`
          : `چاپ سند تعویض انجام نشد: ${e.message}`
      )
    } finally {
      printingRef.current = false
      setPrinting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const printSourceInvoice = useCallback(async (invoiceId: number) => {
    if (printingRef.current) return
    printingRef.current = true
    setPrinting(true)
    try {
      const res = await printWith('INVOICE', (deviceName, opts) =>
        call(CH.printInvoice, { invoiceId, deviceName, silent: opts?.silent })
      )
      if (res !== 'CANCELLED') flash('رسید فاکتور برای چاپ فرستاده شد')
    } catch (e: any) {
      setErr(
        isUnknownPrintMessage(e)
          ? `معلوم نیست رسید فاکتور چاپ شده باشد: ${e.message} قبل از چاپ دوباره خروجی چاپگر را ببینید.`
          : e.message
      )
    } finally {
      printingRef.current = false
      setPrinting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * نشست ۶۴ · بند ۴-۲۲ — ابطال یک برگشت ثبت‌شده (نه حذف فیزیکی). سند با مهر
   * «باطل» و دلیل می‌ماند؛ اثر انبار/اعتبار/کارت‌به‌کارتِ در انتظار سمت main در
   * یک تراکنش برمی‌گردد. اگر پول واقعاً رفته یا اعتبار خرج شده باشد، main رد
   * می‌کند و برای مدیر «رسیدگی» ثبت می‌شود.
   */
  const doDelete = useCallback(async () => {
    const target = deleteTarget
    if (!target) return
    const reason = voidReason.trim()
    if (reason.length < 3) {
      setVoidReasonErr('دلیل ابطال را بنویسید (حداقل ۳ حرف)؛ بدون دلیل، سند باطل نمی‌شود.')
      return
    }
    setRowBusy(true)
    try {
      const res = await call<any>(CH.saleReturnDelete, {
        id: target.id,
        reason,
        panelPassword: voidAuthPassword || undefined,
        /** دوره‌ی بسته فقط همین رمز را به‌عنوان رمز مدیر می‌پذیرد؛ رمز دوم کافی نیست. */
        managerPassword: voidAuthPassword || undefined,
        overrideReason: reason,
        approverUserId: voidApproverUserId ?? undefined,
        approverPassword: voidApproverPassword || undefined
      })
      setDeleteTarget(null)
      setVoidReason('')
      setVoidAuthPassword('')
      setVoidApproverUserId(null)
      setVoidApproverPassword('')
      setVoidReasonErr(null)
      flash(
        `برگشت از فروش فاکتور شماره ${faDigits(res.receiptNo ?? target.receiptNo ?? 0)} باطل شد · ` +
          `${money(res.total ?? target.total ?? 0)} ریال · ` +
          (res.reversedQty
            ? `${faDigits(res.reversedQty)} عدد از موجودی انبار برگشت خورد (موجودی به حالت قبل از این برگشت رسید)`
            : 'این برگشت موجودی انبار را تغییر نداده بود، پس انبار دست‌نخورده ماند') +
          (res.canceledCreditRefs?.length ? ` · ${res.canceledCreditRefs.join('، ')} هم باطل شد` : '')
      )
      await loadHistory()
      if (lookup) await lookupCode(returnLookupInput(lookup))
    } catch (e: any) {
      /** هدف باز می‌ماند تا فروشنده بتواند، مثلاً، رمز لازم را وارد و دوباره ثبت کند. */
      setVoidReasonErr(String(e?.message ?? 'ابطال انجام نشد.'))
    } finally {
      setRowBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    deleteTarget,
    voidReason,
    voidAuthPassword,
    voidApproverUserId,
    voidApproverPassword,
    loadHistory,
    lookup,
    lookupCode
  ])

  const doCorrection = useCallback(async () => {
    const target = correctionTarget
    if (!target) return
    const reason = correctionReason.trim()
    if (reason.length < 3) {
      setCorrectionErr('دلیل اصلاح جبرانی را بنویسید (حداقل ۳ حرف).')
      return
    }
    const cashRecovered = Number(digitsOnly(correctionCash) || '0')
    const cardRecovered = Number(digitsOnly(correctionCard) || '0')
    if (!Number.isSafeInteger(cashRecovered) || !Number.isSafeInteger(cardRecovered)) {
      setCorrectionErr('مبلغ بازیافتی معتبر نیست.')
      return
    }
    setCorrectionBusy(true)
    try {
      const res = await call<any>(CH.saleReturnCorrection, {
        id: target.id,
        reason,
        panelPassword: correctionAuthPassword || undefined,
        approverUserId: correctionApproverUserId ?? undefined,
        approverPassword: correctionApproverPassword || undefined,
        cashRecovered,
        cardRecovered,
        cardReference: correctionCardReference.trim() || undefined,
        creditOutcome: correctionCreditOutcome,
        note: correctionNote.trim() || undefined
      })
      setCorrectionTarget(null)
      setCorrectionErr(null)
      flash(
        `اصلاح جبرانی شماره ${faDigits(res.id)} ثبت شد` +
          (res.cashRecovered ? ` · نقدِ بازیافتی: ${money(res.cashRecovered)} ریال` : '') +
          (res.cardRecovered ? ` · کارت/بانکِ بازیافتی: ${money(res.cardRecovered)} ریال` : '') +
          (res.unrecoveredAmount ? ` · مغایرت بازیافت‌نشده: ${money(res.unrecoveredAmount)} ریال` : '')
      )
      await loadHistory()
      if (lookup) await lookupCode(returnLookupInput(lookup))
    } catch (e: any) {
      setCorrectionErr(String(e?.message ?? 'اصلاح جبرانی انجام نشد.'))
    } finally {
      setCorrectionBusy(false)
    }
  }, [
    correctionTarget,
    correctionReason,
    correctionCash,
    correctionCard,
    correctionAuthPassword,
    correctionApproverUserId,
    correctionApproverPassword,
    correctionCardReference,
    correctionCreditOutcome,
    correctionNote,
    loadHistory,
    lookup,
    lookupCode
  ])

  const reset = () => {
    setLookup(null)
    setQty({})
    setCode('')
    setErr(null)
    setNote('')
    setAllowRemoved(false)
    setReps([])
    setRepFor(null)
    setExResult(null)
    setRetResult(null)
    setRefundMethod(null)
    setRefundAmount('')
    setRefundReference('')
    setRefundNote('')
    setExRefundMode(null)
    setDiscountTransferOption(null)
    setExCreditCode('')
    setExCreditVerifiedCode(null)
    setExCreditInfo(null)
    setExCreditPreview(null)
    setExCreditPreviewBusy(false)
    setExCreditError(null)
    exchangeRequestKeyRef.current = null
    setExSplitPayment(false)
    setExSplitCash('')
    setExSplitCard('')
    setMethodId(null)
    setExSplitCashMethodId(null)
    setExSplitCardMethodId(null)
    setPriceOverrideOn(false)
    setManagerPw('')
    setLockNeeded(false)
    setLockPw('')
    setLockReason('')
    setCreditLimitNeeded(false)
    setCreditLimitPw('')
    scan.reset()
    inputRef.current?.focus()
  }

  const diffLabel =
    exSettlementDiff > 0
      ? exCreditAppliedPreview > 0
        ? `اعتبار ${money(exCreditAppliedPreview)} ریال · باقیمانده قابل دریافت ${money(exCashDuePreview)} ریال`
        : `مشتری باید ${money(exSettlementDiff)} ریال بپردازد`
      : exSettlementDiff < 0
        ? `اختلاف تسویه ${money(-exSettlementDiff)} ریال است؛ سهم اعتبارِ منشأدار جداگانه و غیرنقدی برمی‌گردد. مازاد وجه واقعیِ مبدأ پیش از کسر بدهی تا ${money(Number(exFundingPreview?.realMoneySurplus ?? 0))} ریال است؛ مبلغ نهاییِ بازپرداخت می‌تواند کمتر یا صفر باشد. روش انتخابی فقط روی وجه واقعیِ نهایی اعمال می‌شود: ${
            exRefundMode === 'CASH'
              ? exRefundPayoutAmount.trim()
                ? `درخواست ${money(Number(exRefundPayoutAmount.replace(/[^0-9]/g, '') || 0))} ریال نقد؛ اعتبار برای باقیمانده‌ی سهم وجه واقعی`
                : 'بازپرداخت کامل سهم وجه واقعی به‌صورت نقدی از کشو'
              : exRefundMode === 'CARD'
                ? exRefundPayoutAmount.trim()
                  ? `درخواست ${money(Number(exRefundPayoutAmount.replace(/[^0-9]/g, '') || 0))} ریال به کارت؛ اعتبار برای باقیمانده‌ی سهم وجه واقعی`
                  : 'بازپرداخت کامل سهم وجه واقعی به کارت'
                : exRefundMode === 'STORE_CREDIT'
                  ? 'صدور بارکد تازه فقط برای سهم وجه واقعی'
                  : exRefundMode === 'CARD_TO_CARD'
                    ? 'درخواست کارت‌به‌کارت مدیر برای سهم وجه واقعی'
                    : 'روش تسویه را صریح انتخاب کنید اگر پس از کسر بدهی و بازگرداندن اعتبار منشأدار، وجه واقعی برای تسویه باقی بماند'
          }`
        : 'مابه‌التفاوت صفر است؛ تسویه‌ای لازم نیست'

  return (
    <div className="page">
      <div className="bg-white rounded shadow p-2 flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold">برگشت از فروش و تعویض کالا</h1>
        <span className="kbd">
          کد فاکتور را تایپ کنید یا بارکد روی رسید را اسکن کنید · اعتبار هر کد یک هفته از تاریخ صدور است
        </span>
        <div className="ms-auto flex gap-1">
          <button className="btn" onClick={() => nav('/sales-reports')}>
            گزارشات فروش <span className="keycap">F9</span>
          </button>
          <button className="btn" onClick={() => nav('/pos')}>
            پنل فروش <span className="keycap">F2</span>
          </button>
        </div>
      </div>

      {/* ---------------- ورود کد فاکتور ---------------- */}
      <div className="bg-white rounded shadow p-3 flex flex-wrap gap-2 items-end">
        <label className="flex-1 min-w-[260px]">
          <div className="mb-1 font-bold">کد فاکتور (روی رسید، هم متن و هم بارکد)</div>
          <input
            ref={inputRef}
            dir="ltr"
            className="inp text-center text-lg tracking-widest"
            placeholder="مثلاً K7M4QP"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              scan.onKeyDown(e)
              if (e.key === 'Enter') {
                e.preventDefault()
                void lookupCode(code)
              }
            }}
          />
        </label>
        <button className="btn btn-primary" onClick={() => void lookupCode(code)} disabled={busy || !code.trim()}>
          {busy ? 'در حال جستجو…' : 'پیدا کردن فاکتور'}
        </button>
        <button className="btn" onClick={reset} disabled={busy}>
          پاک کردن
        </button>
        <div className="kbd">
          بارکدخوان فعال است؛ لازم نیست فیلد را انتخاب کنید — کافی است بارکد رسید را اسکن کنید. شماره فیش هم پذیرفته
          می‌شود.
        </div>
      </div>

      {(msg || err) && (
        <div
          className={`rounded px-3 py-2 border whitespace-pre-line ${
            err ? 'bg-amber-100 border-amber-300' : 'bg-emerald-50 border-emerald-300'
          }`}
        >
          {err ?? msg}
        </div>
      )}

      {/* ---------------- بند ۱۷: دوره‌ی بسته‌شده — رمز مدیر و دلیل اجباری ---------------- */}
      {lockNeeded && (
        <div className="bg-rose-50 border-2 border-rose-400 rounded p-3 space-y-2">
          <b className="text-rose-800">این تاریخ در یک «دوره‌ی بسته» است</b>
          <div className="kbd leading-6">
            صندوق این روز بسته شده یا روز «تجمیع و انتقال» شده است. ثبت اصلاحی ممنوع نیست، ولی آزاد هم نیست: رمز مدیر و
            دلیل اجباری است و هر دو با جزئیات کامل در سابقه‌ی تغییرات ثبت می‌شوند. اگر نمی‌خواهید اعداد آن دوره دست
            بخورند، سند را با تاریخ امروز ثبت کنید.
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <label>
              <div className="kbd">رمز مدیر</div>
              <input type="password" className="inp w-40" dir="ltr" value={lockPw} onChange={(e) => setLockPw(e.target.value)} />
            </label>
            <label className="flex-1 min-w-[240px]">
              <div className="kbd">دلیل ثبت در دوره‌ی بسته (اجباری)</div>
              <input className="inp" value={lockReason} onChange={(e) => setLockReason(e.target.value)} />
            </label>
            <button className="btn" onClick={() => setLockNeeded(false)}>
              انصراف
            </button>
          </div>
        </div>
      )}

      {creditLimitNeeded && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded p-3 space-y-2">
          <b className="text-amber-900">مجوز مستقل برای عبور از سقف اعتبار خرید</b>
          <div className="kbd">این مجوز جدا از رمز قیمت دستی یا قفل دوره است و فقط وقتی سقف صدور/بازگردانی اعتبار رد شود درخواست می‌شود.</div>
          <div className="flex flex-wrap gap-2 items-end">
            <label>
              <div className="kbd">رمز مدیر برای سقف اعتبار</div>
              <input type="password" className="inp w-40" dir="ltr" value={creditLimitPw} onChange={(e) => setCreditLimitPw(e.target.value)} />
            </label>
            <button className="btn" onClick={() => { setCreditLimitNeeded(false); setCreditLimitPw('') }}>انصراف</button>
          </div>
        </div>
      )}

      {/* ---------------- بند ۱۳: برگشت تازه ثبت‌شده + رسید چاپی ---------------- */}
      {retResult && (
        <div className="bg-emerald-50 border-2 border-emerald-400 rounded p-2 flex flex-wrap items-center gap-3">
          <b>برگشت از فروش فاکتور {faDigits(retResult.receiptNo)} ثبت شد</b>
          <span className="kbd">مبلغ برگشت {money(retResult.total)} ریال</span>
          <span className="px-2 py-1 rounded bg-white border font-bold">
            {REFUND_CHOICES.find((c) => c.value === retResult.refundMethod)?.title ?? 'بدون بازپرداخت'}
            {retResult.refundAmount ? ` · ${money(retResult.refundAmount)} ریال` : ' · بدون خروج پول'}
          </span>
          <span className="kbd">
            {retResult.restocked
              ? `${faDigits(retResult.restockedQty)} عدد به موجودی انبار برگشت`
              : 'این فاکتور بدون کسر از موجودی بود، پس موجودی تغییر نکرد'}
          </span>
          {retResult.sourceCreditRestoredAmount > 0 && (
            <span className="px-2 py-1 rounded bg-white border font-bold" title="اعتبار مصرف‌شده به منشأ/جانشین غیرنقدی برگشت شد">
              بازگشت به منشأ اعتبار: {money(retResult.sourceCreditRestoredAmount)} ریال
            </span>
          )}
          {retResult.expiredCreditClosedAmount > 0 && (
            <span className="px-2 py-1 rounded bg-amber-50 border border-amber-300 font-bold" title="اعتبار منقضی احیا، تمدید یا نقد نشده است">
              سهم منقضیِ بسته‌شده: {money(retResult.expiredCreditClosedAmount)} ریال
            </span>
          )}
          {retResult.storeCredit && (
            <span className="px-2 py-1 rounded bg-white border font-bold" title="مرجع امن اعتبار خرید صادرشده برای سهم وجه واقعی">
              اعتبار جدید: {retResult.storeCredit.publicReference}
            </span>
          )}
          {(retResult.sourceCreditSuccessors ?? []).map((successor: any) => (
            <span key={successor.id} className="px-2 py-1 rounded bg-white border font-bold"
              title="جانشین غیرنقدی اعتبار مصرف‌شده با حفظ انقضا و محدودیت منشأ">
              جانشین اعتبار: {successor.publicReference}
            </span>
          ))}
          <ReturnCreditHandoffActions credits={retResult.handoffCredits} />
          {/* جلسه ۱۷ · بند ۱ — هیچ پولی جابه‌جا نشده؛ فقط یک درخواست ساخته شده است */}
          {retResult.cardTransfer && (
            <span className="px-2 py-1 rounded bg-amber-100 border-2 border-amber-400 font-bold">
              درخواست کارت‌به‌کارت شماره {faDigits(retResult.cardTransfer.id)} ثبت شد ·{' '}
              {money(retResult.cardTransfer.amount)} ریال · در انتظار پرداخت مدیر
            </span>
          )}
          <button className="btn btn-primary" onClick={() => void printReturn(retResult.id)} disabled={printing}>
            {printing ? 'در حال چاپ…' : 'چاپ رسید برگشت'}
          </button>
          <button className="btn ms-auto" onClick={() => setRetResult(null)}>
            بستن
          </button>
        </div>
      )}

      {/* ---------------- سند تعویض تازه ثبت‌شده ---------------- */}
      {exResult && (
        <div className="bg-sky-50 border-2 border-sky-400 rounded p-2 flex flex-wrap items-center gap-3">
          <b>سند تعویض شماره {faDigits(exResult.exchangeReceiptNo)} ثبت شد</b>
          <span className="kbd">کالای برگشتی {money(exResult.returnTotal)} ریال</span>
          <span className="kbd">کالای جایگزین {money(exResult.exchangeTotal)} ریال</span>
          <span className="font-bold">
            {exResult.diff > 0
              ? `دریافتی از مشتری ${money(exResult.diff)} ریال`
              : exResult.diff < 0
                ? `بدهی ما ${money(-exResult.diff)} ریال`
                : 'مابه‌التفاوت صفر'}
          </span>
          <span className="kbd">{exResult.settlementLabel}</span>
          {(exResult.sourceCreditRestoredAmount ?? 0) > 0 && (
            <span className="px-2 py-1 rounded bg-white border border-indigo-300 font-bold"
              title="سهم اعتبار بارکدی به همان منشأ یا جانشین غیرنقدی برگشت؛ این مبلغ نقد نیست و عدد آبی را تغییر نمی‌دهد">
              اعتبار منشأدارِ غیرنقدیِ برگشتی: {money(exResult.sourceCreditRestoredAmount ?? 0)} ریال
            </span>
          )}
          {(exResult.sourceCreditClosedExpiredAmount ?? 0) > 0 && (
            <span className="px-2 py-1 rounded bg-amber-50 border border-amber-300 font-bold"
              title="اعتبار منقضی فقط بسته شد؛ احیا، تمدید یا تبدیل به وجه نشد">
              سهم اعتبار منقضیِ بسته‌شده: {money(exResult.sourceCreditClosedExpiredAmount ?? 0)} ریال
            </span>
          )}
          {(exResult.realMoneyRefundAmount ?? 0) > 0 && (
            <span className="px-2 py-1 rounded bg-white border border-amber-300 font-bold"
              title="این فقط سهم پول واقعاً وصول‌شده پس از کسر کالای جایگزین است؛ نوع پرداخت در انتخاب فروشنده ثبت می‌شود">
              سهم وجه واقعی برای تسویه: {money(exResult.realMoneyRefundAmount ?? 0)} ریال
            </span>
          )}
          {/**
           * جلسه ۵۰ · مرحله ۱-ب — «کالای جایگزین از کدام انبار برداشته شد».
           * فقط وقتی دیده می‌شود که واقعاً برداشتی از انبار مرکزی انجام شده
           * باشد؛ نبودنش = کاملاً از انبار فروشگاه (رفتار همیشگی). همین جمله
           * در سابقه‌ی سند و ستون «مبدأ برداشت» گزارش تعویض هم نشسته است، پس
           * اگر بعداً مغایرتی دیده شد از هر سه جا قابل ردیابی است.
           */}
          {!!exResult.centralWithdrawSources?.length && (
            <span
              className="px-2 py-1 rounded bg-white border-2 border-sky-400 font-bold"
              title="کمبود موجودی کالای جایگزین از این انبار(ها) برداشته و به انبار فروشگاه منتقل شد · در سابقه‌ی سند و گزارش تعویض هم ثبت شد"
            >
              برداشت از انبار:{' '}
              {exResult.centralWithdrawSources.map((w) => `${w.name} ${faDigits(w.qty)}`).join(' · ')}
            </span>
          )}
          {/* جلسه ۱۷ · بند ۱ */}
          {exResult.cardTransfer && (
            <span className="px-2 py-1 rounded bg-amber-100 border-2 border-amber-400 font-bold">
              درخواست کارت‌به‌کارت شماره {faDigits(exResult.cardTransfer.id)} ثبت شد ·{' '}
              {money(exResult.cardTransfer.amount)} ریال · در انتظار پرداخت مدیر
            </span>
          )}
          {exResult.storeCredit && (
            <span className="px-2 py-1 rounded bg-white border font-bold" title="مرجع امن اعتبار خرید صادرشده">
              {exResult.storeCredit.publicReference}
            </span>
          )}
          {exResult.storeCredit && (
            <span className="kbd">
              {money(exResult.storeCredit.amount)} ریال
              {exResult.storeCredit.expiresAtJalali
                ? ` · اعتبار تا ${faDigits(exResult.storeCredit.expiresAtJalali)}`
                : ''}
            </span>
          )}
          {(exResult.sourceCreditSuccessors ?? [])
            .filter((successor: any) => successor.id !== exResult.storeCredit?.id)
            .map((successor: any) => (
              <span key={successor.id} className="px-2 py-1 rounded bg-white border border-indigo-300 font-bold"
                title="جانشین بارکدِ مصرف‌شده؛ غیرنقدی است و مهلت ریشه را حفظ می‌کند">
                جانشین اعتبارِ منشأدار: {successor.publicReference} · {money(successor.amount)} ریال
              </span>
            ))}
          <ReturnCreditHandoffActions credits={exResult.handoffCredits} />
          <button className="btn btn-primary" onClick={() => void printExchange(exResult.returnId)} disabled={printing}>
            {printing ? 'در حال چاپ…' : 'چاپ سند تعویض'}
          </button>
          <button className="btn ms-auto" onClick={() => setExResult(null)}>
            بستن
          </button>
        </div>
      )}

      {lookup && (
        <>
          {/* ---------------- اطلاعات فاکتور ---------------- */}
          <div className="bg-white rounded shadow p-3 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2 pb-1 border-b">
              <span className="font-bold text-sm">مشخصات فاکتور #{faDigits(lookup.receiptNo)}</span>
              <InvoiceFinanceBadge profile={lookup.settlementProfile} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
              <Info label="شماره فیش" value={faDigits(lookup.receiptNo)} strong />
              <Info label="کد برگشت" value={lookup.returnCode ?? 'صادر نشده'} ltr strong />
              <Info label="جست‌وجو با" value={lookup.lookupKind === 'RETURN_CODE' ? 'کد برگشت' : 'شماره فیش'} />
              <Info label="تاریخ / ساعت" value={`${faDigits(lookup.issuedAtJalali)} · ${faDigits(lookup.issuedTime)}`} />
              <Info label="خریدار" value={lookup.customerName} />
              <Info label="شیفت" value={lookup.shiftName ?? '—'} />
              <Info label="وضعیت" value={lookup.statusLabel} />
              <Info label="اعتبار کد" value={lookupExpiryLabel} />
              <Info label="جمع مبلغ کالا" value={money(lookup.goodsTotal)} />
              <Info label="تخفیف" value={money(lookup.discountTotal)} />
              <Info label="حق سرویس" value={money(lookup.serviceCharge)} />
              <Info label="عوارض و مالیات" value={money(lookup.taxTotal)} />
              <Info label="جمع کل" value={money(lookup.grandTotal)} strong />
              <Info label="نحوه پرداخت" value={lookup.paymentLabels || '—'} />
              <Info
                label="برگشت‌های قبلی"
                value={lookup.returnedTotal ? money(lookup.returnedTotal) + ' ریال' : 'ندارد'}
              />
            </div>
          </div>

          {!lookup.deductInventory && (
            <div className="bg-amber-50 border-2 border-amber-400 rounded px-3 py-2">
              این فاکتور «بدون کسر از موجودی انبار» ثبت شده بود، پس برگشتش هم موجودی انبار را زیاد نمی‌کند (فقط سند
              مالی برگشت ثبت می‌شود). این تقارن عمدی است تا انبار الکی پر نشود. سند تعویض همین فاکتور هم — به همان
              تقارن — موجودی را کم نمی‌کند.
            </div>
          )}

          {/* ---------------- سوییچ حالت: برگشت ساده / تعویض کالا ---------------- */}
          <div className="bg-white rounded shadow p-2 flex flex-wrap items-center gap-3">
            <label
              className={`flex items-center gap-2 px-2 py-1 rounded border-2 cursor-pointer font-bold ${
                exchangeMode ? 'bg-emerald-50 border-emerald-400' : 'border-slate-300'
              }`}
              title="با روشن کردن این گزینه، جای «پس دادن پول»، کالای جایگزین انتخاب می‌شود و مابه‌التفاوت حساب می‌گردد"
            >
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={exchangeMode}
                onChange={(e) => {
                  setExchangeMode(e.target.checked)
                  if (!e.target.checked) {
                    setReps([])
                    setRepFor(null)
                  }
                }}
              />
              تعویض کالا (جای برگشت ساده)
            </label>
            <span className="kbd leading-6">
              {exchangeMode
                ? 'تعداد برگشتی هر قلم را بگذارید، بعد کالای جایگزین را اسکن/جست‌وجو کنید. مابه‌التفاوت زنده پایین صفحه دیده می‌شود و با «ثبت تعویض کالا» همه‌چیز در یک تراکنش ثبت می‌گردد.'
                : 'خاموش = همان برگشت از فروش همیشگی (کالا برمی‌گردد، سند برگشت ثبت می‌شود).'}
            </span>
          </div>

          {/* ---------------- اقلام ---------------- */}
          <div className="bg-white rounded shadow flex-1 overflow-auto min-h-[240px] max-h-[46vh]">
            <table className="tbl">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th>#</th>
                  <th>کد</th>
                  <th>بارکد</th>
                  <th>نام کالا</th>
                  <th>تعداد فروش</th>
                  <th>برگشت‌خورده</th>
                  <th>قابل برگشت</th>
                  <th>قیمت واحد</th>
                  <th>تعداد برگشتی</th>
                  <th>مبلغ برگشت</th>
                  <th>وضعیت کالا در انبار</th>
                  {exchangeMode && <th>کالای جایگزین</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => {
                  const q = qty[i.saleItemId] ?? 0
                  const blocked = i.stockState === 'MISSING'
                  const removed = i.stockState === 'REMOVED'
                  return (
                    <tr key={i.saleItemId} className={blocked ? 'bg-rose-50' : removed ? 'bg-amber-50' : ''}>
                      <td>{faDigits(idx + 1)}</td>
                      <td>{faDigits(i.code)}</td>
                      <td>{faDigits(i.barcode)}</td>
                      <td>{i.name}</td>
                      <td className="text-center">
                        {faDigits(i.qty)} {i.unit}
                      </td>
                      <td className="text-center">{faDigits(i.returnedQty)}</td>
                      <td className="text-center font-bold">{faDigits(i.remainingQty)}</td>
                      <td>{money(i.unitPrice)}</td>
                      <td className="w-28">
                        <input
                          type="number"
                          min={0}
                          max={i.remainingQty}
                          className="inp py-0.5"
                          disabled={blocked || i.remainingQty <= 0}
                          value={q}
                          onChange={(e) => setQtyFor(i, +e.target.value)}
                        />
                      </td>
                      <td className="font-bold">{money(returnValueFor(i, q))}</td>
                      <td className={blocked ? 'text-rose-700 font-bold' : removed ? 'text-amber-700 font-bold' : ''}>
                        {blocked || removed ? (
                          <>
                            این کالا از موجودی انبار حذف شده است
                            <div className="kbd">
                              {blocked
                                ? 'رکوردی از این کالا در سیستم نمانده؛ برگشت خودکارش ممکن نیست و باید دستی رسیدگی شود.'
                                : 'برای برگشت این قلم، تیک «رسیدگی دستی» را بزنید.'}
                            </div>
                          </>
                        ) : (
                          <>
                            موجود · {faDigits(i.stock)} {i.unit}
                          </>
                        )}
                      </td>
                      {exchangeMode && (
                        <td className="whitespace-nowrap">
                          <button
                            className="text-brand font-bold"
                            onClick={() => focusRep(i.name)}
                            title="کادر انتخاب کالای جایگزین (پایین جدول) فوکوس می‌شود: بارکد را اسکن کنید، نام یا کد کالا را بنویسید، یا از «همه کالاها» انتخاب کنید"
                          >
                            + جایگزین
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 font-bold">
                  <td colSpan={8}>جمع انتخاب‌شده برای برگشت</td>
                  <td className="text-center">{faDigits(totals.qty)}</td>
                  <td>{money(totals.amount)}</td>
                  <td colSpan={exchangeMode ? 2 : 1}>
                    {isFull ? 'برگشت کامل فاکتور' : totals.count ? 'برگشت جزئی' : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* ---------------- کالای جایگزین (بخش ۶) ---------------- */}
          {exchangeMode && (
            <div className="bg-white rounded shadow p-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">کالای جایگزین</span>
                <div className="flex-1 min-w-[280px] flex items-center gap-2">
                  <VariantSearchBox
                    ref={repSearchRef}
                    onPick={addRep}
                    placeholder="بارکد کالای جایگزین را اسکن کنید یا نام / کد کالا را بنویسید"
                    onAllOpenChange={setRepModalOpen}
                    allTitle="انتخاب کالای جایگزین از فهرست انبار"
                  />
                </div>
                {repFor && <span className="kbd">جایگزین «{repFor}» در حال انتخاب است</span>}
                <span className="kbd">
                  همان سه روش پنل فروش: اسکن بارکد · جست‌وجوی نام · تایپ کد — به‌علاوه‌ی دکمه‌ی «همه کالاها»
                </span>
              </div>

              {/*
                ---------------------- بند ۱۸: قیمت دستی، فقط با گیت مدیر ----------------------
                قیمت کالای جایگزین همیشه از `variant.salePrice` می‌آید. راه سوءاستفاده‌ای که
                بسته می‌شود: کالای برگشتیِ ۳ میلیونی با کالایی که قیمت واقعی‌اش ۱ میلیون است
                ولی روی صفر گذاشته شده تعویض شود و ۳ میلیون اعتبار خرید صادر گردد. سمت main
                هم همین قاعده هست و `AuditLog` قیمت واقعی، قیمت واردشده و کاربر را ثبت می‌کند.
              */}
              <div
                className={`rounded p-2 border-2 flex flex-wrap items-end gap-2 ${
                  priceOverrideOn ? 'bg-amber-50 border-amber-400' : 'bg-slate-50 border-slate-300'
                }`}
              >
                <label className="flex items-center gap-2 font-bold">
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    checked={priceOverrideOn}
                    onChange={(e) => {
                      const on = e.target.checked
                      setPriceOverrideOn(on)
                      if (!on) {
                        setManagerPw('')
                        // قفل که بسته شد، قیمت‌ها بی‌چون‌وچرا به قیمت واقعی کالا برمی‌گردند
                        setReps((prev) => prev.map((l) => ({ ...l, unitPrice: l.realPrice })))
                      }
                    }}
                  />
                  تغییر دستی قیمت کالای جایگزین (رمز مدیر لازم است)
                </label>
                {priceOverrideOn ? (
                  <>
                    <label>
                      <div className="kbd">رمز مدیر</div>
                      <input
                        type="password"
                        className="inp w-40"
                        dir="ltr"
                        value={managerPw}
                        onChange={(e) => setManagerPw(e.target.value)}
                      />
                    </label>
                    <span className="kbd text-amber-800 leading-6">
                      قیمت واقعی و قیمت واردشده‌ی هر قلم، همراه نام کاربر، در سابقه‌ی تغییرات ثبت می‌شود.
                      {!!priceChanged.length && (
                        <b className="block">
                          {faDigits(priceChanged.length)} قلم با قیمت دستی:{' '}
                          {priceChanged
                            .map((l) => `«${l.name}» واقعی ${money(l.realPrice)} ← واردشده ${money(l.unitPrice)}`)
                            .join(' · ')}
                        </b>
                      )}
                    </span>
                  </>
                ) : (
                  <span className="kbd leading-6">
                    قیمت هر کالای جایگزین همان قیمت فروش ثبت‌شده‌ی خودش است و قابل تایپ نیست. این قفل، ساختنِ «اعتبار خرید
                    بزرگ‌تر از واقعیت» با قیمت صفر را غیرممکن می‌کند.
                  </span>
                )}
              </div>

              <div className="overflow-auto max-h-[28vh] border border-slate-200 rounded">
                <table className="tbl">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th>کد</th>
                      <th>بارکد</th>
                      <th>نام کالا</th>
                      <th className="w-24">تعداد</th>
                      <th className="w-32">قیمت واحد</th>
                      <th className="w-28">تخفیف ردیف</th>
                      <th>جمع</th>
                      <th>موجودی</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reps.map((l, index) => (
                      <tr key={l.variantId} className={l.qty > l.stock ? 'bg-amber-50' : ''}>
                        <td>{faDigits(l.code)}</td>
                        <td>{faDigits(l.barcode)}</td>
                        <td>{l.name}</td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            className="inp py-0.5"
                            value={l.qty}
                            onChange={(e) => patchRep(l.variantId, { qty: Math.max(1, Math.round(+e.target.value || 1)) })}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            className="inp py-0.5"
                            value={l.unitPrice}
                            disabled={!priceOverrideOn}
                            onChange={(e) =>
                              patchRep(l.variantId, { unitPrice: Math.max(0, Math.round(+e.target.value || 0)) })
                            }
                            title={
                              priceOverrideOn
                                ? `قیمت واقعی این کالا ${money(l.realPrice)} ریال است؛ تغییرش با رمز مدیر ثبت و در سابقه ضبط می‌شود`
                                : 'قیمت از خودِ کالا خوانده می‌شود (بند ۱۸). برای تغییر دستی، قفل بالای همین بخش را با رمز مدیر باز کنید.'
                            }
                          />
                          {l.unitPrice !== l.realPrice && (
                            <div className="kbd text-amber-800 font-bold">قیمت واقعی {money(l.realPrice)}</div>
                          )}
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            className="inp py-0.5"
                            value={l.discount}
                            onChange={(e) =>
                              patchRep(l.variantId, { discount: Math.max(0, Math.round(+e.target.value || 0)) })
                            }
                          />
                          {Number(exFundingPreview?.replacementTransferShares?.[index] ?? 0) > 0 && (
                            <div className="kbd text-violet-700 font-semibold">+
                              {money(Number(exFundingPreview.replacementTransferShares[index]))} ریال انتقال تاریخی (جدا از تخفیف جاری)
                            </div>
                          )}
                        </td>
                        <td className="font-bold">{money(Math.max(0, l.unitPrice * l.qty - l.discount - Number(exFundingPreview?.replacementTransferShares?.[index] ?? 0)))}</td>
                        <td className={l.qty > l.stock ? 'text-amber-700 font-bold' : ''}>{faDigits(l.stock)}</td>
                        <td>
                          <button className="text-red-500" onClick={() => removeRep(l.variantId)}>
                            حذف
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!reps.length && (
                      <tr>
                        <td colSpan={9} className="text-center py-6 text-slate-400">
                          هنوز کالای جایگزینی انتخاب نشده است — بارکدش را اسکن کنید یا نام/کدش را بنویسید
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {!!reps.length && (
                    <tfoot>
                      <tr className="bg-slate-100 font-bold">
                        <td colSpan={3}>جمع کالای جایگزین</td>
                        <td className="text-center">{faDigits(exTotals.qty)}</td>
                        <td>{money(exTotals.goods)}</td>
                        <td>{money(exTotals.discount)}</td>
                        <td>{money(exTotals.goods - exTotals.discount)}</td>
                        <td colSpan={2}></td>
                      </tr>
                      {historicalTransferAmount > 0 && (
                        <tr className="bg-violet-50 font-semibold text-violet-800">
                          <td colSpan={6}>تخفیف تاریخی منتقل‌شده (مستقل از تخفیف جاری)</td>
                          <td>−{money(historicalTransferAmount)}</td>
                          <td colSpan={2}></td>
                        </tr>
                      )}
                      {/* نشست ۱۵۸ (Y16) — عوارض/حق سرویس کالای جایگزین از تنظیمات کانال فاکتور اصلی */}
                      {(effectiveTaxTotal > 0 || effectiveServiceCharge > 0) && (
                        <tr className="bg-slate-50">
                          <td colSpan={6}>
                            عوارض و مالیات {money(effectiveTaxTotal)} ریال · حق سرویس {money(effectiveServiceCharge)} ریال
                            {exScope === 'wholesale' ? ' (تنظیمات فروش عمده)' : ' (تنظیمات پنل فروش)'}
                          </td>
                          <td>{money(effectiveTaxTotal + effectiveServiceCharge)}</td>
                          <td colSpan={2}></td>
                        </tr>
                      )}
                      <tr className="bg-slate-100 font-bold">
                        <td colSpan={6}>جمع سند تعویض</td>
                        <td>{money(effectiveExchangeTotal)}</td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              {/* ---------- مابه‌التفاوت زنده ---------- */}
              <div
                className={`rounded p-2 border-2 grid grid-cols-2 md:grid-cols-4 gap-2 ${
                  exSettlementDiff > 0
                    ? 'bg-emerald-50 border-emerald-400'
                    : exSettlementDiff < 0
                      ? 'bg-amber-50 border-amber-400'
                      : 'bg-slate-50 border-slate-300'
                }`}
              >
                {discountTransferNeedsChoice ? (
                  <div className="col-span-2 md:col-span-4 rounded border border-violet-300 bg-white p-2 font-semibold">
                    مبلغ نهایی دریافت یا بازپرداخت پس از انتخاب یکی از گزینه‌های انتقال تخفیف نمایش داده می‌شود.
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="kbd">ارزش کالای برگشتی</div>
                      <div className="font-bold">{money(totals.amount)}</div>
                    </div>
                    <div>
                      <div className="kbd">جمع کالای جایگزین</div>
                      <div className="font-bold">{money(Number(exFundingPreview?.exchangeTotal ?? exTotals.exchangeTotal))}</div>
                    </div>
                    <div>
                      <div className="kbd">مابه‌التفاوت</div>
                      <div className="font-bold text-base">{money(Math.abs(exSettlementDiff))}</div>
                    </div>
                    <div>
                      <div className="kbd">نحوه‌ی تسویه</div>
                      <div className="font-bold">{diffLabel}</div>
                    </div>
                  </>
                )}
                {exFundingPreviewBusy && (
                  <div className="col-span-2 md:col-span-4 rounded border border-sky-300 bg-sky-50 p-2 font-semibold">
                    سیستم دارد سهم پول واقعی و اعتبارِ مجاز برای کالای جایگزین را بررسی می‌کند؛ تا پایان بررسی، ثبت تعویض متوقف است.
                  </div>
                )}
                {!exFundingPreviewBusy && exFundingPreviewError && (
                  <div className="col-span-2 md:col-span-4 rounded border border-rose-400 bg-rose-50 p-2 font-semibold text-rose-900">
                    پیش‌نمایش تسویه کامل نشد: {exFundingPreviewError}
                  </div>
                )}
                {exFundingPreview?.ok && Number(exFundingPreview.sourceCreditRestoration ?? 0) > 0 && (
                  <div className="col-span-2 md:col-span-4 rounded border border-indigo-300 bg-indigo-50 p-2">
                    {money(Number(exFundingPreview.sourceCreditRestoration))} ریال از اعتبار مبدأ خارج از پشتوانهٔ کالای جایگزین است؛ به کالای دیگری منتقل نمی‌شود و جداگانه با همان محدوده و تاریخ انقضا بازمی‌گردد یا اگر منقضی باشد بسته می‌ماند.
                  </div>
                )}
                {exFundingPreview?.ok && exFundingPreview.discountTransfer && (
                  <div className="col-span-2 md:col-span-4 rounded border-2 border-violet-300 bg-violet-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <b>تخفیف تاریخیِ قابل‌اثبات: {money(Number(exFundingPreview.discountTransfer.historicalDiscount))} ریال</b>
                      <span className="text-sm">ظرفیت قلم‌های جایگزین: {money(Number(exFundingPreview.discountTransfer.capacity))} ریال</span>
                    </div>
                    <p className="mb-2 text-sm font-semibold text-violet-950">یکی از گزینه‌ها را انتخاب کنید؛ هیچ گزینه‌ای از پیش انتخاب نشده است.</p>
                    {discountTransferNeedsChoice && (
                      <p className="mb-2 rounded bg-white p-2 text-sm">جمع تسویهٔ هر سه گزینه در همین‌جا مقایسه شده است؛ پس از انتخاب، فقط روش و جزئیات پرداخت/بازپرداخت را جداگانه تعیین کنید.</p>
                    )}
                    <label className={`flex items-start gap-2 rounded border p-2 ${
                      discountTransferChoice('YES')?.recommended
                        ? 'border-emerald-500 bg-emerald-50'
                        : discountTransferOption === 'YES' ? 'border-violet-600 bg-white' : 'border-slate-300 bg-white'
                    }`}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={discountTransferOption === 'YES'}
                        disabled={discountTransferChoice('YES')?.enabled === false}
                        onChange={(event) => setDiscountTransferOption(event.target.checked ? 'YES' : 'NO')}
                      />
                      <span>
                        <b>بله — انتقال تا سقف ظرفیت</b>
                        {discountTransferChoice('YES')?.recommended && <span className="mr-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">★ پیشنهاد</span>}
                        <span className="block text-sm">{discountTransferExplanation(
                          'YES',
                          Number(exFundingPreview.discountTransfer.historicalDiscount),
                          Number(discountTransferChoice('YES')?.transferAmount ?? 0),
                          (amount) => money(amount)
                        )}</span>
                        {discountTransferSettlementSummary(discountTransferChoice('YES'))}
                        {discountTransferChoice('YES')?.enabled === false && (
                          <span className="block text-sm font-bold text-rose-700">این گزینه غیرفعال است؛ انتقال کامل باعث بازپرداخت اضافه از محل تخفیف تاریخی می‌شود.</span>
                        )}
                      </span>
                    </label>
                    <div className="mt-2 grid grid-cols-1 gap-2">
                      <button type="button" className={`btn text-right ${discountTransferOption === 'NO' ? 'btn-primary' : ''} ${discountTransferChoice('NO')?.recommended ? 'border-emerald-500 bg-emerald-50' : ''}`} onClick={() => setDiscountTransferOption('NO')}>
                        <b>خیر — بدون انتقال</b>
                        {discountTransferChoice('NO')?.recommended && <span className="mr-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">★ پیشنهاد</span>}
                        <span className="block text-xs">{discountTransferExplanation(
                          'NO',
                          Number(exFundingPreview.discountTransfer.historicalDiscount),
                          Number(discountTransferChoice('NO')?.transferAmount ?? 0),
                          (amount) => money(amount)
                        )}</span>
                        {discountTransferSettlementSummary(discountTransferChoice('NO'))}
                      </button>
                      <button type="button" className={`btn text-right ${discountTransferOption === 'YES_ZERO' ? 'btn-primary' : ''} ${discountTransferChoice('YES_ZERO')?.recommended ? 'border-emerald-500 bg-emerald-50' : ''}`} onClick={() => setDiscountTransferOption('YES_ZERO')}>
                        <b>بله صفر — انتقال امنِ تخفیف</b>
                        {discountTransferChoice('YES_ZERO')?.recommended && <span className="mr-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">★ پیشنهاد</span>}
                        <span className="block text-xs">{discountTransferExplanation(
                          'YES_ZERO',
                          Number(exFundingPreview.discountTransfer.historicalDiscount),
                          Number(discountTransferChoice('YES_ZERO')?.transferAmount ?? 0),
                          (amount) => money(amount)
                        )}</span>
                        {discountTransferSettlementSummary(discountTransferChoice('YES_ZERO'))}
                      </button>
                    </div>
                  </div>
                )}
                {/* روش تسویه فقط برای سهم پولیِ واقعیِ باقی‌مانده پس از کسر بدهی و اعتبار منشأدار لازم است؛ انتخاب خودکار نداریم. */}
                {!discountTransferNeedsChoice && exSettlementDiff < 0 && (
                  <div
                    className={`col-span-2 md:col-span-4 rounded p-2 border-2 ${
                      exRefundMode ? 'bg-white border-emerald-400' : 'bg-amber-50 border-amber-300'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <b>تسویه‌ی مابه‌التفاوت منفی — {money(-exSettlementDiff)} ریال</b>
                      {!exRefundMode && <span className="text-amber-900 font-bold">اگر پس از کسر بدهی و برگرداندن اعتبار منشأدار، وجه واقعی باقی بماند، انتخاب روش تسویه اجباری است؛ هیچ روش یا اعتباری خودکار انتخاب نمی‌شود.</span>}
                    </div>
                    <div className="kbd mb-2">
                      سهم اعتبارِ منشأدار جداگانه و غیرنقدی به منبع/جانشین خودش برمی‌گردد. اگر پس از کسر بدهی و این سهم، وجه واقعی باقی بماند، یک روش مجاز را صریح انتخاب کنید؛ سیستم اعتبار خرید یا اولین روش فعال را به‌جای شما انتخاب نمی‌کند.
                      مثلاً با برگشت ۲۰، شامل ۵ اعتبار و ۱۵ وجه واقعی، و تعویض ۱۰، در نبود بدهیِ قابل‌کسر، ۵ اعتبار منشأدار به منبعش برمی‌گردد و برای ۵ وجه واقعی باید روش تسویه را انتخاب کنید.
                    </div>
                    {/* جلسه ۱۷ · بند ۱ — چهار ستون، چون گزینه‌ی «کارت‌به‌کارت توسط مدیر» اضافه شد */}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                      {EXCHANGE_REFUND_CHOICES.map((c) => (
                        <label
                          key={c.value}
                          className={`flex items-start gap-2 p-2 rounded border-2 cursor-pointer ${
                            exRefundMode === c.value ? 'bg-emerald-50 border-emerald-500' : 'border-slate-300'
                          }`}
                        >
                          <input
                            type="radio"
                            className="w-4 h-4 mt-1"
                            name="exchangeRefundMode"
                            checked={exRefundMode === c.value}
                            onChange={() => {
                              setExRefundMode(c.value)
                              if (c.value !== 'CASH' && c.value !== 'CARD') setExRefundPayoutAmount('')
                            }}
                          />
                          <span>
                            <b>{c.title}</b>
                            <div className="kbd leading-5">{c.hint}</div>
                          </span>
                        </label>
                      ))}
                    </div>
                    {(exRefundMode === 'CASH' || exRefundMode === 'CARD') && (
                      <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 space-y-1">
                        <label className="block font-bold" htmlFor="exchange-payout-amount">
                          مبلغی که واقعاً {exRefundMode === 'CASH' ? 'نقد از صندوق' : 'به کارت مشتری'} پرداخت می‌شود (اختیاری)
                        </label>
                        <input
                          id="exchange-payout-amount"
                          className="input w-full max-w-sm"
                          inputMode="numeric"
                          placeholder="خالی = کل سهم وجه واقعیِ قابل‌پرداخت"
                          value={groupThousands(exRefundPayoutAmount)}
                          onChange={(event) => setExRefundPayoutAmount(event.target.value.replace(/[^0-9]/g, ''))}
                        />
                        <div className="kbd">
                          خالی بماند: کل سهم وجه واقعی با روش انتخاب‌شده پرداخت می‌شود. مبلغ کمتر: باقیمانده‌ی سهم وجه واقعی به‌صورت بارکد اعتباری صادر می‌شود؛ مبلغ بیشتر از سهم قابل‌پرداخت در سرور رد خواهد شد. سهم اعتبار منشأدار جداگانه و غیرنقدی می‌ماند.
                        </div>
                        {/*
                          مورد ۳ — پیش‌نمایش read-only از همان plan سرور: عدد پرداختی
                          و مانده‌ای که بارکد اعتبار می‌شود، پیش از ثبت دیده می‌شود.
                          ثبت نهایی همین plan را دوباره اعتبارسنجی می‌کند و اگر
                          عوض شده باشد با اختلاف دقیق رد می‌شود.
                        */}
                        {(() => {
                          const split: any = exFundingPreview?.ok === true ? (exFundingPreview as any).settlementSplit : null
                          if (!split) return null
                          const over = Boolean(split.overRequested)
                          return (
                            <div className={`rounded border p-2 space-y-1 ${over ? 'border-rose-400 bg-rose-50' : 'border-emerald-300 bg-white'}`}>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">
                                <div>
                                  <div className="kbd">سهم وجه واقعیِ قابل‌پرداخت</div>
                                  <b>{money(Number(split.moneySurplus ?? 0))} ریال</b>
                                </div>
                                <div>
                                  <div className="kbd">پرداخت واقعی</div>
                                  <b>{money(Number(split.payoutAmount ?? 0))} ریال</b>
                                </div>
                                <div>
                                  <div className="kbd">تبدیل به بارکد اعتبار</div>
                                  <b className={Number(split.remainderAsCredit ?? 0) > 0 ? 'text-amber-800' : ''}>
                                    {money(Number(split.remainderAsCredit ?? 0))} ریال
                                  </b>
                                </div>
                              </div>
                              {over ? (
                                <div className="font-bold text-rose-700">
                                  مبلغ واردشده از سهم وجه واقعی بیشتر است؛ ثبت نهایی رد می‌شود. مبلغ را کم کنید یا فیلد را خالی بگذارید
                                  تا کل سهم پرداخت شود.
                                </div>
                              ) : (
                                <div className="kbd leading-5">
                                  {Number(split.remainderAsCredit ?? 0) > 0
                                    ? `این مبلغ نقد/کارت خارج می‌شود و ${money(Number(split.remainderAsCredit ?? 0))} ریال از سهم وجه واقعی، بارکد اعتبار خرید می‌شود. سهم اعتبار منشأدار همچنان جداگانه به منبعش برمی‌گردد.`
                                    : 'کل سهم وجه واقعی با روش انتخابی پرداخت می‌شود؛ بارکد اعتباری از این بابت صادر نمی‌شود.'}
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )}
                {!discountTransferNeedsChoice && exSettlementDiff > 0 && (
                  <div className="col-span-2 md:col-span-4 rounded border border-emerald-300 bg-white p-2 space-y-2">
                    <div className="kbd">
                      بارکد اعتبار را می‌توانید تا سقف مابه‌التفاوت مصرف کنید؛ اعتبار وجه نقد نیست و فقط باقی‌مانده از مشتری دریافت می‌شود.
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex-1 min-w-[16rem]">
                        <div className="kbd">بارکد اعتبار موجود (اختیاری)</div>
                        <input
                          className="inp"
                          dir="ltr"
                          value={exCreditCode}
                          onChange={(e) => {
                            setExCreditCode(e.target.value)
                            setExCreditVerifiedCode(null)
                            setExCreditInfo(null)
                            setExCreditError(null)
                          }}
                          placeholder="کد بارکد اعتبار را وارد یا اسکن کنید"
                          autoComplete="off"
                        />
                      </label>
                      <button type="button" className="btn" disabled={exCreditBusy || !exCreditCode.trim()} onClick={() => void checkExchangeCredit()}>
                        {exCreditBusy ? 'در حال بررسی…' : 'بررسی اعتبار'}
                      </button>
                    </div>
                    {exCreditError && <div className="text-rose-700 font-bold">{exCreditError}</div>}
                    {exCreditInfo && exCreditVerifiedCode === exCreditCode.trim() && (
                      <div className="kbd text-emerald-800">
                        اعتبار بررسی شد · مانده {money(exCreditRemaining)} ریال · قابل مصرف در این تعویض تا {money(exCreditAppliedPreview)} ریال
                      </div>
                    )}
                    {exCashDuePreview > 0 ? (
                      <>
                        <label className="flex items-center gap-2 cursor-pointer w-fit">
                          <input
                            type="checkbox"
                            className="w-4 h-4"
                            checked={exSplitPayment}
                            onChange={(e) => setExSplitPayment(e.target.checked)}
                          />
                          <span className="font-bold">دریافت ترکیبی نقد + کارت از باقیمانده</span>
                        </label>
                        <div className="kbd">مبلغ لازم از مشتری: {money(exCashDuePreview)} ریال · اعتبار مصرفی در صندوق ثبت نمی‌شود.</div>
                        {!exSplitPayment ? (
                          <label className="block max-w-sm">
                            <div className="kbd">روش دریافت باقیمانده</div>
                            <select
                              className="inp"
                              value={methodId ?? ''}
                              onChange={(e) => setMethodId(e.target.value ? Number(e.target.value) : null)}
                            >
                              <option value="">روش پرداخت را انتخاب کنید</option>
                              {methods.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              <label>
                                <div className="kbd">سهم نقدی</div>
                                <input
                                  className="inp"
                                  dir="ltr"
                                  inputMode="numeric"
                                  value={groupThousands(exSplitCash)}
                                  onChange={(e) => {
                                    if (parseGroupedInteger(e.target.value) != null) setExSplitCash(digitsOnly(e.target.value))
                                  }}
                                  placeholder="مبلغ نقد"
                                  title="فقط عدد صحیح ریالی؛ جداکنندهٔ هزارگان و ارقام فارسی پذیرفته می‌شود."
                                />
                                <select
                                  className="inp mt-1"
                                  value={exSplitCashMethodId ?? ''}
                                  onChange={(e) => setExSplitCashMethodId(e.target.value ? Number(e.target.value) : null)}
                                >
                                  <option value="">روش نقدی را انتخاب کنید</option>
                                  {cashMethods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </select>
                              </label>
                              <label>
                                <div className="kbd">سهم کارتی</div>
                                <input
                                  className="inp"
                                  dir="ltr"
                                  inputMode="numeric"
                                  value={groupThousands(exSplitCard)}
                                  onChange={(e) => {
                                    if (parseGroupedInteger(e.target.value) != null) setExSplitCard(digitsOnly(e.target.value))
                                  }}
                                  placeholder="مبلغ کارت"
                                  title="فقط عدد صحیح ریالی؛ جداکنندهٔ هزارگان و ارقام فارسی پذیرفته می‌شود."
                                />
                                <select
                                  className="inp mt-1"
                                  value={exSplitCardMethodId ?? ''}
                                  onChange={(e) => setExSplitCardMethodId(e.target.value ? Number(e.target.value) : null)}
                                >
                                  <option value="">روش کارتی را انتخاب کنید</option>
                                  {cardMethods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </select>
                              </label>
                            </div>
                            <div className={`kbd font-bold ${exSplitTotal === exCashDuePreview && (exSplitCashAmount ?? 0) > 0 && (exSplitCardAmount ?? 0) > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                              جمع نقد و کارت: {money(exSplitTotal ?? 0)} ریال · مبلغ لازم: {money(exCashDuePreview)} ریال
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <div className="rounded bg-emerald-50 border border-emerald-300 p-2 font-bold text-emerald-800">
                        کل مابه‌التفاوت با اعتبار غیرنقدی پوشش داده می‌شود؛ از مشتری وجهی دریافت نمی‌شود.
                      </div>
                    )}
                  </div>
                )}
                <label className="col-span-2 md:col-span-3 flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="w-4 h-4 mt-1"
                    checked={repAutoCentral}
                    onChange={(e) => setRepAutoCentral(e.target.checked)}
                  />
                  <span className="kbd leading-6">
                    کمبود موجودی کالای جایگزین از «انبار مرکزی» برداشته شود (همان رفتار پنل فروش).
                    {!!repShort.length && (
                      <b className="block text-amber-800">
                        موجودی فروشگاه برای {faDigits(repShort.length)} قلم جایگزین کافی نیست:{' '}
                        {repShort.map((l) => `«${l.name}» (موجودی ${faDigits(l.stock)} · درخواست ${faDigits(l.qty)})`).join(' · ')}
                      </b>
                    )}
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* ---------------- روش بازپرداخت (پیش‌فرض امن: بدون خروج وجه) ---------------- */}
          {!exchangeMode && (
            <div
              className={`rounded shadow p-3 space-y-2 border-2 ${
                refundMethod ? 'bg-white border-emerald-400' : 'bg-sky-50 border-sky-300'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <b>روش بازپرداخت این برگشت</b>
                {!refundMethod && <span className="text-sky-800 font-bold">روش هنوز انتخاب نشده است؛ اگر حق بازپرداخت وجود داشته باشد ثبت نهایی متوقف می‌شود. تا انتخاب صریح روش، هیچ پول، اعتبار یا حرکت موجودی ثبت نمی‌شود.</span>}
                <span className="kbd ms-auto">
                  مشتری تا الان {money(lookup.paidTotal)} ریال بابت این فاکتور پرداخت کرده است؛ بازپرداخت نقدی/کارتی از این
                  مبلغ بیشتر نمی‌شود.
                </span>
              </div>
              <div className="kbd rounded border border-sky-300 bg-sky-50 p-2">
                اعتبار عمومی «ALL» سهم کالاها نمی‌شود: ابتدا سهم اعتبار مصرف‌شده طبق منشأ آن برمی‌گردد؛ فقط باقیمانده‌ی حق واقعی را اینجا به‌صورت وجه واقعی یا بارکد غیرنقدی انتخاب کنید. اعتبار مدیریتیِ محدود به کالا/دسته فقط با برگشت کالای مشمولش برمی‌گردد.
              </div>
              <SmartSettlementPanel
                guidance={guidance}
                selectedMethod={refundMethod}
                onSelectMethod={(m) => {
                  setRefundMethod(m)
                  if (m !== 'CARD') setCardPosOverride(null)
                }}
                onCardPosLocked={() => setCardPosDialog(true)}
              />
              {refundMethod && refundMethod !== 'NONE' && (
                <div className="flex flex-wrap gap-2 items-end">
                  <label>
                    <div className="kbd">مبلغ وجه واقعی/بارکد جدید (خالی = حق واقعی محاسبه‌شده پس از برگشت اعتبار منشأدار)</div>
                    <input
                      className="inp w-44"
                      dir="ltr"
                      /**
                       * نشست ۳۱۶ — نمایش سه‌رقم‌سه‌رقم هنگام تایپ؛ state خامِ
                       * رقمی می‌ماند تا Number(...) سمت ارسال (:۵۰۶) نیاز به
                       * تغییر نداشته باشد.
                       */
                      value={groupThousands(refundAmount)}
                      onChange={(e) => setRefundAmount(digitsOnly(e.target.value))}
                      placeholder={groupThousands(String(totals.amount))}
                      inputMode="numeric"
                    />
                  </label>
                  {refundMethod === 'CARD' && (
                    <label>
                      <div className="kbd">شماره پیگیری / مرجع بازپرداخت</div>
                      <input className="inp w-48" dir="ltr" value={refundReference} onChange={(e) => setRefundReference(e.target.value)} />
                    </label>
                  )}
                  <label className="flex-1 min-w-[200px]">
                    <div className="kbd">توضیح بازپرداخت (اختیاری)</div>
                    <input
                      className="inp"
                      value={refundNote}
                      onChange={(e) => setRefundNote(e.target.value)}
                      placeholder="مثلاً: مشتری درخواست کرد فقط همین مبلغ پرداخت شود"
                    />
                    <span className="kbd block mt-1">مبلغ بازپرداخت باید <b>دقیقاً</b> برابر حق امن محاسبه‌شده باشد؛ کمتر یا بیشتر — حتی با توضیح — ثبت نمی‌شود. خالی گذاشتن یعنی همان مبلغ امن. این توضیح فقط برای سابقه و گزارش برگشت‌های فروش است.</span>
                  </label>
                </div>
              )}
              {refundMethod === 'NONE' && (
                <label className="block rounded border border-amber-300 bg-amber-50 p-2">
                  <div className="kbd font-bold">دلیل صریح «بدون بازپرداخت» (در صورت وجود حق مثبت اجباری است)</div>
                  <input
                    className="inp w-full mt-1"
                    value={refundNote}
                    onChange={(e) => setRefundNote(e.target.value)}
                    placeholder="برای نمونه: مشتری بازپرداخت را نپذیرفت"
                  />
                </label>
              )}
              <label className="flex items-start gap-2 mt-2 rounded border border-rose-300 bg-rose-50 p-2">
                <input
                  type="checkbox"
                  className="w-4 h-4 mt-1"
                  checked={managerFullRefund}
                  onChange={(e) => setManagerFullRefund(e.target.checked)}
                />
                <span className="flex-1">
                  <b className="text-rose-800">بازپرداخت مبلغ کامل، بدون کسر تخفیف، با تایید مدیر</b>
                  <span className="kbd block">فقط مدیر با رمز و دلیل می‌تواند تخفیف را نادیده بگیرد؛ این رویداد در Audit ثبت می‌شود.</span>
                  {managerFullRefund && (
                    <span className="flex flex-wrap gap-2 mt-2">
                      <input
                        type="password"
                        className="inp w-40"
                        dir="ltr"
                        placeholder="رمز مدیر"
                        value={fullRefundPw}
                        onChange={(e) => setFullRefundPw(e.target.value)}
                      />
                      <input
                        className="inp flex-1 min-w-[220px]"
                        placeholder="دلیل اجباری مدیر"
                        value={fullRefundReason}
                        onChange={(e) => setFullRefundReason(e.target.value)}
                      />
                    </span>
                  )}
                </span>
              </label>
            </div>
          )}

          {/* ---------------- عملیات ---------------- */}
          <div className="bg-white rounded shadow p-3 flex flex-wrap gap-3 items-end">
            <button className="btn" onClick={selectAll} disabled={busy}>
              برگشت کامل (همه‌ی اقلام)
            </button>
            <button className="btn" onClick={clearAll} disabled={busy}>
              پاک کردن انتخاب‌ها
            </button>
            <label className="flex-1 min-w-[200px]">
              <div className="mb-1">یادداشت {exchangeMode ? 'تعویض' : 'برگشت'} (اختیاری)</div>
              <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {!!removedSelected.length && (
              <label className="flex items-center gap-2 pb-2 text-amber-800 font-bold">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={allowRemoved}
                  onChange={(e) => setAllowRemoved(e.target.checked)}
                />
                رسیدگی دستی: کالای حذف‌شده از انبار هم برگشت بخورد
              </label>
            )}
            {lookup && deadlineBlocked && (
              <div className="text-rose-700 font-bold">
                {lookup.expiryState === 'EXPIRED'
                  ? `مهلت برگشت تا پایان روز ${lookup.expiresAtJalali ? faDigits(lookup.expiresAtJalali) : 'ثبت‌شده'} به وقت تهران تمام شده است؛ برگشت و تعویض ثبت نمی‌شود.`
                  : 'مهلت کد در سابقه ثبت نشده است؛ برای جلوگیری از ثبت خارج از مهلت، برگشت و تعویض مسدود است.'}
              </div>
            )}
            {lookup && !isReturnableStatus(lookup.status) && (
              <div className="text-rose-700 font-bold">
                این فاکتور {lookup.status === 'CANCELED' ? 'لغو شده' : 'پیش‌نویس'} است؛ برگشت و تعویض روی آن ممکن نیست.
              </div>
            )}
            {exchangeMode ? (
              <button
                className="btn btn-primary"
                onClick={() => void doExchange(false)}
                disabled={busy || lookupLocked || !totals.count || !reps.length}
                title="برگشت اقلام + سند تعویض + تسویه‌ی مابه‌التفاوت، همه در یک تراکنش"
              >
                {busy ? 'در حال ثبت…' : 'ثبت تعویض کالا'}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void doSubmit(false)}
                disabled={busy || lookupLocked || !totals.count}
                title={refundMethod ? undefined : 'روش انتخاب‌نشده با «بدون بازپرداخت» فرق دارد؛ در صورت وجود حق مثبت، ثبت نهایی متوقف و بدون تغییر می‌ماند.'}
              >
                {busy ? 'در حال ثبت…' : 'ثبت برگشت از فروش'}
              </button>
            )}
            <button
              className="btn"
              onClick={() => void printSourceInvoice(lookup.invoiceId)}
              disabled={busy || printing}
            >
              {printing ? 'در حال چاپ…' : 'چاپ رسید فاکتور'}
            </button>
            <div className="kbd">
              {exchangeMode
                ? 'تعویض = یک «سند تعویض» جدید با اقلام جایگزین + برگشت اقلام قدیمی. ارزش کالای برگشتی به‌صورت یک پرداختی غیرنقدی روی سند می‌نشیند، پس در «خالص واقعی دریافتی» گزارش شمرده نمی‌شود.'
                : 'برگشت، موجودی را فوراً و به‌صورت قطعی به انبار برمی‌گرداند (حرکت انبار با دلیل SALE_RETURN ثبت می‌شود) و وضعیت فاکتور به «برگشت جزئی/کامل» تغییر می‌کند.'}
            </div>
          </div>
        </>
      )}

      {/* ---------------- آخرین برگشت‌ها ---------------- */}
      {!lookup && (
        <div className="tbl-card">
          <div className="p-2 border-b flex flex-wrap gap-3 items-end">
            <div className="font-bold self-center">برگشت‌های ثبت‌شده</div>
            <div>
              <div className="mb-1">از تاریخ</div>
              <JalaliDateInput value={histFrom} onChange={setHistFrom} />
            </div>
            <div>
              <div className="mb-1">تا تاریخ</div>
              <JalaliDateInput value={histTo} onChange={setHistTo} />
            </div>
            <button className="btn btn-primary" onClick={() => void loadHistory()} disabled={rowBusy}>
              نمایش
            </button>
            <button
              className="btn"
              onClick={() => {
                setHistFrom(jalaliToday())
                setHistTo(jalaliToday())
              }}
              disabled={rowBusy}
            >
              امروز
            </button>
            <div className="kbd self-center leading-6">
              {faDigits(history.length)} برگشت · جمع {money(history.reduce((s, r) => s + (r.total ?? 0), 0))} ریال · از این
              مبلغ {money(history.reduce((s, r) => s + (r.cashRefundAmount ?? 0), 0))} ریال نقد از کشوی صندوق خارج شده است ·
              هر ردیف قابل ویرایش و حذف است (موجودی انبار خودکار اصلاح می‌شود)
              <div>
                این فهرست فقط «برگشت ساده» را نشان می‌دهد؛ تعویض‌ها در تب «تعویض کالا»ی گزارشات فروش دیده می‌شوند (بند ۱۰).
              </div>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>شماره فیش</th>
                <th>کد فاکتور</th>
                <th>تاریخ برگشت</th>
                <th>ساعت</th>
                <th>مشتری</th>
                <th>نوع</th>
                <th>تعداد</th>
                <th>مبلغ</th>
                {/* ---- بند ۱۱: دو ستونی که تفکیک «کسری واقعی» از «کسری کاذب» را ممکن می‌کنند ---- */}
                <th>نحوه‌ی تسویه</th>
                <th>نقد خارج‌شده از صندوق</th>
                <th>برگشت به انبار</th>
                <th>اقلام</th>
                <th>رسید</th>
                <th>ویرایش</th>
                <th>حذف</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td className="font-bold">{faDigits(r.receiptNo ?? '—')}</td>
                  <td dir="ltr">
                    {r.returnCode ? (
                      <button className="text-brand" onClick={() => void lookupCode(r.returnCode)}>
                        {r.returnCode}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{faDigits(r.returnedAtJalali)}</td>
                  <td>{faDigits(r.time)}</td>
                  <td>{r.customerName}</td>
                  <td>{r.isFull ? 'کامل' : 'جزئی'}</td>
                  <td className="text-center">{faDigits(r.qty)}</td>
                  <td>{money(r.total)}</td>
                  <td className="whitespace-normal">
                    {r.refundMethodLabel ?? '—'}
                    {r.legacyAssumed && (
                      <div className="kbd text-amber-800 font-bold">فرض‌شده از داده‌ی قدیمی</div>
                    )}
                    {r.refundReference && <div className="kbd" dir="ltr">{r.refundReference}</div>}
                  </td>
                  <td className={r.cashRefundAmount ? 'text-rose-700 font-bold' : ''}>
                    {money(r.cashRefundAmount ?? 0)}
                  </td>
                  <td className="text-center">{faDigits(r.restockedQty ?? 0)}</td>
                  <td className="whitespace-normal">
                    {r.items.map((i: any) => `${i.name} (${faDigits(i.qty)})`).join(' · ')}
                    {r.hasRemovedItems && <div className="text-amber-700 font-bold">شامل کالای حذف‌شده از انبار</div>}
                  </td>
                  <td>
                    <button
                      className="text-brand"
                      onClick={() => void printReturn(r.id)}
                      disabled={rowBusy || printing}
                      title="چاپ رسید مستقل همین برگشت (بند ۱۳)"
                    >
                      چاپ
                    </button>
                  </td>
                  <td>
                    <button
                      className="text-brand"
                      onClick={() => requestReturnCorrectionAction('EDIT', r)}
                      disabled={rowBusy}
                      title="اصلاح تعداد یا اقلام این برگشت (اختلاف روی موجودی انبار اعمال می‌شود)"
                    >
                      ویرایش
                    </button>
                  </td>
                  <td>
                    <button
                      className="text-red-600"
                      onClick={() => requestReturnCorrectionAction('VOID', r)}
                      disabled={rowBusy}
                      title="ابطال این برگشت (سند با مهر «باطل» و دلیل می‌ماند) و بازگرداندن اثرش روی موجودی انبار"
                    >
                      ابطال
                    </button>
                    <button
                      className="text-amber-700 mr-2"
                      onClick={() => requestReturnCorrectionAction('RECONCILE', r)}
                      disabled={rowBusy}
                      title="ثبت اثر جبرانی جدید برای پول، کارت، اعتبار و موجودی؛ سند برگشت اصلی دست‌نخورده می‌ماند"
                    >
                      اصلاح جبرانی
                    </button>
                  </td>
                </tr>
              ))}
              {!history.length && (
                <tr>
                  <td colSpan={14} className="text-center py-10 text-slate-400">
                    در این بازه برگشت از فروشی ثبت نشده است
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <OverpayFlowDialogs
        flow={overpayFlow}
        busy={busy}
        onFlow={setOverpayFlow}
        onSubmit={(req) => void doSubmit(false, req)}
        issuedCredit={issuedOverpayCredit}
        onCloseIssued={() => {
          issuedOverpayCreditOpenRef.current = false
          setIssuedOverpayCredit(null)
          setOverpayCreditPrintProblem(null)
        }}
        onReprint={(pw) => void printIssuedOverpayCredit(issuedOverpayCredit, { reprintPassword: pw })}
        creditPrinting={overpayCreditPrinting}
        creditPrintProblem={overpayCreditPrintProblem}
      />

      {/*
       * قفل عملیاتیِ ویرایش/ابطال: این گیت عمداً قبل از خودِ فرم‌های تغییر
       * قرار دارد. پس با قفل روشن، کارمند نه اقلام ویرایش را می‌بیند و نه
       * دیالوگ ابطال/اصلاح جبرانی را؛ اول باید همین اختیار محدود را باز کند.
       */}
      <ConfirmDialog
        open={!!correctionUnlockRequest}
        title="قفل عملیات اصلاح و ابطال"
        confirmLabel="تأیید و باز کردن قفل"
        busy={correctionUnlockBusy}
        message={
          <div className="space-y-3">
            <p className="font-bold text-amber-900">
              این صفحه قفل است؛ شما نمی‌توانید ویرایش، اصلاح جبرانی یا ابطال برگشت/تعویض انجام دهید.
            </p>
            <p className="kbd leading-6">
              برای ادامه، رمز مدیر، رمز دوم اختصاصی «اصلاح و ابطال برگشت / تعویض»، یا رمز سومِ تعریف‌شده برای شیفت جاری را وارد کنید.
              این رمز فقط همین اختیار را باز می‌کند و نشست مدیر ایجاد نمی‌کند مگر رمز مدیر وارد شود.
            </p>
            <label className="block">
              <span className="font-bold">رمز مجوز عملیات</span>
              <PasswordField
                className="inp w-full mt-1"
                value={correctionUnlockPassword}
                onChange={(e) => {
                  setCorrectionUnlockPassword(e.target.value)
                  setCorrectionUnlockError(null)
                }}
                autoComplete="off"
                autoFocus
                placeholder="رمز مدیر یا رمز دوم/سوم این عملیات"
              />
            </label>
            {correctionUnlockError && <p className="text-red-600 whitespace-pre-line">{correctionUnlockError}</p>}
            <p className="kbd leading-6">
              پس از باز شدن قفل، فقط فرمِ عملیات انتخاب‌شده باز می‌شود. هنگام ثبت نهایی نیز کنترل‌های مالی و ثبت سابقهٔ سمت سرور برقرار می‌مانند.
            </p>
          </div>
        }
        onConfirm={() => void unlockReturnCorrectionAction()}
        onCancel={() => {
          if (correctionUnlockBusy) return
          setCorrectionUnlockRequest(null)
          setCorrectionUnlockPassword('')
          setCorrectionUnlockError(null)
        }}
      />

      {/* ---------------- ویرایش یک برگشت ثبت‌شده ---------------- */}
      <ReturnEditModal
        returnId={editId}
        onClose={() => setEditId(null)}
        onSaved={(m) => {
          flash(m)
          void loadHistory()
          if (lookup) void lookupCode(returnLookupInput(lookup))
        }}
      />

      {/* ---------------- دفتر جبرانی برای اثرهای واقعاً تسویه‌شده ---------------- */}
      <ConfirmDialog
        open={!!correctionTarget}
        title="اصلاح جبرانی برگشت از فروش"
        busy={correctionBusy}
        confirmLabel="ثبت اثرهای جبرانی"
        message={
          <div className="space-y-2">
            <p className="text-amber-800">
              این مسیر سند برگشت اصلی را پاک یا باطل نمی‌کند. خروج موجودی، نقد بازیافتی و ثبت کارت/اعتبار با زمان، کاربر و شیفت <b>فعلی</b> در دفتر جبرانی ثبت می‌شوند تا گزارش شیفت مبدأ دست‌نخورده بماند.
            </p>
            <p>
              برگشت فاکتور <b>{faDigits(correctionTarget?.receiptNo ?? '—')}</b> به تاریخ <b>{faDigits(correctionTarget?.returnedAtJalali ?? '—')}</b> · مبلغ <b>{money(correctionTarget?.total ?? 0)}</b> ریال
            </p>
            <label className="block">
              <span className="font-bold">دلیل اصلاح جبرانی (اجباری)</span>
              <input className="inp w-full" autoFocus value={correctionReason} onChange={(e) => { setCorrectionReason(e.target.value); setCorrectionErr(null) }} />
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <label>
                <span>نقدی که واقعاً به کشوی فعلی برگشت</span>
                <input dir="ltr" className="inp w-full" inputMode="numeric" value={groupThousands(correctionCash)} onChange={(e) => { setCorrectionCash(digitsOnly(e.target.value)); setCorrectionErr(null) }} placeholder="۰" />
              </label>
              <label>
                <span>کارت/بانکی که واقعاً برگشت</span>
                <input dir="ltr" className="inp w-full" inputMode="numeric" value={groupThousands(correctionCard)} onChange={(e) => { setCorrectionCard(digitsOnly(e.target.value)); setCorrectionErr(null) }} placeholder="۰" />
              </label>
            </div>
            <label className="block">
              <span>شماره پیگیری/توضیح بازیافت کارت (اگر مبلغ کارت وارد شده)</span>
              <input className="inp w-full" value={correctionCardReference} onChange={(e) => { setCorrectionCardReference(e.target.value); setCorrectionErr(null) }} />
            </label>
            <label className="block">
              <span className="font-bold">وضعیت اعتبار صادرشده از همین برگشت</span>
              <select className="inp w-full" value={correctionCreditOutcome} onChange={(e) => { setCorrectionCreditOutcome(e.target.value); setCorrectionErr(null) }}>
                <option value="NONE">این برگشت اعتبار صادر نکرده است</option>
                <option value="CANCELED_UNUSED">اعتبار مصرف‌نشده لغو شد</option>
                <option value="REMAINS_ACTIVE">اعتبار هنوز باقی و قابل مصرف است</option>
                <option value="CONSUMED">اعتبار کامل مصرف شده است</option>
              </select>
            </label>
            <label className="block">
              <span>یادداشت تسویه/کسری (اختیاری، ولی برای مغایرت توصیه می‌شود)</span>
              <input className="inp w-full" value={correctionNote} onChange={(e) => setCorrectionNote(e.target.value)} />
            </label>
            <label className="block">
              <span>رمز اصلاح جبرانی (در نصب تازه اجباری)</span>
              <input type="password" dir="ltr" className="inp w-full" value={correctionAuthPassword} onChange={(e) => { setCorrectionAuthPassword(e.target.value); setCorrectionErr(null) }} placeholder="رمز مدیر یا رمز اختصاصی اصلاح/ابطال" />
            </label>
            <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-2">
              <p className="font-bold">تأیید شخصی مدیر — فقط روز بعد یا دوره‌ی بسته</p>
              <select className="inp w-full" value={correctionApproverUserId ?? ''} onChange={(e) => { setCorrectionApproverUserId(e.target.value ? Number(e.target.value) : null); setCorrectionErr(null) }}>
                <option value="">انتخاب مدیر تأییدکننده…</option>
                {voidManagers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}{manager.hasCorrectionApprovalPassword ? '' : ' — رمز شخصی تعریف نشده'}</option>)}
              </select>
              <input type="password" dir="ltr" className="inp w-full" value={correctionApproverPassword} onChange={(e) => { setCorrectionApproverPassword(e.target.value); setCorrectionErr(null) }} placeholder="رمز شخصی مدیر انتخاب‌شده" />
            </div>
            {correctionErr && <p className="text-red-600 whitespace-pre-line">{correctionErr}</p>}
            <p className="kbd">اگر همه‌ی پولِ بازپرداخت‌شده برنگشته باشد، سیستم همان کسری را به‌عنوان «مغایرت بازیافت‌نشده» ثبت می‌کند؛ آن را صفر یا پنهان نمی‌کند.</p>
          </div>
        }
        onConfirm={() => void doCorrection()}
        onCancel={() => { setCorrectionTarget(null); setCorrectionErr(null) }}
      />

      {/* ---------------- تاییدیه‌ی حذف یک برگشت ثبت‌شده ---------------- */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="ابطال برگشت از فروش"
        message={
          <div className="space-y-2">
            <p>
              برگشت فاکتور شماره <b>{faDigits(deleteTarget?.receiptNo ?? '—')}</b> به تاریخ{' '}
              <b>{faDigits(deleteTarget?.returnedAtJalali ?? '—')}</b> با مبلغ{' '}
              <b>{money(deleteTarget?.total ?? 0)}</b> ریال باطل می‌شود. سند پاک نمی‌شود؛ با مهر «باطل»، نام شما،
              زمان و دلیل برای همیشه در سابقه می‌ماند و از همه‌ی گزارش‌ها و محاسبه‌ها بیرون می‌رود.
            </p>
            <label className="block">
              <span className="font-bold">دلیل ابطال (اجباری)</span>
              <input
                className="inp w-full"
                value={voidReason}
                autoFocus
                onChange={(e) => {
                  setVoidReason(e.target.value)
                  setVoidReasonErr(null)
                }}
              />
            </label>
            <label className="block">
              <span className="font-bold">رمز تأیید ابطال (در نصب تازه اجباری)</span>
              <input
                type="password"
                dir="ltr"
                className="inp w-full"
                value={voidAuthPassword}
                onChange={(e) => {
                  setVoidAuthPassword(e.target.value)
                  setVoidReasonErr(null)
                }}
                placeholder="رمز مدیر یا رمز اختصاصی اصلاح/ابطال را وارد کنید"
              />
              <span className="kbd block mt-1">
                در روز جاری این فیلد فقط وقتی لازم است که مدیر قفل عملیات ابطال را روشن کرده باشد. رمز شخصیِ مدیرِ مشخص برای روزهای بعد یا دوره‌ی بسته در فیلدهای پایین وارد می‌شود.
              </span>
            </label>
            <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-2">
              <p className="text-sm font-bold text-amber-900">تأیید شخصی مدیر — فقط اصلاح دیرهنگام یا دوره‌ی بسته</p>
              <label className="block">
                <span>مدیر تأییدکننده</span>
                <select
                  className="inp w-full"
                  value={voidApproverUserId ?? ''}
                  onChange={(e) => {
                    setVoidApproverUserId(e.target.value ? Number(e.target.value) : null)
                    setVoidReasonErr(null)
                  }}
                >
                  <option value="">انتخاب کنید…</option>
                  {voidManagers.map((manager) => (
                    <option key={manager.id} value={manager.id}>
                      {manager.name}{manager.hasCorrectionApprovalPassword ? '' : ' — رمز شخصی تعریف نشده'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span>رمز شخصی مدیر انتخاب‌شده</span>
                <input
                  type="password"
                  dir="ltr"
                  className="inp w-full"
                  value={voidApproverPassword}
                  onChange={(e) => {
                    setVoidApproverPassword(e.target.value)
                    setVoidReasonErr(null)
                  }}
                  placeholder="برای روزهای بعد یا دوره‌ی بسته اجباری است"
                />
              </label>
              <p className="kbd">
                مدیر و رمز او در سابقه‌ی غیرقابل‌تغییر ثبت می‌شود؛ رمز سراسری یا رمز پنل جای این هویت شخصی را نمی‌گیرد.
              </p>
            </div>
            {voidReasonErr && <p className="text-red-600 whitespace-pre-line">{voidReasonErr}</p>}
            <p className="text-amber-700">
              اگر بازپرداخت نقد/کارت‌خوان/کارت‌به‌کارتِ پرداخت‌شده انجام شده یا اعتبار خرید این برگشت خرج شده باشد،
              ابطال انجام نمی‌شود (پول واقعاً رفته است) و موضوع برای رسیدگی مدیر ثبت می‌شود.
            </p>
            <p>
              {deleteTarget?.restockedQty
                ? `اثر این برگشت روی انبار برگردانده می‌شود: ${faDigits(
                    deleteTarget.restockedQty
                  )} عدد که با این برگشت به انبار آمده بود، از موجودی خارج می‌شود و موجودی به حالت قبل از این برگشت برمی‌گردد.`
                : 'این برگشت موجودی انبار را تغییر نداده بود، پس با حذفش هم موجودی دست‌نخورده می‌ماند.'}
            </p>
            <p className="kbd">
              وضعیت فاکتور بر اساس برگشت‌های باقی‌مانده بازمحاسبه می‌شود و سابقه‌ی حرکات انبار پاک نمی‌شود (حرکت
              معکوس ثبت می‌گردد).
            </p>
          </div>
        }
        confirmLabel="بله، باطل کن"
        busy={rowBusy}
        onConfirm={() => void doDelete()}
        onCancel={() => {
          setDeleteTarget(null)
          setVoidAuthPassword('')
          setVoidApproverUserId(null)
          setVoidApproverPassword('')
          setVoidReasonErr(null)
        }}
      />

      <ConfirmDialog
        open={!!confirmForce}
        title="تعداد برگشتی بیشتر از فروش است"
        message={<div className="whitespace-pre-line">{confirmForce}</div>}
        confirmLabel="بله، همین را ثبت کن"
        busy={busy}
        onConfirm={() => void doSubmit(true)}
        onCancel={() => setConfirmForce(null)}
      />

      {/* تعویض: همان هشدار «بیشتر از تعداد قابل برگشت»، ولی برای مسیر تعویض */}
      <ConfirmDialog
        open={!!confirmExchange}
        title="تعداد برگشتی تعویض بیشتر از فروش است"
        message={<div className="whitespace-pre-line">{confirmExchange}</div>}
        confirmLabel="بله، تعویض را ثبت کن"
        busy={busy}
        onConfirm={() => void doExchange(true)}
        onCancel={() => setConfirmExchange(null)}
      />

      {/* نشست ۳۱۹ — تأیید مدیر برای بازپرداخت کارتی (کارت‌خوان) */}
      <CardPosOverrideDialog
        open={cardPosDialog}
        onClose={() => setCardPosDialog(false)}
        onConfirm={(override) => {
          setCardPosOverride(override)
          setRefundMethod('CARD')
          setCardPosDialog(false)
        }}
      />
    </div>
  )
}

function Info({
  label,
  value,
  strong,
  ltr
}: {
  label: string
  value: string
  strong?: boolean
  ltr?: boolean
}) {
  return (
    <div>
      <div className="kbd">{label}</div>
      <div dir={ltr ? 'ltr' : undefined} className={`inp bg-slate-50 truncate ${strong ? 'font-bold' : ''}`} title={value}>
        {value}
      </div>
    </div>
  )
}
