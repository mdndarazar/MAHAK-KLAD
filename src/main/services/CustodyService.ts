import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { audit, auditOrThrow } from './AuditService'
import { AuditAction } from '@shared/enums'
import { DEFAULT_CUSTODY_CONFIG, parseCustodyConfig, parseShiftConfig, SETTING_KEYS, type CustodyConfig, type ShiftConfig, type ShiftTemplate } from '@shared/receipt'
import { toJalaliDate, jalaliStartOfDay, jalaliEndOfDay, isValidJalaliDate, toLatinDigits, parseRequiredRialAmount } from '@shared/jalali'
import { observationOf, absenceUncounted, isAbsentUncounted } from '@shared/custodyPeriod'
import { compareCustodyPeerCounts } from '@shared/custodyPeerCount'
import { pendingCustodyReference, CUSTODY_REFERENCE_LEGACY_VERSION } from '@shared/custodyReference'
import { recordBlueSnapshot, referenceFromBlueSnapshot } from './CustodyBlueSnapshotService'
import { shiftService } from './ShiftService'
import { recordCashMovement } from './CashMovementService'
import { cashboxService } from './CashboxService'
import { physicalMovementForCustodyShift, previewSegmentBoundary, recordAdoptionBaseline, recordAggregateBoundary, segmentAggregateBaseline } from './CustodyAggregateService'
import { CashMovementType } from '@shared/enums'
import { assertManagerSession } from './panelSession'

/**
 * Custody v2 deliberately lives beside, rather than inside, the legacy shift
 * model.  The feature flag is false by default: callers must opt in before a
 * single legacy sale/shift path changes.
 */
const MAIN = 'MAIN'
const PURPOSE = 'CUSTODY_PIN'
const PIN_ATTEMPTS = 5
const PIN_LOCK_MS = 15 * 60 * 1000
/** The final fifteen minutes belong to the planned shift-change flow; before
 * this boundary a replacement is a true mid-day handover and needs its own
 * template permission. */
const MIDDAY_HANDOVER_CUTOFF_MS = 15 * 60 * 1000

type Client = any
export type CustodyFence = {
  epoch: number
  expectedShiftId: number
  expectedActorUserId: number
}

function asSafeId(value: unknown, label = 'شناسه'): number {
  const n = Math.round(Number(value))
  if (!Number.isSafeInteger(n) || n <= 0) throw new BusinessError(`${label} نامعتبر است.`)
  return n
}

function asCash(value: unknown, label = 'مبلغ'): number {
  /** `Number('')` and `Number(null)` are zero, but an omitted count must never
   * silently become a cash count. Zero is accepted only when it was explicit. */
  if (value == null || (typeof value === 'string' && !value.trim()) || (typeof value !== 'number' && typeof value !== 'string'))
    throw new BusinessError(`${label} را صریحاً به‌صورت یک عدد صحیحِ صفر یا مثبت وارد کنید.`)
  const n = typeof value === 'string' ? parseRequiredRialAmount(value) : value
  if (n == null || !Number.isSafeInteger(n) || n < 0) throw new BusinessError(`${label} باید یک عدد صحیحِ صفر یا مثبت باشد.`)
  return n
}

/** Same shape for the just-recorded IN and the receiver-PIN readback. The
 * peer warning only uses the two physical witnesses, never the reference or
 * the inherited/fresh accounting variance. Monetary amounts do not enter
 * public status or the handover-start response. */
function blueHandoverPreview(handoverId: number, out: any, incoming: any, selfCount: boolean) {
  return {
    handoverId, state: 'RECEIVER_COUNTED' as const,
    referenceStatus: incoming.referenceStatus,
    referenceAmount: incoming.referenceAmount == null ? null : Number(incoming.referenceAmount),
    knownSubtotal: incoming.knownSubtotal == null ? null : Number(incoming.knownSubtotal),
    destinationUnknownReceived: incoming.destinationUnknownReceived == null ? null : Number(incoming.destinationUnknownReceived),
    ambiguousLegacyCredit: incoming.ambiguousLegacyCredit == null ? null : Number(incoming.ambiguousLegacyCredit),
    rawDifference: incoming.rawDifference == null ? null : Number(incoming.rawDifference),
    freshDifference: incoming.freshDifference == null ? null : Number(incoming.freshDifference),
    peerComparison: compareCustodyPeerCounts(out, incoming, selfCount)
  }
}

/** Manager discrepancy filters are intentionally Jalali-only.  A malformed
 * boundary must never silently fall back to another reporting period. */
function custodyJalaliRange(input: { from?: unknown; to?: unknown }) {
  const normalize = (raw: unknown, label: string) => {
    if (raw == null || String(raw).trim() === '') return null
    const date = toLatinDigits(String(raw)).trim()
    if (!isValidJalaliDate(date)) throw new BusinessError(`${label} گزارش مغایرت باید به شکل ۱۴۰۵/۰۷/۲۰ باشد.`, 'CUSTODY_REPORT_RANGE_INVALID')
    return date
  }
  const fromJalali = normalize(input.from, 'از تاریخ')
  const toJalali = normalize(input.to, 'تا تاریخ')
  const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60_000)
  const from = fromJalali ? jalaliStartOfDay(fromJalali) : defaultFrom
  const to = toJalali ? jalaliEndOfDay(toJalali) : new Date()
  if (to.getTime() < from.getTime())
    throw new BusinessError('تا تاریخ گزارش مغایرت نمی‌تواند پیش از از تاریخ باشد.', 'CUSTODY_REPORT_RANGE_INVALID')
  return { from, to, fromJalali: fromJalali ?? toJalaliDate(from), toJalali: toJalali ?? toJalaliDate(to) }
}

/** Persian/Arabic digits and the two common Arabic letter variants must not
 * create visually-identical but different credentials.  All other letters and
 * symbols remain exact; whitespace is banned to prevent invisible passwords. */
export function normalizeCustodyPassword(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
}

function assertPasswordPolicy(raw: unknown, phone?: string | null) {
  const password = normalizeCustodyPassword(raw)
  if (password.length < 6 || password.length > 128 || /\s/u.test(password))
    throw new BusinessError('رمز شخصی باید بین ۶ تا ۱۲۸ کاراکتر باشد و فاصله نداشته باشد.')
  if (!/^[\p{L}\p{N}\p{P}\p{S}]+$/u.test(password))
    throw new BusinessError('رمز شخصی فقط می‌تواند شامل حروف، اعداد و نمادهای معمول باشد.')
  const plain = password.toLocaleLowerCase('fa-IR')
  if (/^(.)\1+$/u.test(plain) || ['123456', '654321', 'abcdef', 'fedcba', 'qwerty'].includes(plain))
    throw new BusinessError('این رمز بسیار ساده است؛ یک رمز شخصی متفاوت انتخاب کنید.')
  const digits = normalizeCustodyPassword(phone ?? '').replace(/\D/g, '')
  if (digits.length >= 6 && plain === digits.slice(-6))
    throw new BusinessError('رمز شخصی نباید شش رقم آخر شماره تلفن خودتان باشد.')
  return password
}

function derive(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex')
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Fallback only for unscheduled/legacy sessions. Scheduled canonical work
 * must expire from its own scheduled end, never from a day cutover that can
 * prematurely terminate an overnight allowance. */
function cutoverRolloverAt(now: Date, config: CustodyConfig): Date {
  const out = new Date(now)
  out.setHours(0, config.dayCutoverMinute, 0, 0)
  if (out <= now) out.setDate(out.getDate() + 1)
  return out
}

type CustodyPlanSnapshot = {
  legacyPlanId: number | null
  templateId: string | null
  title: string | null
  scheduledEndAt: Date | null
  reminderRepeatMin: number
  allowMidDayHandover: boolean
}

/** Schedule configuration is mutable policy for future work. Every newly
 * opened responsibility segment stores this compact immutable snapshot so a
 * later mode/template edit cannot rewrite its expiry, handover permission,
 * reminder rhythm, or scheduled-recipient rule. */
type CustodySegmentScheduleSnapshot = {
  templateId: string | null
  planId: number | null
  title: string | null
  scheduledEndAt: string | null
  reminderRepeatMin: number
  allowMidDayHandover: boolean
  staffIds: number[]
  overrunGraceMinutes: number
  overtimeMaxMinutes: number
  reminderEnabled: boolean
  mode: 'SINGLE_SHIFT' | 'MULTI_SHIFT'
}

function scheduleSnapshotJson(plan: CustodyPlanSnapshot | null, scheduling?: ShiftConfig | null, custody?: CustodyConfig | null): string | null {
  if (!plan) return null
  const template = plan.templateId && scheduling ? scheduling.templates.find((row) => row.id === plan.templateId) ?? null : null
  return JSON.stringify({
    templateId: plan.templateId ?? null,
    planId: plan.legacyPlanId ?? null,
    title: plan.title ?? null,
    scheduledEndAt: plan.scheduledEndAt ? new Date(plan.scheduledEndAt).toISOString() : null,
    reminderRepeatMin: Math.max(5, Math.min(60, Number(plan.reminderRepeatMin) || 15)),
    allowMidDayHandover: plan.allowMidDayHandover === true,
    staffIds: template ? [...template.staffIds] : [],
    overrunGraceMinutes: Math.max(0, Math.min(1440, Math.round(Number(scheduling?.overrunGraceMinutes)) || 0)),
    overtimeMaxMinutes: Math.max(0, Math.min(240, Math.round(Number(scheduling?.overtimeMaxMinutes)) || 0)),
    reminderEnabled: scheduling?.reminderEnabled !== false,
    mode: scheduling && custody ? effectiveCustodyMode(custody, scheduling) : 'MULTI_SHIFT'
  } satisfies CustodySegmentScheduleSnapshot)
}

function scheduleSnapshotOf(meta: { scheduleSnapshotJson?: string | null } | null | undefined): CustodySegmentScheduleSnapshot | null {
  if (!meta?.scheduleSnapshotJson) return null
  try {
    const raw = JSON.parse(String(meta.scheduleSnapshotJson))
    if (!raw || typeof raw !== 'object') return null
    const templateId = raw.templateId == null ? null : String(raw.templateId)
    const planId = raw.planId == null ? null : Math.round(Number(raw.planId))
    const scheduledEndAt = raw.scheduledEndAt == null ? null : String(raw.scheduledEndAt)
    if (scheduledEndAt && !Number.isFinite(new Date(scheduledEndAt).getTime())) return null
    const rawStaffIds: unknown[] = Array.isArray(raw.staffIds) ? raw.staffIds : []
    const staffIds = [...new Set<number>(rawStaffIds
      .map((id): number => Math.round(Number(id)))
      .filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
    return {
      templateId,
      planId: Number.isSafeInteger(planId) && planId! > 0 ? planId : null,
      title: raw.title == null ? null : String(raw.title),
      scheduledEndAt,
      reminderRepeatMin: Math.max(5, Math.min(60, Math.round(Number(raw.reminderRepeatMin)) || 15)),
      allowMidDayHandover: raw.allowMidDayHandover === true,
      staffIds,
      overrunGraceMinutes: Math.max(0, Math.min(1440, Math.round(Number(raw.overrunGraceMinutes)) || 0)),
      overtimeMaxMinutes: Math.max(0, Math.min(240, Math.round(Number(raw.overtimeMaxMinutes)) || 0)),
      // v1 snapshots did not record these fields; they were emitted only for
      // canonical multi-shift segments, so preserve that conservative meaning.
      reminderEnabled: raw.reminderEnabled !== false,
      mode: raw.mode === 'SINGLE_SHIFT' ? 'SINGLE_SHIFT' : 'MULTI_SHIFT'
    }
  } catch {
    return null
  }
}

function planFromSegmentSnapshot(meta: { templateId?: string | null; planId?: number | null; planTitle?: string | null; scheduledEndAt?: Date | null; scheduleSnapshotJson?: string | null }, fallback?: { reminderRepeatMin?: number; allowMidDayHandover?: boolean } | null): CustodyPlanSnapshot | null {
  const snap = scheduleSnapshotOf(meta)
  const templateId = snap?.templateId ?? meta.templateId ?? null
  const legacyPlanId = snap?.planId ?? meta.planId ?? null
  const title = snap?.title ?? meta.planTitle ?? null
  const scheduledEndAt = snap?.scheduledEndAt ? new Date(snap.scheduledEndAt) : meta.scheduledEndAt ? new Date(meta.scheduledEndAt) : null
  if (!templateId && !legacyPlanId && !title && !scheduledEndAt) return null
  return {
    legacyPlanId,
    templateId,
    title,
    scheduledEndAt,
    reminderRepeatMin: snap?.reminderRepeatMin ?? fallback?.reminderRepeatMin ?? 15,
    allowMidDayHandover: snap?.allowMidDayHandover ?? fallback?.allowMidDayHandover ?? false
  }
}

/** `overtimeMaxMinutes` is the configured scheduled overtime allowance. It is
 * deliberately distinct from `overrunGraceMinutes`, which merely controls a
 * reminder. Only canonical scheduled sessions get this expiry; legacy plans
 * and unscheduled sessions retain their cutover fallback. */
function rolloverAt(now: Date, config: CustodyConfig, scheduling: ShiftConfig, plan: CustodyPlanSnapshot | null): Date {
  const scheduledEnd = plan?.templateId && plan.scheduledEndAt ? new Date(plan.scheduledEndAt) : null
  if (scheduledEnd && Number.isFinite(scheduledEnd.getTime()))
    return new Date(scheduledEnd.getTime() + Math.max(0, Number(scheduling.overtimeMaxMinutes) || 0) * 60_000)
  return cutoverRolloverAt(now, config)
}

/** Reused/continued segments inherit the source snapshot's overtime, rather
 * than letting an edit made after their original opening move their expiry. */
function rolloverAtForSnapshot(now: Date, config: CustodyConfig, scheduling: ShiftConfig, plan: CustodyPlanSnapshot | null, snapshotJson?: string | null): Date {
  const snapshot = scheduleSnapshotOf(snapshotJson == null ? null : { scheduleSnapshotJson: snapshotJson })
  const scheduledEnd = snapshot?.templateId && snapshot.scheduledEndAt ? new Date(snapshot.scheduledEndAt) : null
  if (snapshot && scheduledEnd && Number.isFinite(scheduledEnd.getTime()))
    return new Date(scheduledEnd.getTime() + snapshot.overtimeMaxMinutes * 60_000)
  return rolloverAt(now, config, scheduling, plan)
}

/** Existing open canonical segments did not snapshot their scheduled expiry in
 * earlier versions. Read their durable scheduled-end metadata instead of
 * imposing the legacy cutover; newly opened segments persist the same result
 * in `rolloverAt`. */
function expiryAt(meta: { rolloverAt: Date }, _scheduling?: ShiftConfig): Date {
  // `rolloverAt` was calculated and persisted at segment creation. Reading the
  // current Settings here would silently change a live segment after a manager
  // edits overtime or mode, which is precisely what the custody boundary forbids.
  return new Date(meta.rolloverAt)
}

async function configOf(client: Client = prisma): Promise<CustodyConfig> {
  const row = await client.setting.findUnique({ where: { key: SETTING_KEYS.custodyConfig } })
  return parseCustodyConfig(row?.value ?? DEFAULT_CUSTODY_CONFIG)
}

/**
 * A pre-custody Shift is not evidence of a real custody segment. Once custody
 * has been explicitly configured, however, such an open row is a durable
 * migration block: allowing a Settings toggle to reveal the old close/open
 * surfaces would erase the only PIN/count recovery boundary. A plain legacy
 * installation which has never persisted custody.config stays untouched.
 *
 * This helper intentionally returns rows rather than a boolean. Later recovery
 * phases need the exact immutable set for a compare-and-set transaction; P1
 * uses only its existence to close the current Settings bypass.
 */
async function legacyOpenShifts(client: Client): Promise<any[]> {
  const configured = await client.setting.findUnique({ where: { key: SETTING_KEYS.custodyConfig }, select: { key: true } })
  if (!configured) return []
  const open = await client.shift.findMany({
    where: { closedAt: null },
    orderBy: [{ id: 'asc' }],
    select: { id: true, name: true, number: true, sessionSeq: true, dayJalali: true, openedAt: true, userId: true }
  })
  if (!open.length) return []
  const metas = await client.custodyShiftMeta.findMany({
    where: { shiftId: { in: open.map((row: any) => row.id) } },
    select: { shiftId: true }
  })
  const custodyShiftIds = new Set(metas.map((row: any) => row.shiftId))
  return open.filter((row: any) => !custodyShiftIds.has(row.id))
}

/** Canonical schedule lives in shift.config. The legacy custody config remains
 * only as an execution/feature flag during transition; legacy ShiftPlan rows
 * are never silently copied into this model. */
async function shiftSchedulingOf(client: Client = prisma): Promise<ShiftConfig> {
  const row = await client.setting.findUnique({ where: { key: SETTING_KEYS.shiftConfig } })
  return parseShiftConfig(row?.value ?? null)
}

/** There were historically two persisted mode fields.  An old installation is
 * deliberately left on its custody.config decision until the manager completes
 * the explicit workflow, which writes both fields atomically.  From that point
 * onward shift.config is the sole operational scheduling authority. */
function effectiveCustodyMode(custody: CustodyConfig, scheduling: ShiftConfig): 'SINGLE_SHIFT' | 'MULTI_SHIFT' {
  if (scheduling.custodyModeConfigured) return scheduling.custodyMode
  // Pre-workflow canonical multi-shift templates were already an explicit,
  // persisted scheduling choice.  Keep them governing rather than letting the
  // newly added marker downgrade an existing installation to custody.config.
  if (scheduling.custodyMode === 'MULTI_SHIFT' && hasCanonicalAssignments(scheduling)) return 'MULTI_SHIFT'
  return custody.mode
}

/** A plan describes expected staffing only. Missing, late, or absent scheduled
 * staff never blocks sales; it merely produces a reminder tied to the actual
 * authenticated custody session. */
async function planForOpen(client: Client, userId: number, now = new Date()) {
  const [plans, assignments] = await Promise.all([
    client.shiftPlan.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    client.shiftPlanStaff.findMany({ where: { userId } })
  ])
  const assigned = new Set(assignments.map((row: any) => row.planId))
  const candidates: Array<{ plan: any; start: Date; end: Date }> = []
  for (const plan of plans) {
    if (!assigned.has(plan.id)) continue
    for (const dayOffset of [0, -1]) {
      const start = new Date(now)
      start.setDate(start.getDate() + dayOffset)
      start.setHours(0, Number(plan.startMinute), 0, 0)
      const weekdayMask = 1 << start.getDay()
      if ((Number(plan.daysMask) & weekdayMask) === 0) continue
      const end = new Date(start.getTime() + Number(plan.durationMinutes) * 60_000)
      if (now >= start && now < end) candidates.push({ plan, start, end })
    }
  }
  candidates.sort((a, b) => b.start.getTime() - a.start.getTime() || a.plan.id - b.plan.id)
  const match = candidates[0] ?? null
  return match ? { legacyPlanId: match.plan.id, templateId: null, title: match.plan.title, scheduledEndAt: match.end, reminderRepeatMin: Number(match.plan.reminderRepeatMin), allowMidDayHandover: false } : null
}

/** New schedules are read exclusively from Shift Settings. This code never
 * writes/changes ShiftPlan; the legacy fallback remains only for already
 * enabled legacy installations until their manager reviews the inventory. */
/** A schedule becomes operational once Settings contains an active named shift
 * with a selected person. Until then the deliberately simple fresh-install
 * single-shift path remains unscheduled and backwards compatible. */
function hasCanonicalAssignments(cfg: ShiftConfig): boolean {
  return cfg.templates.some((template) => template.isActive && template.staffIds.length > 0)
}

function canonicalPlanForOpen(cfg: ShiftConfig, userId: number, now = new Date()) {
  const candidates: Array<{ template: ShiftTemplate; start: Date; end: Date }> = []
  const minutesOf = (value: string) => {
    const [hour, minute] = String(value ?? '00:00').split(':').map(Number)
    return (Number(hour) || 0) * 60 + (Number(minute) || 0)
  }
  for (const template of cfg.templates) {
    if (!template.isActive || !template.staffIds.includes(userId)) continue
    const startMinute = minutesOf(template.startTime)
    const endMinute = minutesOf(template.endTime)
    const durationMinutes = ((endMinute - startMinute + 1440) % 1440) || 1440
    for (const dayOffset of [0, -1]) {
      const start = new Date(now)
      start.setDate(start.getDate() + dayOffset)
      start.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0)
      if ((template.daysMask & (1 << start.getDay())) === 0) continue
      const end = new Date(start.getTime() + durationMinutes * 60_000)
      if (now >= start && now < end) candidates.push({ template, start, end })
    }
  }
  candidates.sort((a, b) => b.start.getTime() - a.start.getTime() || a.template.id.localeCompare(b.template.id))
  const match = candidates[0] ?? null
  return match
    ? {
        legacyPlanId: null,
        templateId: match.template.id,
        title: match.template.name,
        scheduledEndAt: match.end,
        reminderRepeatMin: match.template.reminderRepeatMin,
        allowMidDayHandover: match.template.allowMidDayHandover
      }
    : null
}

function recoveryIdempotencyKey(value: unknown): string {
  const key = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(key))
    throw new BusinessError('کلید درخواست بازیابی نامعتبر است؛ دوباره تلاش کنید.', 'CUSTODY_RECOVERY_IDEMPOTENCY_INVALID')
  return key
}

function recoveryAckVersion(value: unknown): string {
  const version = String(value ?? '').trim()
  if (version !== 'LEGACY_RECOVERY_V1')
    throw new BusinessError('متن تأیید بازیابی معتبر نیست؛ صفحه را دوباره باز کنید.', 'CUSTODY_RECOVERY_ACK_INVALID')
  return version
}

function recoverySeenEpoch(value: unknown): number {
  const epoch = Math.round(Number(value))
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new BusinessError('وضعیت بازیابی قدیمی است؛ صفحه را دوباره باز کنید.', 'CUSTODY_STALE')
  return epoch
}

function recoverySeenShiftIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new BusinessError('فهرست نشست‌های قدیمی معتبر نیست؛ صفحه را دوباره باز کنید.', 'CUSTODY_LEGACY_STALE')
  const ids = value.map((item) => asSafeId(item, 'شناسه نشست قدیمی'))
  if (new Set(ids).size !== ids.length)
    throw new BusinessError('فهرست نشست‌های قدیمی تکراری است؛ صفحه را دوباره باز کنید.', 'CUSTODY_LEGACY_STALE')
  return ids.sort((a, b) => a - b)
}

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function toMoneyBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  const numeric = Number(value ?? 0)
  return BigInt(Number.isSafeInteger(numeric) ? numeric : 0)
}

function recoveryFingerprint(input: { userId: number; countedCash: number; note: string; ackTextVersion: string; seenEpoch: number; seenShiftIds: number[] }) {
  return createHash('sha256')
    .update(JSON.stringify({ ...input, seenShiftIds: [...input.seenShiftIds].sort((a, b) => a - b) }))
    .digest('hex')
}

/** Capture only immutable, reportable legacy facts before the atomic CAS.
 * Expected cash is best-effort: historical rows may be too incomplete for a
 * formula, but that must not strand a physically counted drawer forever. */
async function legacyEvidenceSnapshot(shift: any) {
  const [invoiceRows, movementRows, invoiceCount] = await Promise.all([
    prisma.saleInvoice.findMany({ where: { shiftId: shift.id }, orderBy: [{ id: 'desc' }], take: 1, select: { id: true, issuedAt: true } }),
    prisma.cashMovement.findMany({ where: { shiftId: shift.id }, orderBy: [{ id: 'desc' }], select: { id: true, occurredAt: true, amount: true, type: true } }),
    prisma.saleInvoice.count({ where: { shiftId: shift.id } })
  ])
  let expectedCash: number | null = null
  let expectedCalcStatus = 'AVAILABLE'
  try {
    const expected = await cashboxService.expected({ shiftId: shift.id })
    const value = Number((expected as any).expectedCash)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('expected cash is invalid')
    expectedCash = value
  } catch {
    expectedCalcStatus = 'UNAVAILABLE'
  }
  const openingFloat = movementRows
    .filter((row: any) => row.type === CashMovementType.OPENING_FLOAT)
    .reduce((sum: bigint, row: any) => sum + toMoneyBigInt(row.amount), 0n)
  const cashIn = movementRows
    .filter((row: any) => !['CASH_OUT', 'RETURN_REFUND', 'EXCHANGE_REFUND', 'WITHDRAWAL'].includes(String(row.type)))
    .reduce((sum: bigint, row: any) => sum + toMoneyBigInt(row.amount), 0n)
  const cashOut = movementRows
    .filter((row: any) => ['CASH_OUT', 'RETURN_REFUND', 'EXCHANGE_REFUND', 'WITHDRAWAL'].includes(String(row.type)))
    .reduce((sum: bigint, row: any) => sum + toMoneyBigInt(row.amount), 0n)
  const lastTimes = [shift.openedAt, invoiceRows[0]?.issuedAt, movementRows[0]?.occurredAt]
    .filter(Boolean)
    .map((at: any) => new Date(at))
    .filter((at: Date) => Number.isFinite(at.getTime()))
  lastTimes.sort((a: Date, b: Date) => b.getTime() - a.getTime())
  return {
    shift,
    invoiceCount: Number(invoiceCount),
    expectedCash,
    expectedCalcStatus,
    openingFloat,
    cashIn,
    cashOut,
    lastActivityAt: lastTimes[0] ?? null,
    watermark: {
      invoiceId: invoiceRows[0]?.id ?? null,
      movementId: movementRows[0]?.id ?? null
    }
  }
}

async function legacyWatermarkStillMatches(tx: Client, snapshot: any): Promise<boolean> {
  const [invoice, movement] = await Promise.all([
    tx.saleInvoice.findMany({ where: { shiftId: snapshot.shift.id }, orderBy: [{ id: 'desc' }], take: 1, select: { id: true } }),
    tx.cashMovement.findMany({ where: { shiftId: snapshot.shift.id }, orderBy: [{ id: 'desc' }], take: 1, select: { id: true } })
  ])
  return (invoice[0]?.id ?? null) === snapshot.watermark.invoiceId && (movement[0]?.id ?? null) === snapshot.watermark.movementId
}

/** There can be at most one unlinked recovery in normal operation: recovery
 * closes every current orphan Shift and opening consumes that boundary once.
 * We still calculate it from durable append-only rows, never from renderer
 * state, so a crash between recovery and opening simply resumes at S1. */
async function pendingLegacyOpening(client: Client): Promise<any | null> {
  const stores: any = client as any
  const recoveries = await stores.legacyShiftRecovery.findMany({ orderBy: [{ id: 'desc' }], take: 100 })
  if (!recoveries.length) return null
  const links = await stores.legacyRecoveryOpeningLink.findMany({
    where: { recoveryId: { in: recoveries.map((row: any) => row.id) } },
    select: { recoveryId: true }
  })
  const linked = new Set(links.map((row: any) => row.recoveryId))
  return recoveries.find((row: any) => !linked.has(row.id)) ?? null
}

/** The roster suggests the ordinary opener; it must not strand the drawer
 * when that worker is absent. A NO_SESSION cashier/manager can open an OWN,
 * unscheduled segment only after personal PIN verification by the caller, a
 * real explicit physical count and a durable reason. Never borrow the missing
 * worker's plan, PIN, count or prior difference. Recovery uses the same gate
 * before it closes any legacy-open Shift and rechecks inside its transaction. */
async function openingPlanForActor(
  client: Client,
  actor: { userId: number },
  exceptionEvidence: { count: number | null; reason: unknown }
) {
  const [cfg, scheduling] = await Promise.all([configOf(client), shiftSchedulingOf(client)])
  if (!cfg.enabled) throw new BusinessError('ماژول حضانت صندوق هنوز فعال نشده است.')
  const custodyMode = effectiveCustodyMode(cfg, scheduling)
  const canonicalConfigured = scheduling.custodyModeConfigured
    ? custodyMode === 'MULTI_SHIFT'
    : hasCanonicalAssignments(scheduling)
  const otherDailyCustodian = scheduling.custodyModeConfigured && custodyMode === 'SINGLE_SHIFT' &&
    scheduling.singleShiftCustodianUserId !== actor.userId
  const plan = otherDailyCustodian ? null : canonicalConfigured
    ? canonicalPlanForOpen(scheduling, actor.userId)
    : custodyMode === 'MULTI_SHIFT'
      ? await planForOpen(client, actor.userId)
      : null
  const legacyPlanExists = custodyMode === 'MULTI_SHIFT' && !canonicalConfigured && !plan &&
    !!(await client.shiftPlan.findFirst({ where: { isActive: true }, select: { id: true } }))
  const blockedBy = otherDailyCustodian ? 'NOT_DAILY_CUSTODIAN'
    : !plan && (canonicalConfigured || legacyPlanExists) ? 'NO_SCHEDULED_SHIFT' : null
  if (!blockedBy) return { cfg, scheduling, plan, offSchedule: null }
  if (exceptionEvidence.count == null || !Number.isSafeInteger(exceptionEvidence.count) || exceptionEvidence.count < 0)
    throw new BusinessError('برای افتتاح خارج از برنامه، مجموع واقعیِ کشو و کارت‌خوان را صریح وارد کنید؛ صفر فقط با ثبت رقم ۰ پذیرفته است.', 'CUSTODY_UNSCHEDULED_COUNT_REQUIRED')
  const reason = String(exceptionEvidence.reason ?? '').trim()
  if (reason.length < 10 || reason.length > 1000)
    throw new BusinessError('برای افتتاح خارج از برنامه، دلیل روشنِ ۱۰ تا ۱۰۰۰ نویسه‌ای لازم است.', 'CUSTODY_UNSCHEDULED_REASON_REQUIRED')
  return { cfg, scheduling, plan: null, offSchedule: { blockedBy, mode: custodyMode, reason } }
}

async function writeEvent(client: Client, input: {
  type: string
  shiftId?: number | null
  handoverId?: number | null
  resolutionId?: number | null
  legacyRecoveryId?: number | null
  actorUserId?: number | null
  actorKind: string
  authMethod?: string | null
  epochBefore?: number | null
  epochAfter?: number | null
  payload?: unknown
}) {
  await client.custodyEvent.create({
    data: {
      type: input.type,
      shiftId: input.shiftId ?? null,
      handoverId: input.handoverId ?? null,
      resolutionId: input.resolutionId ?? null,
      legacyRecoveryId: input.legacyRecoveryId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorKind: input.actorKind,
      authMethod: input.authMethod ?? null,
      epochBefore: input.epochBefore ?? null,
      epochAfter: input.epochAfter ?? null,
      payloadJson: input.payload == null ? null : JSON.stringify(input.payload),
      operationalDay: toJalaliDate(new Date())
    }
  })
}

async function credentialOf(client: Client, userId: number) {
  return client.custodyCredential.findFirst({ where: { userId, purpose: PURPOSE } })
}

async function ensureState(client: Client) {
  await client.custodyState.upsert({
    where: { key: MAIN },
    update: {},
    create: { key: MAIN, state: 'NO_SESSION', epoch: 0 }
  })
  const state = await client.custodyState.findUnique({ where: { key: MAIN } })
  if (!state) throw new BusinessError('وضعیت صندوق قابل تعیین نیست. از مدیر بخواهید وضعیت را بررسی کند.', 'CUSTODY_NOT_INITIALIZED')
  return state
}

type BlueScopeKind = 'TODAY' | 'PRIOR_AND_TODAY'

/** No top-N shortcut can decide that there was no earlier REAL count today.
 * An opening, final close or completed IN can be the first daily observation.
 * An aborted handover or SYSTEM absence can NEVER end the morning scope. */
async function hasRealCountToday(today: string) {
  const [boundary, oldOpening] = await Promise.all([
    prisma.custodyBlueSnapshot.findFirst({
      where: { operationalDay: today, role: { in: ['OPENING', 'FINAL_CLOSE', 'RECOVERY'] },
        countOrigin: { in: ['EXPLICIT_AMOUNT', 'EXPLICIT_ZERO'] } }, select: { id: true }
    }),
    prisma.custodyCount.findFirst({ where: { operationalDay: today, kind: 'OPENING' }, select: { id: true } })
  ])
  if (boundary || oldOpening) return true
  const pageSize = 400
  for (let skip = 0; ; skip += pageSize) {
    const snapshots = await prisma.custodyBlueSnapshot.findMany({
      where: { operationalDay: today, role: 'IN' }, orderBy: { id: 'desc' },
      select: { handoverId: true }, skip, take: pageSize
    })
    const ids = snapshots.map((row: any) => row.handoverId).filter((id: any): id is number => id != null)
    if (ids.length && await prisma.custodyHandover.findFirst({ where: { id: { in: ids }, status: 'COMPLETED' }, select: { id: true } })) return true
    if (snapshots.length < pageSize) return false
  }
}

/** A blank optional opening creates an ACTUAL new Shift but not a real count.
 * When its day is already today, look back to the previous actual Shift—not a
 * roster slot—to choose the first observed sales scope. Without this, a blank
 * morning opening would silently discard yesterday from the first count. */
async function firstRealScopeOrigin(today: string, currentDay: string): Promise<string> {
  if (currentDay !== today) return currentDay
  const preceding = await prisma.custodyShiftMeta.findFirst({
    where: { operationalDay: { lt: today } }, orderBy: { shiftId: 'desc' },
    select: { operationalDay: true }
  })
  return String(preceding?.operationalDay ?? currentDay)
}

/** Scope is chosen by Main from the actual segment and prior ACCEPTED counts,
 * never a UI shift selector. Reads are optimistic; a financial write during
 * the full report makes this attempt stale rather than inventing a reference. */
async function blueReferenceForActiveShift(meta: any, state: any) {
  const now = new Date()
  const today = toJalaliDate(now)
  const previousDay = toJalaliDate(new Date(jalaliStartOfDay(today).getTime() - 1))
  const originDay = String(meta.operationalDay ?? '')
  const firstReal = !(await hasRealCountToday(today))
  const scopeOrigin = firstReal ? await firstRealScopeOrigin(today, originDay) : originDay
  const firstMorning = firstReal && scopeOrigin < today
  const fromDay = firstMorning ? previousDay : today
  const scopeKind: BlueScopeKind = firstMorning ? 'PRIOR_AND_TODAY' : 'TODAY'
  const initialRev = Number(state.financialRevision ?? 0)
  const reference = !isValidJalaliDate(originDay) || originDay > today ||
      (firstMorning && (!isValidJalaliDate(scopeOrigin) || scopeOrigin < previousDay))
    ? pendingCustodyReference('چند روز بدون مرز شمارش واقعی سپری شده است؛ مرجع قطعی بدون بررسی همهٔ روزهای جاافتاده صادر نمی‌شود.')
    : await (await import('./CustodyReferenceService')).officialReferenceForDays({
        operationalDay: today,
        previousDayForFirstMorning: firstMorning ? previousDay : null
      })
  const after = await ensureState(prisma)
  if (after.activeShiftId !== state.activeShiftId || after.epoch !== state.epoch ||
      Number(after.financialRevision ?? 0) !== initialRev || toJalaliDate(new Date()) !== today)
    throw new BusinessError('در حین خواندن مرجع، فروش یا مرز روز تغییر کرد؛ با شمارش تازه دوباره تلاش کنید.', 'CUSTODY_STALE')
  return { reference, fromDay, today, scopeKind, financialRevision: initialRev }
}

/** A real opening count is itself a blue observation, including after a long
 * offline interval. Prior-day money belongs to the FIRST count only; once a
 * human counted today, later handovers see just today's sales. The last actual
 * Shift—not unmaterialized shifts on a roster—decides outage provenance. */
async function blueReferenceForOpening(state: any) {
  const today = toJalaliDate(new Date())
  const previousDay = toJalaliDate(new Date(jalaliStartOfDay(today).getTime() - 1))
  const lastActual = await prisma.custodyShiftMeta.findFirst({ orderBy: { shiftId: 'desc' }, select: { operationalDay: true } })
  const originDay = String(lastActual?.operationalDay ?? '')
  const firstReal = !!lastActual && !(await hasRealCountToday(today))
  const scopeOrigin = firstReal ? await firstRealScopeOrigin(today, originDay) : originDay
  const firstMorning = firstReal && scopeOrigin < today
  const fromDay = firstMorning ? previousDay : today
  const scopeKind: BlueScopeKind = firstMorning ? 'PRIOR_AND_TODAY' : 'TODAY'
  const initialRev = Number(state.financialRevision ?? 0)
  const reference = firstReal && (!isValidJalaliDate(originDay) || originDay > today ||
      (firstMorning && (!isValidJalaliDate(scopeOrigin) || scopeOrigin < previousDay)))
    ? pendingCustodyReference('چند روز بدون شمارش واقعی سپری شده است؛ مرجع قطعی برای روزهای جاافتاده صادر نمی‌شود.')
    : await (await import('./CustodyReferenceService')).officialReferenceForDays({
        operationalDay: today, previousDayForFirstMorning: firstMorning ? previousDay : null
      })
  const after = await ensureState(prisma)
  if (after.state !== state.state || after.activeShiftId !== state.activeShiftId ||
      after.epoch !== state.epoch || Number(after.financialRevision ?? 0) !== initialRev ||
      toJalaliDate(new Date()) !== today)
    throw new BusinessError('هنگام خواندن مرجع افتتاح، فروش یا روز تغییر کرد؛ با شمارش تازه تلاش کنید.', 'CUSTODY_STALE')
  return { reference, fromDay, today, scopeKind, financialRevision: initialRev }
}

