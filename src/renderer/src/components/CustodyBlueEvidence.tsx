import { money } from '@shared/jalali'
import { CustodyDifference } from './CustodyDifference'
import { CustodyBlueNotes, type BlueManagerNoteView } from './CustodyBlueNotes'

/** Read-only manager view of server-frozen evidence. It never computes a
 * reference, difference, attribution or manager decision in the renderer. */
export type BlueDecisionView = {
  id: number
  kind: string
  destinationKind: string | null
  destinationEvidenceDay: string | null
  destinationEvidenceReference: string | null
  managerUserId: number
  managerName: string | null
  evidenceDay: string
  evidenceReference: string
  reason: string
  at: string
}
export type BlueSnapshotView = {
  id: number
  role: string
  at: string
  calculationVersion: string
  countOrigin: string
  authMethod: string
  humanAmount: number | null
  referenceStatus: string
  referenceAmount: number | null
  knownSubtotal: number | null
  destinationUnknownReceived: number | null
  ambiguousLegacyCredit: number | null
  rawDifference: number | null
  freshDifference: number | null
  managerNotes: BlueManagerNoteView[]
}
export type BlueBoundaryView = {
  snapshotId: number
  shiftId: number
  role: string
  at: string
  actorName: string | null
  calculationVersion: string
  countOrigin: string
  authMethod: string
  countedAmount: number | null
  referenceFromDay: string
  referenceToDay: string
  originalReferenceStatus: string
  originalReferenceAmount: number | null
  originalRawDifference: number | null
  originalFreshDifference: number | null
  knownSubtotal: number | null
  destinationUnknownReceived: number | null
  ambiguousLegacyCredit: number | null
  referenceAmount: number | null
  rawDifference: number | null
  freshDifference: number | null
  managerNotes: BlueManagerNoteView[]
  decision: BlueDecisionView | null
}
export type BlueHandoverView = {
  id: number
  fromUser: string | null
  selectedRecipient: string | null
  finalCustodian: string | null
  status: string
  blue?: null | {
    status: string
    calculationVersion: string | null
    referenceFromDay: string | null
    referenceToDay: string | null
    countedAmount: number | null
    originalReferenceAmount: number | null
    originalRawDifference: number | null
    originalFreshDifference: number | null
    knownSubtotal: number | null
    destinationUnknownReceived: number | null
    ambiguousLegacyCredit: number | null
    referenceAmount: number | null
    rawDifference: number | null
    freshDifference: number | null
    outgoing: BlueSnapshotView | null
    incoming: BlueSnapshotView | null
    decision: BlueDecisionView | null
  }
}

const amount = (value: number | null | undefined) => value == null ? 'نامعلوم' : `${money(value)} ریال`
const roleName = (role: string) => role === 'FINAL_CLOSE' ? 'بستن نهایی'
  : role === 'OPENING' ? 'افتتاح' : role === 'RECOVERY' ? 'بازیابی' : role
// The old ZERO-named identifier is immutable storage, not a monetary zero.
// Both historic and new absence evidence must read as NO outgoing count.
const absentOut = (origin: string) => origin === 'ABSENT_UNCOUNTED' || origin === 'SYSTEM_ABSENCE_ZERO'
const originName = (origin: string) => absentOut(origin) ? 'غایب؛ شمارش خروجی انجام نشده'
  : origin === 'EMPTY_OPTIONAL' ? 'افتتاح اختیاریِ خالی؛ بدون شمارش واقعی'
    : origin === 'EXPLICIT_ZERO' ? 'صفرِ صریحِ انسان' : origin === 'EXPLICIT_AMOUNT' ? 'شمارش واقعی' : origin

