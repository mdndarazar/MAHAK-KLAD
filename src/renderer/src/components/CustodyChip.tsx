import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { call, CH } from '../lib/api'
import { money } from '@shared/jalali'
import { useTopmostModalKey } from './Modal'
import { useManagerSession } from '../hooks/useManagerSession'

type Staff = { id: number; name: string; role: string; isActive: boolean; hasCustodyPin: boolean; mustChangePin: boolean }
type Status = {
  enabled: boolean
  /** Durable main-process verdict; a recovery case can govern even if a stale
   * config row says the feature is disabled. */
  governed?: boolean
  state: 'NO_SESSION' | 'ACTIVE' | 'HANDOVER_PENDING' | string
  epoch: number
  custodian: { id: number; name: string | null } | null
  shift: { id: number; name: string; openedAt: string } | null
  pendingHandover: { id: number; fromUserId: number; selectedRecipientUserId: number; startedAt: string; status?: string; resolutionKind?: string | null; blueReference?: boolean; countedAtStart?: number; resolutionReason?: string | null; blindCountedCash?: number | null } | null
  schedule: { planId: number; title: string; scheduledEndAt: string } | null
  schedulingPolicy?: { mode: 'SINGLE_SHIFT' | 'MULTI_SHIFT'; configured: boolean; singleShiftCustodianUserId: number | null }
  reminder: { due: boolean; bucket: number | null; repeatMinutes: number; scheduledEndAt: string | null }
  unresolvedCount: number
  unresolved: Array<{ id: number; shiftId: number; openedAt: string; nightExpectedCash: number | null; evidence?: string | null }>
  legacyBlock?: null | {
    count: number
    shiftIds: number[]
    shifts: Array<{ id: number; name: string; number: number; sessionSeq: number; dayJalali: string; openedAt: string; legacyUserName: string | null }>
  }
  /** Main exposes only that a recovery boundary remains; never its amount. */
  legacyOpeningRequired?: boolean
}

type View = 'main' | 'open' | 'handover' | 'accept' | 'confirmBlue' | 'emergency' | 'masterOverride' | 'close' | 'changePin' | 'legacyRecovery'

type BlueCountPreview = {
  referenceStatus: 'AVAILABLE' | 'PENDING_RECONCILIATION'
  referenceAmount: number | null
  knownSubtotal: number | null
  destinationUnknownReceived: number | null
  ambiguousLegacyCredit: number | null
  rawDifference: number | null
  freshDifference: number | null
}

/**
 * Small, opt-in custody control surface. The old ShiftSessionChip remains the
 * entire UI when the feature is off; therefore an installation can enable this
 * module only after staff credentials have been deliberately configured.
 */