async function acceptedBlueBaselineForShift(tx: Client, shiftId: number) {
  const [opening, incomingHandover] = await Promise.all([
    tx.custodyBlueSnapshot.findFirst({ where: { shiftId, role: 'OPENING' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] }),
    tx.custodyHandover.findFirst({ where: { toShiftId: shiftId, status: 'COMPLETED' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] })
  ])
  const incoming = incomingHandover ? await tx.custodyBlueSnapshot.findFirst({ where: { handoverId: incomingHandover.id, role: 'IN' } }) : null
  if (!incoming) return opening
  if (!opening) return incoming
  return new Date(incoming.at).getTime() >= new Date(opening.at).getTime() ? incoming : opening
}

/** An absent giver cannot enter a PIN or attest a zero. The cover/manager
 * supplies ONE real count and personal PIN; the outgoing side is SYSTEM
 * absence evidence only. Re-read the complete blue reference optimistically,
 * then commit count + old Shift close + new owner inside ONE short writer
 * transaction. No persisted freeze or guessed inherited shortage blocks sales.
 * A prior unfinished handover is preserved as superseded, never reused. */
async function commitBlueEmergency(input: {
  receiver: { userId: number; role: string }
  count: number
  reason: string
  managerOverride: boolean
}) {
  await custodyService.ensureRolledOver()
  const state = await ensureState(prisma)
  if (!['ACTIVE', 'HANDOVER_PENDING', 'HANDOVER_RECOUNT'].includes(state.state) || !state.activeShiftId)
    throw new BusinessError('برای پوشش غیبت، صندوق باید مسئول ثبت‌شدهٔ فعال داشته باشد؛ پس از پایان روز با شمارش خودتان افتتاح کنید.', 'NO_ACTIVE_CUSTODY')
  if (state.state === 'HANDOVER_RECOUNT' && !state.pendingHandoverId)
    throw new BusinessError('سند تحویل ناتمام پیدا نشد؛ مدیر باید وضعیت صندوق را بازبینی کند.', 'CUSTODY_INVARIANT_BROKEN')
  const fromMeta = await prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })
  if (!fromMeta) throw new BusinessError('سند مسئولیت فعلی ناقص است.', 'CUSTODY_INVARIANT_BROKEN')
  if (fromMeta.custodianUserId === input.receiver.userId)
    throw new BusinessError('برای شخصی که خودش مسئول صندوق است از خودتحویلی با دو شمارش استفاده کنید.', 'EMERGENCY_SAME_CUSTODIAN')
  const blue = await blueReferenceForActiveShift(fromMeta, state)
  return prisma.$transaction(async (tx: Client) => {
    const live = await ensureState(tx)
    if (live.state !== state.state || live.activeShiftId !== state.activeShiftId ||
        live.pendingHandoverId !== state.pendingHandoverId || live.epoch !== state.epoch ||
        Number(live.financialRevision ?? 0) !== blue.financialRevision || toJalaliDate(new Date()) !== blue.today)
      throw new BusinessError('حین خواندن مرجع فروش/مالک تغییر کرد؛ با مبلغ واقعی و PIN تازه تلاش کنید.', 'CUSTODY_STALE')
    const locked = await tx.custodyState.updateMany({
      where: { key: MAIN, state: state.state, activeShiftId: state.activeShiftId,
        pendingHandoverId: state.pendingHandoverId, epoch: state.epoch, financialRevision: blue.financialRevision },
      data: { updatedAt: new Date() }
    })
    if (locked.count !== 1) throw new BusinessError('حین ثبت غیبت فروش یا مالک تغییر کرد؛ دوباره شمارش کنید.', 'CUSTODY_STALE')
    const [fromShift, sourceMeta, cfg, scheduling] = await Promise.all([
      tx.shift.findUnique({ where: { id: state.activeShiftId } }),
      tx.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } }),
      configOf(tx), shiftSchedulingOf(tx)
    ])
    if (!fromShift || fromShift.closedAt || fromShift.userId !== sourceMeta?.custodianUserId ||
        !sourceMeta || sourceMeta.custodianUserId === input.receiver.userId)
      throw new BusinessError('مسئول فعلی صندوق با سند مالی سازگار نیست.', 'CUSTODY_INVARIANT_BROKEN')
    let supersededId: number | null = null
    let priorHandoverStatus: string | null = null
    let priorResolutionKind: string | null = null
    if (live.state === 'HANDOVER_PENDING' || live.state === 'HANDOVER_RECOUNT') {
      if (!live.pendingHandoverId) throw new BusinessError('تحویل ناتمام پیدا نشد.', 'CUSTODY_INVARIANT_BROKEN')
      const previous = await tx.custodyHandover.findUnique({ where: { id: live.pendingHandoverId } })
      const allowed = live.state === 'HANDOVER_PENDING' ? ['PENDING', 'RECEIVER_COUNTED']
        : ['PENDING', 'RECEIVER_COUNTED', 'EMERGENCY_RECOUNT', 'MASTER_OVERRIDE_RECOUNT']
      if (!previous || !allowed.includes(previous.status) || previous.fromShiftId !== fromShift.id || previous.fromUserId !== fromShift.userId)
        throw new BusinessError('تحویل ناتمام ناسازگار است؛ مدیر باید بازیابی حالت را انجام دهد.', 'CUSTODY_INVARIANT_BROKEN')
      supersededId = previous.id
      priorHandoverStatus = previous.status
      priorResolutionKind = previous.resolutionKind ?? null
      // The old count(s), reason and original kind stay on the historical
      // attempt. Only its mutable workflow status is retired; the new worker
      // attests a DIFFERENT count and a system-absence OUT snapshot below.
      await tx.custodyHandover.update({ where: { id: previous.id }, data: {
        status: 'SUPERSEDED_EMERGENCY', resolutionKind: previous.resolutionKind ?? 'SUPERSEDED_BY_REAL_COVER',
        finishedAt: new Date(), version: { increment: 1 }
      } })
    }
    const nextEpoch = Number(live.epoch) + 1
    const master = input.managerOverride
    const authMethod = master ? 'MANAGER_CUSTODY_PIN' : 'CUSTODY_PIN'
    // Establish the responsibility boundary before recording the arriving
    // worker's count. Everything below is ONE SQLite transaction: on failure
    // the old Shift stays open, and no sale/owner/count is partly reassigned.
    const closed = await shiftService.closeInTx(tx, { shiftId: fromShift.id, userId: fromShift.userId,
      note: master ? 'پوشش غیبت با PIN شخصی مدیر؛ خروج قبلی بدون شمارش' : 'پوشش غیبت؛ خروج قبلی بدون شمارش' })
    const sourceTemplate = sourceMeta.templateId ? scheduling.templates.find((row: ShiftTemplate) => row.id === sourceMeta.templateId) ?? null : null
    const plan = planFromSegmentSnapshot(sourceMeta, sourceTemplate)
    const immutableScheduleSnapshot = sourceMeta.scheduleSnapshotJson ?? scheduleSnapshotJson(plan, scheduling, cfg)
    const key = `blue-cover:${fromShift.id}:${state.epoch}:${input.receiver.userId}`
    const next = await shiftService.createSession(tx, {
      staffId: input.receiver.userId, staffConfirmed: true, actorId: input.receiver.userId,
      mode: master ? 'MASTER_OVERRIDE' : 'EMERGENCY_COVER',
      openIdempotencyKey: key, openIdempotencyFingerprint: `custody-${key}`,
      note: master ? 'Master Override با PIN شخصی و شمارش آغاز مسئولیت خود' : 'پوشش غیبت با شمارش آغاز مسئولیت خود'
    })
    const count = await tx.custodyCount.create({ data: {
      shiftId: next.id, kind: master ? 'BLUE_MASTER_OVERRIDE_IN' : 'BLUE_EMERGENCY_IN',
      countedCash: BigInt(input.count), expectedCash: null, differenceCash: null,
      countedByUserId: input.receiver.userId, authMethod, note: input.reason,
      epochAtCount: nextEpoch, operationalDay: blue.today, idempotencyKey: key
    } })
    /** outCountId and the numeric fields are required CASH-ERA bridge columns.
     * They are never presented as an outgoing count for an absence. The ID
     * points to the receiver's OWN count on the NEW Shift, not the old one;
     * the true absent OUT is null-valued in the immutable blue snapshot. */
    const handover = await tx.custodyHandover.create({ data: {
      fromShiftId: fromShift.id, fromUserId: fromShift.userId,
      selectedRecipientUserId: input.receiver.userId,
      managerApproverUserId: master ? input.receiver.userId : null,
      status: 'PENDING', outCountId: count.id,
      expectedAtStart: BigInt(0), countedAtStart: BigInt(input.count), differenceCash: BigInt(0),
      ledgerWatermark: JSON.stringify({ blueV1: true, emergency: true, masterOverride: master,
        outCountOrigin: 'ABSENT_UNCOUNTED', outgoingHumanCount: null, outCountIdIsReceiverWitness: true,
        receiverCountId: count.id, receiverShiftId: next.id, supersededHandoverId: supersededId, reason: input.reason }),
      fenceEpochAtStart: nextEpoch, idempotencyKey: key,
      stateKey: MAIN, operationalDay: blue.today, resolutionReason: input.reason
    } })
    const prior = await acceptedBlueBaselineForShift(tx, fromShift.id)
    const out = await recordBlueSnapshot(tx, {
      handoverId: handover.id, shiftId: fromShift.id, role: 'OUT',
      // The physical counter is ABSENT. This non-null cash-era actor field
      // identifies who requested the system absence boundary, not a counter.
      // Manager views explicitly project its witness as SYSTEM, never this id.
      actorUserId: input.receiver.userId, authMethod: 'SYSTEM_ABSENCE',
      count: absenceUncounted(), reference: blue.reference,
      referenceFromDay: blue.fromDay, referenceToDay: blue.today,
      scopeKind: blue.scopeKind, financialRevision: blue.financialRevision,
      epochAtCount: nextEpoch, prior, idempotencyKey: `blue-absence:${handover.id}`
    })
    const incoming = await recordBlueSnapshot(tx, {
      handoverId: handover.id, shiftId: next.id, role: 'IN',
      actorUserId: input.receiver.userId, authMethod,
      count: observationOf(input.count, false), reference: blue.reference,
      referenceFromDay: blue.fromDay, referenceToDay: blue.today,
      scopeKind: blue.scopeKind, financialRevision: blue.financialRevision,
      epochAtCount: nextEpoch, prior: out, idempotencyKey: `blue-cover-in:${handover.id}`
    })
    await writeEvent(tx, {
      type: 'BLUE_OUTGOING_UNCOUNTED_ABSENT', shiftId: fromShift.id,
      handoverId: handover.id, actorUserId: null,
      actorKind: 'SYSTEM', authMethod: 'SYSTEM_ABSENCE',
      epochBefore: state.epoch, epochAfter: nextEpoch,
      payload: { absentCustodianUserId: fromShift.userId, initiatedByUserId: input.receiver.userId,
        outgoingHumanCount: null, outgoingSnapshotId: out.id, incomingShiftId: next.id, reason: input.reason }
    })
    await tx.custodyShiftMeta.update({ where: { shiftId: fromShift.id }, data: {
      endKind: master ? 'BLUE_MASTER_OVERRIDE' : 'BLUE_EMERGENCY_COVER', endedAt: closed.closedAt
    } })
    await tx.custodyShiftMeta.create({ data: {
      shiftId: next.id, custodianUserId: input.receiver.userId,
      openAuth: master ? 'BLUE_MASTER_OVERRIDE_MANAGER_PIN' : 'BLUE_EMERGENCY_COVER_PIN',
      templateId: plan?.templateId ?? null, planId: plan?.legacyPlanId ?? null,
      planTitle: plan?.title ?? null, scheduledEndAt: plan?.scheduledEndAt ?? null,
      scheduleSnapshotJson: immutableScheduleSnapshot,
      rolloverAt: rolloverAtForSnapshot(new Date(), cfg, scheduling, plan, immutableScheduleSnapshot),
      dayCutoverSnapshot: cfg.dayCutoverMinute, operationalDay: blue.today,
      countStatus: 'COUNTED', openEpoch: nextEpoch
    } })
    await tx.custodyHandover.update({ where: { id: handover.id }, data: {
      status: 'COMPLETED', finalCustodianUserId: input.receiver.userId,
      acceptedByUserId: input.receiver.userId,
      resolutionKind: master ? 'BLUE_MASTER_OVERRIDE' : 'BLUE_EMERGENCY_COVER',
      toShiftId: next.id, finishedAt: new Date(), version: { increment: 1 }
    } })
    const switched = await tx.custodyState.updateMany({
      where: { key: MAIN, state: state.state, activeShiftId: fromShift.id,
        pendingHandoverId: state.pendingHandoverId, epoch: state.epoch,
        financialRevision: blue.financialRevision },
      data: { state: 'ACTIVE', activeShiftId: next.id, pendingHandoverId: null,
        epoch: nextEpoch, updatedAt: new Date() }
    })
    if (switched.count !== 1) throw new BusinessError('فروش هم‌زمان تغییر کرد؛ عملیات نیازمند شمارش تازه است.', 'CUSTODY_STALE')
    if (supersededId) await writeEvent(tx, {
      type: 'BLUE_HANDOVER_SUPERSEDED_EMERGENCY', shiftId: fromShift.id,
      handoverId: supersededId, actorUserId: input.receiver.userId,
      actorKind: master ? 'MASTER_OVERRIDE_MANAGER' : 'EMERGENCY_COVER', authMethod,
      epochBefore: state.epoch, epochAfter: nextEpoch,
      payload: { replacementHandoverId: handover.id, priorCountsNotReused: true,
        previousState: state.state, priorHandoverStatus, priorResolutionKind }
    })
    await writeEvent(tx, {
      type: master ? 'BLUE_MASTER_OVERRIDE_COMMITTED' : 'BLUE_EMERGENCY_COVER_COMMITTED',
      shiftId: next.id, handoverId: handover.id, actorUserId: input.receiver.userId,
      actorKind: master ? 'MASTER_OVERRIDE_MANAGER' : 'EMERGENCY_COVER', authMethod,
      epochBefore: state.epoch, epochAfter: nextEpoch,
      payload: { fromShiftId: fromShift.id, toShiftId: next.id, priorCustodianUserId: fromShift.userId,
        outSnapshotId: out.id, inSnapshotId: incoming.id, countOrigin: 'ABSENT_UNCOUNTED',
        rawDifference: incoming.rawDifference == null ? null : String(incoming.rawDifference),
        freshDifference: null, reason: input.reason, automaticBlame: false }
    })
    return { handoverId: handover.id, shiftId: next.id, state: 'ACTIVE',
      referenceStatus: incoming.referenceStatus,
      referenceAmount: incoming.referenceAmount == null ? null : Number(incoming.referenceAmount),
      rawDifference: incoming.rawDifference == null ? null : Number(incoming.rawDifference),
      freshDifference: null }
  })
}

/** One final real count against the same blue daily reference; no persistent
 * freeze, cash withdrawal, auto-blame case or fabricated cash-only movement.
 * A sale during report reading invalidates this attempt instead of blocking
 * the sale. Closing the actual Shift and its count is atomic. */
async function commitBlueFinalClose(input: {
  shiftId: number
  actorUserId: number
  count: number
  note?: string
}) {
  await custodyService.ensureRolledOver()
  const state = await ensureState(prisma)
  if (state.state !== 'ACTIVE' || state.activeShiftId !== input.shiftId)
    throw new BusinessError('صندوق دیگر زیر مسئولیت این شخص باز نیست؛ دوباره وضعیت را بررسی کنید.', 'CUSTODY_STALE')
  const meta = await prisma.custodyShiftMeta.findUnique({ where: { shiftId: input.shiftId } })
  if (!meta || meta.custodianUserId !== input.actorUserId)
    throw new BusinessError('سند مسئول فعلی صندوق ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
  const blue = await blueReferenceForActiveShift(meta, state)
  return prisma.$transaction(async (tx: Client) => {
    const live = await ensureState(tx)
    if (live.state !== 'ACTIVE' || live.activeShiftId !== input.shiftId || live.epoch !== state.epoch ||
        Number(live.financialRevision ?? 0) !== blue.financialRevision || toJalaliDate(new Date()) !== blue.today)
      throw new BusinessError('در زمان شمارش نهایی فروش یا مرز روز تغییر کرد؛ دوباره شمارش کنید.', 'CUSTODY_STALE')
    const locked = await tx.custodyState.updateMany({
      where: { key: MAIN, state: 'ACTIVE', activeShiftId: input.shiftId, pendingHandoverId: null,
        epoch: state.epoch, financialRevision: blue.financialRevision },
      data: { updatedAt: new Date() }
    })
    if (locked.count !== 1) throw new BusinessError('فروش هم‌زمان ثبت شد؛ شمارش تازه لازم است.', 'CUSTODY_STALE')
    const shift = await tx.shift.findUnique({ where: { id: input.shiftId } })
    const sourceMeta = await tx.custodyShiftMeta.findUnique({ where: { shiftId: input.shiftId } })
    if (!shift || shift.closedAt || shift.userId !== input.actorUserId || sourceMeta?.custodianUserId !== input.actorUserId)
      throw new BusinessError('مسئولیت صندوق با نشست واقعی سازگار نیست.', 'CUSTODY_INVARIANT_BROKEN')
    const nextEpoch = Number(live.epoch) + 1
    const count = await tx.custodyCount.create({ data: {
      shiftId: input.shiftId, kind: 'BLUE_FINAL_CLOSE', countedCash: BigInt(input.count),
      expectedCash: null, differenceCash: null, countedByUserId: input.actorUserId,
      authMethod: 'CUSTODY_PIN', note: input.note ?? null, epochAtCount: nextEpoch,
      idempotencyKey: `blue-final:${input.shiftId}:${live.epoch}`,
      operationalDay: blue.today
    } })
    const prior = await acceptedBlueBaselineForShift(tx, input.shiftId)
    const snapshot = await recordBlueSnapshot(tx, {
      shiftId: input.shiftId, role: 'FINAL_CLOSE', actorUserId: input.actorUserId,
      count: observationOf(input.count, false), reference: blue.reference,
      referenceFromDay: blue.fromDay, referenceToDay: blue.today,
      scopeKind: blue.scopeKind, financialRevision: blue.financialRevision,
      epochAtCount: nextEpoch, prior,
      idempotencyKey: `blue-final-snapshot:${input.shiftId}:${live.epoch}`
    })
    const closed = await shiftService.closeInTx(tx, {
      shiftId: input.shiftId, userId: input.actorUserId,
      note: input.note || 'بستن نهایی با شمارش واقعی کشو و کارت‌خوان'
    })
    await tx.custodyShiftMeta.update({ where: { shiftId: input.shiftId }, data: {
      endKind: 'BLUE_FINAL_CLOSE', endedAt: closed.closedAt, countStatus: 'COUNTED'
    } })
    const ended = await tx.custodyState.updateMany({
      where: { key: MAIN, state: 'ACTIVE', activeShiftId: input.shiftId, pendingHandoverId: null,
        epoch: state.epoch, financialRevision: blue.financialRevision },
      data: { state: 'NO_SESSION', activeShiftId: null, pendingHandoverId: null,
        epoch: nextEpoch, updatedAt: new Date() }
    })
    if (ended.count !== 1) throw new BusinessError('حین ثبت نهایی وضعیت مالی تغییر کرد؛ عملیات ثبت نشد.', 'CUSTODY_STALE')
    await writeEvent(tx, {
      type: 'BLUE_FINAL_CLOSE_COMMITTED', shiftId: input.shiftId,
      actorUserId: input.actorUserId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN',
      epochBefore: live.epoch, epochAfter: nextEpoch,
      payload: { countId: count.id, snapshotId: snapshot.id, priorSnapshotId: prior?.id ?? null,
        referenceStatus: snapshot.referenceStatus,
        rawDifference: snapshot.rawDifference == null ? null : String(snapshot.rawDifference),
        freshDifference: snapshot.freshDifference == null ? null : String(snapshot.freshDifference),
        automaticBlame: false, managerCashWithdrawal: false }
    })
    return { shiftId: input.shiftId, state: 'NO_SESSION', referenceStatus: snapshot.referenceStatus }
  })
}

async function pinGateOpen(userId: number) {
  const gate = `custody-pin:${userId}`
  const row = await prisma.authLockout.findUnique({ where: { gate } })
  if (row?.lockedUntil && new Date(row.lockedUntil) > new Date())
    throw new BusinessError('رمز شخصی به‌دلیل تلاش‌های ناموفق موقتاً قفل شده است. چند دقیقه دیگر دوباره تلاش کنید.', 'PIN_LOCKED')
}

async function pinFailure(userId: number): Promise<never> {
  const gate = `custody-pin:${userId}`
  const previous = await prisma.authLockout.findUnique({ where: { gate } })
  const failures = Number(previous?.failCount ?? 0) + 1
  const locked = failures >= PIN_ATTEMPTS
  await prisma.authLockout.upsert({
    where: { gate },
    update: {
      failCount: locked ? 0 : failures,
      lastFailAt: new Date(),
      lockedUntil: locked ? new Date(Date.now() + PIN_LOCK_MS) : null,
      lockCount: locked ? Number(previous?.lockCount ?? 0) + 1 : Number(previous?.lockCount ?? 0)
    },
    create: {
      gate,
      failCount: locked ? 0 : failures,
      lastFailAt: new Date(),
      lockedUntil: locked ? new Date(Date.now() + PIN_LOCK_MS) : null,
      lockCount: locked ? 1 : 0
    }
  })
  throw new BusinessError(locked ? 'رمز شخصی چند بار اشتباه وارد شد و ۱۵ دقیقه قفل شد.' : 'رمز شخصی درست نیست.', locked ? 'PIN_LOCKED' : 'PIN_WRONG')
}

async function pinSuccess(userId: number) {
  const gate = `custody-pin:${userId}`
  await prisma.authLockout.updateMany({ where: { gate }, data: { failCount: 0, lockedUntil: null } })
}

type CustodyAuditExportCell = string | number | null

/** Report values can contain bigint. Export them as decimal text, not Number,
 * so a custody audit file cannot silently lose rial precision. */
function custodyAuditExportAmount(value: number | bigint | null | undefined): string | null {
  return value == null ? null : typeof value === 'bigint' ? value.toString() : String(value)
}

function custodyAuditExportTime(value: unknown): string | null {
  if (value == null || value === '') return null
  const date = new Date(value as any)
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value)
}

function custodyAuditExportRows(report: any): CustodyAuditExportCell[][] {
  const rows: CustodyAuditExportCell[][] = [[
    'دامنهٔ شواهد اپراتور', null, null, null, null, null, null, 'فقط سند مستقل ثبت‌شده',
    'اپراتور فاکتورهای قدیمی فاقد سند مستقل قابل اثبات نیست؛ مسئول مالی فاکتور یا کشو، اپراتور POS فرض نمی‌شود. نبود ردیف در این صفحه به معنی نبود فروش نیست.'
  ]]
  for (const row of report.segments ?? []) rows.push([
    'بخش حضانت', custodyAuditExportTime(row.startedAt), `نشست ${row.shiftId}`, row.custodianName ?? '—', null, null, null,
    row.endKind ?? 'باز', `برنامهٔ snapshot: ${row.scheduleTitleSnapshot ?? 'بدون برنامه'}${row.endedAt ? ` · پایان: ${custodyAuditExportTime(row.endedAt)}` : ''}`
  ])
  for (const event of report.events ?? []) {
    if (event.type !== 'OPEN_UNSCHEDULED' && event.type !== 'LEGACY_RECOVERY_UNSCHEDULED') continue
    rows.push([
      event.type === 'OPEN_UNSCHEDULED' ? 'افتتاح خارج از برنامه' : 'شاهد بازیابی خارج از برنامه',
      custodyAuditExportTime(event.at),
      event.shiftId ? `نشست ${event.shiftId}` : `بازیابی ${event.legacyRecoveryId ?? '—'}`,
      event.actorName ?? `کارمند ${event.actorUserId ?? '—'}`,
      null, null, null, 'PIN شخصی · مسئولیت قبلی منتقل نشد',
      `دلیل: ${event.payload?.reason ?? 'نامعلوم'} · حالت ${event.payload?.mode ?? 'نامعلوم'} · مانع برنامه ${event.payload?.blockedBy ?? 'نامعلوم'} · شمارش ${event.payload?.countKind ?? 'نامعلوم'}`
    ])
  }
  for (const row of report.handovers ?? []) {
    const owner = `${row.fromUser ?? '—'} → ${row.finalCustodian ?? row.selectedRecipient ?? '—'}`
    const shift = `نشست ${row.fromShiftId}${row.toShiftId ? ` → ${row.toShiftId}` : ''}`
    const outgoingAbsent = row.blue?.outgoing && isAbsentUncounted(row.blue.outgoing.countOrigin)
    rows.push([
      row.blue ? outgoingAbsent ? 'پوشش غیبت؛ خروج بدون شمارش' : 'تحویل آبی' : 'تحویل',
      custodyAuditExportTime(row.startedAt), shift, owner,
      custodyAuditExportAmount(row.countedAtStart), custodyAuditExportAmount(row.expectedAtStart),
      custodyAuditExportAmount(row.differenceCash), row.status ?? null,
      row.unbasedAdoption
        ? `${row.resolutionKind ?? 'تحویل'} · مبنای قبلی نامعلوم؛ شمارش گیرنده مبنای تازه است و اختلاف قابل استنتاج نیست`
        : row.resolutionKind ?? null
    ])
    if (row.blue) {
      const blue = row.blue
      /** OUT and IN are separate, immutable witnesses. An absent person's OUT
       * has SYSTEM provenance, no human amount and NO absent person's PIN. The
       * IN row remains the decision anchor and always retains its original
       * null reference even after a later append-only manager resolution. */
      const outgoing = blue.outgoing
      if (outgoing && blue.incoming) rows.push([
        outgoingAbsent ? 'غیبت تحویل‌دهنده؛ شمارش خروجی انجام نشده' : 'شمارش مستقل تحویل‌دهندهٔ آبی',
        custodyAuditExportTime(outgoing.at), `تحویل ${row.id} / سند ${outgoing.id}`,
        outgoingAbsent ? `سیستم؛ غیبت ${row.fromUser ?? 'مسئول قبلی'}` : row.fromUser ?? '—',
        custodyAuditExportAmount(outgoing.humanAmount), custodyAuditExportAmount(outgoing.referenceAmount),
        custodyAuditExportAmount(outgoing.rawDifference), outgoing.referenceStatus,
        outgoingAbsent
          ? 'غایب؛ مبلغ شمارش خروجی نامعلوم · بدون PIN فرد غایب · شمارش نفر حاضر فقط متعلق به نشست خودش است؛ اختلاف تازه منتسب نمی‌شود'
          : `منشأ ${outgoing.countOrigin} · احراز ${outgoing.authMethod ?? 'نامعلوم'} · اختلاف تازه ${custodyAuditExportAmount(outgoing.freshDifference) ?? 'نامعلوم'}`
      ])
      rows.push([
        'شمارش و مرجع آبی اولیه', custodyAuditExportTime(blue.snapshotAt), `تحویل ${row.id} / سند ${blue.snapshotId ?? '—'}`,
        owner, custodyAuditExportAmount(blue.countedAmount), custodyAuditExportAmount(blue.originalReferenceAmount),
        custodyAuditExportAmount(blue.originalRawDifference),
        blue.originalReferenceAmount == null ? 'PENDING_RECONCILIATION' : 'AVAILABLE',
        `بازه ${blue.referenceFromDay ?? '—'} تا ${blue.referenceToDay ?? '—'} · نسخه ${blue.calculationVersion ?? 'نامعلوم'} · منشأ ${blue.countOrigin ?? 'نامعلوم'} · احراز ${blue.initialAuthMethod ?? 'نامعلوم'} · بخش معلوم ${custodyAuditExportAmount(blue.knownSubtotal) ?? 'نامعلوم'} · مقصد نامشخص ${blue.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? 'در نسخهٔ قدیمی ثبت نمی‌شد' : custodyAuditExportAmount(blue.destinationUnknownReceived) ?? 'نامعلوم'} · پرداخت مبهم ${custodyAuditExportAmount(blue.ambiguousLegacyCredit) ?? 'نامعلوم'} · اختلاف تازه ${custodyAuditExportAmount(blue.originalFreshDifference) ?? 'نامعلوم'}`
      ])
      if (blue.decision) rows.push([
        'تصمیم افزایشی مرجع آبی', custodyAuditExportTime(blue.decision.at), `تحویل ${row.id} / سند ${blue.incomingSnapshotId ?? '—'}`,
        blue.decision.managerName ?? `مدیر ${blue.decision.managerUserId}`,
        null, custodyAuditExportAmount(blue.referenceAmount), custodyAuditExportAmount(blue.rawDifference),
        'RESOLVED', `${blue.decision.kind} · سند ${blue.decision.evidenceReference} · روز ${blue.decision.evidenceDay}${blue.decision.destinationKind ? ` · مقصد نامشخص ${blue.decision.destinationKind} · سند ${blue.decision.destinationEvidenceReference} · روز ${blue.decision.destinationEvidenceDay}` : ''} · اختلاف تازه ${custodyAuditExportAmount(blue.freshDifference) ?? 'نامعلوم'} · ${blue.decision.reason}`
      ])
    }
  }
  for (const row of report.blueBoundaries ?? []) {
    rows.push([
      row.role === 'FINAL_CLOSE' ? 'بستن نهایی و مرجع آبی اولیه' : row.role === 'OPENING' ? 'افتتاح و مرجع آبی اولیه' : 'بازیابی و مرجع آبی اولیه',
      custodyAuditExportTime(row.at), `نشست ${row.shiftId} / سند ${row.snapshotId}`,
      row.actorName ?? `کارمند ${row.actorUserId}`,
      custodyAuditExportAmount(row.countedAmount), custodyAuditExportAmount(row.originalReferenceAmount),
      custodyAuditExportAmount(row.originalRawDifference), row.originalReferenceStatus,
      `بازه ${row.referenceFromDay} تا ${row.referenceToDay} · نسخه ${row.calculationVersion} · منشأ ${row.countOrigin} · احراز ${row.authMethod} · بخش معلوم ${custodyAuditExportAmount(row.knownSubtotal) ?? 'نامعلوم'} · مقصد نامشخص ${row.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? 'در نسخهٔ قدیمی ثبت نمی‌شد' : custodyAuditExportAmount(row.destinationUnknownReceived) ?? 'نامعلوم'} · پرداخت مبهم ${custodyAuditExportAmount(row.ambiguousLegacyCredit) ?? 'نامعلوم'} · اختلاف تازه ${custodyAuditExportAmount(row.originalFreshDifference) ?? 'نامعلوم'}`
    ])
    if (row.decision) rows.push([
      'تصمیم افزایشی مرز آبی', custodyAuditExportTime(row.decision.at),
      `نشست ${row.shiftId} / سند ${row.snapshotId}`,
      row.decision.managerName ?? `مدیر ${row.decision.managerUserId}`,
      null, custodyAuditExportAmount(row.referenceAmount), custodyAuditExportAmount(row.rawDifference),
      'RESOLVED', `${row.decision.kind} · سند ${row.decision.evidenceReference} · روز ${row.decision.evidenceDay}${row.decision.destinationKind ? ` · مقصد نامشخص ${row.decision.destinationKind} · سند ${row.decision.destinationEvidenceReference} · روز ${row.decision.destinationEvidenceDay}` : ''} · اختلاف تازه ${custodyAuditExportAmount(row.freshDifference) ?? 'نامعلوم'} · ${row.decision.reason}`
    ])
  }
  for (const row of report.saleOperators ?? []) rows.push([
    'عملیات POS', custodyAuditExportTime(row.at), `نشست ${row.custodyShiftId}`, `${row.operatorName ?? (row.operatorKind === 'MANAGER_SESSION' ? 'نشست مدیر، بدون انتساب شخصی' : '—')} · مسئول کشو: ${row.custodianName ?? '—'}`, null, null, null,
    row.operatorKind ?? null, `${row.receiptNo == null ? `فاکتور ${row.invoiceId}` : `فیش ${row.receiptNo}`} · ${row.authMethod ?? 'روش ثبت‌شده'}`
  ])
  for (const row of report.counts ?? []) {
    const arrivingCount = row.kind === 'BLUE_EMERGENCY_IN' || row.kind === 'BLUE_MASTER_OVERRIDE_IN'
    rows.push([
      arrivingCount ? 'شمارش آغاز مسئولیت فرد حاضر؛ پوشش غیبت' : row.kind ?? 'شمارش',
      custodyAuditExportTime(row.at), `نشست ${row.shiftId}`, row.countedByName ?? '—',
      custodyAuditExportAmount(row.countedCash), custodyAuditExportAmount(row.expectedCash),
      custodyAuditExportAmount(row.differenceCash), row.authMethod ?? null,
      arrivingCount ? `${row.note ? `${row.note} · ` : ''}شمارش ورودی فرد حاضر است، نه خروج فرد غایب؛ در برخی اسناد قدیمی شناسهٔ نشست پیشین ذخیره شده است` : row.note ?? null
    ])
  }
  for (const row of report.resolutions ?? []) rows.push([
    row.evidence ?? 'پروندهٔ بازیابی', custodyAuditExportTime(row.openedAt), `نشست ${row.shiftId}`, row.decisionByName ?? row.attributedToName ?? '—', null, custodyAuditExportAmount(row.nightExpectedCash), custodyAuditExportAmount(row.provisionalDifference),
    row.status ?? null, `انتساب: ${row.differenceAttribution ?? '—'}${row.decisionReason ? ` · دلیل: ${row.decisionReason}` : ''}`
  ])
  for (const row of report.legacyRecoveries ?? []) rows.push([
    'بازیابی Shift قدیمی', custodyAuditExportTime(row.createdAt), `بازیابی ${row.id}`, row.witnessName ?? 'شاهد ناشناس', custodyAuditExportAmount(row.countedCash), custodyAuditExportAmount(row.expectedTotalSnapshot), custodyAuditExportAmount(row.provisionalDifference),
    row.differenceScope ?? null, `نشست‌های قدیمی: ${(row.items ?? []).map((item: any) => item.shiftId).join(', ') || '—'}${row.opening ? ` · افتتاح ${row.opening.openingShiftId} · اختلاف افتتاح: ${custodyAuditExportAmount(row.opening.gapCash) ?? '—'}${row.opening.reason ? ` · دلیل: ${row.opening.reason}` : ''}` : ' · افتتاح جدید هنوز پیوند نخورده'}`
  ])
  for (const row of report.legacyRecoveryReviews ?? []) rows.push([
    'بازبینی بازیابی قدیمی', custodyAuditExportTime(row.createdAt), `بازیابی ${row.recoveryId}${row.itemId ? ` / مورد ${row.itemId}` : ''}`, row.actorName ?? 'نشست مدیر', null, null, null,
    row.decision ?? null, row.reason ?? null
  ])
  for (const row of report.dispositions ?? []) rows.push([
    'تعیین‌تکلیف وجه', custodyAuditExportTime(row.at), `نشست ${row.shiftId}`, row.confirmedByName ?? row.recipientName ?? '—', custodyAuditExportAmount(row.amount), null, null,
    row.confirmStatus ?? null, `${row.kind ?? '—'}${row.destinationLabel ? ` · مقصد: ${row.destinationLabel}` : ''}${row.trackingNo ? ` · پیگیری: ${row.trackingNo}` : ''}`
  ])
  return rows
}

const CUSTODY_AUDIT_EXPORT_HEADERS = ['نوع سند', 'زمان ثبت', 'segment / شیفت', 'عامل / مسئول', 'مبلغ / فیزیکی', 'مورد انتظار', 'اختلاف', 'وضعیت / احراز', 'جزئیات / مرجع']