function Components({ knownSubtotal, destinationUnknownReceived, ambiguousLegacyCredit, calculationVersion }: {
  knownSubtotal: number | null
  destinationUnknownReceived: number | null
  ambiguousLegacyCredit: number | null
  calculationVersion: string
}) {
  return <p>بخش معلوم: <b>{amount(knownSubtotal)}</b> · دریافتی با مقصد نامشخص: <b>{calculationVersion === 'sales-blue-v1' ? 'در نسخهٔ قدیمی ثبت نمی‌شد' : amount(destinationUnknownReceived)}</b> · پرداخت اعتباری قدیمی مبهم: <b>{amount(ambiguousLegacyCredit)}</b></p>
}
function Decision({ decision, referenceAmount, rawDifference, freshDifference }: {
  decision: BlueDecisionView | null
  referenceAmount: number | null
  rawDifference: number | null
  freshDifference: number | null
}) {
  if (!decision) return null
  return <div className="rounded bg-emerald-50 border border-emerald-200 p-2 text-emerald-950">
    <b>تصمیم افزایشی #{decision.id}</b> · مدیر: {decision.managerName ?? `شناسهٔ ${decision.managerUserId}`}
    {decision.kind !== 'NO_LEGACY_CREDIT' ? <div>اعتبار قدیمی: {decision.kind} · روز سند: {decision.evidenceDay} · مدرک: {decision.evidenceReference}</div> : null}
    {decision.destinationKind ? <div>مقصد نامشخص: {decision.destinationKind} · روز سند: {decision.destinationEvidenceDay ?? 'نامعلوم'} · مدرک: {decision.destinationEvidenceReference ?? 'نامعلوم'}</div> : null}
    <div>توضیح: {decision.reason}</div>
    <div>عدد مرجع پس از تصمیم: {amount(referenceAmount)} · اختلاف خام: <CustodyDifference value={rawDifference} label="اختلاف خام پس از تصمیم" /> · اختلاف تازه: <CustodyDifference value={freshDifference} label="اختلاف تازه پس از تصمیم" />. تصمیم به‌تنهایی حکم مقصر بودن نیست.</div>
  </div>
}