export function CustodyChip({ showSetup = true, showOperations = true }: { showSetup?: boolean; showOperations?: boolean } = {}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [visible, setVisible] = useState(false)
  const [view, setView] = useState<View>('main')
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('')
  const [recipientId, setRecipientId] = useState<number | ''>('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatNewPassword, setRepeatNewPassword] = useState('')
  const [managerId, setManagerId] = useState<number | ''>('')
  const [managerPassword, setManagerPassword] = useState('')
  const [countedCash, setCountedCash] = useState('')
  const [blueCountPreview, setBlueCountPreview] = useState<BlueCountPreview | null>(null)
  const [note, setNote] = useState('')
  const [legacyRecoveryKey, setLegacyRecoveryKey] = useState('')
  const [legacyAcknowledged, setLegacyAcknowledged] = useState({ missedHandover: false, physicalCount: false, responsibilityBoundary: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissedReminderBucket, setDismissedReminderBucket] = useState<number | null>(null)
  const { isManager } = useManagerSession()

  const reload = useCallback(async () => {
    try {
      const next = await call<Status>(CH.custodyStatus, {})
      setStatus(next)
      setStaff(await call<Staff[]>(CH.custodyStaffList, {}))
    } catch {
      // The established shift chip remains usable if an old database has not
      // migrated yet. No renderer fallback may silently create a shift here.
    }
  }, [])

  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => void reload(), 30_000)
    return () => window.clearInterval(timer)
  }, [reload])

  useTopmostModalKey(visible, (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (!busy) setVisible(false)
  })

  if (!status) return null
  // An OPEN recovery record is still a custody operation even if a stale or
  // manually altered config row says disabled. Keep the PIN/count recovery UI
  // available; hiding it would strand the drawer after legacy paths close.
  const governed = status.governed === true || status.enabled === true
  if (!governed) return isManager && showSetup ? <CustodySetup onReady={reload} /> : null
  if (!showOperations) return null
  const eligible = staff.filter((row) => row.isActive && row.hasCustodyPin && !row.mustChangePin && (row.role === 'CASHIER' || row.role === 'MANAGER'))
  /** An absent scheduled worker must not remove every replacement from the
   * dialog. Main still demands the selected person's personal PIN, real count
   * and a reason before an off-roster opening or legacy recovery is recorded. */
  const openingEligible = eligible
  const managers = eligible.filter((row) => row.role === 'MANAGER')
  const legacyBlock = status.legacyBlock
  const nameOf = (id: number | null | undefined) => staff.find((row) => row.id === id)?.name ?? 'کارمند انتخاب‌شده'
  const reset = (next: View = 'main') => {
    setView(next)
    setPassword('')
    setNewPassword('')
    setRepeatNewPassword('')
    setManagerPassword('')
    setCountedCash('')
    setBlueCountPreview(null)
    setNote('')
    setError(null)
  }
  const normalHandoverDifferencePending = status.state === 'HANDOVER_RECOUNT' && status.pendingHandover?.status === 'PENDING' && status.pendingHandover?.blindCountedCash != null
  const resumeHandoverDifference = () => {
    const pending = status.pendingHandover
    reset('accept')
    if (pending?.blindCountedCash != null) setCountedCash(String(pending.blindCountedCash))
  }
  const resumeEmergency = () => {
    const pending = status.pendingHandover
    reset('emergency')
    if (pending?.status === 'EMERGENCY_RECOUNT') {
      setSelectedUserId(pending.selectedRecipientUserId)
      setCountedCash(pending.countedAtStart == null ? '' : String(pending.countedAtStart))
      setNote(pending.resolutionReason ?? '')
    }
  }
  const resumeMasterOverride = () => {
    const pending = status.pendingHandover
    reset('masterOverride')
    if (pending?.status === 'MASTER_OVERRIDE_RECOUNT') {
      setManagerId(pending.selectedRecipientUserId)
      setCountedCash(pending.countedAtStart == null ? '' : String(pending.countedAtStart))
      setNote(pending.resolutionReason ?? '')
    }
  }
  const amount = () => {
    if (!countedCash.trim()) throw new Error('شمارش واقعی را وارد کنید؛ برای صفر، رقم ۰ را صریحاً بنویسید.')
    const value = Number(countedCash)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('مبلغ شمارش‌شده را به‌صورت عدد صحیحِ صفر یا بیشتر وارد کنید.')
    return value
  }
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reset()
      await reload()
      window.dispatchEvent(new Event('mahak:shift-changed'))
    } catch (e: any) {
      setError(e?.message ?? 'عملیات انجام نشد.')
      // A failed command can still have durably frozen a blind count. Refresh
      // the server verdict so the operator sees the only safe next action.
      await reload()
    } finally {
      setBusy(false)
    }
  }
  const countBlueAndPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      const observed = amount()
      const result = await call<BlueCountPreview>(CH.custodyHandoverCountBlue, {
        handoverId: status.pendingHandover?.id, password, operationalTotal: observed
      })
      setBlueCountPreview(result)
      setPassword('')
      setCountedCash('')
      setView('confirmBlue')
      await reload()
    } catch (e: any) {
      setError(e?.message ?? 'شمارش گیرنده ثبت نشد.')
      await reload()
    } finally {
      setBusy(false)
    }
  }
  const showReminder = !!status.reminder?.due && status.reminder.bucket !== dismissedReminderBucket
  const emergencyInProgress = status.state === 'HANDOVER_RECOUNT' && status.pendingHandover?.status === 'EMERGENCY_RECOUNT'
  const masterOverrideInProgress = status.state === 'HANDOVER_RECOUNT' && status.pendingHandover?.status === 'MASTER_OVERRIDE_RECOUNT'
  const title =
    status.legacyBlock
      ? `${status.legacyBlock.count} نشست قدیمی نیازمند بازیابی است`
      : normalHandoverDifferencePending
        ? `مغایرتِ شمارشِ تحویل برای ${nameOf(status.pendingHandover?.selectedRecipientUserId)} منتظر دلیل است`
      : masterOverrideInProgress
        ? `شمارش Master Override مدیر ${nameOf(status.pendingHandover?.selectedRecipientUserId)} در حال ثبت است`
        : emergencyInProgress
          ? `شمارش پوشش اضطراریِ ${nameOf(status.pendingHandover?.selectedRecipientUserId)} در حال ثبت است`
          : status.state === 'HANDOVER_PENDING'
            ? status.pendingHandover?.status === 'RECEIVER_COUNTED'
              ? `دو شمارش انجام شد؛ تأیید جداگانهٔ ${nameOf(status.pendingHandover?.selectedRecipientUserId)} لازم است`
              : `تحویل در انتظار شمارش مستقل ${nameOf(status.pendingHandover?.selectedRecipientUserId)}`
            : status.state === 'ACTIVE'
              ? `صندوق: ${status.custodian?.name ?? 'مسئول نامشخص'}`
              : 'صندوق بدون مسئول فعال'

  return (
    <>
      <button
        className={`text-xs px-2 py-1 rounded whitespace-nowrap font-bold ${status.state === 'HANDOVER_PENDING' ? 'bg-rose-600 hover:bg-rose-700' : status.state === 'ACTIVE' ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-amber-500 hover:bg-amber-600'}`}
        onClick={() => { setVisible(true); reset() }}
        title="حضانت صندوق: مسئول فعلی، تحویل احرازشده و بستن نهایی"
      >
        {status.legacyBlock ? '⚠ صندوق · نیازمند بازیابی Shift قدیمی' : normalHandoverDifferencePending ? '⚠ اختلاف تحویل نیازمند دلیل' : masterOverrideInProgress ? '⚠ Master Override در حال ثبت' : emergencyInProgress ? '⚠ پوشش اضطراری در حال ثبت' : status.state === 'HANDOVER_PENDING' ? '⚠ تحویل صندوق در انتظار تأیید' : status.state === 'ACTIVE' ? `صندوق · ${status.custodian?.name ?? 'فعال'}` : 'صندوق · نیازمند ورود'}
      </button>
      {visible ? createPortal(
        <div className="fixed inset-0 z-[80] bg-black/55 flex justify-center items-start overflow-auto p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setVisible(false) }}>
          <section className="w-full max-w-xl bg-white rounded-lg shadow-xl p-5 mt-8 text-slate-800" dir="rtl">
            <div className="flex items-start gap-3 border-b pb-3 mb-4">
              <div className="flex-1"><h2 className="font-bold text-lg">حضانت صندوق</h2><p className="text-xs text-slate-500 mt-1">{title} · تغییر مسئول با PIN شخصی و شمارش مستقل انجام می‌شود؛ Master Override فقط با PIN شخصی همان مدیر انجام می‌شود.</p></div>
              <button className="text-slate-500 hover:text-slate-900 px-2" onClick={() => !busy && setVisible(false)} aria-label="بستن">×</button>
            </div>
            {showReminder ? <div className="mb-3 p-3 rounded border border-amber-300 bg-amber-50 text-sm"><b>یادآوری پایان برنامهٔ شیفت</b><br />برنامهٔ «{status.schedule?.title ?? 'شیفت'}» به پایان رسیده است. فروش متوقف نمی‌شود و همچنان به مسئول فعلی منتسب است؛ در زمان مناسب تحویل یا بستن نهایی را ثبت کنید.<button className="block mt-2 underline" onClick={() => setDismissedReminderBucket(status.reminder.bucket)}>فعلاً بستن این یادآوری</button></div> : null}
            {error ? <div className="mb-3 p-2 rounded bg-red-50 text-red-700 text-sm">{error}</div> : null}
            {view === 'main' ? <>
              {status.legacyBlock ? <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><b>نشست قدیمی نیازمند بازیابی است.</b><p className="mt-1">تا ثبت شمارش واقعی، فروش و افتتاح صندوق قفل است. بازیابی، مسئولیت فروش‌ها یا اختلاف‌های گذشته را به شما منتقل نمی‌کند؛ مسئولیت شما فقط پس از افتتاح جداگانهٔ صندوق جدید آغاز می‌شود.</p><button className="btn-primary mt-3 w-full" onClick={() => { reset('legacyRecovery'); setLegacyRecoveryKey(`legacy-${crypto.randomUUID()}`); setLegacyAcknowledged({ missedHandover: false, physicalCount: false, responsibilityBoundary: false }) }}>ثبت بازیابی Shift قدیمی</button></div> : null}
              {status.state === 'NO_SESSION' && !status.legacyBlock ? <button className="w-full btn-primary py-3" onClick={() => reset('open')}>ورود مسئول و باز کردن صندوق</button> : null}
              {status.state === 'ACTIVE' ? <div className={`grid gap-3 ${isManager ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'}`}><button className="btn-secondary py-3" onClick={() => reset('handover')}>تحویل عادی</button><button className="btn-secondary py-3" onClick={() => reset('emergency')}>پوشش اضطراری</button>{isManager ? <button className="btn-secondary py-3 border-amber-400 text-amber-900" onClick={() => reset('masterOverride')}>Master Override</button> : null}<button className="btn-primary py-3" onClick={() => reset('close')}>بستن نهایی</button></div> : null}
              {status.state === 'HANDOVER_PENDING' ? <div className="grid grid-cols-2 gap-3"><button className="btn-primary py-3" onClick={() => reset(status.pendingHandover?.blueReference && status.pendingHandover.status === 'RECEIVER_COUNTED' ? 'confirmBlue' : 'accept')}>{status.pendingHandover?.blueReference ? status.pendingHandover.status === 'RECEIVER_COUNTED' ? 'تأیید جداگانهٔ گیرنده' : 'شمارش مستقل گیرنده' : 'تأیید تحویل‌گیرندهٔ قدیمی'}</button><button className="btn-secondary py-3" onClick={() => reset('handover')}>لغو با رمز تحویل‌دهنده</button><button className="btn-secondary py-3" onClick={() => reset('emergency')}>پوشش ضروریِ غیبت با شمارش تازه</button>{isManager ? <button className="btn-secondary py-3" onClick={() => reset('masterOverride')}>Master Override با PIN شخصی</button> : null}</div> : null}
              {emergencyInProgress ? <div className="p-3 rounded bg-amber-50 text-sm leading-6">شمارش پوشش اضطراری برای <b>{nameOf(status.pendingHandover?.selectedRecipientUserId)}</b> موقتاً صندوق را freeze کرده است. همان کارمند باید با همان PIN، شمارش و دلیل، ثبت را ادامه دهد.<button className="block mt-2 underline font-bold" onClick={resumeEmergency}>ادامهٔ پوشش اضطراری</button></div> : null}
              {masterOverrideInProgress ? <div className="p-3 rounded bg-amber-50 text-sm leading-6">Master Override برای مدیر <b>{nameOf(status.pendingHandover?.selectedRecipientUserId)}</b> موقتاً صندوق را freeze کرده است. همان مدیر با PIN شخصی خود، شمارش و دلیل تازه را ثبت می‌کند.<button className="block mt-2 underline font-bold" onClick={resumeMasterOverride}>ادامهٔ Master Override</button></div> : null}
              {normalHandoverDifferencePending ? <div className="p-3 rounded bg-rose-50 border border-rose-200 text-sm leading-6"><b>اختلاف شمارشِ تحویل فریز شده است.</b> هیچ فروش یا محاسبهٔ تازه‌ای تا تکمیل این مرز مالی انجام نمی‌شود. فقط <b>{nameOf(status.pendingHandover?.selectedRecipientUserId)}</b> می‌تواند با همان شمارش و PIN خود دلیل اختلاف را ثبت کند؛ یا مسئول قبلی با PIN خودش تحویل را لغو کند.<div className="grid grid-cols-2 gap-2 mt-3"><button className="btn-primary" onClick={resumeHandoverDifference}>ثبت دلیل و تکمیل تحویل</button><button className="btn-secondary" onClick={() => reset('handover')}>لغو با PIN تحویل‌دهنده</button></div></div> : null}
              {staff.some((row) => row.isActive && row.hasCustodyPin && row.mustChangePin) ? <button className="mt-3 text-sm underline text-slate-700" onClick={() => reset('changePin')}>تغییر رمز موقت کارکنان</button> : null}
            </> : null}
            {view === 'open' ? <CredentialForm
              staff={openingEligible} selected={selectedUserId} setSelected={setSelectedUserId}
              password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash}
              label={status.legacyOpeningRequired ? 'شمارش مستقل نقدی برای افتتاح پس از بازیابی قدیمی' : 'مجموع فیزیکی کشو و کارت‌خوان در افتتاح'}
              submit="باز کردن صندوق" busy={busy} onBack={() => reset()}
              showNote legacyOpening={status.legacyOpeningRequired === true}
              openingHelp="اگر مسئول برنامه‌ریزی‌شده حاضر نیست، صندوق‌دار یا مدیر دیگری با PIN شخصی، شمارش واقعی و دلیل روشن می‌تواند صندوق تازه را باز کند. سوابق و اختلاف قبلی به او منتقل نمی‌شود."
              note={note} setNote={setNote}
              noteLabel={status.legacyOpeningRequired
                ? 'دلیل خروج از برنامه یا تفاوت شمارش با بازیابی (حداقل ۱۰ حرف در صورت لزوم)'
                : 'دلیل افتتاح خارج از برنامه (برای مسئول برنامه‌ریزی‌شده اختیاری)'}
              onSubmit={() => run(async () => {
                if (!selectedUserId) throw new Error('مسئول صندوق را انتخاب کنید.')
                const count = amount()
                const reason = note.trim() || undefined
                await call(CH.custodyOpen, status.legacyOpeningRequired
                  ? { userId: selectedUserId, password, countedCash: count, note: reason, boundaryReason: reason }
                  : { userId: selectedUserId, password, operationalTotal: count, note: reason })
              })}
            /> : null}
            {view === 'legacyRecovery' && legacyBlock ? <LegacyRecoveryForm legacy={legacyBlock} staff={openingEligible} selected={selectedUserId} setSelected={setSelectedUserId} password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash} note={note} setNote={setNote} acknowledgements={legacyAcknowledged} setAcknowledgements={setLegacyAcknowledged} busy={busy} onBack={() => reset()} onSubmit={() => run(async () => { if (!selectedUserId) throw new Error('صندوق‌دار یا مدیر حاضر را انتخاب کنید.'); if (!legacyAcknowledged.missedHandover || !legacyAcknowledged.physicalCount || !legacyAcknowledged.responsibilityBoundary) throw new Error('هر سه تأیید بازیابی را بخوانید و تأیید کنید.'); await call(CH.custodyLegacyRecover, { userId: selectedUserId, password, countedCash: amount(), note: note.trim() || undefined, ackTextVersion: 'LEGACY_RECOVERY_V1', idempotencyKey: legacyRecoveryKey, seenEpoch: status.epoch, seenShiftIds: legacyBlock.shiftIds }) })} /> : null}
            {view === 'changePin' ? <ChangeTemporaryPinForm staff={staff.filter((row) => row.isActive && row.hasCustodyPin && row.mustChangePin)} selected={selectedUserId} setSelected={setSelectedUserId} temporaryPassword={password} setTemporaryPassword={setPassword} newPassword={newPassword} setNewPassword={setNewPassword} repeatNewPassword={repeatNewPassword} setRepeatNewPassword={setRepeatNewPassword} busy={busy} onBack={() => reset()} onSubmit={() => run(async () => { if (!selectedUserId) throw new Error('کارمند دارای رمز موقت را انتخاب کنید.'); if (newPassword !== repeatNewPassword) throw new Error('تکرار رمز جدید یکسان نیست.'); await call(CH.custodyPinSet, { userId: selectedUserId, currentPassword: password, newPassword }) })} /> : null}
            {view === 'handover' ? (status.state === 'HANDOVER_PENDING' || normalHandoverDifferencePending) ? <PasswordOnly label={normalHandoverDifferencePending ? "شمارشِ دارای اختلاف به‌عنوان سند باقی می‌ماند؛ فقط مسئول قبلی با PIN خودش می‌تواند تحویل فریز‌شده را لغو و فروش را به segment قبلی بازگرداند." : "برای لغو تحویل، مسئول قبلی رمز خودش را وارد می‌کند"} password={password} setPassword={setPassword} busy={busy} onBack={() => reset()} submit="لغو تحویل" onSubmit={() => run(() => call(CH.custodyHandoverCancel, { handoverId: status.pendingHandover?.id, password }))} /> : <CredentialForm staff={eligible} selected={recipientId} setSelected={setRecipientId} password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash} label="مجموع کور کشو و کارت‌خوان پیش از تحویل" submit="شروع تحویل" busy={busy} onBack={() => reset()} selectLabel="تحویل‌گیرنده (خودتحویلی هم با دو شمارش و دو بار PIN مجاز است)" onSubmit={() => run(async () => { if (!recipientId) throw new Error('تحویل‌گیرنده را انتخاب کنید.'); await call(CH.custodyHandoverStart, { toUserId: recipientId, password, operationalTotal: amount(), note: note.trim() || undefined }) })} /> : null}
            {view === 'accept' ? status.pendingHandover?.blueReference
              ? <PasswordOnly label={`فقط ${nameOf(status.pendingHandover.selectedRecipientUserId)} با PIN شخصی خود، بدون دیدن مبلغ شمارش اول، مجموع واقعی کشو و کارت‌خوان را مستقل وارد می‌کند. پس از ثبت، تأیید جداگانه لازم است؛ فروش در این فاصله به نام مسئول فعلی ادامه دارد.`} password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash} amountLabel="مجموع واقعی کشو و کارت‌خوان (صفر را صریح بنویسید)" busy={busy} onBack={() => reset()} submit="ثبت شمارش مستقل؛ هنوز تحویل انجام نمی‌شود" onSubmit={() => void countBlueAndPreview()} />
              : <PasswordOnly label={`فقط ${nameOf(status.pendingHandover?.selectedRecipientUserId)} با رمز شخصی خود، مجموع کشو و کارت‌خوان را مستقل وارد می‌کند (تحویل ناتمامِ قدیمی).`} password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash} amountLabel="مجموع فیزیکی کشو و کارت‌خوان" busy={busy} onBack={() => reset()} submit="شمارش و پذیرش تحویل قدیمی" onSubmit={() => run(() => call(CH.custodyHandoverAccept, { handoverId: status.pendingHandover?.id, password, operationalTotal: amount() }))} /> : null}
            {view === 'confirmBlue' && status.pendingHandover?.blueReference && status.pendingHandover.status === 'RECEIVER_COUNTED' ? <div className="space-y-3">
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6" role="status">
                <b>شمارش مستقل ثبت شد؛ مسئولیت هنوز جابه‌جا نشده است.</b>
                {blueCountPreview?.referenceStatus === 'PENDING_RECONCILIATION' ? <p>مرجع و اختلاف قطعی در انتظار تطبیق است. بخش معلوم: {blueCountPreview.knownSubtotal == null ? 'نامعلوم' : money(blueCountPreview.knownSubtotal)} ریال · پرداخت قدیمی مبهم: {blueCountPreview.ambiguousLegacyCredit == null ? 'نامعلوم' : money(blueCountPreview.ambiguousLegacyCredit)} ریال · دریافتی با مقصد نامشخص: {blueCountPreview.destinationUnknownReceived == null ? 'نامعلوم' : money(blueCountPreview.destinationUnknownReceived)} ریال. شمارش و فروش ادامه دارند.</p> : blueCountPreview ? <p>مرجع گزارش: {blueCountPreview.referenceAmount == null ? 'نامعلوم' : money(blueCountPreview.referenceAmount)} ریال · اختلاف خام: {blueCountPreview.rawDifference == null ? 'نامعلوم' : money(blueCountPreview.rawDifference)} ریال · اختلاف تازه: {blueCountPreview.freshDifference == null ? 'نامعلوم' : money(blueCountPreview.freshDifference)} ریال.</p> : <p>برای دیدن جزئیات مدیر به گزارش شواهد رجوع می‌کند؛ شمارش ثبت‌شده پس از بازکردن دوبارهٔ فرم نمایش داده نمی‌شود.</p>}
                <p>اختلاف یا وضعیت در انتظار، اتهام نیست و نیازمند تأیید قبلی مدیر نیست. اگر در این فاصله فروش شود، شمارش‌های تازه لازم خواهد شد.</p>
              </div>
              <PasswordOnly label={`فقط ${nameOf(status.pendingHandover.selectedRecipientUserId)} با PIN شخصی خود انتقال مسئولیت را جداگانه تأیید می‌کند؛ هیچ مبلغی دوباره از فرم فرستاده نمی‌شود.`} password={password} setPassword={setPassword} busy={busy} onBack={() => reset()} submit="تأیید نهایی و تحویل مسئولیت" onSubmit={() => run(() => call(CH.custodyHandoverConfirmBlue, { handoverId: status.pendingHandover?.id, password }))} />
            </div> : null}
            {view === 'emergency' ? <EmergencyCoverForm staff={eligible.filter((row) => row.id !== status.custodian?.id)} selected={selectedUserId} setSelected={setSelectedUserId} password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash} reason={note} setReason={setNote} busy={busy} inProgress={emergencyInProgress} onBack={() => reset()} onSubmit={() => run(async () => { if (!selectedUserId) throw new Error('کارمند پوشش‌دهنده را انتخاب کنید.'); await call(CH.custodyEmergencyCover, { userId: selectedUserId, password, operationalTotal: amount(), reason: note.trim() }) })} /> : null}
            {view === 'masterOverride' ? <MasterOverrideForm managers={managers.filter((row) => row.id !== status.custodian?.id)} managerId={managerId} setManagerId={setManagerId} managerPassword={managerPassword} setManagerPassword={setManagerPassword} amount={countedCash} setAmount={setCountedCash} reason={note} setReason={setNote} busy={busy} inProgress={masterOverrideInProgress} onBack={() => reset()} onSubmit={() => run(async () => { if (!managerId) throw new Error('مدیر مسئول Master Override را انتخاب کنید.'); await call(CH.custodyMasterOverride, { managerUserId: managerId, managerPassword, operationalTotal: amount(), reason: note.trim() }) })} /> : null}
            {view === 'close' ? <PasswordOnly label="مسئول فعلی مجموع واقعی کشو و کارت‌خوان را کور و با PIN شخصی ثبت می‌کند. مبلغ انتظار یا اختلاف به او نمایش داده نمی‌شود." password={password} setPassword={setPassword} amount={countedCash} setAmount={setCountedCash} amountLabel="مجموع فیزیکی کشو و کارت‌خوان" busy={busy} onBack={() => reset()} submit="ثبت بستن نهایی" onSubmit={() => run(() => call(CH.custodyFinalClose, { password, operationalTotal: amount() }))} /> : null}
          </section>
        </div>, document.body) : null}
    </>
  )
}

