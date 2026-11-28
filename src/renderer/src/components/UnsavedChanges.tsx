import { useState } from 'react'
import { useBlocker } from 'react-router-dom'

/**
 * دفتر آزمون ۴-۳۸ — یک رفتار روشن برای دکمه‌های ذخیره، در همهٔ صفحه‌های دارای دکمهٔ ذخیره:
 *  - یک نشان «تغییرات ذخیره نشده» و یک پیام «✓ ذخیره شد»؛
 *  - `saveSections`: هر بخشِ تغییرکرده، به ترتیب، با تابع ذخیرهٔ خودش (همان مسیر سرور و همان اجازهٔ امروزِ همان بخش؛
 *    اصل «ج»)؛ شکست یک بخش جلوی بقیه را نمی‌گیرد و پیامش نام همان بخش را می‌گوید؛
 *  - `useLeaveGuard`: بیرون رفتن از صفحه یا تب با تغییر ذخیره‌نشده ⇐ «ذخیره»، «بیرون رفتن بی ذخیره» یا «ماندن».
 */
export const UNSAVED_TEXT = 'تغییرات ذخیره نشده'
export const SAVED_TEXT = '✓ ذخیره شد'
export const LEAVE_QUESTION = 'تغییرهای ذخیره‌نشده دارید؛ ذخیره شود؟'

export function UnsavedBadge({ show, sections }: { show: boolean; sections?: readonly string[] }) {
  if (!show) return null
  return (
    <span className="kbd text-amber-700 font-bold self-center" title={sections?.length ? `ذخیره‌نشده: ${sections.join('، ')}` : undefined}>
      {UNSAVED_TEXT}
    </span>
  )
}

/** تابع ذخیرهٔ هر بخش: `null` یعنی ذخیره شد؛ متن یعنی ذخیره نشد (همان پیام سرور). */
export type SectionSave = { name: string; dirty: boolean; save: () => Promise<string | null | undefined> }
export type SaveReport = { saved: string[]; failed: Array<{ name: string; error: string }> }

export async function saveSections(sections: readonly SectionSave[]): Promise<SaveReport> {
  const report: SaveReport = { saved: [], failed: [] }
  for (const s of sections) {
    if (!s.dirty) continue
    let error: string | null | undefined
    try { error = await s.save() } catch (e) { error = e instanceof Error && e.message ? e.message : 'انجام نشد' }
    if (error) report.failed.push({ name: s.name, error: String(error) })
    else report.saved.push(s.name)
  }
  return report
}

/** پیام نهایی: «✓ ذخیره شد» با نام بخش‌های ذخیره‌شده، و برای هر بخش ناموفق یک خط با نام همان بخش. */
export function saveReportText(r: SaveReport): { ok: string | null; error: string | null } {
  const ok = r.saved.length ? `${SAVED_TEXT}: ${r.saved.map((n) => `«${n}»`).join('، ')}` : r.failed.length ? null : SAVED_TEXT
  const error = r.failed.length ? r.failed.map((f) => `«${f.name}» ذخیره نشد: ${f.error}`).join('\n') : null
  return { ok, error }
}

export type LeaveChoice = 'save' | 'discard' | 'stay'
/** پس از انتخاب: برود، بی ذخیره برود (تغییرها دور ریخته شوند) یا بماند؛ «ذخیره»ی ناموفق یعنی ماندن. */
export async function resolveLeave(choice: LeaveChoice, save: () => Promise<boolean>): Promise<'go' | 'go-discard' | 'stay'> {
  if (choice === 'stay') return 'stay'
  if (choice === 'discard') return 'go-discard'
  return (await save()) ? 'go' : 'stay'
}

export function UnsavedChangesDialog({ busy, onChoose }: { busy: boolean; onChoose: (choice: LeaveChoice) => void }) {
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="bg-white rounded shadow p-4 space-y-3 w-[min(92vw,440px)]">
        <div className="font-bold">{LEAVE_QUESTION}</div>
        <div className="flex flex-wrap gap-2 justify-end">
          <button className="btn btn-primary" disabled={busy} onClick={() => onChoose('save')}>{busy ? 'در حال ذخیره…' : 'ذخیره'}</button>
          <button className="btn" disabled={busy} onClick={() => onChoose('discard')}>بیرون رفتن بی ذخیره</button>
          <button className="btn" disabled={busy} onClick={() => onChoose('stay')}>ماندن</button>
        </div>
      </div>
    </div>
  )
}

/**
 * پرسش هنگام بیرون رفتن: رفتن به صفحهٔ دیگر با `useBlocker`؛ تب‌های همان صفحه با `guard(() => setTab(…))`.
 * `save` باید `true` بدهد اگر همه ذخیره شد؛ `discard` (برای تب) تغییرها را از پایگاه داده بازمی‌خواند.
 */
export function useLeaveGuard(unsaved: boolean, save: () => Promise<boolean>, discard?: () => unknown) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => unsaved && currentLocation.pathname !== nextLocation.pathname)
  const [pendingTab, setPendingTab] = useState<{ go: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const guard = (go: () => void) => { if (unsaved) setPendingTab({ go }); else go() }
  const choose = async (choice: LeaveChoice) => {
    setBusy(true)
    try {
      const outcome = await resolveLeave(choice, save)
      if (blocker.state === 'blocked') {
        if (outcome === 'stay') blocker.reset?.()
        else blocker.proceed?.()
      } else if (pendingTab && outcome !== 'stay') {
        if (outcome === 'go-discard') await discard?.()
        pendingTab.go()
      }
    } finally {
      setBusy(false)
      setPendingTab(null)
    }
  }
  const asking = blocker.state === 'blocked' || pendingTab !== null
  return { guard, dialog: asking ? <UnsavedChangesDialog busy={busy} onChoose={(c) => void choose(c)} /> : null }
}