export function CustodyBlueEvidence({ blueBoundaries, handovers, managers, onSaved }: {
  blueBoundaries: BlueBoundaryView[]
  handovers: BlueHandoverView[]
  managers: Array<{ id: number; name: string; role: string; isActive: boolean }>
  onSaved: () => Promise<void>
}) {
  const blueHandovers = handovers.filter((row) => !!row.blue)
  if (!blueBoundaries.length && !blueHandovers.length) return null
  return <section className="border-t border-sky-200 pt-3 space-y-2 text-sm leading-6" dir="rtl">
    <h3 className="font-bold text-sky-950">اسناد آبیِ شمارش و تحویل (فقط‌خواندنی)</h3>
    <p className="text-xs text-slate-600">مرجع و اختلاف اولیه از سند واقعی سرور خوانده می‌شوند و هیچ‌وقت بازنویسی نمی‌شوند. «نامعلوم» صفر نیست؛ تصمیم بعدی مدیر سندی جداگانه است. در سندهای V1 مقصد نامشخص ثبت نمی‌شد و مبلغِ به‌اصطلاح معلوم ممکن است شامل آن باشد؛ با V2/V3 قابل قیاس نیست. سند V3 دامنه، منبع و پیوند امضاشده دارد؛ خرابی آن «مبلغ معلق» نیست.</p>
    {blueHandovers.map((handover) => {
      const blue = handover.blue!
      return <details key={`handover-${handover.id}`} className="rounded border border-sky-200 bg-white p-2" open={blue.status === 'PENDING_RECONCILIATION' || blue.status === 'EVIDENCE_QUARANTINED'}>
        <summary className="cursor-pointer font-semibold">{blue.outgoing && absentOut(blue.outgoing.countOrigin) ? 'پوشش غیبت؛ خروج بدون شمارش' : 'تحویل'} #{handover.id} · {handover.fromUser ?? '—'} → {handover.finalCustodian ?? handover.selectedRecipient ?? '—'} · {blue.status === 'EVIDENCE_QUARANTINED' ? 'شاهد ناسازگار؛ قرنطینه' : blue.status === 'PENDING_RECONCILIATION' ? 'مرجع نامعلوم، نیازمند تطبیق' : handover.status}</summary>
        <div className="space-y-1 mt-2">
          {blue.status === 'EVIDENCE_QUARANTINED' ? <p className="rounded bg-rose-50 p-2 text-rose-900"><b>قرنطینهٔ شاهد خراب:</b> اعداد این تحویل مرجع یا اختلاف قابل اتکا نیستند. سند اصلی را در پروندهٔ مستقل مدیر بررسی کنید؛ از «تطبیق مبلغ نامعلوم» یا ریست شیفت استفاده نکنید.</p> : null}
          <p>بازهٔ سند: {blue.referenceFromDay ?? 'نامعلوم'} تا {blue.referenceToDay ?? 'نامعلوم'} · نسخهٔ محاسبه: {blue.calculationVersion ?? 'نامعلوم'}</p>
          {([['خروجِ تحویل‌دهنده', blue.outgoing], ['شمارش مستقل گیرنده', blue.incoming]] as const).map(([label, snapshot]) => snapshot
            ? <div key={snapshot.id} className="rounded bg-sky-50 p-2">
                <b>{absentOut(snapshot.countOrigin) ? 'غیبت تحویل‌دهنده؛ شمارش خروجی ثبت نشده' : label} · سند #{snapshot.id}</b> · {originName(snapshot.countOrigin)} · احراز: {absentOut(snapshot.countOrigin) ? 'بدون PIN فرد غایب؛ ثبت سیستمی' : snapshot.authMethod} · مبلغ انسانی: {amount(snapshot.humanAmount)}
                <div>عدد مرجع اولیه: {amount(snapshot.referenceAmount)} · اختلاف خام اولیه: <CustodyDifference value={snapshot.rawDifference} label="اختلاف خام اولیه" /> · اختلاف تازهٔ اولیه: <CustodyDifference value={snapshot.freshDifference} label="اختلاف تازهٔ اولیه" /> · {snapshot.referenceStatus}</div>
                <Components knownSubtotal={snapshot.knownSubtotal} destinationUnknownReceived={snapshot.destinationUnknownReceived} ambiguousLegacyCredit={snapshot.ambiguousLegacyCredit} calculationVersion={snapshot.calculationVersion} />
                <CustodyBlueNotes snapshotId={snapshot.id} notes={snapshot.managerNotes ?? []} managers={managers} onSaved={onSaved} />
              </div>
            : <p key={label} className="text-amber-900">{label}: هنوز سندِ شمارش ثبت نشده است؛ صفرِ فرضی محسوب نمی‌شود.</p>)}
          <Decision decision={blue.decision} referenceAmount={blue.referenceAmount} rawDifference={blue.rawDifference} freshDifference={blue.freshDifference} />
        </div>
      </details>
    })}
    {blueBoundaries.map((row) => <details key={`boundary-${row.snapshotId}`} className="rounded border border-sky-200 bg-white p-2" open={row.originalReferenceStatus === 'PENDING_RECONCILIATION' || row.originalReferenceStatus === 'EVIDENCE_QUARANTINED'}>
      <summary className="cursor-pointer font-semibold">{row.role === 'OUT' && absentOut(row.countOrigin) ? 'غیبت مسئول قبلی؛ خروج بدون شمارش' : roleName(row.role)} · شیفت #{row.shiftId} / سند #{row.snapshotId} · {row.actorName ?? '—'} · {row.originalReferenceStatus === 'EVIDENCE_QUARANTINED' ? 'شاهد ناسازگار؛ قرنطینه' : row.originalReferenceStatus === 'PENDING_RECONCILIATION' ? 'مرجع اولیه نامعلوم' : 'مرجع اولیه معلوم'}</summary>
      <div className="space-y-1 mt-2">
        {row.originalReferenceStatus === 'EVIDENCE_QUARANTINED' ? <p className="rounded bg-rose-50 p-2 text-rose-900">این سند قدیمی خراب با «مرجع معلق» تفاوت دارد؛ هیچ مبلغ یا اختلافی از آن استخراج نمی‌شود. اصل ادعا در پروندهٔ قرنطینهٔ مدیر محفوظ است.</p> : null}
        <p>بازهٔ سند: {row.referenceFromDay} تا {row.referenceToDay} · نسخهٔ محاسبه: {row.calculationVersion} · {originName(row.countOrigin)} · احراز: {absentOut(row.countOrigin) ? 'بدون PIN فرد غایب؛ ثبت سیستمی' : row.authMethod} · مبلغ انسانی: {amount(row.countedAmount)}</p>
        <p>عدد مرجع اولیه: <b>{amount(row.originalReferenceAmount)}</b> · اختلاف خام اولیه: <CustodyDifference value={row.originalRawDifference} label="اختلاف خام اولیه" /> · اختلاف تازهٔ اولیه: <CustodyDifference value={row.originalFreshDifference} label="اختلاف تازهٔ اولیه" /></p>
        <Components knownSubtotal={row.knownSubtotal} destinationUnknownReceived={row.destinationUnknownReceived} ambiguousLegacyCredit={row.ambiguousLegacyCredit} calculationVersion={row.calculationVersion} />
        <CustodyBlueNotes snapshotId={row.snapshotId} notes={row.managerNotes ?? []} managers={managers} onSaved={onSaved} />
        <Decision decision={row.decision} referenceAmount={row.referenceAmount} rawDifference={row.rawDifference} freshDifference={row.freshDifference} />
      </div>
    </details>)}
  </section>
}