/** Initial activation is visible only inside the established manager session.
 * The main process still verifies the existing manager secret before it creates
 * the first personal manager credential, so this convenience UI is never the
 * security boundary. */
function CustodySetup({ onReady }: { onReady: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activate = async () => {
    setBusy(true); setError(null)
    try {
      /** The IPC handler derives manager authority from Main. A clean install
       * starts with the deliberately simple, unscheduled single-shift mode. */
      await call(CH.custodyConfigSet, { config: { enabled: true, mode: 'SINGLE_SHIFT' } })
      await onReady()
      setOpen(false)
    } catch (e: any) { setError(e?.message ?? 'راه‌اندازی انجام نشد.') } finally { setBusy(false) }
  }
  return <><button className="text-xs px-2 py-1 rounded whitespace-nowrap font-bold bg-amber-500 hover:bg-amber-600" onClick={() => setOpen(true)}>راه‌اندازی حضانت صندوق</button>{open ? createPortal(<div className="fixed inset-0 z-[80] bg-black/55 flex justify-center items-start overflow-auto p-4"><section className="w-full max-w-lg bg-white rounded-lg shadow-xl p-5 mt-8 text-slate-800" dir="rtl"><h2 className="font-bold text-lg border-b pb-3">راه‌اندازی حضانت صندوق</h2><p className="text-sm leading-6 mt-3">حضانت ابتدا در حالت <b>تک‌شیفت</b> فعال می‌شود: تعریف کارمند یا برنامهٔ زمانی اجباری نیست. برای چندکارمندی، ابتدا در «مدیریت حضانت» کارکنان و رمزهای موقت را ثبت کنید، سپس برنامهٔ دارای کارمند بسازید و حالت چندشیفت را آگاهانه فعال کنید.</p><p className="text-xs leading-5 mt-3 text-slate-600">برای باز کردن نخستین صندوق، مدیر می‌تواند از مدیریت حضانت برای خودش رمز موقت صادر کند و از گزینهٔ «تغییر رمز موقت» در کنترل صندوق، آن را شخصی‌سازی کند.</p>{error ? <div className="my-3 p-2 rounded bg-red-50 text-red-700 text-sm">{error}</div> : null}<div className="flex gap-2 mt-5"><button className="btn-secondary flex-1" disabled={busy} onClick={() => setOpen(false)}>انصراف</button><button className="btn-primary flex-1" disabled={busy} onClick={() => void activate()}>{busy ? 'در حال فعال‌سازی…' : 'فعال‌سازی تک‌شیفت'}</button></div></section></div>, document.body) : null}</>
}

function ChangeTemporaryPinForm({ staff, selected, setSelected, temporaryPassword, setTemporaryPassword, newPassword, setNewPassword, repeatNewPassword, setRepeatNewPassword, busy, onBack, onSubmit }: any) {
  return <div className="space-y-3"><p className="text-sm leading-6 bg-slate-50 p-3 rounded">رمز موقت فقط برای یک‌بار استفاده است. هر کارمند فقط با رمز موقت خودش می‌تواند رمز شخصی خود را تعیین کند؛ مدیر هرگز رمز نهایی را نمی‌بیند.</p><label className="block text-sm">کارمند<select className="input mt-1 w-full" value={selected} onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : '')}><option value="">انتخاب کنید…</option>{staff.map((row: Staff) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="block text-sm">رمز موقت<input className="input mt-1 w-full" type="password" value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)} autoComplete="current-password" /></label><label className="block text-sm">رمز شخصی جدید<input className="input mt-1 w-full" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" /></label><label className="block text-sm">تکرار رمز شخصی<input className="input mt-1 w-full" type="password" value={repeatNewPassword} onChange={(e) => setRepeatNewPassword(e.target.value)} autoComplete="new-password" /></label><div className="flex gap-2"><button className="btn-secondary flex-1" onClick={onBack} disabled={busy}>بازگشت</button><button className="btn-primary flex-1" onClick={onSubmit} disabled={busy}>{busy ? 'در حال ثبت…' : 'ثبت رمز شخصی'}</button></div></div>
}