async function markBlueHandoverStale(tx: Client, state: any, handover: any, actorUserId: number, reason: string) {
  const nextEpoch = Number(state.epoch) + 1
  const changed = await tx.custodyHandover.updateMany({
    where: { id: handover.id, status: { in: ['PENDING', 'RECEIVER_COUNTED'] } },
    data: { status: 'STALE', resolutionKind: 'BLUE_RECOUNT_REQUIRED', resolutionReason: reason, finishedAt: new Date(), version: { increment: 1 } }
  })
  if (changed.count !== 1) throw new BusinessError('وضعیت تحویل هم‌زمان عوض شد.', 'CUSTODY_STALE')
  const resumed = await tx.custodyState.updateMany({
    where: { key: MAIN, state: 'HANDOVER_PENDING', activeShiftId: handover.fromShiftId, pendingHandoverId: handover.id, epoch: state.epoch },
    data: { state: 'ACTIVE', pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() }
  })
  if (resumed.count !== 1) throw new BusinessError('تلاش تحویل کهنه قابل بازیابی نبود.', 'CUSTODY_STALE')
  await writeEvent(tx, { type: 'BLUE_HANDOVER_RECOUNT_REQUIRED', shiftId: handover.fromShiftId, handoverId: handover.id, actorUserId, actorKind: 'RECEIVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { reason, countsRetained: true, salesStayedWithOutgoing: true } })
  return { stale: true as const }
}

export const custodyService = {
  async config() {
    return configOf(prisma)
  },

  async enabled() {
    return (await configOf(prisma)).enabled
  },

  /**
   * One fail-closed answer for every legacy ShiftSession surface.  Looking only
   * at the feature flag was unsafe: an interrupted/older custody segment could
   * still be live while a stale settings row said "disabled", and the old
   * name-only session form then became a second way to assign drawer custody.
   *
   * `CustodyState` and open resolutions are durable evidence, not a renderer
   * preference.  This helper intentionally does not create state rows, so a
   * plain legacy installation remains legacy until custody is really enabled.
   */
  async isGoverned(): Promise<boolean> {
    const cfg = await configOf(prisma)
    if (cfg.enabled) return true
    const [state, unresolved, legacy] = await Promise.all([
      prisma.custodyState.findUnique({ where: { key: MAIN } }),
      prisma.custodyResolution.findFirst({ where: { status: 'OPEN' }, select: { id: true } }),
      legacyOpenShifts(prisma)
    ])
    return state?.state !== 'NO_SESSION' || !!unresolved || legacy.length > 0
  },

  async guardLegacyPath() {
    if (await this.isGoverned())
      throw new BusinessError('در حالت حضانت صندوق، ثبت یا تعویض نشست قدیمی مجاز نیست؛ فقط از مسیر رسمی حضانت با رمز شخصی استفاده کنید.', 'CUSTODY_LEGACY_PATH')
  },

  async status() {
    const cfg = await configOf(prisma)
    if (cfg.enabled) await this.ensureRolledOver()
    const state = await ensureState(prisma)
    const shift = state.activeShiftId ? await prisma.shift.findUnique({ where: { id: state.activeShiftId }, include: { user: true } }) : null
    const meta = state.activeShiftId ? await prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } }) : null
    const [unresolved, scheduling, legacy, pendingLegacyRecovery] = await Promise.all([
      prisma.custodyResolution.findMany({ where: { status: 'OPEN' }, orderBy: { openedAt: 'asc' } }),
      shiftSchedulingOf(prisma),
      legacyOpenShifts(prisma),
      pendingLegacyOpening(prisma)
    ])
    const legacyUserIds = [...new Set(legacy.map((row: any) => row.userId).filter((id: any) => Number.isSafeInteger(id) && id > 0))]
    const legacyUsers = legacyUserIds.length
      ? await prisma.user.findMany({ where: { id: { in: legacyUserIds } }, select: { id: true, displayName: true } })
      : []
    const legacyUserNames = new Map(legacyUsers.map((row: any) => [row.id, row.displayName]))
    const scheduledPlan = meta?.planId ? await prisma.shiftPlan.findUnique({ where: { id: meta.planId }, select: { reminderRepeatMin: true } }) : null
    const storedSchedule = scheduleSnapshotOf(meta)
    // Legacy rows without the additive snapshot retain their historic fallback.
    const template = !storedSchedule && meta?.templateId ? scheduling.templates.find((row: ShiftTemplate) => row.id === meta.templateId) ?? null : null
    const scheduledEndAt = storedSchedule?.scheduledEndAt ? new Date(storedSchedule.scheduledEndAt) : meta?.scheduledEndAt ? new Date(meta.scheduledEndAt) : null
    const overrunGraceMinutes = storedSchedule?.overrunGraceMinutes ?? (template ? scheduling.overrunGraceMinutes : cfg.overrunGraceMinutes)
    const reminderStart = scheduledEndAt ? new Date(scheduledEndAt.getTime() + overrunGraceMinutes * 60_000) : null
    const repeatMinutes = Math.max(5, Number(storedSchedule?.reminderRepeatMin ?? template?.reminderRepeatMin ?? scheduledPlan?.reminderRepeatMin ?? 15))
    const scheduleMode = effectiveCustodyMode(cfg, scheduling)
    const remindersEnabled = storedSchedule?.reminderEnabled ?? (template ? scheduling.reminderEnabled : cfg.reminderEnabled)
    const snapshotIsMultiShift = storedSchedule?.mode === 'MULTI_SHIFT'
    const now = Date.now()
    const reminderDue = !!((storedSchedule ? snapshotIsMultiShift : scheduleMode === 'MULTI_SHIFT') && remindersEnabled && reminderStart && now >= reminderStart.getTime())
    const reminderBucket = reminderDue ? Math.floor((now - reminderStart!.getTime()) / (repeatMinutes * 60_000)) : null
    const pendingRow = state.pendingHandoverId
      ? await prisma.custodyHandover.findUnique({ where: { id: state.pendingHandoverId }, select: { id: true, fromUserId: true, selectedRecipientUserId: true, startedAt: true, status: true, resolutionKind: true, countedAtStart: true, resolutionReason: true, ledgerWatermark: true } })
      : null
    let blindCountedCash: number | null = null
    let aggregatePending = false
    let bluePending = false
    if (pendingRow?.ledgerWatermark) {
      try {
        const watermark = JSON.parse(String(pendingRow.ledgerWatermark || '{}'))
        aggregatePending = watermark?.aggregateMode === true
        bluePending = watermark?.blueV1 === true
        const value = Number(watermark?.differencePending?.countedCash)
        if (!aggregatePending && Number.isSafeInteger(value) && value >= 0) blindCountedCash = value
      } catch {
        // A malformed legacy watermark must not expose an amount or break the
        // fail-closed custody status surface.
      }
    }
    return {
      enabled: cfg.enabled,
      /** Consumers that decide whether to show an old name-only ShiftSession
       * must use this durable, fail-closed value—not just the feature flag. */
      governed: cfg.enabled || state.state !== 'NO_SESSION' || unresolved.length > 0 || legacy.length > 0,
      /** Non-sensitive recovery hint only. Main remains authoritative and does
       * not expose amounts, expected cash, credentials or legacy notes here. */
      legacyBlock: legacy.length
        ? {
            count: legacy.length,
            shiftIds: legacy.map((row: any) => row.id),
            shifts: legacy.map((row: any) => ({
              id: row.id,
              name: row.name,
              number: row.number,
              sessionSeq: row.sessionSeq,
              dayJalali: row.dayJalali,
              openedAt: row.openedAt,
              legacyUserName: row.userId ? legacyUserNames.get(row.userId) ?? null : null
            }))
          }
        : null,
      /** Amount deliberately omitted: a new opener must recount blindly. */
      legacyOpeningRequired: !!pendingLegacyRecovery,
      config: cfg,
      /** Ordinary roster hint only. An absent primary never hides the
       * authenticated off-schedule opening option from the dialog; Main
       * independently verifies the PIN, count and reason in open(). */
      schedulingPolicy: {
        mode: scheduleMode,
        configured: scheduling.custodyModeConfigured,
        singleShiftCustodianUserId: scheduling.custodyModeConfigured && scheduleMode === 'SINGLE_SHIFT'
          ? scheduling.singleShiftCustodianUserId
          : null
      },
      state: state.state,
      epoch: state.epoch,
      activeShiftId: state.activeShiftId,
      custodian: shift?.userId ? { id: shift.userId, name: shift.user?.displayName ?? null, openAuth: meta?.openAuth ?? null } : null,
      shift: shift ? { id: shift.id, openedAt: shift.openedAt, closedAt: shift.closedAt, name: shift.name } : null,
      schedule: meta?.planId || meta?.templateId ? { planId: storedSchedule?.planId ?? meta?.planId ?? null, templateId: storedSchedule?.templateId ?? meta?.templateId ?? null, title: storedSchedule?.title ?? meta?.planTitle, scheduledEndAt: scheduledEndAt, allowMidDayHandover: storedSchedule?.allowMidDayHandover ?? template?.allowMidDayHandover ?? false } : null,
      reminder: { due: reminderDue, bucket: reminderBucket, repeatMinutes, scheduledEndAt: scheduledEndAt?.toISOString() ?? null },
      pendingHandover: pendingRow
        ? { id: pendingRow.id, fromUserId: pendingRow.fromUserId, selectedRecipientUserId: pendingRow.selectedRecipientUserId, startedAt: pendingRow.startedAt, status: pendingRow.status, resolutionKind: pendingRow.resolutionKind, blueReference: bluePending, countedAtStart: aggregatePending ? null : pendingRow.countedAtStart, resolutionReason: aggregatePending ? null : pendingRow.resolutionReason, blindCountedCash }
        : null,
      /** Public custody status is visible to every new worker. Historical
       * expired Shift IDs/counts and manager case inventory belong ONLY to the
       * manager-only Settings report; the previous Shift was already closed by
       * the SYSTEM before this response and must not be closed by the opener. */
      unresolved: [],
      unresolvedCount: 0
    }
  },

  /** Missed-shift history belongs in Manager Settings, NOT public status. A
   * new worker needs only their own opening PIN and real count; the old Shift
   * was already ended by ensureRolledOver() without a witnessed count. */
  async openResolutions() {
    assertManagerSession('دیدن پرونده‌های شیفت منقضی و رهاشده')
    const found = await prisma.custodyResolution.findMany({
      where: { status: 'OPEN' }, orderBy: [{ openedAt: 'desc' }, { id: 'desc' }], take: 101
    })
    const rows = found.slice(0, 100)
    const shifts = rows.length ? await prisma.shift.findMany({
      where: { id: { in: rows.map((row: any) => row.shiftId) } },
      select: { id: true, userId: true, closedAt: true }
    }) : []
    const byId = new Map(shifts.map((row: any) => [row.id, row]))
    return { rows: rows.map((row: any) => ({
      id: row.id, shiftId: row.shiftId, openedAt: row.openedAt,
      evidence: row.evidence, oldOwnerUserId: (byId.get(row.shiftId) as any)?.userId ?? null,
      systemEndedAt: (byId.get(row.shiftId) as any)?.closedAt ?? null
    })), hasMore: found.length > 100 }
  },

  /** Credential verification is deliberately outside a financial transaction:
   * it writes its own lockout row, exactly like the existing auth preverify pattern. */
  async verifyPin(userIdInput: unknown, rawPassword: unknown, opts: { allowTemporary?: boolean; requireManager?: boolean } = {}) {
    const userId = asSafeId(userIdInput, 'شناسه کارمند')
    await pinGateOpen(userId)
    const [user, credential] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      credentialOf(prisma, userId)
    ])
    if (!user || !user.isActive) throw new BusinessError('کارمند انتخاب‌شده فعال نیست.', 'INACTIVE')
    if (opts.requireManager && user.role !== 'MANAGER') throw new BusinessError('این عملیات فقط با رمز شخصی مدیر فعال مجاز است.', 'NO_PERMISSION')
    if (!credential || credential.status !== 'ACTIVE') throw new BusinessError('برای این کارمند هنوز رمز شخصی حضانت تعریف نشده است.', 'PIN_NOT_SET')
    const password = normalizeCustodyPassword(rawPassword)
    if (!password || !sameHash(credential.hash, derive(password, credential.salt))) return pinFailure(userId)
    await pinSuccess(userId)
    if (credential.mustChange && !opts.allowTemporary)
      throw new BusinessError('این رمز موقت است؛ ابتدا رمز شخصی خودتان را تغییر دهید.', 'PIN_MUST_CHANGE')
    return { userId: user.id, displayName: user.displayName, role: user.role, mustChange: credential.mustChange }
  },

  async setPin(input: { userId: unknown; newPassword: unknown; currentPassword?: unknown; managerUserId?: unknown; managerPassword?: unknown; reason?: unknown; managerSession?: boolean }) {
    const userId = asSafeId(input.userId, 'شناسه کارمند')
    const target = await prisma.user.findUnique({ where: { id: userId } })
    if (!target) throw new BusinessError('کارمند پیدا نشد.')
    const managerId = input.managerUserId == null ? null : asSafeId(input.managerUserId, 'شناسه مدیر')
    const sessionManager = input.managerSession === true
    if (sessionManager) assertManagerSession('صدور یا بازنشانی رمز حضانت کارمند')
    const isSelf = !sessionManager && (managerId == null || managerId === userId)
    let actorId: number | null = isSelf ? userId : null
    let setKind = isSelf ? 'SELF' : 'MANAGER_TEMP'
    if (isSelf) {
      const prior = await credentialOf(prisma, userId)
      if (prior) await this.verifyPin(userId, input.currentPassword, { allowTemporary: true })
      else if (target.role !== 'MANAGER') throw new BusinessError('تعریف اولین رمز این کارمند باید توسط مدیر انجام شود.')
      else {
        /** Bootstrap has no custody PIN to verify yet; use the established
         * server-side manager secret once, then all subsequent actions use the
         * named manager's personal credential. Dynamic import avoids a module
         * initialization cycle with ShiftService. */
        const { assertManagerPassword } = await import('./AuthService')
        await assertManagerPassword(String(input.currentPassword ?? ''), 'تعریف رمز اولیه حضانت مدیر')
      }
    } else {
      const reason = String(input.reason ?? '').trim()
      if (reason.length < 3) throw new BusinessError('مدیر برای تغییر رمز کارمند باید دلیل کوتاهی ثبت کند.')
      if (!sessionManager) {
        const manager = await this.verifyPin(managerId, input.managerPassword, { requireManager: true })
        actorId = manager.userId
      }
    }
    const profile = await prisma.staffProfile.findUnique({ where: { userId } })
    const password = assertPasswordPolicy(input.newPassword, profile?.phone ?? null)
    const salt = randomBytes(16).toString('hex')
    await prisma.$transaction(async (tx: Client) => {
      const prior = await credentialOf(tx, userId)
      const data = { algo: 'scrypt-v1', salt, hash: derive(password, salt), mustChange: !isSelf, status: 'ACTIVE', setAt: new Date(), setByUserId: actorId, setKind }
      if (prior) await tx.custodyCredential.updateMany({ where: { userId, purpose: PURPOSE }, data: { ...data, version: { increment: 1 } } })
      else await tx.custodyCredential.create({ data: { userId, purpose: PURPOSE, ...data } })
      await writeEvent(tx, { type: isSelf ? 'PIN_SET' : 'PIN_RESET_TEMP', actorUserId: actorId, actorKind: isSelf ? 'CUSTODIAN' : sessionManager ? 'GLOBAL_MANAGER' : 'MANAGER', authMethod: isSelf ? 'CUSTODY_PIN' : sessionManager ? 'MANAGER_SESSION' : 'MANAGER_CUSTODY_PIN', payload: { targetUserId: userId, setKind } })
      await auditOrThrow(tx, { action: AuditAction.SETTINGS_UPDATE, entity: 'CustodyCredential', entityId: userId, userId: actorId, after: JSON.stringify({ targetUserId: userId, purpose: PURPOSE, setKind, mustChange: !isSelf, authMethod: sessionManager ? 'MANAGER_SESSION' : undefined }), note: isSelf ? 'رمز شخصی حضانت کارمند تغییر کرد.' : `مدیر رمز موقت حضانت کارمند «${target.displayName}» را تعیین کرد.` })
    })
    await pinSuccess(userId)
    return { userId, hasPin: true, mustChange: !isSelf }
  },


  /**
   * This list also feeds the daily top-bar workflow, so it must not become a
   * back door to employment/contact data. Identity, role and credential state
   * are all that opening/handing-over a drawer needs; the manager-only Staff
   * profile remains the sole source for phone/job/banking/identity data.
   */
  async staffList() {
    const [users, credentials] = await Promise.all([
      /** This is an operational authentication roster, never a personnel
       * directory: archived people remain in history/Staff Settings but must
       * not leak back into an opening, handover, recovery or PIN workflow. */
      prisma.user.findMany({ where: { isActive: true }, orderBy: [{ id: 'asc' }] }),
      prisma.custodyCredential.findMany({ where: { purpose: PURPOSE }, select: { userId: true, mustChange: true, status: true } })
    ])
    const c = new Map(credentials.map((r: any) => [r.userId, r]))
    return users.map((user: any) => {
      const credential = c.get(user.id)
      return { id: user.id, name: user.displayName, role: user.role, isActive: user.isActive, hasCustodyPin: !!credential && credential.status === 'ACTIVE', mustChangePin: !!credential?.mustChange }
    })
  },

  /** Manager-only operational report. It deliberately exposes identities and
   * reconciliation evidence but never a credential hash, PIN, or raw credit
   * code. Every row comes from append-only custody/cash records. */
  async report(input: { managerUserId?: unknown; managerPassword?: unknown; from?: unknown; to?: unknown; take?: unknown; skip?: unknown; managerSession?: boolean } = {} as any) {
    if (input.managerSession === true) assertManagerSession('دیدن گزارش کنترل حضانت')
    else await this.verifyPin(input.managerUserId, input.managerPassword, { requireManager: true })
    const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60_000)
    const parsedFrom = input.from == null ? defaultFrom : new Date(String(input.from))
    const parsedTo = input.to == null ? new Date() : new Date(String(input.to))
    /** A manager audit view must not silently substitute a different period for
     * an invalid requested boundary. Missing bounds intentionally use defaults;
     * malformed supplied bounds fail closed. */
    if (!Number.isFinite(parsedFrom.getTime()) || !Number.isFinite(parsedTo.getTime()))
      throw new BusinessError('بازهٔ گزارش حضانت معتبر نیست.', 'CUSTODY_REPORT_RANGE_INVALID')
    const from = parsedFrom
    const to = parsedTo
    if (to.getTime() < from.getTime()) throw new BusinessError('پایان بازهٔ گزارش حضانت نمی‌تواند پیش از آغاز آن باشد.', 'CUSTODY_REPORT_RANGE_INVALID')
    const take = Math.min(500, Math.max(1, Math.round(Number(input.take ?? 150)) || 150))
    /** Pagination stays bounded even for a manager-only report. The same offset
     * is deliberately applied to each independently ordered evidence stream;
     * `hasMore` remains per-stream, so UI never claims a unified cursor. */
    const skip = Math.min(50_000, Math.max(0, Math.trunc(Number(input.skip ?? 0)) || 0))
    /** Read one extra immutable row per collection so report consumers never
     * mistake a bounded window for a complete history. The extra row is not
     * returned, does not affect summary totals, and causes no write. */
    const queryTake = take + 1
    const stores: any = prisma as any
    const [eventRows, countRows, handoverRows, resolutionRows, dispositionRows, shiftRows, operatorRows, legacyRecoveryRows, legacyReviewRows, blueBoundaryRows] = await Promise.all([
      prisma.custodyEvent.findMany({ where: { at: { gte: from, lte: to } }, orderBy: { at: 'desc' }, skip, take: queryTake }),
      prisma.custodyCount.findMany({ where: { at: { gte: from, lte: to } }, orderBy: { at: 'desc' }, skip, take: queryTake }),
      prisma.custodyHandover.findMany({ where: { startedAt: { gte: from, lte: to } }, orderBy: { startedAt: 'desc' }, skip, take: queryTake }),
      prisma.custodyResolution.findMany({ where: { openedAt: { gte: from, lte: to } }, orderBy: { openedAt: 'desc' }, skip, take: queryTake }),
      prisma.custodyDisposition.findMany({ where: { at: { gte: from, lte: to } }, orderBy: { at: 'desc' }, skip, take: queryTake }),
      // CustodyShiftMeta is append-only evidence.  Join it manually rather than
      // adding a Prisma relation so the schema stays additive for old databases.
      prisma.shift.findMany({ where: { openedAt: { gte: from, lte: to } }, orderBy: { openedAt: 'desc' }, skip, take: queryTake }),
      /** POS evidence is separately append-only. It is intentionally queried
       * from its own timestamp rather than inferred from mutable invoice/user
       * fields, which remain financial drawer attribution. */
      prisma.custodySaleEvidence.findMany({ where: { at: { gte: from, lte: to } }, orderBy: { at: 'desc' }, skip, take: queryTake }),
      stores.legacyShiftRecovery.findMany({ where: { createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' }, skip, take: queryTake }),
      stores.legacyShiftRecoveryReview.findMany({ where: { createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' }, skip, take: queryTake }),
      /** OPENING/FINAL_CLOSE have no handoverId; fetch them as an independent
       * bounded stream so export never silently omits final daily evidence. */
      prisma.custodyBlueSnapshot.findMany({
        where: { at: { gte: from, lte: to }, role: { in: ['OPENING', 'FINAL_CLOSE', 'RECOVERY'] } },
        orderBy: { at: 'desc' }, skip, take: queryTake
      })
    ])
    const truncated = {
      events: eventRows.length > take,
      counts: countRows.length > take,
      handovers: handoverRows.length > take,
      resolutions: resolutionRows.length > take,
      dispositions: dispositionRows.length > take,
      segments: shiftRows.length > take,
      saleOperators: operatorRows.length > take,
      legacyRecoveries: legacyRecoveryRows.length > take,
      legacyRecoveryReviews: legacyReviewRows.length > take,
      blueBoundaries: blueBoundaryRows.length > take
    }
    const events = eventRows.slice(0, take)
    const counts = countRows.slice(0, take)
    const handovers = handoverRows.slice(0, take)
    const resolutions = resolutionRows.slice(0, take)
    const dispositions = dispositionRows.slice(0, take)
    const shifts = shiftRows.slice(0, take)
    const saleOperators = operatorRows.slice(0, take)
    const legacyRecoveries = legacyRecoveryRows.slice(0, take)
    const legacyReviews = legacyReviewRows.slice(0, take)
    const blueBoundaries = blueBoundaryRows.slice(0, take)
    const evidenceInvoiceIds = saleOperators.map((row: any) => row.invoiceId)
    const evidenceInvoices = evidenceInvoiceIds.length
      ? await prisma.saleInvoice.findMany({ where: { id: { in: evidenceInvoiceIds } }, select: { id: true, receiptNo: true, issuedAt: true } })
      : []
    const invoiceById = new Map(evidenceInvoices.map((row: any) => [row.id, row]))
    const shiftIds = shifts.map((row: any) => row.id)
    const metas = shiftIds.length ? await prisma.custodyShiftMeta.findMany({ where: { shiftId: { in: shiftIds } } }) : []
    const metaByShift = new Map(metas.map((row: any) => [row.shiftId, row]))
    /** The old handover columns are non-nullable cash-era placeholders. A blue
     * handover MUST get its reference/differences from its immutable snapshots
     * instead: especially when an ambiguous payment made the reference null.
     * Joining batched by the report's bounded handover page also prevents a
     * long-lived manager report from losing decisions made on earlier days. */
    const blueIds = handovers.filter((row: any) => {
      try { return JSON.parse(String(row.ledgerWatermark ?? '{}')).blueV1 === true }
      catch { return false }
    }).map((row: any) => row.id)
    const blueSnapshots = blueIds.length
      ? await prisma.custodyBlueSnapshot.findMany({ where: { handoverId: { in: blueIds } }, orderBy: { id: 'asc' } }) : []
    const blueByHandover = new Map<number, { OUT?: any; IN?: any }>()
    for (const snapshot of blueSnapshots) {
      const pair: { OUT?: any; IN?: any } = blueByHandover.get(snapshot.handoverId) ?? {}
      if (snapshot.role === 'OUT' || snapshot.role === 'IN') pair[snapshot.role] = snapshot
      blueByHandover.set(snapshot.handoverId, pair)
    }
    const inIds = blueSnapshots.filter((row: any) => row.role === 'IN').map((row: any) => row.id)
    const decisionSnapshotIds = [...inIds, ...blueBoundaries.map((row: any) => row.id)]
    const blueDecisions = decisionSnapshotIds.length
      ? await prisma.custodyBlueResolution.findMany({ where: { snapshotId: { in: decisionSnapshotIds } } }) : []
    const decisionBySnapshot = new Map(blueDecisions.map((row: any) => [row.snapshotId, row]))
    /** Legacy evidence lives in its own append-only tables rather than being
     * retrofitted onto old financial rows. The report joins only by immutable
     * IDs, which keeps historical movement/liability attribution untouched. */
    const recoveryIds = legacyRecoveries.map((row: any) => row.id)
    const [legacyItems, legacyLinks] = recoveryIds.length
      ? await Promise.all([
          stores.legacyShiftRecoveryItem.findMany({ where: { recoveryId: { in: recoveryIds } }, orderBy: [{ recoveryId: 'asc' }, { id: 'asc' }] }),
          stores.legacyRecoveryOpeningLink.findMany({ where: { recoveryId: { in: recoveryIds } } })
        ])
      : [[], []]
    const itemsByRecovery = new Map<number, any[]>()
    for (const item of legacyItems as any[]) {
      const rows = itemsByRecovery.get(item.recoveryId) ?? []
      rows.push(item)
      itemsByRecovery.set(item.recoveryId, rows)
    }
    const linkByRecovery = new Map((legacyLinks as any[]).map((row: any) => [row.recoveryId, row]))
    const ids = new Set<number>()
    for (const e of events) if (e.actorUserId) ids.add(e.actorUserId)
    for (const c of counts) ids.add(c.countedByUserId)
    for (const h of handovers) { ids.add(h.fromUserId); ids.add(h.selectedRecipientUserId); if (h.finalCustodianUserId) ids.add(h.finalCustodianUserId) }
    for (const r of resolutions) { if (r.decisionByUserId) ids.add(r.decisionByUserId); if (r.attributedToUserId) ids.add(r.attributedToUserId) }
    for (const d of dispositions) { if (d.recipientUserId) ids.add(d.recipientUserId); if (d.confirmedByUserId) ids.add(d.confirmedByUserId) }
    for (const meta of metas) ids.add(meta.custodianUserId)
    for (const row of saleOperators) {
      ids.add(row.custodianUserId)
      /** A shared manager session is deliberately anonymous: even if malformed
       * legacy data carried an id, do not use it to reconstruct an individual. */
      if (row.operatorKind !== 'MANAGER_SESSION' && row.operatorUserId) ids.add(row.operatorUserId)
    }
    for (const row of legacyRecoveries) if (row.witnessUserId) ids.add(row.witnessUserId)
    for (const item of legacyItems as any[]) if (item.legacyUserId) ids.add(item.legacyUserId)
    for (const link of legacyLinks as any[]) if (link.openerUserId) ids.add(link.openerUserId)
    for (const review of legacyReviews) if (review.actorUserId) ids.add(review.actorUserId)
    for (const decision of blueDecisions) ids.add(decision.managerUserId)
    for (const snapshot of blueBoundaries) ids.add(snapshot.actorUserId)
    const users = ids.size ? await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, displayName: true } }) : []
    const userName = new Map(users.map((row: any) => [row.id, row.displayName]))
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      coverage: {
        skip,
        take,
        /** `truncated` is retained for callers from Phase 6; `hasMore` makes
         * the paging meaning explicit without pretending all streams share an
         * atomic combined cursor. */
        truncated,
        truncatedAny: Object.values(truncated).some(Boolean),
        hasMore: { ...truncated },
        hasMoreAny: Object.values(truncated).some(Boolean)
      },
      summary: {
        handovers: handovers.length,
        unresolvedOpen: resolutions.filter((row: any) => row.status === 'OPEN').length,
        dispositionPending: dispositions.filter((row: any) => row.confirmStatus !== 'CONFIRMED' && row.confirmStatus !== 'REVERSED').length,
        /** This sum covers only actually calculated differences. Null is not a
         * zero reconciliation; its separate counter keeps the UI honest. */
        totalCountDifference: counts.reduce((sum: bigint, row: any) => sum + BigInt(row.differenceCash ?? 0), BigInt(0)),
        unknownCountDifferences: counts.filter((row: any) => row.differenceCash == null).length,
        blueHandoversAwaitingReference: blueIds.filter((id: number) => {
          const pair = blueByHandover.get(id)
          const snapshot = pair?.IN ?? pair?.OUT
          return !snapshot || (snapshot.referenceAmount == null && (!pair?.IN || !decisionBySnapshot.has(pair.IN.id)))
        }).length,
        operatorSales: saleOperators.length,
        operatorPinSales: saleOperators.filter((row: any) => row.operatorKind === 'OPERATOR_PIN').length,
        managerSessionSales: saleOperators.filter((row: any) => row.operatorKind === 'MANAGER_SESSION').length,
        legacyRecoveries: legacyRecoveries.length,
        legacyRecoveryReviews: legacyReviews.length,
        legacyRecoveriesAwaitingOpening: legacyRecoveries.filter((row: any) => !linkByRecovery.has(row.id)).length
      },
      events: events.map((row: any) => ({ id: row.id, type: row.type, at: row.at, shiftId: row.shiftId, handoverId: row.handoverId, resolutionId: row.resolutionId, legacyRecoveryId: row.legacyRecoveryId ?? null, actorUserId: row.actorUserId, actorName: row.actorUserId ? userName.get(row.actorUserId) ?? null : null, actorKind: row.actorKind, payload: row.payloadJson ? JSON.parse(row.payloadJson) : null })),
      /** A segment retains the schedule title/identity captured when its drawer
       * opened. Never look up the current template title here: a later rename,
       * deactivation or deletion must not rewrite cash-close history. */
      segments: shifts
        .map((shift: any) => {
          const meta = metaByShift.get(shift.id)
          if (!meta) return null
          return {
            shiftId: shift.id,
            startedAt: shift.openedAt,
            endedAt: meta.endedAt ?? shift.closedAt ?? null,
            custodianUserId: meta.custodianUserId,
            custodianName: userName.get(meta.custodianUserId) ?? null,
            templateId: meta.templateId ?? null,
            scheduleTitleSnapshot: meta.planTitle ?? null,
            scheduledEndAt: meta.scheduledEndAt ?? null,
            scheduleKind: meta.templateId ? 'CANONICAL' : meta.planId ? 'LEGACY' : 'UNSCHEDULED',
            endKind: meta.endKind ?? null,
            countStatus: meta.countStatus,
            operationalDay: meta.operationalDay
          }
        })
        .filter(Boolean),
      /** Explicit POS operation proof. `operatorUserId` is withheld for the
       * shared manager-session mode, by policy—not merely because today's row
       * happens to be null. Financial invoice ownership remains separate. */
      saleOperators: saleOperators.map((row: any) => {
        const invoice = invoiceById.get(row.invoiceId)
        const anonymousManagerSession = row.operatorKind === 'MANAGER_SESSION'
        const operatorUserId = anonymousManagerSession ? null : row.operatorUserId ?? null
        return {
          id: row.id,
          at: row.at,
          invoiceId: row.invoiceId,
          receiptNo: invoice?.receiptNo ?? null,
          saleIssuedAt: invoice?.issuedAt ?? null,
          custodyShiftId: row.custodyShiftId,
          custodianUserId: row.custodianUserId,
          custodianName: userName.get(row.custodianUserId) ?? null,
          operatorKind: row.operatorKind,
          operatorUserId,
          operatorName: operatorUserId ? userName.get(operatorUserId) ?? null : null,
          authMethod: row.authMethod
        }
      }),
      /** Count rows are immutable physical/ledger evidence. Expose their
       * method and free-text note only to the existing manager-only report;
       * neither can contain or reconstruct a credential. */
      counts: counts.map((row: any) => ({ id: row.id, at: row.at, shiftId: row.shiftId, kind: row.kind, countedCash: row.countedCash, expectedCash: row.expectedCash, differenceCash: row.differenceCash, countedByUserId: row.countedByUserId, countedByName: userName.get(row.countedByUserId) ?? null, authMethod: row.authMethod, note: row.note ?? null, operationalDay: row.operationalDay })),
      blueBoundaries: blueBoundaries.map((row: any) => {
        const decision: any = decisionBySnapshot.get(row.id)
        const amount = (value: any) => value == null ? null : Number(value)
        // The cash-era column actorUserId on an absence OUT identifies the
        // initiator of a SYSTEM boundary, never an outgoing physical counter.
        // Old immutable ZERO-named rows get exactly the same honest view.
        const absentOut = row.role === 'OUT' && isAbsentUncounted(row.countOrigin)
        return {
          snapshotId: row.id, shiftId: row.shiftId, role: row.role, at: row.at,
          actorUserId: absentOut ? null : row.actorUserId,
          actorName: absentOut ? 'سیستم؛ غیبت مسئول قبلی' : userName.get(row.actorUserId) ?? null,
          countOrigin: row.countOrigin, authMethod: row.authMethod,
          calculationVersion: row.calculationVersion,
          countedAmount: amount(row.humanAmount),
          originalReferenceStatus: row.referenceStatus,
          originalReferenceAmount: amount(row.referenceAmount),
          originalRawDifference: amount(row.rawDifference),
          originalFreshDifference: amount(row.freshDifference),
          referenceStatus: decision ? 'RESOLVED' : row.referenceStatus,
          referenceFromDay: row.referenceFromDay, referenceToDay: row.referenceToDay,
          referenceAmount: decision ? amount(decision.effectiveReferenceAmount) : amount(row.referenceAmount),
          knownSubtotal: amount(row.knownSubtotal),
          destinationUnknownReceived: row.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? null : amount(row.destinationUnknownReceived),
          ambiguousLegacyCredit: amount(row.ambiguousLegacyCredit),
          rawDifference: decision ? amount(decision.resolvedRawDifference) : amount(row.rawDifference),
          freshDifference: decision ? amount(decision.resolvedFreshDifference) : amount(row.freshDifference),
          freshStatus: decision ? decision.freshStatus : row.freshStatus,
          decision: decision ? { id: decision.id, kind: decision.decisionKind,
            managerUserId: decision.managerUserId, managerName: userName.get(decision.managerUserId) ?? null,
            destinationKind: decision.destinationDecisionKind ?? null,
            destinationEvidenceDay: decision.destinationEvidenceDay ?? null,
            destinationEvidenceReference: decision.destinationEvidenceReference ?? null,
            evidenceDay: decision.evidenceDay, evidenceReference: decision.evidenceReference,
            reason: decision.reason, at: decision.at } : null
        }
      }),
      handovers: handovers.map((row: any) => {
        const isBlue = blueIds.includes(row.id)
        /** In a completed pre-blue aggregate handover with no prior baseline,
         * ADOPT_RECEIVER used the receiver's own count as a neutral starting
         * point. Its stored expected=count and difference=0 are NOT a measured
         * reconciliation. Keep the immutable row, but do not show those two
         * placeholders as financial evidence in the report or its CSV. */
        const unbasedAdoption = (() => {
          if (isBlue || row.status !== 'COMPLETED') return false
          try {
            const watermark = JSON.parse(String(row.ledgerWatermark ?? '{}'))
            return watermark.aggregateMode === true && watermark.aggregateBootstrap === 'ADOPT_RECEIVER'
          } catch { return false }
        })()
        const pair = blueByHandover.get(row.id)
        const frozen = pair?.IN ?? pair?.OUT
        const decision: any = pair?.IN ? decisionBySnapshot.get(pair.IN.id) : null
        const amount = (value: any) => value == null ? null : Number(value)
        const blueEvidence = (snapshot: any) => snapshot ? {
          id: snapshot.id, at: snapshot.at, role: snapshot.role,
          actorUserId: snapshot.role === 'OUT' && isAbsentUncounted(snapshot.countOrigin) ? null : snapshot.actorUserId,
          authMethod: snapshot.authMethod,
          countOrigin: snapshot.countOrigin, humanAmount: amount(snapshot.humanAmount),
          calculationVersion: snapshot.calculationVersion,
          referenceStatus: snapshot.referenceStatus, referenceAmount: amount(snapshot.referenceAmount),
          knownSubtotal: amount(snapshot.knownSubtotal), destinationUnknownReceived: snapshot.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? null : amount(snapshot.destinationUnknownReceived),
          ambiguousLegacyCredit: amount(snapshot.ambiguousLegacyCredit),
          rawDifference: amount(snapshot.rawDifference), freshDifference: amount(snapshot.freshDifference)
        } : null
        const blue = isBlue ? {
          outgoing: blueEvidence(pair?.OUT), incoming: blueEvidence(pair?.IN),
          initialAuthMethod: frozen?.authMethod ?? null,
          status: decision ? 'RESOLVED' : frozen?.referenceStatus ?? 'AWAITING_COUNT',
          snapshotId: frozen?.id ?? null, incomingSnapshotId: pair?.IN?.id ?? null,
          snapshotAt: frozen?.at ?? null,
          calculationVersion: frozen?.calculationVersion ?? null,
          referenceFromDay: frozen?.referenceFromDay ?? null,
          referenceToDay: frozen?.referenceToDay ?? null,
          countOrigin: frozen?.countOrigin ?? null,
          countedAmount: amount(frozen?.humanAmount),
          originalReferenceAmount: amount(frozen?.referenceAmount),
          knownSubtotal: amount(frozen?.knownSubtotal),
          destinationUnknownReceived: frozen?.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? null : amount(frozen?.destinationUnknownReceived),
          ambiguousLegacyCredit: amount(frozen?.ambiguousLegacyCredit),
          originalRawDifference: amount(frozen?.rawDifference),
          originalFreshDifference: amount(frozen?.freshDifference),
          referenceAmount: decision ? amount(decision.effectiveReferenceAmount) : amount(frozen?.referenceAmount),
          rawDifference: decision ? amount(decision.resolvedRawDifference) : amount(frozen?.rawDifference),
          freshDifference: decision ? amount(decision.resolvedFreshDifference) : amount(frozen?.freshDifference),
          decision: decision ? { id: decision.id, kind: decision.decisionKind,
            managerUserId: decision.managerUserId, managerName: userName.get(decision.managerUserId) ?? null,
            destinationKind: decision.destinationDecisionKind ?? null,
            destinationEvidenceDay: decision.destinationEvidenceDay ?? null,
            destinationEvidenceReference: decision.destinationEvidenceReference ?? null,
            evidenceDay: decision.evidenceDay, evidenceReference: decision.evidenceReference,
            reason: decision.reason, at: decision.at } : null
        } : null
        return { id: row.id, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt,
          fromShiftId: row.fromShiftId, toShiftId: row.toShiftId,
          fromUser: userName.get(row.fromUserId) ?? null,
          selectedRecipient: userName.get(row.selectedRecipientUserId) ?? null,
          finalCustodian: row.finalCustodianUserId ? userName.get(row.finalCustodianUserId) ?? null : null,
          /** Neither blue's bridge columns nor a neutral aggregate adoption
           * prove an expected amount/difference. Other legacy handovers retain
           * their stored, measured comparison unchanged. */
          expectedAtStart: isBlue || unbasedAdoption ? null : row.expectedAtStart,
          // Outgoing never attested a count on an absence. Old cash-era bridge
          // columns must not present the arriving worker's IN amount as OUT.
          countedAtStart: isBlue && pair?.OUT && isAbsentUncounted(pair.OUT.countOrigin)
            ? null : row.countedAtStart,
          differenceCash: isBlue || unbasedAdoption ? null : row.differenceCash,
          unbasedAdoption,
          resolutionKind: row.resolutionKind, blue }
      }),
      resolutions: resolutions.map((row: any) => ({ id: row.id, shiftId: row.shiftId, status: row.status, evidence: row.evidence, openedAt: row.openedAt, resolvedAt: row.resolvedAt, nightExpectedCash: row.nightExpectedCash, provisionalDifference: row.provisionalDifference, differenceAttribution: row.differenceAttribution, attributedToName: row.attributedToUserId ? userName.get(row.attributedToUserId) ?? null : null, decisionByName: row.decisionByUserId ? userName.get(row.decisionByUserId) ?? null : null, decisionReason: row.decisionReason })),
      /** Recovery count remains a witness record—not a new responsible party.
       * Expected snapshots are only manager-report evidence and no record here
       * ever changes old invoice/movement attribution. */
      legacyRecoveries: legacyRecoveries.map((row: any) => {
        const link = linkByRecovery.get(row.id)
        const items = itemsByRecovery.get(row.id) ?? []
        return {
          id: row.id,
          createdAt: row.createdAt,
          witnessName: userName.get(row.witnessUserId) ?? null,
          witnessUserId: row.witnessUserId,
          countedCash: row.countedCash,
          expectedTotalSnapshot: row.expectedTotalSnapshot,
          provisionalDifference: row.provisionalDifference,
          differenceScope: row.differenceScope,
          note: row.note ?? null,
          operationalDay: row.operationalDay,
          itemCount: items.length,
          items: items.map((item: any) => ({
            id: item.id,
            shiftId: item.shiftId,
            legacyUserName: item.legacyUserId ? userName.get(item.legacyUserId) ?? null : null,
            openedAtSnapshot: item.openedAtSnapshot,
            lastActivityAt: item.lastActivityAt ?? null,
            invoiceCountSnapshot: item.invoiceCountSnapshot,
            expectedCashSnapshot: item.expectedCashSnapshot,
            expectedCalcStatus: item.expectedCalcStatus
          })),
          opening: link ? {
            openingShiftId: link.openingShiftId,
            openingCountId: link.openingCountId,
            at: link.at,
            openingCountedCash: link.openingCountedCash,
            gapCash: link.gapCash,
            reason: link.reason ?? null,
            openerName: userName.get(link.openerUserId) ?? null
          } : null
        }
      }),
      legacyRecoveryReviews: legacyReviews.map((row: any) => ({
        id: row.id,
        recoveryId: row.recoveryId,
        itemId: row.itemId ?? null,
        decision: row.decision,
        actorKind: row.actorKind,
        authMethod: row.authMethod,
        actorName: row.actorUserId ? userName.get(row.actorUserId) ?? null : null,
        reason: row.reason,
        createdAt: row.createdAt
      })),
      dispositions: dispositions.map((row: any) => ({ id: row.id, at: row.at, shiftId: row.shiftId, cashSessionId: row.cashSessionId, kind: row.kind, amount: row.amount, confirmStatus: row.confirmStatus, recipientName: row.recipientUserId ? userName.get(row.recipientUserId) ?? null : null, confirmedByName: row.confirmedByUserId ? userName.get(row.confirmedByUserId) ?? null : null, trackingNo: row.trackingNo, destinationLabel: row.destinationLabel }))
    }
  },

  /** A manager may append a neutral review note to recovery evidence. This is
   * intentionally not a resolution, cash movement, liability assignment or
   * rewrite of a historical Shift: the review table is append-only. */
  async reviewLegacyRecovery(input: { recoveryId: unknown; itemId?: unknown; reason: unknown; idempotencyKey: unknown; decision?: unknown; managerUserId?: unknown; managerPassword?: unknown; managerSession?: boolean }) {
    const recoveryId = asSafeId(input.recoveryId, 'شناسهٔ بازیابی قدیمی')
    const itemId = input.itemId == null || input.itemId === '' ? null : asSafeId(input.itemId, 'شناسهٔ مورد بازیابی')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 3 || reason.length > 1000)
      throw new BusinessError('یادداشت بازبینی باید بین ۳ تا ۱۰۰۰ نویسه باشد.', 'LEGACY_RECOVERY_REVIEW_REASON_INVALID')
    const idempotencyKey = recoveryIdempotencyKey(input.idempotencyKey)
    const decision = String(input.decision ?? 'NOTE').trim()
    if (decision !== 'NOTE' && decision !== 'REVIEWED_KEEP_UNRESOLVED')
      throw new BusinessError('نوع بازبینی بازیابی معتبر نیست.', 'LEGACY_RECOVERY_REVIEW_DECISION_INVALID')
    const actor = input.managerSession === true
      ? (assertManagerSession('ثبت بازبینی بازیابی Shift قدیمی'), { userId: null as number | null, actorKind: 'GLOBAL_MANAGER', authMethod: 'MANAGER_SESSION' })
      : (() => null)()
    const manager = actor ? null : await this.verifyPin(input.managerUserId, input.managerPassword, { requireManager: true })
    const actorUserId = actor?.userId ?? manager!.userId
    const actorKind = actor?.actorKind ?? 'MANAGER'
    const authMethod = actor?.authMethod ?? 'MANAGER_CUSTODY_PIN'
    const stores: any = prisma as any
    const existing = await stores.legacyShiftRecoveryReview.findUnique({ where: { idempotencyKey } })
    if (existing) {
      if (existing.recoveryId === recoveryId && existing.itemId === itemId && existing.reason === reason && existing.decision === decision)
        return { reviewId: existing.id, replayed: true }
      throw new BusinessError('این کلید بازبینی با اطلاعات دیگری استفاده شده است.', 'LEGACY_RECOVERY_REVIEW_IDEMPOTENCY_MISMATCH')
    }
    try {
      return await prisma.$transaction(async (tx: Client) => {
        const txStores: any = tx as any
        const recovery = await txStores.legacyShiftRecovery.findUnique({ where: { id: recoveryId } })
        if (!recovery) throw new BusinessError('سند بازیابی قدیمی پیدا نشد.', 'LEGACY_RECOVERY_NOT_FOUND')
        if (itemId != null) {
          const item = await txStores.legacyShiftRecoveryItem.findUnique({ where: { id: itemId } })
          if (!item || item.recoveryId !== recoveryId)
            throw new BusinessError('مورد انتخاب‌شده متعلق به این بازیابی نیست.', 'LEGACY_RECOVERY_ITEM_INVALID')
        }
        const raced = await txStores.legacyShiftRecoveryReview.findUnique({ where: { idempotencyKey } })
        if (raced) {
          if (raced.recoveryId === recoveryId && raced.itemId === itemId && raced.reason === reason && raced.decision === decision)
            return { reviewId: raced.id, replayed: true }
          throw new BusinessError('این کلید بازبینی با اطلاعات دیگری استفاده شده است.', 'LEGACY_RECOVERY_REVIEW_IDEMPOTENCY_MISMATCH')
        }
        const review = await txStores.legacyShiftRecoveryReview.create({
          data: { recoveryId, itemId, decision, actorKind, authMethod, actorUserId, reason, idempotencyKey }
        })
        await writeEvent(tx, {
          type: 'LEGACY_RECOVERY_REVIEWED',
          legacyRecoveryId: recoveryId,
          actorUserId,
          actorKind,
          authMethod,
          payload: { reviewId: review.id, itemId, decision }
        })
        await auditOrThrow(tx, {
          action: AuditAction.SETTINGS_UPDATE,
          entity: 'LegacyShiftRecoveryReview',
          entityId: review.id,
          userId: actorUserId,
          after: JSON.stringify({ recoveryId, itemId, decision }),
          note: 'بازبینی افزایشیِ سند بازیابی Shift قدیمی؛ بدون تغییر در مسئولیت یا اسناد مالی گذشته.'
        })
        return { reviewId: review.id, replayed: false }
      })
    } catch (error: any) {
      if (error?.code === 'P2002' || /unique constraint/i.test(String(error?.message ?? ''))) {
        const raced = await stores.legacyShiftRecoveryReview.findUnique({ where: { idempotencyKey } })
        if (raced?.recoveryId === recoveryId && raced.itemId === itemId && raced.reason === reason && raced.decision === decision)
          return { reviewId: raced.id, replayed: true }
      }
      throw error
    }
  },

  /**
   * An audit export is generated in Main from a freshly authorized report
   * query. Renderer selects only its bounded scope; it never supplies evidence
   * rows, amounts, names, notes or a title that could misrepresent the audit.
   */
  async exportReport(input: { from?: unknown; to?: unknown; take?: unknown; skip?: unknown; managerSession?: boolean }) {
    const report = await this.report({ ...input, managerSession: true })
    const { exportTableFile } = await import('./ExportService')
    const coverage = (report as any).coverage
    const title = [
      `گزارش ممیزی حضانت · از ${(report as any).from} تا ${(report as any).to}`,
      `offset ${coverage?.skip ?? 0} · حداکثر ${coverage?.take ?? 0} ردیف در هر stream`,
      coverage?.hasMoreAny ? 'هشدار: evidence قدیمی‌تر در همین بازه وجود دارد؛ این خروجی فقط صفحهٔ فعلی است.' : 'این خروجی صفحهٔ کاملِ بازهٔ فعلی است.'
    ].join(' · ')
    const result = await exportTableFile({
      fileName: 'گزارش-ممیزی-حضانت',
      sheetName: 'ممیزی حضانت',
      title,
      headers: CUSTODY_AUDIT_EXPORT_HEADERS,
      rows: custodyAuditExportRows(report)
    })
    /** The shared manager session intentionally has no individual User.id. An
     * export action is nevertheless security-relevant, so append an outcome
     * record without path, evidence contents, credentials or invented actor. */
    await audit(prisma, {
      action: 'CUSTODY_REPORT_EXPORT',
      entity: 'CustodyAuditReport',
      userId: null,
      after: JSON.stringify({
        outcome: result.canceled ? 'CANCELED' : 'SAVED',
        format: result.format,
        rows: result.rows,
        from: (report as any).from,
        to: (report as any).to,
        skip: coverage?.skip ?? 0,
        take: coverage?.take ?? 0,
        hasMoreAny: coverage?.hasMoreAny === true
      }),
      note: 'خروجی گزارش حضانت با نشست مشترک مدیر؛ بدون انتساب هویت فردی مدیر'
    })
    return result
  },

  async setConfig(input: { config: unknown; managerUserId?: unknown; managerPassword?: unknown; managerSession?: boolean }) {
    const current = await configOf(prisma)
    if (input.managerSession === true) {
      assertManagerSession('تغییر تنظیمات ساختاری حضانت صندوق')
    } else {
      const [credentials, managers] = await Promise.all([
        prisma.custodyCredential.findMany({ where: { purpose: PURPOSE, status: 'ACTIVE' } }),
        prisma.user.findMany({ where: { role: 'MANAGER', isActive: true }, select: { id: true } })
      ])
      const managerIds = new Set(managers.map((row: any) => row.id))
      const existingManagerCredential = credentials.find((row: any) => managerIds.has(row.userId))
      if (!existingManagerCredential)
        throw new BusinessError('ابتدا مدیر باید با رمز فعلی مدیر، رمز شخصی حضانت خودش را راه‌اندازی کند.', 'CUSTODY_MANAGER_PIN_REQUIRED')
      await this.verifyPin(input.managerUserId, input.managerPassword, { requireManager: true })
    }
    const next = parseCustodyConfig(input.config)
    // Never change the operational mode via this legacy config writer, even
    // before the first scheduling review. The dedicated workflow records the
    // named manager's PIN and reason and fences an active responsibility; this
    // route has none of those protections. Keeping the OLD mode unchanged is
    // still permitted during onboarding and does not pause an active sale.
    if (current.mode !== next.mode)
      throw new BusinessError('تغییر تک‌شیفت/چندشیفت فقط از گردش‌کار برنامه‌ریزی حضانت در تنظیمات مجاز است.', 'CUSTODY_MODE_WORKFLOW_REQUIRED')
    /** A fresh install is deliberately SINGLE_SHIFT. MULTI_SHIFT is an explicit
     * staffing policy, not a visual toggle: at least one active named plan must
     * already have a scheduled person before it can govern operations. */
    if (next.enabled && next.mode === 'MULTI_SHIFT') {
      const [plans, assignments] = await Promise.all([
        prisma.shiftPlan.findMany({ where: { isActive: true }, select: { id: true } }),
        prisma.shiftPlanStaff.findMany({ select: { planId: true, userId: true } })
      ])
      const activeIds = new Set(plans.map((row: any) => row.id))
      if (!assignments.some((row: any) => activeIds.has(row.planId)))
        throw new BusinessError('برای فعال‌سازی چندشیفت، ابتدا حداقل یک برنامهٔ فعال با کارمند مشخص ثبت کنید.', 'CUSTODY_MULTI_SHIFT_NEEDS_PLAN')
    }
    const state = await ensureState(prisma)
    if (current.enabled !== next.enabled && state.state !== 'NO_SESSION') throw new BusinessError('تا وقتی صندوق باز یا در حال تحویل است، روشن/خاموش‌کردن حضانت مجاز نیست.')
    // A no-session state can still carry an unresolved previous drawer. Turning
    // the feature off here would hide its only PIN/count recovery path while
    // `isGoverned()` correctly blocks the old name-only path.
    if (current.enabled && !next.enabled) {
      const [unresolved, legacy] = await Promise.all([
        prisma.custodyResolution.findFirst({ where: { status: 'OPEN' }, select: { id: true } }),
        legacyOpenShifts(prisma)
      ])
      if (legacy.length)
        throw new BusinessError('یک یا چند نشست بازِ سیستم قدیم نیازمند بازیابی هستند؛ خاموش‌کردن حضانت راه تعیین تکلیف آن‌ها نیست.', 'CUSTODY_LEGACY_RECOVERY_REQUIRED')
      if (unresolved) throw new BusinessError('تا وقتی پروندهٔ بازیابی صندوق قبلی باز است، خاموش‌کردن حضانت مجاز نیست.', 'CUSTODY_RECOVERY_OPEN')
    }
    await prisma.setting.upsert({ where: { key: SETTING_KEYS.custodyConfig }, update: { value: JSON.stringify(next) }, create: { key: SETTING_KEYS.custodyConfig, value: JSON.stringify(next) } })
    return next
  },

  /** Settings-only manager recovery: never create a scheduled Shift, invent a
   * custodian, delete a count, or reuse a previous PIN/amount. Recover the ONE
   * actually open named Shift when the state pointer was lost; otherwise abort
   * only the unfinished attempt and leave the real owner in place. A healthy
   * drawer is a strict operational no-op (audit still records the request). */
  async resetShift(input: { managerUserId: unknown; password: unknown; reason: unknown; confirmed: unknown }) {
    const manager = await this.verifyPin(input.managerUserId, input.password, { requireManager: true })
    if (input.confirmed !== true)
      throw new BusinessError('برای بازیابی ایمن شیفت، تأیید صریح مدیر لازم است.', 'CUSTODY_RESET_CONFIRM_REQUIRED')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 10 || reason.length > 1000)
      throw new BusinessError('برای ریست شیفت، دلیل مدیر باید بین ۱۰ تا ۱۰۰۰ نویسه باشد.', 'CUSTODY_RESET_REASON_REQUIRED')
    // An expired ACTUAL Shift is finished by the normal system rollover, not
    // silently revived by an administrative reset or assigned to today's plan.
    await this.ensureRolledOver()
    return prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      const opens = await tx.shift.findMany({
        where: { closedAt: null }, orderBy: { id: 'desc' },
        select: { id: true, userId: true, openedAt: true }
      })
      const metas = opens.length ? await tx.custodyShiftMeta.findMany({
        where: { shiftId: { in: opens.map((row: any) => row.id) } },
        select: { shiftId: true, custodianUserId: true }
      }) : []
      const byShift = new Map(metas.map((row: any) => [row.shiftId, row]))
      const actual = opens.filter((shift: any) => {
        const meta: any = byShift.get(shift.id)
        return meta && shift.userId === meta.custodianUserId
      })
      if (actual.length > 1)
        throw new BusinessError('چند نشست واقعی هم‌زمان باز است؛ بدون سند نمی‌توان یکی را مسئول اعلام کرد. اسناد تاریخی را بررسی کنید.', 'CUSTODY_RESET_AMBIGUOUS')
      const real = actual[0] ?? null
      let pendingId: number | null = null
      if (state.pendingHandoverId != null) {
        const pending = await tx.custodyHandover.findUnique({ where: { id: state.pendingHandoverId } })
        if (pending && ['PENDING', 'RECEIVER_COUNTED', 'EMERGENCY_RECOUNT', 'MASTER_OVERRIDE_RECOUNT'].includes(pending.status)) {
          pendingId = pending.id
          await tx.custodyHandover.update({ where: { id: pending.id }, data: {
            status: 'RESET_ABORTED', resolutionKind: 'RESET_REQUIRES_NEW_COUNT_AND_PIN',
            finishedAt: new Date(), version: { increment: 1 }
          } })
        }
      }
      const nextState = real ? 'ACTIVE' : 'NO_SESSION'
      const realShiftId = real?.id ?? null
      const changed = state.state !== nextState || state.activeShiftId !== realShiftId ||
        state.pendingHandoverId != null
      const nextEpoch = changed ? Number(state.epoch) + 1 : Number(state.epoch)
      if (changed) {
        const switched = await tx.custodyState.updateMany({
          where: { key: MAIN, state: state.state, activeShiftId: state.activeShiftId,
            pendingHandoverId: state.pendingHandoverId, epoch: state.epoch },
          data: { state: nextState, activeShiftId: realShiftId,
            pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() }
        })
        if (switched.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ ریست انجام نشد.', 'CUSTODY_STALE')
      }
      const outcome = pendingId ? 'ABORTED_INCOMPLETE' : changed
        ? real ? 'RECOVERED_REAL_OWNER' : 'CLEARED_STALE_POINTER' : 'NO_CHANGE'
      await writeEvent(tx, {
        type: 'CUSTODY_SHIFT_RESET_REVIEW', shiftId: realShiftId,
        handoverId: pendingId, actorUserId: manager.userId,
        actorKind: 'MANAGER', authMethod: 'MANAGER_CUSTODY_PIN',
        epochBefore: state.epoch, epochAfter: nextEpoch,
        payload: { outcome, reason, previousState: state.state,
          previousRealShiftId: state.activeShiftId, actualRealShiftId: realShiftId,
          unfinishedHandoverId: pendingId, previousAmountsReused: false }
      })
      await auditOrThrow(tx, {
        action: 'CUSTODY_SHIFT_RESET', entity: 'CustodyShiftReset',
        entityId: realShiftId, userId: manager.userId,
        before: JSON.stringify({ state: state.state, shiftId: state.activeShiftId,
          unfinishedHandoverId: state.pendingHandoverId }),
        after: JSON.stringify({ outcome, state: nextState, shiftId: realShiftId,
          unfinishedHandoverId: pendingId, authMethod: 'MANAGER_CUSTODY_PIN' }),
        note: reason
      })
      return { outcome, state: nextState, activeShiftId: realShiftId }
    })
  },

  /**
   * Records an immutable boundary for a pre-custody orphan Shift. It never
   * creates a financial movement, custody count, CashSession, or new segment.
   * Opening the new drawer is deliberately a separate PIN/count action so the
   * witness cannot accidentally inherit historic financial responsibility.
   */
  async recoverLegacyOpenShifts(input: {
    userId: unknown
    password: unknown
    countedCash: unknown
    note?: unknown
    ackTextVersion: unknown
    idempotencyKey: unknown
    seenEpoch: unknown
    seenShiftIds: unknown
  }) {
    const actor = await this.verifyPin(input.userId, input.password)
    if (actor.role !== 'MANAGER' && actor.role !== 'CASHIER')
      throw new BusinessError('این نقش مجاز به ثبت بازیابی صندوق نیست.', 'NO_PERMISSION')
    const countedCash = asCash(input.countedCash, 'شمارش واقعی بازیابی')
    const ackTextVersion = recoveryAckVersion(input.ackTextVersion)
    const idempotencyKey = recoveryIdempotencyKey(input.idempotencyKey)
    const seenEpoch = recoverySeenEpoch(input.seenEpoch)
    const seenShiftIds = recoverySeenShiftIds(input.seenShiftIds)
    const note = String(input.note ?? '').trim()
    if (note.length > 1000) throw new BusinessError('یادداشت بازیابی نمی‌تواند بیشتر از ۱۰۰۰ نویسه باشد.', 'CUSTODY_RECOVERY_NOTE_INVALID')
    const fingerprint = recoveryFingerprint({ userId: actor.userId, countedCash, note, ackTextVersion, seenEpoch, seenShiftIds })
    const stores: any = prisma as any
    const existing = await stores.legacyShiftRecovery.findUnique({ where: { idempotencyKey } })
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new BusinessError('این کلید بازیابی قبلاً با اطلاعات دیگری استفاده شده است.', 'CUSTODY_RECOVERY_IDEMPOTENCY_MISMATCH')
      return { recoveryId: existing.id, replayed: true, differenceScope: existing.differenceScope }
    }

    /** Use the same PIN/count/reason exception as a fresh opening. Recovery
     * only records the old boundary; it does not create or appoint its owner. */
    await openingPlanForActor(prisma, actor, { count: countedCash, reason: note })
    const [state, legacy] = await Promise.all([ensureState(prisma), legacyOpenShifts(prisma)])
    if (state.state !== 'NO_SESSION' || Number(state.epoch) !== seenEpoch || !sameIds(legacy.map((row: any) => row.id), seenShiftIds))
      throw new BusinessError('وضعیت نشست‌های قدیمی هم‌زمان تغییر کرده است؛ صفحه را دوباره باز کنید.', 'CUSTODY_LEGACY_STALE')
    const evidence = await Promise.all(legacy.map((shift: any) => legacyEvidenceSnapshot(shift)))
    const expectedUnavailable = evidence.some((row: any) => row.expectedCalcStatus !== 'AVAILABLE')
    if ((legacy.length > 1 || countedCash === 0 || expectedUnavailable) && note.length < 10)
      throw new BusinessError('برای این بازیابی، یادداشت روشنِ حداقل ۱۰ حرف لازم است.', 'CUSTODY_RECOVERY_NOTE_REQUIRED')
    const single = evidence.length === 1
    const expected = single ? evidence[0].expectedCash : null
    const differenceScope = expectedUnavailable
      ? 'EXPECTED_UNAVAILABLE'
      : single
        ? 'SINGLE_SHIFT'
        : 'MULTI_SHIFT_UNATTRIBUTABLE'
    const provisionalDifference = single && expected != null ? countedCash - expected : null

    try {
      return await prisma.$transaction(async (tx: Client) => {
        /** Recheck the schedule exception inside the writer transaction. */
        const { offSchedule } = await openingPlanForActor(tx, actor, { count: countedCash, reason: note })
        const live = await ensureState(tx)
        const currentLegacy = await legacyOpenShifts(tx)
        if (live.state !== 'NO_SESSION' || Number(live.epoch) !== seenEpoch || !sameIds(currentLegacy.map((row: any) => row.id), seenShiftIds))
          throw new BusinessError('وضعیت نشست‌های قدیمی هم‌زمان تغییر کرده است؛ صفحه را دوباره باز کنید.', 'CUSTODY_LEGACY_STALE')
        for (const snapshot of evidence) {
          if (!(await legacyWatermarkStillMatches(tx, snapshot)))
            throw new BusinessError('گردش مالی یکی از نشست‌های قدیمی تغییر کرده است؛ شمارش را دوباره بررسی کنید.', 'CUSTODY_LEGACY_STALE')
        }
        const txStores: any = tx as any
        const replay = await txStores.legacyShiftRecovery.findUnique({ where: { idempotencyKey } })
        if (replay) {
          if (replay.requestFingerprint !== fingerprint)
            throw new BusinessError('این کلید بازیابی قبلاً با اطلاعات دیگری استفاده شده است.', 'CUSTODY_RECOVERY_IDEMPOTENCY_MISMATCH')
          return { recoveryId: replay.id, replayed: true, differenceScope: replay.differenceScope }
        }
        const now = new Date()
        const nextEpoch = Number(live.epoch) + 1
        const recovery = await txStores.legacyShiftRecovery.create({
          data: {
            idempotencyKey,
            requestFingerprint: fingerprint,
            witnessUserId: actor.userId,
            actorKind: 'LEGACY_RECOVERY_WITNESS',
            authMethod: 'CUSTODY_PIN',
            countedCash: BigInt(countedCash),
            expectedTotalSnapshot: expected == null ? null : BigInt(expected),
            provisionalDifference: provisionalDifference == null ? null : BigInt(provisionalDifference),
            differenceScope,
            ackTextVersion,
            note: note || null,
            epochBefore: Number(live.epoch),
            epochAfter: nextEpoch,
            operationalDay: toJalaliDate(now)
          }
        })
        for (const snapshot of evidence) {
          const closed = await tx.shift.updateMany({ where: { id: snapshot.shift.id, closedAt: null }, data: { closedAt: now } })
          if (closed.count !== 1) throw new BusinessError('یکی از نشست‌های قدیمی هم‌زمان تغییر کرده است؛ هیچ بازیابی ثبت نشد.', 'CUSTODY_STALE')
          await txStores.legacyShiftRecoveryItem.create({
            data: {
              recoveryId: recovery.id,
              shiftId: snapshot.shift.id,
              legacyUserId: snapshot.shift.userId ?? null,
              openedAtSnapshot: snapshot.shift.openedAt,
              lastActivityAt: snapshot.lastActivityAt,
              invoiceCountSnapshot: snapshot.invoiceCount,
              expectedCashSnapshot: snapshot.expectedCash == null ? null : BigInt(snapshot.expectedCash),
              expectedCalcStatus: snapshot.expectedCalcStatus,
              openingFloatSnapshot: snapshot.openingFloat,
              cashInSnapshot: snapshot.cashIn,
              cashOutSnapshot: snapshot.cashOut,
              closedAtWritten: now
            }
          })
          await auditOrThrow(tx, {
            action: AuditAction.SHIFT_CLOSE,
            entity: 'Shift',
            entityId: snapshot.shift.id,
            userId: actor.userId,
            after: JSON.stringify({ legacyRecoveryId: recovery.id, closedAt: now.toISOString(), preservedLegacyUserId: snapshot.shift.userId ?? null }),
            note: 'بستن نشست قدیمی از مسیر بازیابی رسمی حضانت؛ مسئولیت مالی گذشته منتقل نشده است.'
          })
          await writeEvent(tx, {
            type: 'LEGACY_SHIFT_RECOVERY_CLOSED',
            shiftId: snapshot.shift.id,
            legacyRecoveryId: recovery.id,
            actorUserId: actor.userId,
            actorKind: 'LEGACY_RECOVERY_WITNESS',
            authMethod: 'CUSTODY_PIN',
            epochBefore: Number(live.epoch),
            epochAfter: nextEpoch,
            payload: { expectedCalcStatus: snapshot.expectedCalcStatus, invoiceCount: snapshot.invoiceCount }
          })
        }
        const changed = await tx.custodyState.updateMany({
          where: { key: MAIN, state: 'NO_SESSION', activeShiftId: null, epoch: live.epoch },
          data: { epoch: nextEpoch, updatedAt: now }
        })
        if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ هیچ بازیابی ثبت نشد.', 'CUSTODY_STALE')
        await auditOrThrow(tx, {
          action: 'CUSTODY_LEGACY_RECOVERY',
          entity: 'LegacyShiftRecovery',
          entityId: recovery.id,
          userId: actor.userId,
          after: JSON.stringify({ shiftIds: seenShiftIds, countedCash, differenceScope, provisionalDifference }),
          note: 'شمارش شاهد برای بازیابی نشست‌های بازِ سیستم قدیم؛ بدون انتقال مسئولیت مالی گذشته.'
        })
        await writeEvent(tx, {
          type: 'LEGACY_RECOVERY_RECORDED',
          legacyRecoveryId: recovery.id,
          actorUserId: actor.userId,
          actorKind: 'LEGACY_RECOVERY_WITNESS',
          authMethod: 'CUSTODY_PIN',
          epochBefore: Number(live.epoch),
          epochAfter: nextEpoch,
          payload: { shiftIds: seenShiftIds, differenceScope, expectedAvailable: !expectedUnavailable }
        })
        if (offSchedule) await writeEvent(tx, {
          type: 'LEGACY_RECOVERY_UNSCHEDULED', legacyRecoveryId: recovery.id,
          actorUserId: actor.userId, actorKind: 'LEGACY_RECOVERY_WITNESS', authMethod: 'CUSTODY_PIN',
          epochBefore: Number(live.epoch), epochAfter: nextEpoch,
          payload: { ...offSchedule, countKind: 'LEGACY_CASH' }
        })
        return { recoveryId: recovery.id, replayed: false, differenceScope, provisionalDifference }
      })
    } catch (error: any) {
      /** A unique key can race after the optimistic pre-read. Re-read only the
       * same immutable request; different content with the same key never wins. */
      if (error?.code === 'P2002' || /unique constraint/i.test(String(error?.message ?? ''))) {
        const raced = await stores.legacyShiftRecovery.findUnique({ where: { idempotencyKey } })
        if (raced?.requestFingerprint === fingerprint)
          return { recoveryId: raced.id, replayed: true, differenceScope: raced.differenceScope }
      }
      throw error
    }
  },

  async open(input: { userId: unknown; password: unknown; countedCash?: unknown; operationalTotal?: unknown; note?: unknown; boundaryReason?: unknown }) {
    const actor = await this.verifyPin(input.userId, input.password)
    if (actor.role !== 'MANAGER' && actor.role !== 'CASHIER') throw new BusinessError('این نقش مجاز به تحویل‌گیری صندوق نیست.', 'NO_PERMISSION')
    /** Aggregate mode is additive and deliberately does not reinterpret the
     * cash-only field or opening float used by historical cash-close rows. */
    const operationalTotal = input.operationalTotal == null ? null : asCash(input.operationalTotal, 'مجموع کشو و کارت‌خوان')
    const countedCash = input.countedCash == null ? null : asCash(input.countedCash, 'شمارش نقدی')
    // The next worker may arrive after days without running status() first.
    // Close ONLY an actually expired prior Shift as SYSTEM evidence; never ask
    // that absent worker to log in or create missed planned shifts.
    await this.ensureRolledOver()
    const openingState = await ensureState(prisma)
    if (openingState.state !== 'NO_SESSION') throw new BusinessError('صندوق هم‌اکنون یک مسئول فعال دارد.', 'SESSION_ALREADY_OPEN')
    const blueOpening = operationalTotal == null ? null : await blueReferenceForOpening(openingState)
    return prisma.$transaction(async (tx: Client) => {
      const recovery = await pendingLegacyOpening(tx)
      const { cfg, scheduling, plan, offSchedule } = await openingPlanForActor(tx, actor, {
        // Only the explicit, already-recorded legacy recovery may use the
        // historical cash-only count. Every other off-schedule opening needs
        // the public drawer+POS total; a forged old countedCash is not proof.
        count: recovery ? countedCash : operationalTotal,
        reason: input.note
      })
      const state = await ensureState(tx)
      if (state.state !== 'NO_SESSION' || state.epoch !== openingState.epoch ||
          (blueOpening && (Number(state.financialRevision ?? 0) !== blueOpening.financialRevision ||
            toJalaliDate(new Date()) !== blueOpening.today)))
        throw new BusinessError('صندوق یا مرجع مالی هنگام افتتاح تغییر کرد؛ با شمارش تازه تلاش کنید.', 'CUSTODY_STALE')
      const legacy = await legacyOpenShifts(tx)
      if (legacy.length)
        throw new BusinessError('یک یا چند نشست بازِ سیستم قدیم نیازمند بازیابی هستند؛ ابتدا بازیابی رسمی حضانت را ثبت کنید.', 'CUSTODY_LEGACY_OPEN_SHIFT')
      if (countedCash == null && operationalTotal == null &&
          await tx.custodyResolution.findFirst({ where: { status: 'OPEN' }, select: { id: true } }))
        throw new BusinessError('بعد از وقفه، شمارش واقعیِ خودتان برای افتتاح الزامی است؛ صفر را صریح بنویسید.', 'CUSTODY_RECOVERY_COUNT_REQUIRED')
      /** A remaining open Shift with custody metadata is an actual broken live
       * custody invariant, not a migratable legacy row. Keep this hard stop. */
      if (await shiftService.anyOpenShift(tx)) throw new BusinessError('وضعیت حضانت صندوق ناسازگار است؛ ابتدا از مدیر بخواهید آن را بررسی کند.', 'CUSTODY_INVARIANT_BROKEN')
      if (recovery && countedCash == null)
        throw new BusinessError('پس از بازیابی نشست قدیمی، شمارش افتتاح مستقل صندوق جدید الزامی است.', 'CUSTODY_RECOVERY_OPENING_COUNT_REQUIRED')
      if (recovery && operationalTotal != null)
        throw new BusinessError('بازیابی Shift قدیمی فقط با مسیر رسمی شمارش نقدیِ موجود قابل افتتاح است؛ مبلغ تجمیعی حضانت جای دادهٔ تاریخی را نمی‌گیرد.', 'CUSTODY_LEGACY_OPEN_SHIFT')
      const boundaryReason = String(input.boundaryReason ?? '').trim()
      if (boundaryReason.length > 1000)
        throw new BusinessError('دلیل اختلاف شمارش نمی‌تواند بیشتر از ۱۰۰۰ نویسه باشد.', 'BOUNDARY_REASON_INVALID')
      if (recovery && countedCash != null && Number(recovery.countedCash) !== countedCash && boundaryReason.length < 10)
        throw new BusinessError('چون شمارش افتتاح با شمارش بازیابی متفاوت است، دلیل روشنِ حداقل ۱۰ حرف وارد کنید.', 'BOUNDARY_REASON_REQUIRED')
      const beforeEpoch = Number(state.epoch)
      const shift = await shiftService.createSession(tx, { staffId: actor.userId, staffConfirmed: true, actorId: actor.userId, mode: 'MANUAL', note: String(input.note ?? '').trim() || null })
      const nextEpoch = beforeEpoch + 1
      let count: any = null
      if (countedCash != null) {
        count = await tx.custodyCount.create({ data: { shiftId: shift.id, kind: 'OPENING', countedCash: BigInt(countedCash), countedByUserId: actor.userId, authMethod: 'CUSTODY_PIN', epochAtCount: nextEpoch, idempotencyKey: `open:${shift.id}`, operationalDay: toJalaliDate(new Date()) } })
        if (countedCash > 0) await recordCashMovement(tx, { amount: countedCash, type: CashMovementType.OPENING_FLOAT, shiftId: shift.id, userId: actor.userId, refType: 'CustodyOpen', refId: count.id, description: 'موجودی اول صندوق حضانت' })
      }
      await tx.custodyShiftMeta.create({ data: { shiftId: shift.id, custodianUserId: actor.userId, openAuth: 'CUSTODY_PIN', openCountId: count?.id ?? null, templateId: plan?.templateId ?? null, planId: plan?.legacyPlanId ?? null, planTitle: plan?.title ?? null, scheduledEndAt: plan?.scheduledEndAt ?? null, scheduleSnapshotJson: scheduleSnapshotJson(plan, scheduling, cfg), rolloverAt: rolloverAt(new Date(), cfg, scheduling, plan), dayCutoverSnapshot: cfg.dayCutoverMinute, operationalDay: toJalaliDate(new Date()), countStatus: countedCash == null && operationalTotal == null ? 'COUNT_PENDING' : 'COUNTED', openEpoch: nextEpoch } })
      if (blueOpening && operationalTotal != null) await recordBlueSnapshot(tx, {
        shiftId: shift.id, role: 'OPENING', actorUserId: actor.userId,
        count: observationOf(operationalTotal, false), reference: blueOpening.reference,
        referenceFromDay: blueOpening.fromDay, referenceToDay: blueOpening.today,
        scopeKind: blueOpening.scopeKind, financialRevision: blueOpening.financialRevision,
        epochAtCount: nextEpoch, prior: null, idempotencyKey: `blue-opening:${shift.id}`
      })
      /** A new combined-money opening has its OWN immutable blue snapshot.
       * Never additionally chain it to a historical aggregate-v2 opening:
       * that old cross-shift chain can create a second discrepancy case when
       * the next person counts the same amount after a real final close.
       * Existing aggregate-v2 history is left completely untouched. */
      let legacyRecoveryId: number | null = null
      if (recovery) {
        if (!count) throw new BusinessError('شمارش افتتاح بازیابی ثبت نشد؛ صندوق باز نشد.', 'CUSTODY_RECOVERY_OPENING_COUNT_REQUIRED')
        legacyRecoveryId = Number(recovery.id)
        const gapCash = countedCash! - Number(recovery.countedCash)
        const txStores: any = tx as any
        await txStores.legacyRecoveryOpeningLink.create({
          data: {
            recoveryId: legacyRecoveryId,
            openingShiftId: shift.id,
            openingCountId: count.id,
            recoveryCountedCash: recovery.countedCash,
            openingCountedCash: BigInt(countedCash!),
            gapCash: BigInt(gapCash),
            reason: gapCash === 0 ? null : boundaryReason,
            openerUserId: actor.userId,
            authMethod: 'CUSTODY_PIN'
          }
        })
        await writeEvent(tx, {
          type: 'LEGACY_RECOVERY_OPENING_LINKED',
          shiftId: shift.id,
          legacyRecoveryId,
          actorUserId: actor.userId,
          actorKind: 'CUSTODIAN',
          authMethod: 'CUSTODY_PIN',
          epochBefore: beforeEpoch,
          epochAfter: nextEpoch,
          payload: { recoveryId: legacyRecoveryId, gapCash, hasReason: gapCash !== 0 }
        })
        await auditOrThrow(tx, {
          action: 'CUSTODY_LEGACY_OPENING_LINK',
          entity: 'LegacyRecoveryOpeningLink',
          entityId: shift.id,
          userId: actor.userId,
          after: JSON.stringify({ recoveryId: legacyRecoveryId, openingShiftId: shift.id, openingCountId: count.id, gapCash }),
          note: gapCash === 0 ? 'افتتاح صندوق پس از بازیابی legacy با همان شمارش ثبت شد.' : 'افتتاح صندوق پس از بازیابی legacy با اختلاف شمارش ثبت شد؛ دلیل در سند مرزی محفوظ است.'
        })
      }
      const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'NO_SESSION', epoch: beforeEpoch }, data: { state: 'ACTIVE', activeShiftId: shift.id, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'OPEN', shiftId: shift.id, actorUserId: actor.userId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN', epochBefore: beforeEpoch, epochAfter: nextEpoch, payload: { counted: countedCash != null || operationalTotal != null, aggregateBoundary: operationalTotal != null, ...(offSchedule ? { offSchedule: true } : {}) } })
      if (offSchedule) {
        // This is an exception to the roster, not a transfer of the previous
        // worker's responsibility or a change to their stored schedule.
        await writeEvent(tx, {
          type: 'OPEN_UNSCHEDULED', shiftId: shift.id,
          actorUserId: actor.userId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN',
          epochBefore: beforeEpoch, epochAfter: nextEpoch,
          payload: { ...offSchedule, countKind: recovery ? 'LEGACY_CASH' : 'DRAWER_AND_POS', previousResponsibilityTransferred: false }
        })
        await auditOrThrow(tx, {
          action: 'CUSTODY_UNSCHEDULED_OPEN', entity: 'Shift', entityId: shift.id,
          userId: actor.userId, after: JSON.stringify({ ...offSchedule, countKind: recovery ? 'LEGACY_CASH' : 'DRAWER_AND_POS' }),
          note: offSchedule.reason
        })
      }
      return { shiftId: shift.id, epoch: nextEpoch, countStatus: countedCash == null && operationalTotal == null ? 'COUNT_PENDING' : 'COUNTED' }
    })
  },

  /** Lazy rollover is invoked by custody status/financial entry, never by a
   * timer that could silently move money. It closes only the operational Shift;
   * a separate PIN-authenticated morning witness or manager later records the
   * physical count and financial snapshot. */
  async ensureRolledOver(now = new Date()) {
    const state = await ensureState(prisma)
    // An interrupted pre-blue recount can remain durably frozen across a power
    // outage. Its ACTUAL Shift still expires: do not require either absent PIN
    // merely because the old acceptance was between its two transactions.
    if (!['ACTIVE', 'HANDOVER_PENDING', 'HANDOVER_RECOUNT'].includes(state.state) || !state.activeShiftId) return null
    const [meta, scheduling] = await Promise.all([
      prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } }),
      shiftSchedulingOf(prisma)
    ])
    if (!meta || expiryAt(meta, scheduling) > now) return null
    const result = await prisma.$transaction(async (tx: Client) => {
      const live = await ensureState(tx)
      const [liveMeta, liveScheduling] = await Promise.all([
        live.activeShiftId ? tx.custodyShiftMeta.findUnique({ where: { shiftId: live.activeShiftId } }) : null,
        shiftSchedulingOf(tx)
      ])
      if (!liveMeta || !['ACTIVE', 'HANDOVER_PENDING', 'HANDOVER_RECOUNT'].includes(live.state) || live.activeShiftId !== state.activeShiftId || live.epoch !== state.epoch || expiryAt(liveMeta, liveScheduling) > now) return null
      const shift = await tx.shift.findUnique({ where: { id: live.activeShiftId } })
      if (!shift || shift.closedAt) return null
      // The lazy detector may run the following morning. Financial attribution
      // must still stop at the planned scheduled end + configured overtime (or
      // the persisted legacy cutover fallback), rather than at detection time.
      const effectiveEndAt = expiryAt(liveMeta, liveScheduling)
      const nextEpoch = Number(live.epoch) + 1
      let handoverId: number | null = null
      let priorHandoverStatus: string | null = null
      let priorResolutionKind: string | null = null
      if (live.state === 'HANDOVER_RECOUNT' && !live.pendingHandoverId)
        // Keep the manager reset route usable for an actually corrupt pointer;
        // do not fabricate a handover or strand reset behind this read.
        return null
      if ((live.state === 'HANDOVER_PENDING' || live.state === 'HANDOVER_RECOUNT') && live.pendingHandoverId) {
        handoverId = live.pendingHandoverId
        const prior = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
        // Only an unfinished, genuinely linked attempt may be retired. An
        // inconsistent pointer must not silently close an unrelated Shift.
        if (live.state === 'HANDOVER_RECOUNT' && (!prior || prior.fromShiftId !== shift.id || prior.fromUserId !== shift.userId ||
            !['PENDING', 'RECEIVER_COUNTED', 'EMERGENCY_RECOUNT', 'MASTER_OVERRIDE_RECOUNT'].includes(prior.status)))
          return null // corrupted evidence is manager-reset only, never automatic attribution
        priorHandoverStatus = prior?.status ?? null
        priorResolutionKind = prior?.resolutionKind ?? null
        await tx.custodyHandover.update({ where: { id: handoverId }, data: {
          status: 'EXPIRED_UNRESOLVED',
          // Preserve the origin of a frozen emergency/override witness. The
          // expired status and audit event already describe its final outcome.
          resolutionKind: live.state === 'HANDOVER_RECOUNT' && priorResolutionKind ? priorResolutionKind : 'EXPIRED_AT_ROLLOVER',
          finalCustodianUserId: null, finishedAt: now, version: { increment: 1 }
        } })
      }
      await shiftService.closeInTx(tx, { shiftId: shift.id, userId: shift.userId ?? null, note: 'پایان برنامه/روز عملیاتی؛ نیازمند شمارش شاهد صبح' })
      await tx.shift.update({ where: { id: shift.id }, data: { closedAt: effectiveEndAt } })
      await tx.custodyShiftMeta.update({ where: { shiftId: shift.id }, data: { endKind: handoverId ? 'EXPIRED_UNRESOLVED' : 'UNRESOLVED', endedAt: effectiveEndAt } })
      const resolution = await tx.custodyResolution.create({ data: { shiftId: shift.id, status: 'OPEN', evidence: 'NONE', differenceAttribution: 'PENDING_DECISION' } })
      const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: live.state, activeShiftId: shift.id, epoch: live.epoch }, data: { state: 'NO_SESSION', activeShiftId: null, pendingHandoverId: null, epoch: nextEpoch, updatedAt: now } })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ rollover ثبت نشد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'ROLLOVER_UNRESOLVED', shiftId: shift.id, handoverId, resolutionId: resolution.id, actorKind: 'SYSTEM', epochBefore: live.epoch, epochAfter: nextEpoch, payload: { resolutionId: resolution.id, effectiveAt: effectiveEndAt.toISOString(), expiryKind: liveMeta.templateId ? 'SCHEDULED_END_PLUS_OVERTIME' : 'CUTOVER_FALLBACK', previousState: live.state, priorHandoverStatus, priorResolutionKind } })
      return { resolutionId: resolution.id, shiftId: shift.id }
    })
    if (result) {
      /** The shift is closed, so this read cannot affect morning attribution.
       * Snapshot completion is retriable; it never changes any money formula. */
      try {
        const expected = await cashboxService.expected({ shiftId: result.shiftId })
        await prisma.custodyResolution.updateMany({ where: { id: result.resolutionId, status: 'OPEN' }, data: { nightExpectedCash: BigInt(Number(expected.expectedCash)) } })
      } catch {
        // Morning-witness/manager recovery still has the canonical Cashbox
        // calculation; do not turn a reporting read failure into a new sales block.
      }
    }
    return result
  },

  async resolveUnresolved(input: { resolutionId: unknown; managerUserId: unknown; managerPassword: unknown; countedCash?: unknown; reason: unknown; attribution?: unknown; attributedToUserId?: unknown }) {
    const resolutionId = asSafeId(input.resolutionId, 'شناسه پرونده شب')
    const manager = await this.verifyPin(input.managerUserId, input.managerPassword, { requireManager: true })
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 10) throw new BusinessError('برای تعیین تکلیف شبِ بی‌پاسخ، دلیل روشن و کامل بنویسید.')
    const resolution = await prisma.custodyResolution.findUnique({ where: { id: resolutionId } })
    if (!resolution || resolution.status !== 'OPEN') throw new BusinessError('این پرونده قبلاً تعیین تکلیف شده یا پیدا نشد.')
    const shift = await prisma.shift.findUnique({ where: { id: resolution.shiftId } })
    if (!shift?.closedAt) throw new BusinessError('نشست شب برای تعیین تکلیف آماده نیست.', 'CUSTODY_INVARIANT_BROKEN')
    const countedCash = input.countedCash == null ? null : asCash(input.countedCash, 'شمارش نقدی')
    const attribution = ['UNASSIGNED', 'CUSTODIAN_ACK', 'MANAGER_DECISION', 'DIFFERENCE_UNKNOWN'].includes(String(input.attribution)) ? String(input.attribution) : 'UNASSIGNED'
    const attributedToUserId = input.attributedToUserId == null ? null : asSafeId(input.attributedToUserId, 'شناسه شخص مسئول')
    return cashboxService.close({
      shiftId: shift.id,
      explicitShift: true,
      closeShift: false,
      countedCash,
      note: reason,
      userId: manager.userId,
      custodyEffectiveTo: new Date(shift.closedAt),
      // `shift` is already closed by rollover and belongs to an absent prior
      // custodian. This is server-only; IPC cannot supply this bypass marker.
      internalCustodyRecovery: true,
      afterCloseInTx: async (tx: Client, session: any) => {
        const changed = await tx.custodyResolution.updateMany({ where: { id: resolutionId, status: 'OPEN', shiftId: shift.id }, data: { status: 'RESOLVED', cashSessionId: session.id, decisionByUserId: manager.userId, decisionReason: reason, differenceAttribution: attribution, attributedToUserId, resolvedAt: new Date() } })
        if (changed.count !== 1) throw new BusinessError('پرونده شب هم‌زمان تغییر کرد؛ عملیات ثبت نشد.', 'CUSTODY_STALE')
        await tx.custodyShiftMeta.updateMany({ where: { shiftId: shift.id, endKind: { in: ['UNRESOLVED', 'EXPIRED_UNRESOLVED', 'CUSTODIAN_ARCHIVED_UNRESOLVED'] } }, data: { endKind: 'FINAL_CLOSE', cashSessionId: session.id } })
        await writeEvent(tx, { type: 'UNRESOLVED_RESOLVED', shiftId: shift.id, resolutionId, actorUserId: manager.userId, actorKind: 'MANAGER', authMethod: 'MANAGER_CUSTODY_PIN', payload: { cashSessionId: session.id, attribution } })
      }
    } as any)
  },

  /**
   * Archive/deactivate is not allowed to strand an active drawer behind an
   * inactive person's PIN. The manager-session Staff service supplies the
   * in-transaction archive callback; this service owns the financial freeze,
   * expected-ledger snapshot and unresolved physical-count recovery record.
   *
   * No client-provided actor establishes custody here: the outgoing custodian
   * is read from `CustodyShiftMeta`, while the archive actor is deliberately
   * recorded only as the already-authorized global manager session.
   */
  async archiveActiveCustodian<T>(input: { userId: unknown; reason: unknown; archiveInTx: (tx: Client) => Promise<T> }) {
    const userId = asSafeId(input.userId, 'شناسه کارمند')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 10)
      throw new BusinessError('برای آرشیو مسئول فعال صندوق، دلیل روشنِ حداقل ۱۰ حرف وارد کنید.', 'CUSTODIAN_ARCHIVE_REASON_REQUIRED')

    const frozen = await prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      if (!state.activeShiftId) throw new BusinessError('این کارمند مسئول فعال صندوق نیست.', 'ACTIVE_CUSTODIAN_REQUIRED')
      const [shift, meta] = await Promise.all([
        tx.shift.findUnique({ where: { id: state.activeShiftId } }),
        tx.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })
      ])
      if (!shift || shift.closedAt || !shift.userId || !meta || meta.custodianUserId !== userId || shift.userId !== userId)
        throw new BusinessError('این کارمند مسئول فعال صندوق نیست.', 'ACTIVE_CUSTODIAN_REQUIRED')
      const existing = await tx.custodyResolution.findUnique({ where: { shiftId: shift.id } })
      if (state.state === 'CUSTODIAN_ARCHIVE_FREEZE') {
        if (!existing || existing.status !== 'ARCHIVE_FREEZE' || existing.evidence !== 'CUSTODIAN_ARCHIVED' || String(existing.decisionReason ?? '') !== reason)
          throw new BusinessError('آرشیو حضانت در حال ثبت است؛ فقط با همان دلیل ثبت‌شده قابل ادامه است.', 'CUSTODIAN_ARCHIVE_IN_PROGRESS')
        return { shiftId: shift.id, epoch: Number(state.epoch), resolutionId: existing.id, resumed: true }
      }
      if (state.state !== 'ACTIVE')
        throw new BusinessError('برای آرشیو این کارمند، ابتدا تحویل یا عملیات در حال انجام صندوق را تعیین تکلیف کنید.', 'CUSTODIAN_ARCHIVE_BLOCKED')
      if (existing && !['ARCHIVE_ABORTED'].includes(existing.status))
        throw new BusinessError('برای این بخش صندوق از قبل پروندهٔ بازیابی وجود دارد.', 'CUSTODY_INVARIANT_BROKEN')
      if (existing && String(existing.decisionReason ?? '') !== reason)
        throw new BusinessError('تلاش آرشیو پیشین با دلیل دیگری ثبت شده است؛ برای حفظ تاریخچه همان دلیل را دوباره وارد کنید.', 'CUSTODIAN_ARCHIVE_RETRY_MISMATCH')
      const freezeEpoch = Number(state.epoch) + 1
      const resolution = existing
        ? await tx.custodyResolution.update({ where: { id: existing.id }, data: { status: 'ARCHIVE_FREEZE', evidence: 'CUSTODIAN_ARCHIVED', differenceAttribution: 'PENDING_DECISION', decisionReason: reason, resolvedAt: null } })
        : await tx.custodyResolution.create({ data: { shiftId: shift.id, status: 'ARCHIVE_FREEZE', evidence: 'CUSTODIAN_ARCHIVED', differenceAttribution: 'PENDING_DECISION', decisionReason: reason } })
      const changed = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'ACTIVE', activeShiftId: shift.id, epoch: state.epoch },
        data: { state: 'CUSTODIAN_ARCHIVE_FREEZE', epoch: freezeEpoch, updatedAt: new Date() }
      })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ آرشیو مسئول ثبت نشد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'CUSTODIAN_ARCHIVE_FREEZE', shiftId: shift.id, resolutionId: resolution.id, actorKind: 'GLOBAL_MANAGER', authMethod: 'MANAGER_SESSION', epochBefore: state.epoch, epochAfter: freezeEpoch, payload: { targetUserId: userId, reason } })
      return { shiftId: shift.id, epoch: freezeEpoch, resolutionId: resolution.id, resumed: false }
    })

    const abort = async (failure: string) => {
      await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'CUSTODIAN_ARCHIVE_FREEZE' || state.activeShiftId !== frozen.shiftId || state.epoch !== frozen.epoch) return
        const resolution = await tx.custodyResolution.findUnique({ where: { id: frozen.resolutionId } })
        if (!resolution || resolution.status !== 'ARCHIVE_FREEZE') return
        const nextEpoch = Number(state.epoch) + 1
        await tx.custodyResolution.update({ where: { id: resolution.id }, data: { status: 'ARCHIVE_ABORTED' } })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'CUSTODIAN_ARCHIVE_FREEZE', activeShiftId: frozen.shiftId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: frozen.shiftId, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count === 1)
          await writeEvent(tx, { type: 'CUSTODIAN_ARCHIVE_ABORTED', shiftId: frozen.shiftId, resolutionId: resolution.id, actorKind: 'GLOBAL_MANAGER', authMethod: 'MANAGER_SESSION', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { targetUserId: userId, failure } })
      })
    }

    let expectedCash: number
    try {
      expectedCash = Number((await cashboxService.expected({ shiftId: frozen.shiftId })).expectedCash)
    } catch (error) {
      await abort('EXPECTED_CALCULATION_FAILED')
      throw error
    }

    try {
      return await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'CUSTODIAN_ARCHIVE_FREEZE' || state.activeShiftId !== frozen.shiftId || state.epoch !== frozen.epoch)
          throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ آرشیو مسئول ثبت نشد.', 'CUSTODY_STALE')
        const [shift, meta, resolution] = await Promise.all([
          tx.shift.findUnique({ where: { id: frozen.shiftId } }),
          tx.custodyShiftMeta.findUnique({ where: { shiftId: frozen.shiftId } }),
          tx.custodyResolution.findUnique({ where: { id: frozen.resolutionId } })
        ])
        if (!shift || shift.closedAt || shift.userId !== userId || !meta || meta.custodianUserId !== userId || !resolution || resolution.status !== 'ARCHIVE_FREEZE')
          throw new BusinessError('اطلاعات آرشیو مسئول صندوق ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
        const nextEpoch = Number(state.epoch) + 1
        const closed = await shiftService.closeInTx(tx, { shiftId: shift.id, userId, note: `آرشیو مسئول فعال صندوق؛ نیازمند شمارش بازیابی: ${reason}` })
        await tx.custodyShiftMeta.update({ where: { shiftId: shift.id }, data: { endKind: 'CUSTODIAN_ARCHIVED_UNRESOLVED', endedAt: closed.closedAt, countStatus: 'COUNT_PENDING' } })
        await tx.custodyResolution.update({ where: { id: resolution.id }, data: { status: 'OPEN', nightExpectedCash: BigInt(expectedCash), evidence: 'CUSTODIAN_ARCHIVED', differenceAttribution: 'PENDING_DECISION' } })
        const archived = await input.archiveInTx(tx)
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'CUSTODIAN_ARCHIVE_FREEZE', activeShiftId: shift.id, epoch: state.epoch }, data: { state: 'NO_SESSION', activeShiftId: null, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ آرشیو مسئول ثبت نشد.', 'CUSTODY_STALE')
        await writeEvent(tx, { type: 'CUSTODIAN_ARCHIVED_UNRESOLVED', shiftId: shift.id, resolutionId: resolution.id, actorKind: 'GLOBAL_MANAGER', authMethod: 'MANAGER_SESSION', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { targetUserId: userId, reason, expectedCash } })
        return { archived, resolutionId: resolution.id, shiftId: shift.id, expectedCash, resumed: frozen.resumed }
      })
    } catch (error) {
      try { await abort('COMPLETION_FAILED') } catch { /* retain the original completion failure */ }
      throw error
    }
  },

  /**
   * Morning recovery for an unattended/expired custody segment. The prior
   * custodian is deliberately not asked to authenticate, and neither is a
   * manager: an active cashier or manager proves their own identity with their
   * PIN and witnesses the physical count. This closes only the old financial
   * segment; opening a new drawer remains a separate PIN/count operation.
   */
  async recoverUnattended(input: { resolutionId: unknown; userId: unknown; password: unknown; countedCash: unknown; note?: unknown }) {
    const resolutionId = asSafeId(input.resolutionId, 'شناسه پرونده شب')
    const witness = await this.verifyPin(input.userId, input.password)
    if (witness.role !== 'MANAGER' && witness.role !== 'CASHIER')
      throw new BusinessError('این نقش مجاز به ثبت شمارش شاهد صبح نیست.', 'NO_PERMISSION')
    const countedCash = asCash(input.countedCash, 'شمارش شاهد صبح')
    const note = String(input.note ?? '').trim() || undefined
    const resolution = await prisma.custodyResolution.findUnique({ where: { id: resolutionId } })
    if (!resolution || resolution.status !== 'OPEN') throw new BusinessError('این پرونده شب قبلاً تعیین تکلیف شده یا پیدا نشد.', 'RECOVERY_NOT_OPEN')
    const shift = await prisma.shift.findUnique({ where: { id: resolution.shiftId } })
    if (!shift?.closedAt) throw new BusinessError('پرونده فقط پس از بسته‌شدن نشست منقضی قابل بازیابی است.', 'CUSTODY_INVARIANT_BROKEN')
    const archivedCustodian = resolution.evidence === 'CUSTODIAN_ARCHIVED'

    return cashboxService.close({
      shiftId: shift.id,
      explicitShift: true,
      closeShift: false,
      countedCash,
      note,
      userId: witness.userId,
      custodyEffectiveTo: new Date(shift.closedAt),
      // The old segment is already closed by rollover and its owner may be
      // absent. This marker is stripped from every IPC payload.
      internalCustodyRecovery: true,
      afterCloseInTx: async (tx: Client, session: any) => {
        const live = await tx.custodyResolution.findUnique({ where: { id: resolutionId } })
        if (!live || live.status !== 'OPEN' || live.shiftId !== shift.id)
          throw new BusinessError('پرونده شب هم‌زمان تغییر کرد؛ شمارش شاهد ثبت نشد.', 'CUSTODY_STALE')
        const count = await tx.custodyCount.create({
          data: {
            shiftId: shift.id,
            kind: archivedCustodian ? 'ARCHIVED_CUSTODIAN_WITNESS' : 'MORNING_WITNESS',
            countedCash: BigInt(countedCash),
            expectedCash: session.expectedCash,
            differenceCash: session.cashDifference,
            countedByUserId: witness.userId,
            authMethod: 'CUSTODY_PIN',
            note: note ?? null,
            epochAtCount: Number((await ensureState(tx)).epoch),
            idempotencyKey: `morning-witness:${resolutionId}:${session.id}`,
            operationalDay: toJalaliDate(new Date())
          }
        })
        const changed = await tx.custodyResolution.updateMany({
          where: { id: resolutionId, status: 'OPEN', shiftId: shift.id },
          data: {
            status: 'RESOLVED',
            nightExpectedCash: live.nightExpectedCash ?? session.expectedCash,
            morningWitnessCountId: count.id,
            provisionalDifference: session.cashDifference,
            evidence: archivedCustodian ? 'CUSTODIAN_ARCHIVED_RECOVERED' : 'MORNING_WITNESS',
            differenceAttribution: 'UNASSIGNED',
            cashSessionId: session.id,
            resolvedAt: new Date()
          }
        })
        if (changed.count !== 1) throw new BusinessError('پرونده شب هم‌زمان تغییر کرد؛ شمارش شاهد ثبت نشد.', 'CUSTODY_STALE')
        await tx.custodyShiftMeta.updateMany({ where: { shiftId: shift.id, endKind: { in: ['UNRESOLVED', 'EXPIRED_UNRESOLVED', 'CUSTODIAN_ARCHIVED_UNRESOLVED'] } }, data: { endKind: archivedCustodian ? 'CUSTODIAN_ARCHIVED_RECOVERED' : 'RECOVERED_MORNING_WITNESS', cashSessionId: session.id } })
        await writeEvent(tx, {
          type: archivedCustodian ? 'CUSTODIAN_ARCHIVE_RECOVERED' : 'UNATTENDED_RECOVERED',
          shiftId: shift.id,
          resolutionId,
          actorUserId: witness.userId,
          actorKind: archivedCustodian ? 'ARCHIVE_RECOVERY_WITNESS' : 'MORNING_WITNESS',
          authMethod: 'CUSTODY_PIN',
          payload: { cashSessionId: session.id, countId: count.id, expectedCash: session.expectedCash, countedCash, differenceCash: session.cashDifference, archivedCustodian }
        })
      }
    } as any)
  },

  async finalClose(input: { password: unknown; countedCash?: unknown; operationalTotal?: unknown; note?: unknown; dispositions?: unknown }) {
    const state = await ensureState(prisma)
    if (state.state !== 'ACTIVE' || !state.activeShiftId) throw new BusinessError('نشست فعالی برای بستن نهایی وجود ندارد.', 'NO_OPEN_SESSION')
    const meta = await prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })
    if (!meta) throw new BusinessError('اطلاعات حضانت نشست فعلی ناقص است.', 'CUSTODY_INVARIANT_BROKEN')
    const actor = await this.verifyPin(meta.custodianUserId, input.password)
    const operationalTotal = input.operationalTotal == null ? null : asCash(input.operationalTotal, 'مجموع کشو و کارت‌خوان در بستن نهایی')
    if (operationalTotal != null) return commitBlueFinalClose({
      shiftId: state.activeShiftId, actorUserId: actor.userId, count: operationalTotal,
      note: String(input.note ?? '').trim()
    })
    /** Compatibility for historic direct cash-only closings. Public IPC
     * strips `countedCash`: all new combined-money closes use the non-freezing
     * immutable blue path above. */
    const countedCash = asCash(input.countedCash, 'شمارش نهایی نقدی')
    const rawDispositions = Array.isArray(input.dispositions) ? input.dispositions : [{ kind: 'KEEP_IN_DRAWER', amount: countedCash }]
    const dispositions = rawDispositions.map((row: any, index: number) => {
      const kind = String(row?.kind ?? '')
      if (!['KEEP_IN_DRAWER', 'TO_MANAGER', 'BANK_OR_SAFE'].includes(kind)) throw new BusinessError('نوع تعیین تکلیف پول نامعتبر است.')
      const amount = asCash(row?.amount, 'مبلغ تعیین تکلیف پول')
      const recipientUserId = row?.recipientUserId == null ? null : asSafeId(row.recipientUserId, 'شناسه گیرنده')
      if (kind === 'TO_MANAGER' && !recipientUserId) throw new BusinessError('برای تحویل پول به مدیر، گیرنده را مشخص کنید.')
      return { kind, amount, recipientUserId, destinationLabel: String(row?.destinationLabel ?? '').trim().slice(0, 160) || null, trackingNo: String(row?.trackingNo ?? '').trim().slice(0, 160) || null, allocationKey: `final:${index}:${kind}` }
    })
    const managerRecipientIds = [...new Set(dispositions.filter((row: any) => row.kind === 'TO_MANAGER').map((row: any) => row.recipientUserId))]
    if (managerRecipientIds.length) {
      const recipients = await prisma.user.findMany({ where: { id: { in: managerRecipientIds as number[] }, role: 'MANAGER', isActive: true }, select: { id: true } })
      if (recipients.length !== managerRecipientIds.length) throw new BusinessError('پول فقط می‌تواند به مدیر فعالِ مشخص تحویل شود.')
    }
    if (dispositions.reduce((sum: number, row: any) => sum + row.amount, 0) !== countedCash)
      throw new BusinessError('جمع تعیین تکلیف پول باید دقیقاً با مبلغ شمرده‌شده صندوق برابر باشد.')
    const fence: CustodyFence = { epoch: Number(state.epoch), expectedShiftId: state.activeShiftId, expectedActorUserId: actor.userId }
    return cashboxService.close({
      shiftId: state.activeShiftId,
      explicitShift: true,
      countedCash,
      note: String(input.note ?? '').trim() || undefined,
      userId: actor.userId,
      afterCloseInTx: async (tx: Client, session: any) => {
        await this.assertFenceInTx(tx, fence, { allowClosedShift: true })
        const live = await ensureState(tx)
        const nextEpoch = Number(live.epoch) + 1
        const count = await tx.custodyCount.create({ data: { shiftId: state.activeShiftId, kind: 'CLOSING', countedCash: BigInt(countedCash), expectedCash: session.expectedCash, differenceCash: session.cashDifference, countedByUserId: actor.userId, authMethod: 'CUSTODY_PIN', epochAtCount: nextEpoch, idempotencyKey: `close:${session.id}`, operationalDay: toJalaliDate(new Date()), note: String(input.note ?? '').trim() || null } })
        await tx.custodyShiftMeta.update({ where: { shiftId: state.activeShiftId }, data: { endKind: 'FINAL_CLOSE', endedAt: new Date(), cashSessionId: session.id, countStatus: 'COUNTED' } })
        await tx.custodyDisposition.createMany({ data: dispositions.map((row: any) => ({ cashSessionId: session.id, shiftId: state.activeShiftId, kind: row.kind, amount: BigInt(row.amount), recipientUserId: row.recipientUserId, destinationLabel: row.destinationLabel, trackingNo: row.trackingNo, confirmStatus: row.kind === 'KEEP_IN_DRAWER' ? 'CONFIRMED' : row.kind === 'TO_MANAGER' ? 'CLAIMED' : 'PENDING', claimedByUserId: actor.userId, confirmedByUserId: row.kind === 'KEEP_IN_DRAWER' ? actor.userId : null, confirmedAt: row.kind === 'KEEP_IN_DRAWER' ? new Date() : null, allocationKey: row.allocationKey, countBeforeWithdrawal: 'COUNT_BEFORE' })) })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'ACTIVE', activeShiftId: state.activeShiftId, epoch: live.epoch }, data: { state: 'NO_SESSION', activeShiftId: null, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ بستن نهایی ثبت نشد.', 'CUSTODY_STALE')
        await writeEvent(tx, { type: 'FINAL_CLOSE', shiftId: state.activeShiftId, actorUserId: actor.userId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN', epochBefore: live.epoch, epochAfter: nextEpoch, payload: { cashSessionId: session.id, countId: count.id } })
      }
    } as any)
  },

  /** A disposition is a declaration, not an untracked cash movement.  Its
   * lifecycle is therefore confirmed/reversed through immutable custody events
   * instead of being deleted or silently overwritten. */
  async confirmDisposition(input: { dispositionId: unknown; userId: unknown; password: unknown }) {
    const dispositionId = asSafeId(input.dispositionId, 'شناسه تعیین تکلیف')
    const row = await prisma.custodyDisposition.findUnique({ where: { id: dispositionId } })
    if (!row || ['CONFIRMED', 'REVERSED'].includes(row.confirmStatus)) throw new BusinessError('این تعیین تکلیف قابل تأیید نیست.')
    const actor = await this.verifyPin(input.userId, input.password)
    if (row.kind === 'TO_MANAGER') {
      if (row.recipientUserId !== actor.userId || actor.role !== 'MANAGER')
        throw new BusinessError('تحویل به مدیر فقط با رمز شخصی همان مدیر انتخاب‌شده تأیید می‌شود.', 'NO_PERMISSION')
    } else if (actor.role !== 'MANAGER') {
      throw new BusinessError('تأیید این تعیین تکلیف فقط با رمز شخصی مدیر مجاز است.', 'NO_PERMISSION')
    }
    return prisma.$transaction(async (tx: Client) => {
      const changed = await tx.custodyDisposition.updateMany({ where: { id: dispositionId, confirmStatus: { in: ['PENDING', 'CLAIMED'] } }, data: { confirmStatus: 'CONFIRMED', confirmedByUserId: actor.userId, confirmedAt: new Date() } })
      if (changed.count !== 1) throw new BusinessError('تعیین تکلیف هم‌زمان تغییر کرد؛ دوباره وضعیت را بگیرید.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'DISPOSITION_CONFIRMED', shiftId: row.shiftId, actorUserId: actor.userId, actorKind: 'MANAGER', authMethod: 'CUSTODY_PIN', payload: { dispositionId, cashSessionId: row.cashSessionId, kind: row.kind, amount: String(row.amount) } })
      return { id: dispositionId, confirmStatus: 'CONFIRMED' }
    })
  },

  async reverseDisposition(input: { dispositionId: unknown; managerUserId: unknown; managerPassword: unknown; reason: unknown }) {
    const dispositionId = asSafeId(input.dispositionId, 'شناسه تعیین تکلیف')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 10) throw new BusinessError('برای برگشت تعیین تکلیف، دلیل روشن و کامل بنویسید.')
    const manager = await this.verifyPin(input.managerUserId, input.managerPassword, { requireManager: true })
    const row = await prisma.custodyDisposition.findUnique({ where: { id: dispositionId } })
    if (!row || row.confirmStatus === 'REVERSED') throw new BusinessError('این تعیین تکلیف قابل برگشت نیست.')
    return prisma.$transaction(async (tx: Client) => {
      const changed = await tx.custodyDisposition.updateMany({ where: { id: dispositionId, confirmStatus: row.confirmStatus }, data: { confirmStatus: 'REVERSED', confirmedByUserId: manager.userId, confirmedAt: new Date() } })
      if (changed.count !== 1) throw new BusinessError('تعیین تکلیف هم‌زمان تغییر کرد؛ دوباره وضعیت را بگیرید.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'DISPOSITION_REVERSED', shiftId: row.shiftId, actorUserId: manager.userId, actorKind: 'MANAGER', authMethod: 'MANAGER_CUSTODY_PIN', payload: { dispositionId, cashSessionId: row.cashSessionId, kind: row.kind, amount: String(row.amount), reason } })
      await auditOrThrow(tx, { action: AuditAction.SETTINGS_UPDATE, entity: 'CustodyDisposition', entityId: dispositionId, userId: manager.userId, after: JSON.stringify({ confirmStatus: 'REVERSED', reason }), note: 'برگشتِ ثبت‌شده‌ی تعیین تکلیف پول صندوق' })
      return { id: dispositionId, confirmStatus: 'REVERSED' }
    })
  },

  async handoverStart(input: { password: unknown; countedCash?: unknown; operationalTotal?: unknown; toUserId: unknown; idempotencyKey?: unknown; note?: unknown; blueReference?: boolean }) {
    const state = await ensureState(prisma)
    if (state.state !== 'ACTIVE' || !state.activeShiftId) throw new BusinessError('نشست فعالی برای تحویل وجود ندارد.', 'NO_OPEN_SESSION')
    const fromMeta = await prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })
    if (!fromMeta) throw new BusinessError('اطلاعات حضانت نشست فعلی ناقص است.', 'CUSTODY_INVARIANT_BROKEN')
    const [cfg, scheduling] = fromMeta.templateId
      ? await Promise.all([configOf(prisma), shiftSchedulingOf(prisma)])
      : [null, null]
    const storedSchedule = scheduleSnapshotOf(fromMeta)
    /** Current settings decide *future* recipient planning, but the live
     * segment's own permission, roster and boundary come from its snapshot. */
    const currentTemplate = fromMeta.templateId
      ? scheduling?.templates.find((row) => row.id === fromMeta.templateId) ?? null
      : null
    const canonicalTemplate = storedSchedule
      ? { allowMidDayHandover: storedSchedule.allowMidDayHandover, staffIds: storedSchedule.staffIds }
      : currentTemplate
    const scheduledEnd = storedSchedule?.scheduledEndAt
      ? new Date(storedSchedule.scheduledEndAt)
      : fromMeta.scheduledEndAt ? new Date(fromMeta.scheduledEndAt) : null
    let handoverKind: 'SHIFT_CHANGE' | 'MIDDAY' = canonicalTemplate && scheduledEnd && Number.isFinite(scheduledEnd.getTime()) && Date.now() >= scheduledEnd.getTime() - MIDDAY_HANDOVER_CUTOFF_MS
      ? 'SHIFT_CHANGE'
      : 'MIDDAY'
    /**
     * «تحویل میان‌روز با تأیید مستقل گیرنده مجاز است» is a manager policy for
     * the *live* drawer. It is granted when the segment's opening snapshot OR
     * the manager's currently saved setting for the same template grants it,
     * so enabling it mid-shift needs no fake close/reopen. The opening
     * snapshot is never rewritten; the granting source is stored on the
     * handover watermark, the HANDOVER_START event and (for a live grant) a
     * dedicated audit row. Turning the option off later does not revoke a
     * grant that the segment already opened with (snapshot evidence).
     */
    const midDayPolicySource: 'SEGMENT_SNAPSHOT' | 'CURRENT_SETTINGS' | null = !fromMeta.templateId
      ? null
      : canonicalTemplate?.allowMidDayHandover === true
        ? 'SEGMENT_SNAPSHOT'
        : currentTemplate?.allowMidDayHandover === true
          ? 'CURRENT_SETTINGS'
          : null
    const midDayAllowed = midDayPolicySource != null
    const samePersonBlue = input.blueReference === true && Number(input.toUserId) === fromMeta.custodianUserId
    if (fromMeta.templateId && handoverKind === 'MIDDAY' && !midDayAllowed && !samePersonBlue)
      throw new BusinessError('مدیر برای این شیفت اجازهٔ تحویل میان‌روز را فعال نکرده است.', 'MIDDAY_HANDOVER_DISABLED')
    const giver = await this.verifyPin(fromMeta.custodianUserId, input.password)
    const toUserId = asSafeId(input.toUserId, 'شناسه تحویل‌گیرنده')
    if (toUserId === giver.userId && input.blueReference !== true) throw new BusinessError('تحویل‌گیرنده باید شخص دیگری باشد.', 'RECEIVER_SAME')
    const [receiver, credential] = await Promise.all([
      prisma.user.findUnique({ where: { id: toUserId } }),
      credentialOf(prisma, toUserId)
    ])
    if (!receiver?.isActive || !credential || credential.status !== 'ACTIVE' || credential.mustChange)
      throw new BusinessError('تحویل‌گیرنده باید کارمند فعال با رمز شخصیِ غیرموقت باشد.', 'RECEIVER_NO_PIN')
    if (receiver.role !== 'MANAGER' && receiver.role !== 'CASHIER') throw new BusinessError('این نقش مجاز به تحویل‌گیری صندوق نیست.', 'NO_PERMISSION')
    const canonicalMultiShift = storedSchedule
      ? storedSchedule.mode === 'MULTI_SHIFT'
      : !!(cfg && scheduling && effectiveCustodyMode(cfg, scheduling) === 'MULTI_SHIFT')
    const nextShiftPlan = fromMeta.templateId && canonicalMultiShift && handoverKind === 'SHIFT_CHANGE' && scheduledEnd && scheduling
      // End is exclusive; +1 ms selects the incoming template at the planned boundary.
      ? canonicalPlanForOpen(scheduling, toUserId, new Date(scheduledEnd.getTime() + 1))
      : null
    /**
     * Template roster checkboxes are planning data (expected staff,
     * suggestions, eligibility to *open* on schedule, reports). They never gate
     * a mid-day transfer the manager has allowed: the receiver only has to be
     * an active CASHIER/MANAGER with a personal, non-temporary PIN (checked
     * above) and enters an independent blind count at acceptance.
     *
     * The incoming segment of a MIDDAY transfer continues the source
     * segment's immutable schedule snapshot (same scheduled end / rollover),
     * so a free transfer never creates an unbounded segment.
     *
     * In the final 15 minutes a recipient planned for the next template takes
     * the SHIFT_CHANGE path. An unplanned recipient is accepted there only
     * under the explicit mid-day permission, as a MIDDAY continuation.
     */
    if (fromMeta.templateId && canonicalMultiShift && handoverKind === 'SHIFT_CHANGE' && !nextShiftPlan) {
      if (!midDayAllowed && !samePersonBlue)
        throw new BusinessError('در ۱۵ دقیقهٔ پایانی، تحویل‌گیرنده باید در شیفت بعدیِ زمان‌بندی‌شده ثبت شده باشد؛ یا مدیر «تحویل میان‌روز» را برای این شیفت مجاز کند.', 'RECEIVER_NOT_SCHEDULED')
      handoverKind = 'MIDDAY'
    }
    const receiverScheduled = !!canonicalTemplate?.staffIds?.includes(toUserId) || !!currentTemplate?.staffIds?.includes(toUserId)
    const aggregateMode = input.operationalTotal != null
    if (!aggregateMode)
      throw new BusinessError('برای تحویل جدید، مجموع کورِ کشو و کارت‌خوان الزامی است.', 'CUSTODY_AGGREGATE_COUNT_REQUIRED')
    const countedCash = asCash(input.operationalTotal, 'مجموع کشو و کارت‌خوان برای تحویل')
    const idempotencyKey = String(input.idempotencyKey ?? '').trim() || randomBytes(16).toString('hex')
    const blue = input.blueReference === true
      ? await blueReferenceForActiveShift(fromMeta, await ensureState(prisma))
      : null
    /**
     * Bootstrap (segment opened cash-only / before the aggregate rollout):
     * remember the giver's count and the segment movement already reflected
     * in it as an adoption *candidate* on this pending handover only. Nothing
     * is written to CustodyAggregateBoundary here: the candidate becomes the
     * segment baseline exclusively inside a successful acceptance. A canceled
     * handover therefore leaves only its immutable HANDOVER_OUT count.
     */
    const needsAdoption = !blue && !(await segmentAggregateBaseline(prisma, state.activeShiftId))
    const movementAtGiverCount = needsAdoption ? await physicalMovementForCustodyShift(state.activeShiftId) : null
    const started = await prisma.$transaction(async (tx: Client) => {
      const live = await ensureState(tx)
      if (live.state !== 'ACTIVE' || live.activeShiftId !== state.activeShiftId || live.epoch !== state.epoch ||
          (blue && Number(live.financialRevision ?? 0) !== blue.financialRevision))
        throw new BusinessError('وضعیت مالی یا صندوق هم‌زمان تغییر کرد؛ با شمارش تازه دوباره تلاش کنید.', 'CUSTODY_STALE')
      const nextEpoch = Number(live.epoch) + 1
      const count = await tx.custodyCount.create({ data: { shiftId: state.activeShiftId, kind: 'HANDOVER_OUT', countedCash: BigInt(countedCash), countedByUserId: giver.userId, authMethod: 'CUSTODY_PIN', epochAtCount: nextEpoch, idempotencyKey: idempotencyKey, operationalDay: toJalaliDate(new Date()), note: String(input.note ?? '').trim() || null } })
      const handover = await tx.custodyHandover.create({ data: { fromShiftId: state.activeShiftId, fromUserId: giver.userId, selectedRecipientUserId: toUserId, status: 'PENDING', outCountId: count.id, expectedAtStart: BigInt(0), countedAtStart: BigInt(countedCash), differenceCash: BigInt(0), ledgerWatermark: JSON.stringify({ ready: aggregateMode, aggregateMode, blueV1: !!blue, handoverKind, midDayPolicySource: handoverKind === 'MIDDAY' ? midDayPolicySource : null, receiverScheduled, aggregateAdoptionCandidate: needsAdoption ? { status: 'PENDING_ACCEPTANCE', observedOperationalTotal: countedCash, sourceMovementOffset: movementAtGiverCount, countedByUserId: giver.userId, countIdempotencyKey: idempotencyKey } : null, incomingSchedule: nextShiftPlan ? { templateId: nextShiftPlan.templateId, title: nextShiftPlan.title, scheduledEndAt: nextShiftPlan.scheduledEndAt?.toISOString() ?? null, reminderRepeatMin: nextShiftPlan.reminderRepeatMin, allowMidDayHandover: nextShiftPlan.allowMidDayHandover, scheduleSnapshotJson: scheduleSnapshotJson(nextShiftPlan, scheduling, cfg) } : null }), fenceEpochAtStart: nextEpoch, idempotencyKey, stateKey: MAIN, operationalDay: toJalaliDate(new Date()) } })
      if (blue) {
        const validPrior = await acceptedBlueBaselineForShift(tx, state.activeShiftId)
        await recordBlueSnapshot(tx, {
          handoverId: handover.id, shiftId: state.activeShiftId, role: 'OUT',
          actorUserId: giver.userId, count: observationOf(countedCash, false),
          reference: blue.reference, referenceFromDay: blue.fromDay,
          referenceToDay: blue.today, scopeKind: blue.scopeKind,
          financialRevision: blue.financialRevision, epochAtCount: nextEpoch,
          prior: validPrior, idempotencyKey: `blue-out:${handover.id}`
        })
      }
      const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'ACTIVE', activeShiftId: state.activeShiftId, epoch: state.epoch }, data: { state: 'HANDOVER_PENDING', pendingHandoverId: handover.id, epoch: nextEpoch, updatedAt: new Date() } })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'HANDOVER_START', shiftId: state.activeShiftId, handoverId: handover.id, actorUserId: giver.userId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { selectedRecipientUserId: toUserId, handoverKind, midDayPolicySource: handoverKind === 'MIDDAY' ? midDayPolicySource : null, receiverScheduled, incomingTemplateId: nextShiftPlan?.templateId ?? null, aggregateAdoptionPending: needsAdoption } })
      if (handoverKind === 'MIDDAY' && midDayPolicySource === 'CURRENT_SETTINGS') {
        await writeEvent(tx, { type: 'MIDDAY_POLICY_LIVE_APPLIED', shiftId: state.activeShiftId, handoverId: handover.id, actorUserId: giver.userId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN', epochBefore: nextEpoch, epochAfter: nextEpoch, payload: { templateId: fromMeta.templateId, snapshotAllowMidDayHandover: canonicalTemplate?.allowMidDayHandover === true, currentAllowMidDayHandover: true, receiverUserId: toUserId, receiverScheduled, segmentScheduledEndAt: scheduledEnd && Number.isFinite(scheduledEnd.getTime()) ? scheduledEnd.toISOString() : null } })
        await auditOrThrow(tx, { action: 'CUSTODY_MIDDAY_POLICY_APPLIED', entity: 'CustodyHandover', entityId: handover.id, userId: giver.userId, after: JSON.stringify({ fromShiftId: state.activeShiftId, templateId: fromMeta.templateId, policySource: 'CURRENT_SETTINGS', snapshotAllowMidDayHandover: canonicalTemplate?.allowMidDayHandover === true, receiverUserId: toUserId, receiverScheduled }), note: 'مجوز تحویل میان‌روزِ ذخیره‌شدهٔ فعلی مدیر برای صندوق فعال اعمال شد؛ snapshot افتتاح بخش دست‌نخورده ماند.' })
      }
      return { handover, epoch: nextEpoch, count }
    })
    /** Aggregate custody has a separate combined-money baseline. It must not
     * call the cash-only preview or disclose an expected/delta to either worker.
     * The incoming worker's blind count is reconciled after the short fence. */
    if (aggregateMode) return { id: started.handover.id, state: 'HANDOVER_PENDING' }

    /** The initial watermark is read-only evidence. Pending sales remain valid
     * and attributed to the outgoing custodian; acceptance takes a separate,
     * short freeze and recount before it can transfer responsibility. */
    const expected = await cashboxService.expected({ shiftId: state.activeShiftId, countedCash })
    const expectedCash = Number(expected.expectedCash)
    await prisma.$transaction(async (tx: Client) => {
      const live = await ensureState(tx)
      if (live.state !== 'HANDOVER_PENDING' || live.pendingHandoverId !== started.handover.id || live.epoch !== started.epoch)
        throw new BusinessError('تحویل دیگر در وضعیت قابل تکمیل نیست.', 'HANDOVER_NOT_PENDING')
      await tx.custodyCount.update({ where: { id: started.count.id }, data: { expectedCash: BigInt(expectedCash), differenceCash: BigInt(countedCash - expectedCash) } })
      const startWatermark = JSON.parse(String(started.handover.ledgerWatermark || '{}'))
      await tx.custodyHandover.update({ where: { id: started.handover.id }, data: { expectedAtStart: BigInt(expectedCash), differenceCash: BigInt(countedCash - expectedCash), ledgerWatermark: JSON.stringify({ ...startWatermark, ready: true, expectedCash, countedCash, at: new Date().toISOString() }) } })
    })
    /** Do not make the start response an expected/difference oracle. Manager
     * evidence remains stored server-side and is available only through reports. */
    return { id: started.handover.id, state: 'HANDOVER_PENDING' }
  },

  /**
   * A pending handover deliberately keeps the outgoing drawer session alive:
   * sales continue under that person while the receiver is away. Acceptance
   * briefly fences writers and takes a fresh receiver count. A non-zero
   * difference is permitted only with a durable reason: it remains attached
   * to the outgoing Shift while the receiver starts the next segment at their
   * actual physical count. This is the opt-in custody feature
   * (custody.config.enabled); legacy installs never enter this state machine.
   */
  /**
   * The receiver's blind count, the ledger expected amount, and any difference
   * must share one immutable financial boundary. Once we freeze the drawer for
   * that count, sales never resume merely because the receiver has not yet
   * typed a difference reason. The only exits are: (a) the same receiver
   * supplies the required reason and completes transfer, or (b) the original
   * custodian explicitly cancels it. This prevents a later expected amount
   * being compared with an earlier physical count.
   */
  async handoverAccept(input: { handoverId: unknown; password: unknown; countedCash?: unknown; operationalTotal?: unknown; differenceReason?: unknown }) {
    const handoverId = asSafeId(input.handoverId, 'شناسه تحویل')
    const pending = await prisma.custodyHandover.findUnique({ where: { id: handoverId } })
    if (!pending || pending.status !== 'PENDING') throw new BusinessError('این تحویل دیگر در انتظار پذیرش نیست.', 'HANDOVER_NOT_PENDING')
    const ready = JSON.parse(String(pending.ledgerWatermark || '{}'))
    if (ready.blueV1 === true) throw new BusinessError('این تحویل باید با شمارش مستقل و تأیید جداگانهٔ مرجع آبی تکمیل شود.', 'BLUE_HANDOVER_REQUIRED')
    if (!ready.ready) throw new BusinessError('شمارش تحویل هنوز کامل نشده است؛ ابتدا تحویل‌دهنده آن را لغو یا کامل کند.', 'RECOUNT_REQUIRED')
    const aggregateMode = ready.aggregateMode === true
    const receiver = await this.verifyPin(pending.selectedRecipientUserId, input.password)
    const submittedCash = aggregateMode
      ? asCash(input.operationalTotal, 'شمارش مستقل مجموع کشو و کارت‌خوان')
      : asCash(input.countedCash, 'شمارش مستقل تحویل‌گیرنده')
    const differenceReason = String(input.differenceReason ?? '').trim()

    type FrozenRecount = {
      fromShiftId: number
      epoch: number
      countedCash: number
      expectedCash?: number
      differenceCash?: number
      pendingCountId?: number
      resumedDifference: boolean
    }

    /** First call moves PENDING → HANDOVER_RECOUNT. A retry after an omitted
     * difference reason resumes the exact frozen snapshot; it cannot recount or
     * recalculate expected after any financial writer has had a chance to run. */
    const frozen: FrozenRecount = await prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      const live = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
      if (!live || live.status !== 'PENDING' || !state.activeShiftId || live.fromShiftId !== state.activeShiftId)
        throw new BusinessError('اطلاعات تحویل ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
      const watermark = JSON.parse(String(live.ledgerWatermark || '{}'))

      if (state.state === 'HANDOVER_RECOUNT') {
        const snapshot = watermark.differencePending
        if (!snapshot || typeof snapshot !== 'object')
          throw new BusinessError('شمارش نهایی دیگری در جریان است؛ وضعیت صندوق را تازه کنید.', 'CUSTODY_FROZEN')
        const countedCash = asCash((snapshot as any).countedCash, 'شمارش فریز‌شده')
        const expectedCash = Number((snapshot as any).expectedCash)
        const differenceCash = Number((snapshot as any).differenceCash)
        const pendingCountId = asSafeId((snapshot as any).countId, 'شناسه شمارش فریز‌شده')
        if (!Number.isSafeInteger(expectedCash) || expectedCash < 0 || !Number.isSafeInteger(differenceCash) || submittedCash !== countedCash)
          throw new BusinessError('شمارش فریز‌شده قابل تغییر نیست؛ همان مبلغ را با دلیل مغایرت ثبت کنید یا تحویل‌دهنده آن را لغو کند.', 'HANDOVER_RECOUNT_RETRY_MISMATCH')
        return { fromShiftId: live.fromShiftId, epoch: Number(state.epoch), countedCash, expectedCash, differenceCash, pendingCountId, resumedDifference: true }
      }

      if (state.state !== 'HANDOVER_PENDING' || state.pendingHandoverId !== handoverId)
        throw new BusinessError('این تحویل دیگر در انتظار پذیرش نیست.', 'HANDOVER_NOT_PENDING')
      const nextEpoch = Number(state.epoch) + 1
      const changed = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'HANDOVER_PENDING', activeShiftId: live.fromShiftId, pendingHandoverId: handoverId, epoch: state.epoch },
        data: { state: 'HANDOVER_RECOUNT', epoch: nextEpoch, updatedAt: new Date() }
      })
      if (changed.count !== 1) throw new BusinessError('فروش یا وضعیت صندوق هم‌زمان تغییر کرد؛ دوباره شمارش کنید.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'HANDOVER_RECOUNT_FREEZE', shiftId: live.fromShiftId, handoverId, actorUserId: receiver.userId, actorKind: 'RECEIVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { countedCash: submittedCash } })
      return { fromShiftId: live.fromShiftId, epoch: nextEpoch, countedCash: submittedCash, resumedDifference: false }
    })

    /** A fresh freeze may be released only when no blind count snapshot was
     * recorded. If expected calculation itself fails, responsibility remains
     * with the outgoing custodian exactly as before the attempted acceptance. */
    const abortFreshFreeze = async (reason: string) => {
      if (frozen.resumedDifference) return
      await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== handoverId || state.epoch !== frozen.epoch) return
        const nextEpoch = Number(state.epoch) + 1
        const changed = await tx.custodyState.updateMany({
          where: { key: MAIN, state: 'HANDOVER_RECOUNT', pendingHandoverId: handoverId, epoch: state.epoch },
          data: { state: 'HANDOVER_PENDING', epoch: nextEpoch, updatedAt: new Date() }
        })
        if (changed.count === 1)
          await writeEvent(tx, { type: 'HANDOVER_RECOUNT_ABORTED', shiftId: frozen.fromShiftId, handoverId, actorUserId: receiver.userId, actorKind: 'RECEIVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { reason } })
      })
    }

    let expectedCash = frozen.expectedCash
    let differenceCash = frozen.differenceCash
    let aggregatePhysicalMovement: number | null = null
    /** CHAINED: segment baseline exists. ADOPT_GIVER: no baseline; the giver's
     * start count (candidate) is adopted inside the acceptance transaction and
     * the receiver is reconciled against it. ADOPT_RECEIVER: no baseline and no
     * candidate (pending handover from an older version): neutral adoption. */
    let aggregateBootstrap: 'CHAINED' | 'ADOPT_GIVER' | 'ADOPT_RECEIVER' = 'CHAINED'
    const adoptionCandidate = ready.aggregateAdoptionCandidate && typeof ready.aggregateAdoptionCandidate === 'object' && ready.aggregateAdoptionCandidate.status === 'PENDING_ACCEPTANCE'
      ? ready.aggregateAdoptionCandidate
      : null
    if (!frozen.resumedDifference) {
      try {
        if (aggregateMode) {
          aggregatePhysicalMovement = await physicalMovementForCustodyShift(frozen.fromShiftId)
          /** Only this segment's own accepted baseline counts. A historic
           * cash-only segment is never reinterpreted as a POS baseline and a
           * stale boundary from another chain is never borrowed. */
          const baseline = await segmentAggregateBaseline(prisma, frozen.fromShiftId)
          if (baseline) {
            const preview = previewSegmentBoundary(baseline, aggregatePhysicalMovement, frozen.countedCash)
            expectedCash = preview.operationalExpectedTotal
          } else if (adoptionCandidate && Number.isSafeInteger(Number(adoptionCandidate.observedOperationalTotal)) && Number.isSafeInteger(Number(adoptionCandidate.sourceMovementOffset))) {
            aggregateBootstrap = 'ADOPT_GIVER'
            const preview = previewSegmentBoundary({ observedOperationalTotal: Number(adoptionCandidate.observedOperationalTotal), sourceMovementOffset: Number(adoptionCandidate.sourceMovementOffset) }, aggregatePhysicalMovement, frozen.countedCash)
            expectedCash = preview.operationalExpectedTotal
          } else {
            aggregateBootstrap = 'ADOPT_RECEIVER'
            expectedCash = frozen.countedCash
          }
          differenceCash = frozen.countedCash - expectedCash
        } else {
          const expected = await cashboxService.expected({ shiftId: frozen.fromShiftId, countedCash: frozen.countedCash })
          expectedCash = Number(expected.expectedCash)
          differenceCash = frozen.countedCash - expectedCash
        }
      } catch (error) {
        await abortFreshFreeze('EXPECTED_CALCULATION_FAILED')
        throw error
      }
    }
    if (!Number.isSafeInteger(expectedCash) || expectedCash! < 0 || !Number.isSafeInteger(differenceCash))
      throw new BusinessError('مبلغ انتظاری تحویل قابل محاسبه نیست.', 'CUSTODY_INVARIANT_BROKEN')

    /** The receiver never supplies an explanation for a discrepancy. A legacy
     * frozen request created by an earlier version may opt in explicitly via its
     * immutable watermark, but all new handovers continue neutrally. */
    if (!aggregateMode && ready.requireHistoricalDifferenceReason === true && differenceCash !== 0 && differenceReason.length < 10) {
      if (!frozen.resumedDifference) {
        await prisma.$transaction(async (tx: Client) => {
          const state = await ensureState(tx)
          if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== handoverId || state.epoch !== frozen.epoch)
            throw new BusinessError('وضعیت تحویل هم‌زمان تغییر کرد؛ دوباره وضعیت صندوق را بگیرید.', 'CUSTODY_STALE')
          const count = await tx.custodyCount.create({
            data: {
              shiftId: frozen.fromShiftId,
              kind: 'HANDOVER_RECOUNT_DIFFERENCE_PENDING',
              countedCash: BigInt(frozen.countedCash),
              expectedCash: BigInt(expectedCash),
              differenceCash: BigInt(differenceCash),
              countedByUserId: receiver.userId,
              authMethod: 'CUSTODY_PIN',
              handoverId,
              epochAtCount: frozen.epoch,
              idempotencyKey: `recount-difference-pending:${handoverId}:${frozen.epoch}`,
              operationalDay: toJalaliDate(new Date())
            }
          })
          const live = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
          const watermark = JSON.parse(String(live?.ledgerWatermark || '{}'))
          await tx.custodyHandover.update({
            where: { id: handoverId },
            data: {
              ledgerWatermark: JSON.stringify({
                ...watermark,
                ready: true,
                accepted: false,
                differencePending: { countId: count.id, countedCash: frozen.countedCash, expectedCash, differenceCash, frozenEpoch: frozen.epoch, at: new Date().toISOString() },
                at: new Date().toISOString()
              }),
              version: { increment: 1 }
            }
          })
          await writeEvent(tx, { type: 'HANDOVER_DIFFERENCE_PENDING', shiftId: frozen.fromShiftId, handoverId, actorUserId: receiver.userId, actorKind: 'RECEIVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: state.epoch, payload: { countId: count.id, countedCash: frozen.countedCash, expectedCash, differenceCash } })
        })
      }
      throw new BusinessError('شمارش مستقل با نقد انتظاری اختلاف دارد. صندوق تا ثبت دلیل روشنِ حداقل ۱۰ حرف یا لغو احرازشدهٔ تحویل‌دهنده freeze می‌ماند؛ همان شمارش فریز‌شده را تغییر ندهید.', 'HANDOVER_DIFFERENCE_REASON_REQUIRED')
    }

    try {
      return await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== handoverId || state.epoch !== frozen.epoch || !state.activeShiftId)
          throw new BusinessError('فروش یا وضعیت صندوق هم‌زمان تغییر کرد؛ دوباره شمارش کنید.', 'CUSTODY_STALE')
        const live = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
        if (!live || live.status !== 'PENDING' || live.fromShiftId !== state.activeShiftId)
          throw new BusinessError('اطلاعات تحویل ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
        const liveWatermark = JSON.parse(String(live.ledgerWatermark || '{}'))
        const nextEpoch = Number(state.epoch) + 1
        /** The blind snapshot row is immutable evidence. A reason is attached
         * to the final handover/event rather than rewriting that physical count. */
        let recount: any
        if (frozen.resumedDifference) {
          recount = await tx.custodyCount.findUnique({ where: { id: frozen.pendingCountId } })
          if (!recount || recount.shiftId !== live.fromShiftId || recount.handoverId !== handoverId || recount.kind !== 'HANDOVER_RECOUNT_DIFFERENCE_PENDING')
            throw new BusinessError('شاهد شمارش فریز‌شده پیدا نشد؛ تحویل قابل تکمیل نیست.', 'CUSTODY_INVARIANT_BROKEN')
        } else {
          recount = await tx.custodyCount.create({
            data: {
              shiftId: live.fromShiftId,
              kind: aggregateMode ? (aggregateBootstrap === 'ADOPT_RECEIVER' ? 'HANDOVER_AGGREGATE_ADOPTION_RECOUNT' : 'HANDOVER_AGGREGATE_RECOUNT') : differenceCash === 0 ? 'HANDOVER_RECOUNT' : 'HANDOVER_RECOUNT_DIFFERENCE',
              countedCash: BigInt(frozen.countedCash),
              /** A neutral adoption has no expected amount; never fake one. */
              expectedCash: aggregateBootstrap === 'ADOPT_RECEIVER' ? null : BigInt(expectedCash!),
              differenceCash: aggregateBootstrap === 'ADOPT_RECEIVER' ? null : BigInt(differenceCash!),
              countedByUserId: receiver.userId,
              authMethod: 'CUSTODY_PIN',
              note: differenceCash === 0 ? null : differenceReason,
              handoverId,
              epochAtCount: nextEpoch,
              idempotencyKey: `recount:${handoverId}:${frozen.epoch}`,
              operationalDay: toJalaliDate(new Date())
            }
          })
        }
        const closed = await shiftService.closeInTx(tx, { shiftId: live.fromShiftId, userId: live.fromUserId, note: differenceCash === 0 ? 'تحویل احرازشده صندوق' : 'تحویل احرازشده صندوق با مغایرت شمارش' })
        const [cfg, scheduling, sourceMeta] = await Promise.all([
          configOf(tx),
          shiftSchedulingOf(tx),
          tx.custodyShiftMeta.findUnique({ where: { shiftId: live.fromShiftId } })
        ])
        /** A mid-day replacement retains the immutable source snapshot; a
         * boundary transfer uses the incoming schedule snapshot captured when
         * the handover began, not Settings as they happen to look now. */
        const sourceTemplate = sourceMeta?.templateId ? scheduling.templates.find((row) => row.id === sourceMeta.templateId) ?? null : null
        const sourcePlan = sourceMeta ? planFromSegmentSnapshot(sourceMeta, sourceTemplate) : null
        const incomingSnapshot = liveWatermark.handoverKind === 'SHIFT_CHANGE' && liveWatermark.incomingSchedule && typeof liveWatermark.incomingSchedule === 'object'
          ? liveWatermark.incomingSchedule
          : null
        const plan = incomingSnapshot
          ? { legacyPlanId: null, templateId: String(incomingSnapshot.templateId), title: String(incomingSnapshot.title ?? 'شیفت بعدی برنامه‌ریزی‌شده'), scheduledEndAt: incomingSnapshot.scheduledEndAt ? new Date(String(incomingSnapshot.scheduledEndAt)) : null, reminderRepeatMin: Number(incomingSnapshot.reminderRepeatMin) || 15, allowMidDayHandover: incomingSnapshot.allowMidDayHandover === true }
          : sourcePlan
            ?? (scheduling.custodyModeConfigured && effectiveCustodyMode(cfg, scheduling) === 'MULTI_SHIFT'
              ? canonicalPlanForOpen(scheduling, receiver.userId)
              : effectiveCustodyMode(cfg, scheduling) === 'MULTI_SHIFT'
                ? await planForOpen(tx, receiver.userId)
                : null)
        const immutableScheduleSnapshot = typeof incomingSnapshot?.scheduleSnapshotJson === 'string'
          ? incomingSnapshot.scheduleSnapshotJson
          : sourceMeta?.scheduleSnapshotJson ?? scheduleSnapshotJson(plan, scheduling, cfg)
        const next = await shiftService.createSession(tx, { staffId: receiver.userId, staffConfirmed: true, actorId: receiver.userId, mode: 'HANDOVER', openIdempotencyKey: live.idempotencyKey, openIdempotencyFingerprint: `custody-handover:${handoverId}`, note: 'تحویل احرازشده صندوق' })
        /** The single aggregate count must never be injected into the old
         * cash-only OPENING_FLOAT ledger: doing so would falsely treat POS
         * balance as banknotes. Aggregate custody owns its separate boundary. */
        if (!aggregateMode && frozen.countedCash > 0) await recordCashMovement(tx, { amount: frozen.countedCash, type: CashMovementType.OPENING_FLOAT, shiftId: next.id, userId: receiver.userId, refType: 'CustodyHandover', refId: handoverId, description: 'موجودی اول ناشی از تحویل صندوقِ شمارش‌شده' })
        /** Bootstrap adoption is written here — and only here — inside the
         * same transaction that transfers responsibility. Any failure below
         * rolls it back together with the handover boundary. */
        const adoption = aggregateMode && aggregateBootstrap === 'ADOPT_GIVER'
          ? await recordAdoptionBaseline(tx, {
              shiftId: live.fromShiftId,
              observedOperationalTotal: Number(adoptionCandidate.observedOperationalTotal),
              sourceMovementOffset: Number(adoptionCandidate.sourceMovementOffset),
              countedByUserId: live.fromUserId,
              authMethod: 'CUSTODY_PIN',
              idempotencyKey: `aggregate-adoption:handover:${handoverId}`,
              operationalDay: toJalaliDate(new Date())
            })
          : null
        const aggregateBoundary = aggregateMode
          ? await recordAggregateBoundary(tx, {
              boundaryKind: 'HANDOVER',
              fromShiftId: live.fromShiftId,
              toShiftId: next.id,
              handoverId,
              observedOperationalTotal: frozen.countedCash,
              countedByUserId: receiver.userId,
              authMethod: 'CUSTODY_PIN',
              idempotencyKey: `aggregate-handover:${handoverId}`,
              physicalMovement: aggregatePhysicalMovement ?? 0,
              operationalDay: toJalaliDate(new Date()),
              priorScope: 'SOURCE_SEGMENT',
              bootstrapWithoutBaseline: aggregateBootstrap === 'ADOPT_RECEIVER'
            })
          : null
        if (aggregateBoundary && (aggregateBoundary.newDifference !== differenceCash || (aggregateBoundary.baselineSource === 'ADOPTION') !== (aggregateBootstrap === 'ADOPT_RECEIVER')))
          throw new BusinessError('محاسبهٔ مرز حضانت هم‌زمان تغییر کرد؛ تحویل ثبت نشد.', 'CUSTODY_STALE')
        await tx.custodyShiftMeta.update({ where: { shiftId: live.fromShiftId }, data: { endKind: differenceCash === 0 ? 'HANDED_OVER' : 'HANDED_OVER_WITH_DIFFERENCE', endedAt: closed.closedAt } })
        await tx.custodyShiftMeta.create({ data: { shiftId: next.id, custodianUserId: receiver.userId, openAuth: 'HANDOVER_RECEIVER_PIN', templateId: plan?.templateId ?? null, planId: plan?.legacyPlanId ?? null, planTitle: plan?.title ?? null, scheduledEndAt: plan?.scheduledEndAt ?? null, scheduleSnapshotJson: immutableScheduleSnapshot, rolloverAt: rolloverAtForSnapshot(new Date(), cfg, scheduling, plan, immutableScheduleSnapshot), dayCutoverSnapshot: cfg.dayCutoverMinute, operationalDay: toJalaliDate(new Date()), countStatus: 'COUNTED', openEpoch: nextEpoch } })
        await tx.custodyHandover.update({ where: { id: handoverId }, data: { status: 'COMPLETED', finalCustodianUserId: receiver.userId, acceptedByUserId: receiver.userId, resolutionKind: differenceCash === 0 ? 'RECEIVER_ACCEPTED' : 'RECEIVER_ACCEPTED_WITH_DIFFERENCE', resolutionReason: differenceCash === 0 ? null : differenceReason, expectedAtStart: BigInt(expectedCash), differenceCash: BigInt(differenceCash), ledgerWatermark: JSON.stringify({ ...liveWatermark, ready: true, accepted: true, differencePending: null, expectedCash, countedCash: frozen.countedCash, differenceCash, differenceReason: differenceCash === 0 ? null : differenceReason, differenceAttributedToUserId: differenceCash === 0 ? null : live.fromUserId, recountCountId: recount.id, aggregateBootstrap: aggregateMode ? aggregateBootstrap : null, aggregateAdoptionCandidate: liveWatermark.aggregateAdoptionCandidate ? { ...liveWatermark.aggregateAdoptionCandidate, status: aggregateBootstrap === 'ADOPT_GIVER' ? 'ADOPTED' : 'NOT_USED', adoptionBoundaryId: adoption?.id ?? null } : null, aggregateBoundaryId: aggregateBoundary?.id ?? null, aggregateBaselineSource: aggregateBoundary?.baselineSource ?? null, at: new Date().toISOString() }), toShiftId: next.id, finishedAt: new Date(), version: { increment: 1 } } })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'HANDOVER_RECOUNT', pendingHandoverId: handoverId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: next.id, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ تحویل ثبت نشد.', 'CUSTODY_STALE')
        await writeEvent(tx, { type: differenceCash === 0 ? 'HANDOVER_ACCEPT' : 'HANDOVER_ACCEPT_WITH_DIFFERENCE', shiftId: differenceCash === 0 ? next.id : live.fromShiftId, handoverId, actorUserId: receiver.userId, actorKind: 'RECEIVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { fromShiftId: live.fromShiftId, toShiftId: next.id, recountCountId: recount.id, expectedCash, countedCash: frozen.countedCash, differenceCash, differenceReason: differenceCash === 0 ? null : differenceReason, differenceAttributedToUserId: differenceCash === 0 ? null : live.fromUserId, frozenBlindCount: frozen.resumedDifference, aggregateBootstrap: aggregateMode ? aggregateBootstrap : null, aggregateAdoptionBoundaryId: adoption?.id ?? null, aggregateBoundaryId: aggregateBoundary?.id ?? null } })
        /** Employee-safe acknowledgement. Expected totals and all deltas remain
         * in append-only manager evidence, never in an IPC response to either
         * side of the handover. */
        return { handoverId, shiftId: next.id, epoch: nextEpoch, state: 'ACTIVE' }
      })
    } catch (error) {
      /** A final transaction failure before a durable difference snapshot may
       * safely return to PENDING. Once a blind difference is durable, it stays
       * frozen for an authenticated retry/cancel and never reopens sales. */
      await abortFreshFreeze('ACCEPT_TRANSACTION_FAILED')
      throw error
    }
  },

  /** Second *independent* count. Both personal PINs were checked; the first
   * amount/expected reference is not returned before this moment. Sales are
   * still permitted under the outgoing owner. A changed financial revision
   * preserves this attempt's evidence, restores ACTIVE and requires new counts. */
  async handoverCountBlue(input: { handoverId: unknown; password: unknown; operationalTotal: unknown }) {
    const handoverId = asSafeId(input.handoverId, 'شناسه تحویل')
    const pending = await prisma.custodyHandover.findUnique({ where: { id: handoverId } })
    if (!pending || pending.status !== 'PENDING' || JSON.parse(String(pending.ledgerWatermark || '{}')).blueV1 !== true)
      throw new BusinessError('این تحویل در مرحلهٔ شمارش مستقل مرجع آبی نیست.', 'BLUE_HANDOVER_NOT_PENDING')
    const receiver = await this.verifyPin(pending.selectedRecipientUserId, input.password)
    const count = asCash(input.operationalTotal, 'شمارش مستقل گیرنده از مجموع کشو و کارت‌خوان')
    const result = await prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      const live = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
      if (!live || live.status !== 'PENDING' || state.state !== 'HANDOVER_PENDING' ||
          state.pendingHandoverId !== handoverId || state.activeShiftId !== live.fromShiftId)
        throw new BusinessError('تلاش تحویل دیگر در جریان نیست؛ شمارش را دوباره آغاز کنید.', 'BLUE_HANDOVER_NOT_PENDING')
      const lock = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'HANDOVER_PENDING', pendingHandoverId: handoverId, activeShiftId: live.fromShiftId, epoch: state.epoch },
        data: { updatedAt: new Date() }
      })
      if (lock.count !== 1) throw new BusinessError('مالک صندوق هم‌زمان تغییر کرد.', 'CUSTODY_STALE')
      const out = await tx.custodyBlueSnapshot.findFirst({ where: { handoverId, role: 'OUT' } })
      if (!out || out.actorUserId !== live.fromUserId || out.shiftId !== live.fromShiftId)
        throw new BusinessError('سند شمارشِ تحویل‌دهنده پیدا نشد.', 'BLUE_SNAPSHOT_MISSING')
      if (Number(state.financialRevision ?? 0) !== out.financialRevision ||
          toJalaliDate(new Date()) !== out.referenceToDay)
        return markBlueHandoverStale(tx, state, live, receiver.userId, 'SALE_OR_DAY_AFTER_OUT_COUNT')
      const counted = await tx.custodyCount.create({ data: {
        shiftId: live.fromShiftId, kind: 'BLUE_HANDOVER_IN', countedCash: BigInt(count),
        expectedCash: null, differenceCash: null, countedByUserId: receiver.userId,
        authMethod: 'CUSTODY_PIN', handoverId, epochAtCount: Number(state.epoch),
        idempotencyKey: `blue-in-count:${handoverId}`, operationalDay: out.referenceToDay
      } })
      const incoming = await recordBlueSnapshot(tx, {
        handoverId, shiftId: live.fromShiftId, role: 'IN', actorUserId: receiver.userId,
        count: observationOf(count, false), reference: referenceFromBlueSnapshot(out),
        referenceFromDay: out.referenceFromDay, referenceToDay: out.referenceToDay,
        scopeKind: out.scopeKind, financialRevision: out.financialRevision,
        epochAtCount: Number(state.epoch), prior: out,
        idempotencyKey: `blue-in:${handoverId}`
      })
      const watermark = JSON.parse(String(live.ledgerWatermark || '{}'))
      const updated = await tx.custodyHandover.updateMany({
        where: { id: handoverId, status: 'PENDING' },
        data: { status: 'RECEIVER_COUNTED', ledgerWatermark: JSON.stringify({ ...watermark, receiverCountId: counted.id, receiverSnapshotId: incoming.id }), version: { increment: 1 } }
      })
      if (updated.count !== 1) throw new BusinessError('شمارش هم‌زمان تغییر کرد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'BLUE_HANDOVER_RECEIVER_COUNT', shiftId: live.fromShiftId, handoverId,
        actorUserId: receiver.userId, actorKind: 'RECEIVER', authMethod: 'CUSTODY_PIN',
        epochBefore: state.epoch, epochAfter: state.epoch,
        payload: { incomingSnapshotId: incoming.id, outgoingSnapshotId: out.id, receiverCountId: counted.id, referenceStatus: incoming.referenceStatus } })
      return { stale: false as const, ...blueHandoverPreview(handoverId, out, incoming, live.fromUserId === receiver.userId) }
    })
    if (result.stale) throw new BusinessError('میان دو شمارش فروش ثبت شد یا روز عوض شد. فروش محفوظ است؛ هر دو نفر با مبلغ و PIN تازه دوباره شمارش کنند.', 'BLUE_RECOUNT_REQUIRED')
    return result
  },

  /** Read back the already-recorded IN preview after reopening the dialog.
   * The receiver's personal PIN (with the usual lockout) is required; public
   * status, the handover start and a pre-IN request reveal no prior count.
   * This transaction performs SELECTs only: it never restores/updates a count
   * or advances custody. Confirmation does not call or depend on this review. */
  async handoverBlueReview(input: { handoverId: unknown; password: unknown }) {
    const handoverId = asSafeId(input.handoverId, 'شناسه تحویل')
    const pending = await prisma.custodyHandover.findUnique({ where: { id: handoverId } })
    if (!pending || pending.status !== 'RECEIVER_COUNTED' || JSON.parse(String(pending.ledgerWatermark || '{}')).blueV1 !== true)
      throw new BusinessError('این تحویل هنوز دو شمارش مستقل برای بازبینی ندارد.', 'BLUE_NOT_COUNTED')
    const receiver = await this.verifyPin(pending.selectedRecipientUserId, input.password)
    return prisma.$transaction(async (tx: Client) => {
      const [state, live, out, incoming] = await Promise.all([
        tx.custodyState.findUnique({ where: { key: MAIN } }),
        tx.custodyHandover.findUnique({ where: { id: handoverId } }),
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId, role: 'OUT' } }),
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId, role: 'IN' } })
      ])
      if (!state || !live || live.status !== 'RECEIVER_COUNTED' ||
          state.state !== 'HANDOVER_PENDING' || state.pendingHandoverId !== handoverId ||
          state.activeShiftId !== live.fromShiftId || live.selectedRecipientUserId !== receiver.userId)
        throw new BusinessError('این تحویل دیگر در انتظار تأیید نیست.', 'BLUE_NOT_COUNTED')
      const watermark = JSON.parse(String(live.ledgerWatermark || '{}'))
      if (watermark.blueV1 !== true || !watermark.receiverCountId ||
          !out || !incoming || watermark.receiverSnapshotId !== incoming.id ||
          incoming.priorSnapshotId !== out.id || out.actorUserId !== live.fromUserId ||
          incoming.actorUserId !== receiver.userId || out.shiftId !== live.fromShiftId ||
          incoming.shiftId !== live.fromShiftId || out.authMethod !== 'CUSTODY_PIN' ||
          incoming.authMethod !== 'CUSTODY_PIN' ||
          out.calculationVersion !== incoming.calculationVersion || out.sourceHash !== incoming.sourceHash)
        throw new BusinessError('اسناد مستقل شمارش تحویل با یکدیگر سازگار نیستند.', 'BLUE_SNAPSHOT_MISSING')
      if (Number(state.financialRevision ?? 0) !== out.financialRevision ||
          incoming.financialRevision !== out.financialRevision ||
          toJalaliDate(new Date()) !== incoming.referenceToDay)
        throw new BusinessError('پس از شمارش فروش ثبت شد یا روز عوض شد؛ این نتیجه نیازمند شمارش تازه است. فروش محفوظ است.', 'BLUE_RECOUNT_REQUIRED')
      return blueHandoverPreview(handoverId, out, incoming, live.fromUserId === receiver.userId)
    })
  },

  /** Explicit second confirmation: no count is supplied/reused by the UI.
   * This one short SQLite transaction fences financial writers, closes the
   * old actual Shift and starts the new one. A bad/missing reference cannot
   * block acceptance; null discrepancies remain pending manager evidence. */
  async handoverConfirmBlue(input: { handoverId: unknown; password: unknown }) {
    const handoverId = asSafeId(input.handoverId, 'شناسه تحویل')
    const pending = await prisma.custodyHandover.findUnique({ where: { id: handoverId } })
    if (!pending || pending.status !== 'RECEIVER_COUNTED' || JSON.parse(String(pending.ledgerWatermark || '{}')).blueV1 !== true)
      throw new BusinessError('تحویل به شمارش مستقل و تأیید گیرنده نیاز دارد.', 'BLUE_NOT_COUNTED')
    const receiver = await this.verifyPin(pending.selectedRecipientUserId, input.password)
    const result = await prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      const live = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
      if (!live || live.status !== 'RECEIVER_COUNTED' || state.state !== 'HANDOVER_PENDING' ||
          state.pendingHandoverId !== handoverId || state.activeShiftId !== live.fromShiftId ||
          live.selectedRecipientUserId !== receiver.userId)
        throw new BusinessError('این تحویل دیگر در انتظار تأیید نیست.', 'BLUE_NOT_COUNTED')
      const locked = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'HANDOVER_PENDING', pendingHandoverId: handoverId, activeShiftId: live.fromShiftId, epoch: state.epoch },
        data: { updatedAt: new Date() }
      })
      if (locked.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد.', 'CUSTODY_STALE')
      const [out, incoming, fromShift, sourceMeta, cfg, scheduling] = await Promise.all([
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId, role: 'OUT' } }),
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId, role: 'IN' } }),
        tx.shift.findUnique({ where: { id: live.fromShiftId } }),
        tx.custodyShiftMeta.findUnique({ where: { shiftId: live.fromShiftId } }),
        configOf(tx), shiftSchedulingOf(tx)
      ])
      if (!out || !incoming || incoming.priorSnapshotId !== out.id ||
          out.calculationVersion !== incoming.calculationVersion || out.sourceHash !== incoming.sourceHash ||
          !fromShift || fromShift.closedAt || fromShift.userId !== live.fromUserId ||
          !sourceMeta || sourceMeta.custodianUserId !== live.fromUserId)
        throw new BusinessError('شواهد دو شمارش یا مسئول فعلی ناسازگار است.', 'BLUE_SNAPSHOT_MISSING')
      if (Number(state.financialRevision ?? 0) !== out.financialRevision ||
          incoming.financialRevision !== out.financialRevision ||
          toJalaliDate(new Date()) !== incoming.referenceToDay)
        return markBlueHandoverStale(tx, state, live, receiver.userId, 'SALE_OR_DAY_AFTER_IN_COUNT')
      const watermark = JSON.parse(String(live.ledgerWatermark || '{}'))
      if (!watermark.receiverCountId || watermark.receiverSnapshotId !== incoming.id)
        throw new BusinessError('تأیید از سند مستقل شمارش گیرنده جدا شده است.', 'BLUE_SNAPSHOT_MISSING')
      const nextEpoch = Number(state.epoch) + 1
      const selfBoundary = live.fromUserId === receiver.userId
      let toShiftId = live.fromShiftId
      if (!selfBoundary) {
        const closed = await shiftService.closeInTx(tx, { shiftId: live.fromShiftId, userId: live.fromUserId,
          note: 'تحویل صندوق با دو شمارش مستقل و مرجع آبی روزانه' })
        const sourceTemplate = sourceMeta.templateId ? scheduling.templates.find((row: ShiftTemplate) => row.id === sourceMeta.templateId) ?? null : null
        const sourcePlan = planFromSegmentSnapshot(sourceMeta, sourceTemplate)
        const plannedIncoming = watermark.handoverKind === 'SHIFT_CHANGE' && watermark.incomingSchedule && typeof watermark.incomingSchedule === 'object'
          ? watermark.incomingSchedule : null
        const plan = plannedIncoming
          ? { legacyPlanId: null, templateId: String(plannedIncoming.templateId), title: String(plannedIncoming.title ?? 'شیفت بعدی برنامه‌ریزی‌شده'), scheduledEndAt: plannedIncoming.scheduledEndAt ? new Date(String(plannedIncoming.scheduledEndAt)) : null, reminderRepeatMin: Number(plannedIncoming.reminderRepeatMin) || 15, allowMidDayHandover: plannedIncoming.allowMidDayHandover === true }
          : sourcePlan ?? (scheduling.custodyModeConfigured && effectiveCustodyMode(cfg, scheduling) === 'MULTI_SHIFT'
            ? canonicalPlanForOpen(scheduling, receiver.userId)
            : effectiveCustodyMode(cfg, scheduling) === 'MULTI_SHIFT' ? await planForOpen(tx, receiver.userId) : null)
        const immutableScheduleSnapshot = typeof plannedIncoming?.scheduleSnapshotJson === 'string'
          ? plannedIncoming.scheduleSnapshotJson : sourceMeta.scheduleSnapshotJson ?? scheduleSnapshotJson(plan, scheduling, cfg)
        const next = await shiftService.createSession(tx, { staffId: receiver.userId, staffConfirmed: true,
          actorId: receiver.userId, mode: 'HANDOVER', openIdempotencyKey: live.idempotencyKey,
          openIdempotencyFingerprint: `custody-blue-handover:${handoverId}`,
          note: 'تحویل صندوق با مرجع آبی؛ مغایرت احتمالی حکم تخلف نیست' })
        toShiftId = next.id
        await tx.custodyShiftMeta.update({ where: { shiftId: live.fromShiftId }, data: {
          endKind: 'BLUE_HANDOVER', endedAt: closed.closedAt, countStatus: 'COUNTED'
        } })
        await tx.custodyShiftMeta.create({ data: {
          shiftId: next.id, custodianUserId: receiver.userId, openAuth: 'BLUE_HANDOVER_RECEIVER_PIN',
          templateId: plan?.templateId ?? null, planId: plan?.legacyPlanId ?? null,
          planTitle: plan?.title ?? null, scheduledEndAt: plan?.scheduledEndAt ?? null,
          scheduleSnapshotJson: immutableScheduleSnapshot,
          rolloverAt: rolloverAtForSnapshot(new Date(), cfg, scheduling, plan, immutableScheduleSnapshot),
          dayCutoverSnapshot: cfg.dayCutoverMinute, operationalDay: incoming.referenceToDay,
          countStatus: 'COUNTED', openEpoch: nextEpoch
        } })
      }
      const complete = await tx.custodyHandover.updateMany({ where: { id: handoverId, status: 'RECEIVER_COUNTED' }, data: {
        status: 'COMPLETED', finalCustodianUserId: receiver.userId, acceptedByUserId: receiver.userId,
        resolutionKind: selfBoundary ? 'BLUE_SELF_COUNT_BOUNDARY' : 'BLUE_RECEIVER_ACCEPTED',
        resolutionReason: null, toShiftId, finishedAt: new Date(),
        ledgerWatermark: JSON.stringify({ ...watermark, accepted: true, blueReceiverSnapshotId: incoming.id,
          blueOutSnapshotId: out.id, legacyExpectedDifferenceNotApplicable: true }),
        version: { increment: 1 }
      } })
      if (complete.count !== 1) throw new BusinessError('تأیید تحویل هم‌زمان تغییر کرد.', 'CUSTODY_STALE')
      const switched = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'HANDOVER_PENDING', activeShiftId: live.fromShiftId,
          pendingHandoverId: handoverId, epoch: state.epoch, financialRevision: out.financialRevision },
        data: { state: 'ACTIVE', activeShiftId: toShiftId, pendingHandoverId: null,
          epoch: nextEpoch, updatedAt: new Date() }
      })
      if (switched.count !== 1) throw new BusinessError('فروش هم‌زمان با تحویل ثبت شد؛ سندها حفظ شدند و تحویل انجام نشد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: selfBoundary ? 'BLUE_SELF_COUNT_BOUNDARY' : 'BLUE_HANDOVER_COMMITTED',
        shiftId: toShiftId, handoverId, actorUserId: receiver.userId, actorKind: 'RECEIVER',
        authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch,
        payload: { fromShiftId: live.fromShiftId, toShiftId, outSnapshotId: out.id,
          inSnapshotId: incoming.id, referenceStatus: incoming.referenceStatus,
          rawDifference: incoming.rawDifference == null ? null : String(incoming.rawDifference),
          freshDifference: incoming.freshDifference == null ? null : String(incoming.freshDifference),
          selfBoundary, automaticBlame: false } })
      return { stale: false as const, handoverId, shiftId: toShiftId,
        state: 'ACTIVE' as const, referenceStatus: incoming.referenceStatus, snapshotId: incoming.id }
    })
    if (result.stale) throw new BusinessError('پس از شمارش گیرنده فروش ثبت شد یا روز عوض شد؛ فروش محفوظ است و دو شمارش تازه لازم است.', 'BLUE_RECOUNT_REQUIRED')
    return result
  },

  /** The original custodian may cancel a normal pending handover or a frozen
   * difference-pending handover. Cancelling never deletes the receiver's blind
   * count; it only returns operational responsibility to the outgoing segment. */
  async handoverCancel(input: { handoverId: unknown; password: unknown }) {
    const handoverId = asSafeId(input.handoverId, 'شناسه تحویل')
    const pending = await prisma.custodyHandover.findUnique({ where: { id: handoverId } })
    if (!pending || !['PENDING', 'RECEIVER_COUNTED'].includes(pending.status))
      throw new BusinessError('این تحویل دیگر در انتظار لغو نیست.', 'HANDOVER_NOT_PENDING')
    const giver = await this.verifyPin(pending.fromUserId, input.password)
    return prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      const watermark = JSON.parse(String(pending.ledgerWatermark || '{}'))
      const live = await tx.custodyHandover.findUnique({ where: { id: handoverId } })
      if (!live || live.status !== pending.status || (pending.status === 'RECEIVER_COUNTED' && watermark.blueV1 !== true))
        throw new BusinessError('تحویل هم‌زمان تغییر کرد؛ وضعیت را تازه کنید.', 'CUSTODY_STALE')
      const frozenDifference = state.state === 'HANDOVER_RECOUNT' && !!watermark.differencePending
      if ((state.state !== 'HANDOVER_PENDING' && !frozenDifference) || state.pendingHandoverId !== handoverId || state.activeShiftId !== pending.fromShiftId)
        throw new BusinessError('این تحویل دیگر در انتظار لغو نیست.', 'HANDOVER_NOT_PENDING')
      const nextEpoch = Number(state.epoch) + 1
      const canceledKind = frozenDifference ? 'CANCELED_BY_GIVER_AFTER_DIFFERENCE_FREEZE' : 'CANCELED_BY_GIVER'
      /** An adoption candidate (bootstrap without baseline) is discarded, not
       * deleted: it is marked CANCELED on this handover's own evidence and was
       * never written as a CustodyAggregateBoundary, so no later boundary can
       * be reconciled against a count that was abandoned. */
      const adoptionCandidate = watermark.aggregateAdoptionCandidate && typeof watermark.aggregateAdoptionCandidate === 'object'
        ? { ...watermark.aggregateAdoptionCandidate, status: 'CANCELED', canceledAt: new Date().toISOString() }
        : null
      const canceled = await tx.custodyHandover.updateMany({ where: { id: handoverId, status: pending.status }, data: { status: 'CANCELED', resolutionKind: canceledKind, finishedAt: new Date(), ...(adoptionCandidate ? { ledgerWatermark: JSON.stringify({ ...watermark, aggregateAdoptionCandidate: adoptionCandidate }) } : {}), version: { increment: 1 } } })
      if (canceled.count !== 1) throw new BusinessError('تحویل هم‌زمان تغییر کرد؛ لغو ثبت نشد.', 'CUSTODY_STALE')
      await tx.custodyCount.create({ data: { shiftId: pending.fromShiftId, kind: 'HANDOVER_CANCELED', countedCash: pending.countedAtStart, countedByUserId: giver.userId, authMethod: 'CUSTODY_PIN', handoverId, epochAtCount: nextEpoch, idempotencyKey: `cancel:${handoverId}`, operationalDay: toJalaliDate(new Date()) } })
      const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: frozenDifference ? 'HANDOVER_RECOUNT' : 'HANDOVER_PENDING', activeShiftId: pending.fromShiftId, pendingHandoverId: handoverId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: pending.fromShiftId, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ لغو ثبت نشد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: frozenDifference ? 'HANDOVER_DIFFERENCE_FROZEN_CANCELED' : 'HANDOVER_CANCEL', shiftId: pending.fromShiftId, handoverId, actorUserId: giver.userId, actorKind: 'CUSTODIAN', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { preservedDifferenceCountId: frozenDifference ? watermark.differencePending?.countId ?? null : null, aggregateAdoptionCandidateCanceled: adoptionCandidate != null } })
      return { handoverId, state: 'ACTIVE', epoch: nextEpoch }
    })
  },

  /**
   * Emergency cover transfers the physical drawer to a present, PIN-authenticated
   * worker when the prior custodian cannot complete a normal handover. It is a
   * separate auditable path: a mandatory reason and physical count are attached
   * to the prior segment, while the cover worker owns the newly created one.
   */
  async emergencyCover(input: { userId: unknown; password: unknown; countedCash?: unknown; operationalTotal?: unknown; reason: unknown }) {
    const cover = await this.verifyPin(input.userId, input.password)
    if (cover.role !== 'MANAGER' && cover.role !== 'CASHIER')
      throw new BusinessError('این نقش مجاز به پوشش اضطراری صندوق نیست.', 'NO_PERMISSION')
    if ((await legacyOpenShifts(prisma)).length)
      throw new BusinessError('نشست بازِ سیستم قدیم فقط از مسیر بازیابی رسمی تعیین تکلیف می‌شود؛ پوشش اضطراری برای آن مجاز نیست.', 'CUSTODY_LEGACY_OPEN_SHIFT')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 10)
      throw new BusinessError('برای پوشش اضطراری صندوق، دلیل روشنِ حداقل ۱۰ حرف وارد کنید.', 'EMERGENCY_REASON_REQUIRED')
    if (input.operationalTotal != null) return commitBlueEmergency({
      receiver: cover, count: asCash(input.operationalTotal, 'مجموع کشو و کارت‌خوان پوشش اضطراری'),
      reason, managerOverride: false
    })
    /** Internal compatibility only for pre-blue cash-only recovery. New IPC
     * never accepts `countedCash` and cannot enter the old freeze workflow. */
    if (input.countedCash == null)
      throw new BusinessError('برای پوشش اضطراری، مجموع کورِ کشو و کارت‌خوان الزامی است.', 'CUSTODY_AGGREGATE_COUNT_REQUIRED')
    const countedCash = asCash(input.countedCash, 'شمارش قدیمی پوشش اضطراری')

    const emergency = await prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      if (state.state === 'HANDOVER_RECOUNT' && state.pendingHandoverId) {
        const pending = await tx.custodyHandover.findUnique({ where: { id: state.pendingHandoverId } })
        if (!pending || pending.status !== 'EMERGENCY_RECOUNT' || pending.resolutionKind !== 'EMERGENCY_COVER')
          throw new BusinessError('یک شمارش نهایی دیگر در جریان است؛ چند لحظه بعد دوباره تلاش کنید.', 'CUSTODY_FROZEN')
        if (pending.selectedRecipientUserId !== cover.userId)
          throw new BusinessError('پوشش اضطراری در حال ثبت فقط با PIN همان کارمند انتخاب‌شده قابل ادامه است.', 'EMERGENCY_COVER_IN_PROGRESS')
        if (Number(pending.countedAtStart) !== countedCash || String(pending.resolutionReason ?? '') !== reason)
          throw new BusinessError('پوشش اضطراریِ ناتمام با شمارش یا دلیل دیگری قابل ادامه نیست؛ همان مبلغ و دلیلِ ثبت‌شده را وارد کنید.', 'EMERGENCY_RETRY_MISMATCH')
        return { handoverId: pending.id, fromShiftId: pending.fromShiftId, epoch: Number(state.epoch), outCountId: pending.outCountId, resumed: true }
      }
      if (state.state !== 'ACTIVE' || !state.activeShiftId)
        throw new BusinessError('پوشش اضطراری فقط وقتی ممکن است که صندوق مسئول فعال داشته باشد.', 'NO_ACTIVE_CUSTODY')
      const [fromShift, fromMeta] = await Promise.all([
        tx.shift.findUnique({ where: { id: state.activeShiftId } }),
        tx.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })
      ])
      if (!fromShift || fromShift.closedAt || !fromShift.userId || !fromMeta || fromMeta.custodianUserId !== fromShift.userId)
        throw new BusinessError('وضعیت مسئول فعلی صندوق ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
      if (fromShift.userId === cover.userId)
        throw new BusinessError('پوشش اضطراری باید به کارمند فعالِ دیگری سپرده شود؛ مسئول فعلی خودش باید مسیر عادی صندوق را تکمیل کند.', 'EMERGENCY_SAME_CUSTODIAN')
      const freezeEpoch = Number(state.epoch) + 1
      const declared = await tx.custodyCount.create({
        data: {
          shiftId: fromShift.id,
          kind: 'EMERGENCY_COVER_AGGREGATE_COUNT',
          countedCash: BigInt(countedCash),
          countedByUserId: cover.userId,
          authMethod: 'CUSTODY_PIN',
          note: reason,
          epochAtCount: freezeEpoch,
          idempotencyKey: `emergency:${fromShift.id}:${state.epoch}:${cover.userId}`,
          operationalDay: toJalaliDate(new Date())
        }
      })
      const handover = await tx.custodyHandover.create({
        data: {
          fromShiftId: fromShift.id,
          fromUserId: fromShift.userId,
          selectedRecipientUserId: cover.userId,
          status: 'EMERGENCY_RECOUNT',
          outCountId: declared.id,
          expectedAtStart: BigInt(0),
          countedAtStart: BigInt(countedCash),
          differenceCash: BigInt(0),
          ledgerWatermark: JSON.stringify({ ready: false, aggregateMode: true, emergency: true, countedCash, reason, at: new Date().toISOString() }),
          fenceEpochAtStart: freezeEpoch,
          idempotencyKey: `emergency:${fromShift.id}:${state.epoch}:${cover.userId}`,
          stateKey: MAIN,
          operationalDay: toJalaliDate(new Date()),
          resolutionKind: 'EMERGENCY_COVER',
          resolutionReason: reason
        }
      })
      const changed = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'ACTIVE', activeShiftId: fromShift.id, epoch: state.epoch },
        data: { state: 'HANDOVER_RECOUNT', activeShiftId: fromShift.id, pendingHandoverId: handover.id, epoch: freezeEpoch, updatedAt: new Date() }
      })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ پوشش اضطراری ثبت نشد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'EMERGENCY_COVER_FREEZE', shiftId: fromShift.id, handoverId: handover.id, actorUserId: cover.userId, actorKind: 'EMERGENCY_COVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: freezeEpoch, payload: { countedCash, reason, priorCustodianUserId: fromShift.userId } })
      return { handoverId: handover.id, fromShiftId: fromShift.id, epoch: freezeEpoch, outCountId: declared.id, resumed: false }
    })

    const restoreAfterFailure = async (failure: string) => {
      await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== emergency.handoverId || state.epoch !== emergency.epoch) return
        const pending = await tx.custodyHandover.findUnique({ where: { id: emergency.handoverId } })
        if (!pending || pending.status !== 'EMERGENCY_RECOUNT') return
        const nextEpoch = Number(state.epoch) + 1
        await tx.custodyHandover.update({ where: { id: emergency.handoverId }, data: { status: 'EMERGENCY_ABORTED', resolutionKind: 'EMERGENCY_COVER_ABORTED', finishedAt: new Date(), version: { increment: 1 } } })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'HANDOVER_RECOUNT', pendingHandoverId: emergency.handoverId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: emergency.fromShiftId, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count === 1) await writeEvent(tx, { type: 'EMERGENCY_COVER_ABORTED', shiftId: emergency.fromShiftId, handoverId: emergency.handoverId, actorUserId: cover.userId, actorKind: 'EMERGENCY_COVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { failure } })
      })
    }

    let expectedCash: number
    let aggregatePhysicalMovement: number
    /** One aggregate count is enough. A live segment without its own
     * aggregate baseline (opened cash-only / before rollout) is bootstrapped
     * by this real count: no second count, no separate opening, no guessed
     * expected amount, no historical delta and no case (ADOPTION). */
    let aggregateBootstrap = false
    try {
      aggregatePhysicalMovement = await physicalMovementForCustodyShift(emergency.fromShiftId)
      const baseline = await segmentAggregateBaseline(prisma, emergency.fromShiftId)
      const preview = previewSegmentBoundary(baseline, aggregatePhysicalMovement, countedCash)
      aggregateBootstrap = preview.bootstrap
      expectedCash = preview.operationalExpectedTotal
    } catch (error) {
      await restoreAfterFailure('EXPECTED_CALCULATION_FAILED')
      throw error
    }
    const differenceCash = countedCash - expectedCash

    try {
      return await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== emergency.handoverId || state.epoch !== emergency.epoch || state.activeShiftId !== emergency.fromShiftId)
          throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ پوشش اضطراری ثبت نشد.', 'CUSTODY_STALE')
        const [live, fromMeta, cfg, scheduling] = await Promise.all([
          tx.custodyHandover.findUnique({ where: { id: emergency.handoverId } }),
          tx.custodyShiftMeta.findUnique({ where: { shiftId: emergency.fromShiftId } }),
          configOf(tx),
          shiftSchedulingOf(tx)
        ])
        if (!live || live.status !== 'EMERGENCY_RECOUNT' || live.selectedRecipientUserId !== cover.userId || live.fromShiftId !== emergency.fromShiftId || !fromMeta)
          throw new BusinessError('اطلاعات پوشش اضطراری ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
        const nextEpoch = Number(state.epoch) + 1
        /** A bootstrap adoption has no expected amount; the count row keeps NULL. */
        if (!aggregateBootstrap) await tx.custodyCount.update({ where: { id: emergency.outCountId }, data: { expectedCash: BigInt(expectedCash), differenceCash: BigInt(differenceCash) } })
        const closed = await shiftService.closeInTx(tx, { shiftId: emergency.fromShiftId, userId: live.fromUserId, note: `پوشش اضطراری صندوق: ${reason}` })
        const sourceTemplate = fromMeta.templateId ? scheduling.templates.find((row) => row.id === fromMeta.templateId) ?? null : null
        const plan = planFromSegmentSnapshot(fromMeta, sourceTemplate)
        const immutableScheduleSnapshot = fromMeta.scheduleSnapshotJson ?? scheduleSnapshotJson(plan, scheduling, cfg)
        const next = await shiftService.createSession(tx, { staffId: cover.userId, staffConfirmed: true, actorId: cover.userId, mode: 'EMERGENCY_COVER', openIdempotencyKey: `emergency-cover:${emergency.handoverId}`, openIdempotencyFingerprint: `custody-emergency:${emergency.handoverId}`, note: `پوشش اضطراری صندوق: ${reason}` })
        const aggregateBoundary = await recordAggregateBoundary(tx, {
          boundaryKind: 'EMERGENCY_COVER',
          fromShiftId: emergency.fromShiftId,
          toShiftId: next.id,
          handoverId: emergency.handoverId,
          observedOperationalTotal: countedCash,
          countedByUserId: cover.userId,
          authMethod: 'CUSTODY_PIN',
          idempotencyKey: `aggregate-emergency:${emergency.handoverId}`,
          physicalMovement: aggregatePhysicalMovement,
          operationalDay: toJalaliDate(new Date()),
          priorScope: 'SOURCE_SEGMENT',
          bootstrapWithoutBaseline: true
        })
        if (aggregateBoundary.newDifference !== differenceCash || (aggregateBoundary.baselineSource === 'ADOPTION') !== aggregateBootstrap)
          throw new BusinessError('محاسبهٔ مرز پوشش اضطراری هم‌زمان تغییر کرد؛ عملیات ثبت نشد.', 'CUSTODY_STALE')
        await tx.custodyShiftMeta.update({ where: { shiftId: emergency.fromShiftId }, data: { endKind: 'EMERGENCY_COVERED', endedAt: closed.closedAt } })
        await tx.custodyShiftMeta.create({ data: { shiftId: next.id, custodianUserId: cover.userId, openAuth: 'EMERGENCY_COVER_PIN', templateId: plan?.templateId ?? null, planId: plan?.legacyPlanId ?? null, planTitle: plan?.title ?? null, scheduledEndAt: plan?.scheduledEndAt ?? null, scheduleSnapshotJson: immutableScheduleSnapshot, rolloverAt: rolloverAtForSnapshot(new Date(), cfg, scheduling, plan, immutableScheduleSnapshot), dayCutoverSnapshot: cfg.dayCutoverMinute, operationalDay: toJalaliDate(new Date()), countStatus: 'COUNTED', openEpoch: nextEpoch } })
        await tx.custodyHandover.update({ where: { id: emergency.handoverId }, data: { status: 'COMPLETED', finalCustodianUserId: cover.userId, acceptedByUserId: cover.userId, resolutionKind: 'EMERGENCY_COVER_COMPLETED', resolutionReason: reason, expectedAtStart: BigInt(expectedCash), differenceCash: BigInt(differenceCash), ledgerWatermark: JSON.stringify({ aggregateMode: true, emergency: true, ready: true, accepted: true, expectedCash, countedCash, differenceCash, reason, differenceAttributedToUserId: aggregateBootstrap ? null : live.fromUserId, countId: emergency.outCountId, aggregateBootstrap, aggregateBoundaryId: aggregateBoundary.id, aggregateBaselineSource: aggregateBoundary.baselineSource, at: new Date().toISOString() }), toShiftId: next.id, finishedAt: new Date(), version: { increment: 1 } } })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'HANDOVER_RECOUNT', activeShiftId: emergency.fromShiftId, pendingHandoverId: emergency.handoverId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: next.id, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ پوشش اضطراری ثبت نشد.', 'CUSTODY_STALE')
        await writeEvent(tx, { type: 'EMERGENCY_COVER_COMPLETED', shiftId: emergency.fromShiftId, handoverId: emergency.handoverId, actorUserId: cover.userId, actorKind: 'EMERGENCY_COVER', authMethod: 'CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { fromShiftId: emergency.fromShiftId, toShiftId: next.id, priorCustodianUserId: live.fromUserId, expectedCash: aggregateBootstrap ? null : expectedCash, countedCash, differenceCash, reason, countId: emergency.outCountId, aggregateBootstrap, aggregateBoundaryId: aggregateBoundary.id, unreconciledSegmentMovement: aggregateBootstrap ? aggregatePhysicalMovement : null } })
        return { handoverId: emergency.handoverId, shiftId: next.id, state: 'ACTIVE', resumed: emergency.resumed }
      })
    } catch (error) {
      try { await restoreAfterFailure('COMPLETION_FAILED') } catch { /* preserve the original failure */ }
      throw error
    }
  },

  /** Master Override selects and authenticates a NAMED manager with their
   * personal custody PIN. A shared manager session alone never approves the
   * transfer. The live combined-money path uses system absence evidence and
   * never waits in a persistent financial freeze. */
  async masterOverride(input: { managerUserId: unknown; managerPassword: unknown; countedCash?: unknown; operationalTotal?: unknown; reason: unknown }) {
    const managerUserId = asSafeId(input.managerUserId, 'شناسه مدیر')
    const [manager, credential] = await Promise.all([
      prisma.user.findUnique({ where: { id: managerUserId } }),
      credentialOf(prisma, managerUserId)
    ])
    if (!manager || !manager.isActive || manager.role !== 'MANAGER')
      throw new BusinessError('مدیر انتخاب‌شده فعال نیست یا دسترسی مدیر ندارد.', 'MASTER_OVERRIDE_MANAGER_INVALID')
    if (!credential || credential.status !== 'ACTIVE' || credential.mustChange)
      throw new BusinessError('مدیر انتخاب‌شده باید پیش از Master Override یک PIN شخصی فعال و غیرموقتِ حضانت داشته باشد.', 'MASTER_OVERRIDE_MANAGER_PIN_REQUIRED')
    /** A shared manager session does not identify the approving person. Only
     * this selected active manager's own non-temporary custody PIN does. */
    const verifiedManager = await this.verifyPin(manager.id, input.managerPassword, { requireManager: true })

    /** Legacy-open Shift recovery is a stricter invariant than the new input
     * contract. Preserve its fail-closed error rather than letting a missing
     * aggregate field look like a bypassable validation issue. */
    if ((await legacyOpenShifts(prisma)).length)
      throw new BusinessError('نشست بازِ سیستم قدیم فقط از مسیر بازیابی رسمی تعیین تکلیف می‌شود؛ Master Override برای آن مجاز نیست.', 'CUSTODY_LEGACY_OPEN_SHIFT')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 10)
      throw new BusinessError('برای Master Override صندوق، دلیل روشنِ حداقل ۱۰ حرف وارد کنید.', 'MASTER_OVERRIDE_REASON_REQUIRED')
    if (input.operationalTotal != null) return commitBlueEmergency({
      receiver: verifiedManager,
      count: asCash(input.operationalTotal, 'مجموع کشو و کارت‌خوان Master Override'),
      reason, managerOverride: true
    })
    /** Old direct/internal cash-only API can resume its historical evidence;
     * the public IPC strips this field and uses the no-freeze blue path. */
    if (input.countedCash == null)
      throw new BusinessError('برای Master Override، مجموع کورِ کشو و کارت‌خوان الزامی است.', 'CUSTODY_AGGREGATE_COUNT_REQUIRED')
    const countedCash = asCash(input.countedCash, 'شمارش قدیمی Master Override')

    const override = await prisma.$transaction(async (tx: Client) => {
      const state = await ensureState(tx)
      if (state.state === 'HANDOVER_RECOUNT' && state.pendingHandoverId) {
        const pending = await tx.custodyHandover.findUnique({ where: { id: state.pendingHandoverId } })
        if (!pending || pending.status !== 'MASTER_OVERRIDE_RECOUNT' || pending.resolutionKind !== 'MASTER_OVERRIDE')
          throw new BusinessError('یک شمارش نهایی دیگر در جریان است؛ چند لحظه بعد دوباره تلاش کنید.', 'CUSTODY_FROZEN')
        if (pending.selectedRecipientUserId !== manager.id)
          throw new BusinessError('Master Override ناتمام فقط با همان مدیر انتخاب‌شده قابل ادامه است.', 'MASTER_OVERRIDE_IN_PROGRESS')
        if (Number(pending.countedAtStart) !== countedCash || String(pending.resolutionReason ?? '') !== reason)
          throw new BusinessError('Master Override ناتمام با شمارش یا دلیل دیگری قابل ادامه نیست؛ همان مبلغ و دلیل ثبت‌شده را وارد کنید.', 'MASTER_OVERRIDE_RETRY_MISMATCH')
        return { handoverId: pending.id, fromShiftId: pending.fromShiftId, epoch: Number(state.epoch), outCountId: pending.outCountId, resumed: true }
      }
      if (state.state !== 'ACTIVE' || !state.activeShiftId) {
        if ((await legacyOpenShifts(tx)).length)
          throw new BusinessError('نشست بازِ سیستم قدیم فقط از مسیر بازیابی رسمی تعیین تکلیف می‌شود؛ Master Override برای آن مجاز نیست.', 'CUSTODY_LEGACY_OPEN_SHIFT')
        throw new BusinessError('Master Override فقط وقتی ممکن است که صندوق مسئول فعال داشته باشد.', 'NO_ACTIVE_CUSTODY')
      }
      const [fromShift, fromMeta] = await Promise.all([
        tx.shift.findUnique({ where: { id: state.activeShiftId } }),
        tx.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })
      ])
      if (!fromShift || fromShift.closedAt || !fromShift.userId || !fromMeta || fromMeta.custodianUserId !== fromShift.userId)
        throw new BusinessError('وضعیت مسئول فعلی صندوق ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
      if (fromShift.userId === manager.id)
        throw new BusinessError('مدیر انتخاب‌شده همین حالا مسئول صندوق است؛ از مسیر عادی صندوق استفاده کنید.', 'MASTER_OVERRIDE_SAME_CUSTODIAN')
      const freezeEpoch = Number(state.epoch) + 1
      const declared = await tx.custodyCount.create({
        data: {
          shiftId: fromShift.id,
          kind: 'MASTER_OVERRIDE_AGGREGATE_COUNT',
          countedCash: BigInt(countedCash),
          countedByUserId: manager.id,
          authMethod: 'MANAGER_CUSTODY_PIN',
          note: reason,
          epochAtCount: freezeEpoch,
          idempotencyKey: `master-override:${fromShift.id}:${state.epoch}:${manager.id}`,
          operationalDay: toJalaliDate(new Date())
        }
      })
      const handover = await tx.custodyHandover.create({
        data: {
          fromShiftId: fromShift.id,
          fromUserId: fromShift.userId,
          selectedRecipientUserId: manager.id,
          /** Same selected manager both approves the exceptional path and owns
           * the incoming responsibility; retain that identity on the durable
           * handover record as well as the append-only event. */
          managerApproverUserId: manager.id,
          status: 'MASTER_OVERRIDE_RECOUNT',
          outCountId: declared.id,
          expectedAtStart: BigInt(0),
          countedAtStart: BigInt(countedCash),
          differenceCash: BigInt(0),
          ledgerWatermark: JSON.stringify({ ready: false, aggregateMode: true, masterOverride: true, countedCash, reason, at: new Date().toISOString() }),
          fenceEpochAtStart: freezeEpoch,
          idempotencyKey: `master-override:${fromShift.id}:${state.epoch}:${manager.id}`,
          stateKey: MAIN,
          operationalDay: toJalaliDate(new Date()),
          resolutionKind: 'MASTER_OVERRIDE',
          resolutionReason: reason
        }
      })
      const changed = await tx.custodyState.updateMany({
        where: { key: MAIN, state: 'ACTIVE', activeShiftId: fromShift.id, epoch: state.epoch },
        data: { state: 'HANDOVER_RECOUNT', activeShiftId: fromShift.id, pendingHandoverId: handover.id, epoch: freezeEpoch, updatedAt: new Date() }
      })
      if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ Master Override ثبت نشد.', 'CUSTODY_STALE')
      await writeEvent(tx, { type: 'MASTER_OVERRIDE_FREEZE', shiftId: fromShift.id, handoverId: handover.id, actorUserId: manager.id, actorKind: 'MASTER_OVERRIDE_MANAGER', authMethod: 'MANAGER_CUSTODY_PIN', epochBefore: state.epoch, epochAfter: freezeEpoch, payload: { countedCash, reason, priorCustodianUserId: fromShift.userId } })
      return { handoverId: handover.id, fromShiftId: fromShift.id, epoch: freezeEpoch, outCountId: declared.id, resumed: false }
    })

    const restoreAfterFailure = async (failure: string) => {
      await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== override.handoverId || state.epoch !== override.epoch) return
        const pending = await tx.custodyHandover.findUnique({ where: { id: override.handoverId } })
        if (!pending || pending.status !== 'MASTER_OVERRIDE_RECOUNT') return
        const nextEpoch = Number(state.epoch) + 1
        await tx.custodyHandover.update({ where: { id: override.handoverId }, data: { status: 'MASTER_OVERRIDE_ABORTED', resolutionKind: 'MASTER_OVERRIDE_ABORTED', finishedAt: new Date(), version: { increment: 1 } } })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'HANDOVER_RECOUNT', pendingHandoverId: override.handoverId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: override.fromShiftId, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count === 1) await writeEvent(tx, { type: 'MASTER_OVERRIDE_ABORTED', shiftId: override.fromShiftId, handoverId: override.handoverId, actorUserId: manager.id, actorKind: 'MASTER_OVERRIDE_MANAGER', authMethod: 'MANAGER_CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { failure } })
      })
    }

    let expectedCash: number
    let aggregatePhysicalMovement: number
    /** One aggregate count is enough. A live segment without its own
     * aggregate baseline (opened cash-only / before rollout) is bootstrapped
     * by this real count: no second count, no separate opening, no guessed
     * expected amount, no historical delta and no case (ADOPTION). */
    let aggregateBootstrap = false
    try {
      aggregatePhysicalMovement = await physicalMovementForCustodyShift(override.fromShiftId)
      const baseline = await segmentAggregateBaseline(prisma, override.fromShiftId)
      const preview = previewSegmentBoundary(baseline, aggregatePhysicalMovement, countedCash)
      aggregateBootstrap = preview.bootstrap
      expectedCash = preview.operationalExpectedTotal
    } catch (error) {
      await restoreAfterFailure('EXPECTED_CALCULATION_FAILED')
      throw error
    }
    const differenceCash = countedCash - expectedCash

    try {
      return await prisma.$transaction(async (tx: Client) => {
        const state = await ensureState(tx)
        if (state.state !== 'HANDOVER_RECOUNT' || state.pendingHandoverId !== override.handoverId || state.epoch !== override.epoch || state.activeShiftId !== override.fromShiftId)
          throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ Master Override ثبت نشد.', 'CUSTODY_STALE')
        const [live, fromMeta, cfg, scheduling] = await Promise.all([
          tx.custodyHandover.findUnique({ where: { id: override.handoverId } }),
          tx.custodyShiftMeta.findUnique({ where: { shiftId: override.fromShiftId } }),
          configOf(tx),
          shiftSchedulingOf(tx)
        ])
        if (!live || live.status !== 'MASTER_OVERRIDE_RECOUNT' || live.selectedRecipientUserId !== manager.id || live.fromShiftId !== override.fromShiftId || !fromMeta)
          throw new BusinessError('اطلاعات Master Override ناسازگار است.', 'CUSTODY_INVARIANT_BROKEN')
        const nextEpoch = Number(state.epoch) + 1
        /** A bootstrap adoption has no expected amount; the count row keeps NULL. */
        if (!aggregateBootstrap) await tx.custodyCount.update({ where: { id: override.outCountId }, data: { expectedCash: BigInt(expectedCash), differenceCash: BigInt(differenceCash) } })
        const closed = await shiftService.closeInTx(tx, { shiftId: override.fromShiftId, userId: live.fromUserId, note: `Master Override صندوق: ${reason}` })
        const sourceTemplate = fromMeta.templateId ? scheduling.templates.find((row) => row.id === fromMeta.templateId) ?? null : null
        const plan = planFromSegmentSnapshot(fromMeta, sourceTemplate)
        const immutableScheduleSnapshot = fromMeta.scheduleSnapshotJson ?? scheduleSnapshotJson(plan, scheduling, cfg)
        const next = await shiftService.createSession(tx, { staffId: manager.id, staffConfirmed: true, actorId: manager.id, mode: 'MASTER_OVERRIDE', openIdempotencyKey: `master-override:${override.handoverId}`, openIdempotencyFingerprint: `custody-master-override:${override.handoverId}`, note: `Master Override صندوق: ${reason}` })
        const aggregateBoundary = await recordAggregateBoundary(tx, {
          boundaryKind: 'MASTER_OVERRIDE',
          fromShiftId: override.fromShiftId,
          toShiftId: next.id,
          handoverId: override.handoverId,
          observedOperationalTotal: countedCash,
          countedByUserId: manager.id,
          authMethod: 'MANAGER_CUSTODY_PIN',
          idempotencyKey: `aggregate-master-override:${override.handoverId}`,
          physicalMovement: aggregatePhysicalMovement,
          operationalDay: toJalaliDate(new Date()),
          priorScope: 'SOURCE_SEGMENT',
          bootstrapWithoutBaseline: true
        })
        if (aggregateBoundary.newDifference !== differenceCash || (aggregateBoundary.baselineSource === 'ADOPTION') !== aggregateBootstrap)
          throw new BusinessError('محاسبهٔ مرز Master Override هم‌زمان تغییر کرد؛ عملیات ثبت نشد.', 'CUSTODY_STALE')
        await tx.custodyShiftMeta.update({ where: { shiftId: override.fromShiftId }, data: { endKind: 'MASTER_OVERRIDDEN', endedAt: closed.closedAt } })
        await tx.custodyShiftMeta.create({ data: { shiftId: next.id, custodianUserId: manager.id, openAuth: 'MASTER_OVERRIDE_MANAGER_PIN', templateId: plan?.templateId ?? null, planId: plan?.legacyPlanId ?? null, planTitle: plan?.title ?? null, scheduledEndAt: plan?.scheduledEndAt ?? null, scheduleSnapshotJson: immutableScheduleSnapshot, rolloverAt: rolloverAtForSnapshot(new Date(), cfg, scheduling, plan, immutableScheduleSnapshot), dayCutoverSnapshot: cfg.dayCutoverMinute, operationalDay: toJalaliDate(new Date()), countStatus: 'COUNTED', openEpoch: nextEpoch } })
        await tx.custodyHandover.update({ where: { id: override.handoverId }, data: { status: 'COMPLETED', finalCustodianUserId: manager.id, acceptedByUserId: manager.id, resolutionKind: 'MASTER_OVERRIDE_COMPLETED', resolutionReason: reason, expectedAtStart: BigInt(expectedCash), differenceCash: BigInt(differenceCash), ledgerWatermark: JSON.stringify({ aggregateMode: true, masterOverride: true, ready: true, accepted: true, expectedCash, countedCash, differenceCash, reason, differenceAttributedToUserId: aggregateBootstrap ? null : live.fromUserId, countId: override.outCountId, aggregateBootstrap, aggregateBoundaryId: aggregateBoundary.id, aggregateBaselineSource: aggregateBoundary.baselineSource, at: new Date().toISOString() }), toShiftId: next.id, finishedAt: new Date(), version: { increment: 1 } } })
        const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: 'HANDOVER_RECOUNT', activeShiftId: override.fromShiftId, pendingHandoverId: override.handoverId, epoch: state.epoch }, data: { state: 'ACTIVE', activeShiftId: next.id, pendingHandoverId: null, epoch: nextEpoch, updatedAt: new Date() } })
        if (changed.count !== 1) throw new BusinessError('وضعیت صندوق هم‌زمان تغییر کرد؛ Master Override ثبت نشد.', 'CUSTODY_STALE')
        await writeEvent(tx, { type: 'MASTER_OVERRIDE_COMPLETED', shiftId: override.fromShiftId, handoverId: override.handoverId, actorUserId: manager.id, actorKind: 'MASTER_OVERRIDE_MANAGER', authMethod: 'MANAGER_CUSTODY_PIN', epochBefore: state.epoch, epochAfter: nextEpoch, payload: { fromShiftId: override.fromShiftId, toShiftId: next.id, priorCustodianUserId: live.fromUserId, expectedCash: aggregateBootstrap ? null : expectedCash, countedCash, differenceCash, reason, countId: override.outCountId, aggregateBootstrap, aggregateBoundaryId: aggregateBoundary.id, unreconciledSegmentMovement: aggregateBootstrap ? aggregatePhysicalMovement : null } })
        return { handoverId: override.handoverId, shiftId: next.id, state: 'ACTIVE', resumed: override.resumed }
      })
    } catch (error) {
      try { await restoreAfterFailure('COMPLETION_FAILED') } catch { /* preserve original failure */ }
      throw error
    }
  },

  /** Manager-only case list for aggregate drawer + POS discrepancies.  The
   * rows are deliberately separate from the legacy cash-only custody report so
   * historical counts retain their original accounting meaning. */
  async discrepancyReport(input: { from?: unknown; to?: unknown; status?: unknown; take?: unknown; skip?: unknown; bootstrapTake?: unknown; bootstrapSkip?: unknown; managerSession?: boolean } = {}) {
    if (input.managerSession !== true) throw new BusinessError('گزارش مغایرت فقط با نشست دوم مدیر قابل مشاهده است.', 'MANAGER_SESSION_REQUIRED')
    assertManagerSession('دیدن پرونده‌های مغایرت کشو و کارت‌خوان')
    const { from, to, fromJalali, toJalali } = custodyJalaliRange(input)
    const requestedStatus = String(input.status ?? 'ALL').toUpperCase()
    if (!['ALL', 'OPEN', 'CLOSED'].includes(requestedStatus)) throw new BusinessError('فیلتر وضعیت مغایرت نامعتبر است.')
    const statusWhere = requestedStatus === 'ALL' ? {} : { status: requestedStatus }
    const take = Math.min(200, Math.max(1, Math.round(Number(input.take ?? 50)) || 50))
    const skip = Math.min(50_000, Math.max(0, Math.trunc(Number(input.skip ?? 0)) || 0))
    /** Cases and neutral adoptions have different identities/meaning. Neither
     * offset should silently advance the other stream. Legacy callers still
     * get their first 200 adoption rows when no explicit window is supplied. */
    const bootstrapTake = Math.min(200, Math.max(1, Math.round(Number(input.bootstrapTake ?? 200)) || 200))
    const bootstrapSkip = Math.min(50_000, Math.max(0, Math.trunc(Number(input.bootstrapSkip ?? 0)) || 0))
    const stores: any = prisma as any
    const where = { detectedAt: { gte: from, lte: to }, ...statusWhere }
    const [rowsPlusOne, openSummary, closedSummary, allSummary, shortageSummary, overageSummary] = await Promise.all([
      stores.custodyDiscrepancyCase.findMany({
        where,
        orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: take + 1,
        include: { reviews: { orderBy: [{ at: 'asc' }, { id: 'asc' }] } }
      }),
      stores.custodyDiscrepancyCase.aggregate({ where: { detectedAt: { gte: from, lte: to }, status: 'OPEN' }, _count: { _all: true }, _sum: { differenceAmount: true } }),
      stores.custodyDiscrepancyCase.aggregate({ where: { detectedAt: { gte: from, lte: to }, status: 'CLOSED' }, _count: { _all: true }, _sum: { differenceAmount: true } }),
      stores.custodyDiscrepancyCase.aggregate({ where: { detectedAt: { gte: from, lte: to } }, _count: { _all: true } }),
      stores.custodyDiscrepancyCase.aggregate({ where: { detectedAt: { gte: from, lte: to }, differenceAmount: { lt: BigInt(0) } }, _sum: { differenceAmount: true } }),
      stores.custodyDiscrepancyCase.aggregate({ where: { detectedAt: { gte: from, lte: to }, differenceAmount: { gt: BigInt(0) } }, _sum: { differenceAmount: true } })
    ])
    const rows = rowsPlusOne.slice(0, take)
    /** Boundary detail for each listed case, plus the evidence-neutral
     * bootstrap (ADOPTION) boundaries of the same Jalali range. Adoptions never
     * create a case, so without this list they would be invisible to the
     * manager. Bounded; never part of any employee response. */
    const boundaryIds = rows.map((row: any) => row.boundaryId).filter((id: any) => Number.isSafeInteger(id))
    const [caseBoundaries, adoptionRowsPlusOne] = await Promise.all([
      boundaryIds.length ? stores.custodyAggregateBoundary.findMany({ where: { id: { in: boundaryIds } } }) : Promise.resolve([]),
      stores.custodyAggregateBoundary.findMany({ where: { baselineSource: 'ADOPTION', at: { gte: from, lte: to } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: bootstrapSkip, take: bootstrapTake + 1 })
    ])
    const boundaryById = new Map((caseBoundaries as any[]).map((row: any) => [row.id, row]))
    const boundaryDetail = (row: any) => row ? {
      id: row.id,
      boundaryKind: row.boundaryKind,
      previousBoundaryId: row.previousBoundaryId ?? null,
      priorAcceptedObservedTotal: row.priorAcceptedObservedTotal,
      priorTheoreticalTotal: row.priorTheoreticalTotal,
      physicalMovement: row.physicalMovement,
      sourceMovementOffset: row.sourceMovementOffset ?? BigInt(0),
      baselineSource: row.baselineSource ?? null,
      countedByUserId: row.countedByUserId,
      authMethod: row.authMethod,
      calculationVersion: row.calculationVersion,
      at: row.at
    } : null
    const adoptionRows = (adoptionRowsPlusOne as any[]).slice(0, bootstrapTake)
    const userIds = new Set<number>()
    for (const row of adoptionRows) if (row.countedByUserId) userIds.add(row.countedByUserId)
    for (const row of caseBoundaries as any[]) if (row.countedByUserId) userIds.add(row.countedByUserId)
    for (const row of rows) {
      if (row.closedByUserId) userIds.add(row.closedByUserId)
      for (const review of row.reviews ?? []) if (review.managerUserId) userIds.add(review.managerUserId)
    }
    const users = userIds.size
      ? await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true } })
      : []
    const names = new Map(users.map((row: any) => [row.id, row.displayName]))
    const difference = (summary: any) => Number(summary?._sum?.differenceAmount ?? 0)
    return {
      from: fromJalali,
      to: toJalali,
      status: requestedStatus,
      page: { skip, take, hasMore: rowsPlusOne.length > take },
      summary: {
        allCases: Number(allSummary?._count?._all ?? 0),
        openCases: Number(openSummary?._count?._all ?? 0),
        closedCases: Number(closedSummary?._count?._all ?? 0),
        net: difference(openSummary) + difference(closedSummary),
        shortages: difference(shortageSummary),
        overages: difference(overageSummary)
      },
      bootstrapBoundaries: {
        page: { skip: bootstrapSkip, take: bootstrapTake, hasMore: adoptionRowsPlusOne.length > bootstrapTake },
        hasMore: adoptionRowsPlusOne.length > bootstrapTake,
        rows: adoptionRows.map((row: any) => ({
          ...boundaryDetail(row),
          fromShiftId: row.fromShiftId ?? null,
          toShiftId: row.toShiftId ?? null,
          observedOperationalTotal: row.observedOperationalTotal,
          operationalDay: row.operationalDay,
          countedByName: names.get(row.countedByUserId) ?? null
        }))
      },
      cases: rows.map((row: any) => ({
        id: row.id,
        boundaryId: row.boundaryId,
        status: row.status,
        boundaryKind: row.boundaryKind,
        fromShiftId: row.fromShiftId ?? null,
        toShiftId: row.toShiftId ?? null,
        detectedAt: row.detectedAt,
        operationalExpectedTotal: row.operationalExpectedTotal,
        theoreticalExpectedTotal: row.theoreticalExpectedTotal,
        observedOperationalTotal: row.observedOperationalTotal,
        differenceAmount: row.differenceAmount,
        totalTheoreticalDifference: row.totalTheoreticalDifference,
        operationalDay: row.operationalDay,
        closedAt: row.closedAt ?? null,
        closedByUserId: row.closedByUserId ?? null,
        closedByName: row.closedByUserId ? names.get(row.closedByUserId) ?? null : null,
        currentReviewResult: row.currentReviewResult ?? null,
        boundary: boundaryDetail(boundaryById.get(row.boundaryId)),
        reviews: (row.reviews ?? []).map((review: any) => ({
          id: review.id,
          action: review.action,
          managerUserId: review.managerUserId ?? null,
          managerName: review.managerUserId ? names.get(review.managerUserId) ?? null : null,
          actorKind: review.actorKind ?? 'MANAGER_SESSION',
          result: review.result ?? null,
          note: review.note,
          at: review.at
        }))
      }))
    }
  },

  /** Main-generated export for the same Jalali-filtered, manager-authorized
   * discrepancy page. Renderer supplies only scope, never financial rows. */
  async exportDiscrepancyReport(input: { from?: unknown; to?: unknown; status?: unknown; take?: unknown; skip?: unknown; bootstrapTake?: unknown; bootstrapSkip?: unknown; managerSession?: boolean } = {}) {
    const report: any = await this.discrepancyReport({ ...input, take: Math.min(200, Math.max(1, Number(input.take ?? 200) || 200)), managerSession: true })
    const { exportTableFile } = await import('./ExportService')
    const rows = report.cases.map((row: any) => [
      row.id,
      row.operationalDay,
      row.boundaryKind,
      row.fromShiftId ?? '—',
      row.toShiftId ?? '—',
      row.status,
      String(row.theoreticalExpectedTotal),
      String(row.operationalExpectedTotal),
      String(row.observedOperationalTotal),
      String(row.differenceAmount),
      String(row.totalTheoreticalDifference),
      row.currentReviewResult ?? '',
      row.reviews.map((review: any) => `${review.action}: ${review.note}`).join(' | ')
    ])
    /** An ADOPTION_BASELINE is a real blind observation, but deliberately has
     * neither a prior reference nor a discrepancy case. Include it as a
     * separate neutral row; NEVER turn its internally equal expected/observed
     * placeholders into a claimed manager reference or a zero fresh delta. */
    for (const boundary of report.bootstrapBoundaries.rows) rows.push([
      `افتتاح خنثی #${boundary.id}`,
      boundary.operationalDay,
      boundary.boundaryKind,
      boundary.fromShiftId ?? '—',
      boundary.toShiftId ?? '—',
      'بدون پرونده (افتتاح خنثی)',
      '', '', String(boundary.observedOperationalTotal), '', '', '',
      `ADOPTION · بدون مبنای قبلی؛ اختلاف تازه نامعلوم · شمارش‌کننده ${boundary.countedByName ?? boundary.countedByUserId} · احراز ${boundary.authMethod} · نسخه ${boundary.calculationVersion}`
    ])
    const result = await exportTableFile({
      fileName: 'گزارش-مغایرت-کشو-کارتخوان',
      sheetName: 'مغایرت حضانت',
      title: `گزارش مغایرت کشو و کارت‌خوان + مرزهای افتتاح خنثی · ${report.from} تا ${report.to} · وضعیت پرونده‌ها ${report.status} · صفحه پرونده ${report.page.skip}، صفحه افتتاح ${report.bootstrapBoundaries.page.skip} · ${report.page.hasMore || report.bootstrapBoundaries.hasMore ? 'این صفحه تمام سوابق نیست؛ صفحه‌های بعد را جدا بگیرید' : 'پایان شواهد بازه'}`,
      headers: ['شناسه', 'روز عملیاتی', 'نوع مرز', 'شیفت قبلی', 'شیفت بعدی', 'وضعیت', 'نظری مدیر', 'انتظار عملیاتی', 'شمارش کور', 'اختلاف تازه', 'اختلاف نظری کل', 'نتیجه فعلی', 'سابقه بازبینی'],
      rows
    })
    await audit(prisma, { action: 'CUSTODY_DISCREPANCY_EXPORT', entity: 'CustodyDiscrepancyReport', userId: null, after: JSON.stringify({ outcome: result.canceled ? 'CANCELED' : 'SAVED', from: report.from, to: report.to, status: report.status, rows: result.rows, caseRows: report.cases.length, neutralAdoptions: report.bootstrapBoundaries.rows.length, caseSkip: report.page.skip, adoptionSkip: report.bootstrapBoundaries.page.skip, hasMoreCases: report.page.hasMore, hasMoreAdoptions: report.bootstrapBoundaries.hasMore }), note: 'خروجی پرونده‌ها و مرزهای افتتاح خنثی با نشست مشترک مدیر؛ بدون انتساب هویت فردی مدیر' })
    return result
  },

  /** Closing and reopening add manager-authenticated review rows.  The original
   * blind observation, expectation and delta are never updated. */
  async reviewDiscrepancyCase(input: { caseId: unknown; action: unknown; note: unknown; result?: unknown; idempotencyKey?: unknown; managerSession?: boolean }) {
    if (input.managerSession !== true) throw new BusinessError('بازبینی مغایرت فقط با نشست دوم مدیر مجاز است.', 'MANAGER_SESSION_REQUIRED')
    assertManagerSession('بستن یا بازگشایی پرونده مغایرت کشو و کارت‌خوان')
    const caseId = asSafeId(input.caseId, 'شناسه پرونده مغایرت')
    const action = String(input.action ?? '').toUpperCase()
    if (!['CLOSE', 'REOPEN', 'NOTE'].includes(action)) throw new BusinessError('عملیات بازبینی مغایرت نامعتبر است.')
    const note = String(input.note ?? '').trim()
    if (note.length < 10) throw new BusinessError('برای ثبت بازبینی پرونده، یادداشت روشنِ حداقل ۱۰ حرف وارد کنید.')
    const result = String(input.result ?? '').trim().slice(0, 160) || null
    if (action === 'CLOSE' && !result) throw new BusinessError('بستن پرونده نیازمند نتیجهٔ بازبینی مدیر است.')
    const idempotencyKey = String(input.idempotencyKey ?? '').trim() || `discrepancy:${caseId}:${action}:${randomBytes(12).toString('hex')}`
    const stores: any = prisma as any
    return prisma.$transaction(async (tx: Client) => {
      const db: any = tx as any
      const priorReview = await db.custodyDiscrepancyReview.findUnique({ where: { idempotencyKey } })
      if (priorReview) return { caseId, status: (await db.custodyDiscrepancyCase.findUnique({ where: { id: caseId } }))?.status ?? null, replayed: true }
      const row = await db.custodyDiscrepancyCase.findUnique({ where: { id: caseId } })
      if (!row) throw new BusinessError('پرونده مغایرت پیدا نشد.')
      if (action === 'CLOSE' && row.status !== 'OPEN') throw new BusinessError('فقط پرونده باز قابل بستن است.')
      if (action === 'REOPEN' && row.status !== 'CLOSED') throw new BusinessError('فقط پرونده بسته قابل بازگشایی است.')
      /** The shared manager session authenticates authority but does not prove
       * an individual employee identity. Preserve that distinction explicitly
       * instead of inventing a manager id from renderer input. */
      const managerUserId = null
      await db.custodyDiscrepancyReview.create({ data: { caseId, action, managerUserId, actorKind: 'MANAGER_SESSION', result, note, idempotencyKey } })
      if (action === 'CLOSE') {
        await db.custodyDiscrepancyCase.update({ where: { id: caseId }, data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: null, currentReviewResult: result, version: { increment: 1 } } })
      } else if (action === 'REOPEN') {
        await db.custodyDiscrepancyCase.update({ where: { id: caseId }, data: { status: 'OPEN', closedAt: null, closedByUserId: null, currentReviewResult: null, version: { increment: 1 } } })
      }
      await writeEvent(tx, { type: `AGGREGATE_DISCREPANCY_${action}`, actorUserId: null, actorKind: 'GLOBAL_MANAGER', authMethod: 'MANAGER_SESSION', payload: { caseId, action, result } })
      await auditOrThrow(tx, { action: AuditAction.SETTINGS_UPDATE, entity: 'CustodyDiscrepancyCase', entityId: caseId, userId: null, after: JSON.stringify({ action, result, note, actorKind: 'MANAGER_SESSION' }), note: `بازبینی مدیر برای پرونده مغایرت کشو و کارت‌خوان: ${action}` })
      const updated = await db.custodyDiscrepancyCase.findUnique({ where: { id: caseId } })
      return { caseId, status: updated?.status ?? null, replayed: false }
    })
  },

  /**
   * `expectedCash` is sensitive ledger information: it may only be exposed for
   * the drawer that is actively under custody. In particular, it is not a
   * historical/reporting shortcut and it must not become an oracle while the
   * receiver is performing a blind handover count. Manager reports use their
   * own explicitly authenticated, read-only routes instead.
   *
   * The public IPC boundary calls this before CashboxService. Internal custody
   * reconciliation deliberately calls CashboxService directly inside its
   * controlled state machine, so recovery can snapshot a closed segment without
   * reopening it or leaking that number through the renderer.
   */
  async assertExpectedCashRead(input: { shiftId?: unknown } = {}) {
    const cfg = await configOf(prisma)
    if (!cfg.enabled) return null
    /** An active custody workflow has one blind-count rule, not merely a
     * handover-time rule.  The employee-facing cash preview is therefore not
     * an expected-money oracle; the manager-only discrepancy report is the
     * authorized evidence surface. */
    await this.ensureRolledOver()
    void input
    throw new BusinessError('در حالت حضانت، مبلغ انتظار به کارمند نمایش داده نمی‌شود. کنترل مبلغ نظری فقط در گزارش محافظت‌شدهٔ مدیر انجام می‌شود.', 'CUSTODY_EXPECTED_HIDDEN')
  },

  /** A POS operator who is not the physical drawer custodian must prove their
   * own active custody PIN. This authenticates operation only; it deliberately
   * does not open, transfer, or otherwise change drawer responsibility. */
  async verifySaleOperator(userId: unknown, password: unknown) {
    const operator = await this.verifyPin(userId, password)
    if (operator.role !== 'MANAGER' && operator.role !== 'CASHIER')
      throw new BusinessError('این نقش مجاز به ثبت فروش در صندوق نیست.', 'NO_PERMISSION')
    return { userId: operator.userId, name: operator.displayName, role: operator.role }
  },

  async actorForFinancialOperation(): Promise<CustodyFence | null> {
    const cfg = await configOf(prisma)
    if (!cfg.enabled) return null
    await this.ensureRolledOver()
    const state = await ensureState(prisma)
    /** A custody-enabled sale must never manufacture a fictional owner or a
     * drawer segment. The worker who accepts the physical drawer is the only
     * person who may create an ACTIVE custody segment through open(), an
     * authenticated handover, emergency cover, or the explicit shared-password
     * Master Override workflow. */
    if (state.state === 'NO_SESSION')
      throw new BusinessError('برای ثبت فروش، ابتدا مسئول حاضر صندوق باید با رمز شخصی و شمارش فیزیکی صندوق را تحویل بگیرد.', 'CUSTODY_AUTH_REQUIRED')
    /** Pending is not a lock: all monetary writers keep the outgoing fence and
     * therefore remain attributed to the current custodian. Acceptance moves
     * through the short-lived HANDOVER_RECOUNT state to establish a watermark. */
    if (state.state !== 'ACTIVE' && state.state !== 'HANDOVER_PENDING') {
      if (state.state === 'HANDOVER_RECOUNT') throw new BusinessError('تحویل‌گیرنده در حال شمارش نهایی است؛ چند لحظه بعد فروش را دوباره ثبت کنید.', 'HANDOVER_RECOUNT')
      if (state.state === 'CUSTODIAN_ARCHIVE_FREEZE') throw new BusinessError('آرشیو مسئول فعال صندوق در حال ثبت است؛ تا ایجاد پروندهٔ بازیابی هیچ عملیات مالی انجام ندهید.', 'CUSTODIAN_ARCHIVE_FREEZE')
      throw new BusinessError('برای ادامهٔ فروش، ابتدا مسئول صندوق را مشخص کنید.', 'CUSTODY_AUTH_REQUIRED')
    }
    if (!state.activeShiftId) throw new BusinessError('برای ادامهٔ فروش، ابتدا مسئول صندوق را مشخص کنید.', 'CUSTODY_AUTH_REQUIRED')
    const [shift, meta] = await Promise.all([prisma.shift.findUnique({ where: { id: state.activeShiftId } }), prisma.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId } })])
    if (!shift || shift.closedAt || !shift.userId || !meta || meta.custodianUserId !== shift.userId)
      throw new BusinessError('وضعیت حضانت صندوق ناسازگار است؛ مدیر باید آن را بررسی کند.', 'CUSTODY_INVARIANT_BROKEN')
    return { epoch: Number(state.epoch), expectedShiftId: shift.id, expectedActorUserId: shift.userId }
  },

  /** First statement of every fenced financial transaction.  It intentionally
   * performs a conditional write, rather than a read, to serialize SQLite
   * writers and reject stale requests after handover/close/rollover. */
  async assertFenceInTx(tx: Client, fence: CustodyFence, opts: { allowClosedShift?: boolean } = {}) {
    const changed = await tx.custodyState.updateMany({ where: { key: MAIN, state: { in: ['ACTIVE', 'HANDOVER_PENDING'] }, activeShiftId: fence.expectedShiftId, epoch: fence.epoch }, data: { updatedAt: new Date() } })
    if (changed.count !== 1) throw new BusinessError('صندوق همین حالا تحویل یا بسته شد؛ صفحه را تازه کنید و دوباره تلاش کنید.', 'CUSTODY_STALE')
    const [shift, meta] = await Promise.all([tx.shift.findUnique({ where: { id: fence.expectedShiftId } }), tx.custodyShiftMeta.findUnique({ where: { shiftId: fence.expectedShiftId } })])
    if (!shift || (!opts.allowClosedShift && !!shift.closedAt) || shift.userId !== fence.expectedActorUserId || !meta || meta.custodianUserId !== fence.expectedActorUserId)
      throw new BusinessError('وضعیت مسئول صندوق هم‌زمان تغییر کرد؛ درخواست ثبت نشد.', 'CUSTODY_STALE')
    return shift
  }
}