function CredentialForm({ staff, selected, setSelected, password, setPassword, amount, setAmount, label, submit, busy, onBack, onSubmit, selectLabel = 'مسئول صندوق', showNote = false, legacyOpening = false, openingHelp, note, setNote, noteLabel }: any) {
  return <div className="space-y-3">
    {legacyOpening ? <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><b>افتتاح مستقل پس از بازیابی</b><p className="mt-1">دوباره، بدون دیدن مبلغ بازیابی، کشو را شمارش کنید. اگر Main اختلاف را تشخیص دهد، همین دلیل کوتاه لازم می‌شود؛ این اختلاف فروش را متوقف یا تأیید مدیر را لازم نمی‌کند.</p></div> : null}
    {openingHelp ? <p className="rounded border border-sky-200 bg-sky-50 p-3 text-sm leading-6 text-sky-950">{openingHelp}</p> : null}
    <label className="block text-sm">{selectLabel}<select className="input mt-1 w-full" value={selected} onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : '')}><option value="">انتخاب کنید…</option>{staff.map((row: Staff) => <option key={row.id} value={row.id}>{row.name} ({row.role === 'MANAGER' ? 'مدیر' : 'صندوقدار'})</option>)}</select></label>
    <label className="block text-sm">رمز شخصی<input className="input mt-1 w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
    <label className="block text-sm">{label}<input className="input mt-1 w-full" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="۰" /></label>
    {showNote ? <label className="block text-sm">{noteLabel}<textarea className="input mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً مسئول برنامه امروز غایب است و صندوق را خودم شمارش کرده‌ام." /></label> : null}
    <div className="flex gap-2"><button className="btn-secondary flex-1" onClick={onBack} disabled={busy}>بازگشت</button><button className="btn-primary flex-1" onClick={onSubmit} disabled={busy}>{busy ? 'در حال ثبت…' : submit}</button></div>
  </div>
}
function LegacyRecoveryForm({ legacy, staff, selected, setSelected, password, setPassword, amount, setAmount, note, setNote, acknowledgements, setAcknowledgements, busy, onBack, onSubmit }: any) {
  const needsNote = legacy.count > 1 || String(amount).trim() === '0'
  const setAck = (key: string, value: boolean) => setAcknowledgements((prior: any) => ({ ...prior, [key]: value }))
  return <div className="space-y-3"><div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><b>بازیابی نشست‌های قدیمی</b><p className="mt-1">این عملیات فقط شمارش واقعی فعلی را به‌عنوان سند پایان دورهٔ قدیم ثبت می‌کند. فروش‌ها، کسری‌ها و اضافه‌های گذشته به شما منتقل نمی‌شوند. پس از ثبت، باید جداگانه صندوق جدید را با شمارش افتتاح خودتان باز کنید.</p></div><div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm"><b>نشست‌های نیازمند بازیابی</b><ul className="mt-2 list-disc pr-5 space-y-1">{legacy.shifts.map((row: any) => <li key={row.id}>#{row.id} · {row.name} · {row.dayJalali || 'روز ثبت‌نشده'} · {row.legacyUserName ? `ثبت‌شده در سیستم قدیم به نام ${row.legacyUserName}` : 'ثبت‌کنندهٔ قدیمی نامشخص'}</li>)}</ul><p className="mt-2 text-xs text-slate-600">مبلغ مورد انتظار عمداً پیش از شمارش نمایش داده نمی‌شود.</p></div><label className="block text-sm">کارمند حاضر با PIN شخصی (حتی اگر خارج از برنامه باشد)<select className="input mt-1 w-full" value={selected} onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : '')}><option value="">انتخاب کنید…</option>{staff.map((row: Staff) => <option key={row.id} value={row.id}>{row.name} ({row.role === 'MANAGER' ? 'مدیر' : 'صندوقدار'})</option>)}</select></label><label className="block text-sm">PIN شخصی<input className="input mt-1 w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label><label className="block text-sm">شمارش واقعی فعلی کشو<input className="input mt-1 w-full" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="۰" /></label><div className="space-y-2 rounded border border-slate-200 p-3 text-sm"><label className="flex gap-2"><input type="checkbox" checked={acknowledgements.missedHandover} onChange={(e) => setAck('missedHandover', e.target.checked)} />تحویل عادی قبلی انجام نشده یا این نشست‌ها نیازمند بازیابی‌اند.</label><label className="flex gap-2"><input type="checkbox" checked={acknowledgements.physicalCount} onChange={(e) => setAck('physicalCount', e.target.checked)} />مبلغ بالا را واقعاً از پول موجود در کشو شمارش کرده‌ام.</label><label className="flex gap-2"><input type="checkbox" checked={acknowledgements.responsibilityBoundary} onChange={(e) => setAck('responsibilityBoundary', e.target.checked)} />می‌دانم مسئولیت فروش‌ها، کسری‌ها و اضافه‌های نشست‌های قدیمی به من منتقل نمی‌شود؛ مسئولیت من فقط پس از افتتاح جدید آغاز می‌شود.</label></div><label className="block text-sm">یادداشت بازیابی / دلیل خروج از برنامه {needsNote ? <b className="text-rose-700">(اجباری)</b> : <span className="text-slate-500">(اگر خارج از برنامه هستید، دلیل حداقل ۱۰ حرفی لازم است)</span>}<textarea className="input mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="برای نمونه: تحویل شب قبل انجام نشده و شمارش واقعی صبح ثبت شد." /></label><p className="text-xs leading-5 text-slate-500">اگر محاسبهٔ انتظارِ دادهٔ قدیمی ناقص باشد، Main ممکن است یادداشت را الزامی کند؛ مبلغ سیستم پیش از شمارش به شما نمایش داده نمی‌شود.</p><div className="flex gap-2"><button className="btn-secondary flex-1" onClick={onBack} disabled={busy}>بازگشت</button><button className="btn-primary flex-1" onClick={onSubmit} disabled={busy}>{busy ? 'در حال ثبت…' : 'ثبت بازیابی و ادامه'}</button></div></div>
}

function EmergencyCoverForm({ staff, selected, setSelected, password, setPassword, amount, setAmount, reason, setReason, busy, inProgress, onBack, onSubmit }: any) {
  return <div className="space-y-3"><p className="text-sm leading-6 bg-rose-50 border border-rose-200 p-3 rounded"><b>پوشش اضطراری</b> فقط وقتی استفاده می‌شود که مسئول فعلی حاضر نیست. شخص پوشش‌دهنده با PIN خودش و شمارش واقعی مسئولیت بخش تازه را می‌گیرد؛ صفرِ فرد غایب فقط شاهد سیستمی است، نه شمارش او یا حکم تقصیر. فروش قفل نمی‌شود.</p>{inProgress ? <p className="text-xs leading-5 text-amber-800">برای ادامه، دقیقاً همان کارمند، شمارش و دلیل ثبت‌شده را وارد کنید.</p> : null}<label className="block text-sm">کارمند پوشش‌دهنده<select className="input mt-1 w-full" value={selected} onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : '')}><option value="">انتخاب کنید…</option>{staff.map((row: Staff) => <option key={row.id} value={row.id}>{row.name} ({row.role === 'MANAGER' ? 'مدیر' : 'صندوقدار'})</option>)}</select></label><label className="block text-sm">PIN شخصی کارمند پوشش‌دهنده<input className="input mt-1 w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label><label className="block text-sm">مجموع فیزیکی کشو و کارت‌خوان<input className="input mt-1 w-full" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="۰" /></label><label className="block text-sm">دلیل اضطراری (حداقل ۱۰ حرف)<textarea className="input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></label><div className="flex gap-2"><button className="btn-secondary flex-1" onClick={onBack} disabled={busy}>بازگشت</button><button className="btn-primary flex-1" disabled={busy} onClick={onSubmit}>{busy ? 'در حال ثبت…' : inProgress ? 'ادامه و تکمیل پوشش' : 'ثبت پوشش اضطراری'}</button></div></div>
}
function MasterOverrideForm({ managers, managerId, setManagerId, managerPassword, setManagerPassword, amount, setAmount, reason, setReason, busy, inProgress, onBack, onSubmit }: any) {
  return <div className="space-y-3"><p className="text-sm leading-6 bg-rose-50 border border-rose-200 p-3 rounded"><b>Master Override</b> مسیر استثناییِ مدیر است، نه تحویل عادی: مدیر فعالِ انتخاب‌شده با <b>PIN شخصی خود</b> و شمارش واقعی، مسئولیت بخش تازه را می‌پذیرد. غیبت مسئول قبلی فقط شاهد سیستمی است؛ اختلاف حکم تخلف نیست و فروش قفل نمی‌شود.</p>{inProgress ? <p className="text-xs leading-5 text-amber-800">برای ادامهٔ تلاش قدیمی، مدیر با PIN شخصی خود مراجعه کند. مبلغِ تلاش لغوشده برای تحویل تازه دوباره استفاده نمی‌شود.</p> : null}<label className="block text-sm">مدیر مسئول Master Override<select className="input mt-1 w-full" value={managerId} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : '')}><option value="">انتخاب کنید…</option>{managers.map((row: Staff) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="block text-sm">PIN شخصی مدیر انتخاب‌شده<input className="input mt-1 w-full" type="password" value={managerPassword} onChange={(e) => setManagerPassword(e.target.value)} autoComplete="current-password" /></label><label className="block text-sm">مجموع فیزیکی کشو و کارت‌خوان<input className="input mt-1 w-full" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="۰" /></label><label className="block text-sm">دلیل Master Override (حداقل ۱۰ حرف)<textarea className="input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></label><div className="flex gap-2"><button className="btn-secondary flex-1" onClick={onBack} disabled={busy}>بازگشت</button><button className="btn-primary flex-1" disabled={busy} onClick={onSubmit}>{busy ? 'در حال ثبت…' : inProgress ? 'ادامه و تکمیل Override' : 'ثبت Master Override'}</button></div></div>
}
function PasswordOnly({ label, password, setPassword, amount, setAmount, note, setNote, noteLabel = 'یادداشت (برای بستن خالی ضروری است)', amountLabel = 'شمارش نقدی', submit, busy, onBack, onSubmit }: any) {
  return <div className="space-y-3"><p className="text-sm leading-6 bg-slate-50 p-3 rounded">{label}</p><label className="block text-sm">رمز شخصی<input className="input mt-1 w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>{setAmount ? <label className="block text-sm">{amountLabel}<input className="input mt-1 w-full" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="۰" /></label> : null}{setNote ? <label className="block text-sm">{noteLabel}<textarea className="input mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} /></label> : null}<div className="flex gap-2"><button className="btn-secondary flex-1" onClick={onBack} disabled={busy}>بازگشت</button><button className="btn-primary flex-1" onClick={onSubmit} disabled={busy}>{busy ? 'در حال ثبت…' : submit}</button></div></div>
}
