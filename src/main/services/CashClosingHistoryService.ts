import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { currentManagerSessionIdentity } from './panelSession'
import { isValidJalaliDate, jalaliStartOfDay, toJalaliDate, toLatinDigits } from '@shared/jalali'
import { CUSTODY_REFERENCE_LEGACY_VERSION, CUSTODY_REFERENCE_PREVIOUS_VERSION, CUSTODY_REFERENCE_VERSION } from '@shared/custodyReference'
import { blueEvidenceFault, bluePairFault } from './CustodyBlueIntegrity'
import { reconcileCustodyPeriod, type CustodyObservation } from '@shared/custodyPeriod'
import type { CustodyReference } from '@shared/custodyReference'
import { readBlueNotesForSnapshots } from './CustodyBlueNoteService'
import type {
  CashClosingHistoryPerson, CashClosingHistoryQuery, CashClosingHistoryResult,
  CashClosingHistoryRow, CashClosingHistoryStream, CashClosingHistoryTotals
} from '@shared/cashClosingHistory'

/** Only completed outcomes are eligible. OPENING, RECEIVER_COUNTED, stale,
 * canceled, unresolved rollover, recovery and self-count are NOT closings or
 * handovers. No financial/operational service is imported or invoked here. */
const BLUE_HANDOVERS = ['BLUE_HANDOVER_COMMITTED', 'BLUE_EMERGENCY_COVER_COMMITTED', 'BLUE_MASTER_OVERRIDE_COMMITTED'] as const
const OLD_HANDOVERS = ['HANDOVER_ACCEPT', 'HANDOVER_ACCEPT_WITH_DIFFERENCE', 'EMERGENCY_COVER_COMPLETED', 'MASTER_OVERRIDE_COMPLETED'] as const
const FINAL_CLOSES = ['BLUE_FINAL_CLOSE_COMMITTED', 'FINAL_CLOSE'] as const
/** The owner has not approved unlimited memory or writer delay. This is a hard
 * fail-closed bound, not a truncated count. Tighten it if the production
 * Prisma/SQLite contention gate shows unacceptable sale latency. */
export const CASH_HISTORY_MAX_EVIDENCE = 20_000
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const MAX_SNAPSHOTS = 3
const SNAPSHOT_TTL_MS = 5 * 60_000
const CURSOR_KEY = randomBytes(32)
const TAKE_DEFAULT = 50
const TAKE_MAX = 200
const READ_TX_OPTIONS = { maxWait: 150, timeout: 3_000 } as const

const QUERY_FIELDS = new Set(['fromJalali', 'toJalali', 'includeLegacyCustody', 'includeLegacyCashSessions', 'includeBlueV1', 'take', 'snapshotToken', 'cursor'])
const EXPORT_FIELDS = new Set(['snapshotToken', 'format'])
const tooLarge = () => new BusinessError('تعداد رویدادهای این بازه از سقف ایمن گزارش بیشتر است؛ لطفاً بازهٔ تاریخ را کوچک‌تر کنید. هیچ شمارندهٔ ناقصی نمایش داده نمی‌شود.', 'REPORT_TOO_LARGE')
const expired = () => new BusinessError('اعتبار نسخهٔ ثابت گزارش تمام شده یا نشست مدیر تغییر کرده است؛ لطفاً گزارش را دوباره بگیرید.', 'REPORT_SNAPSHOT_EXPIRED')
const invalid = () => new BusinessError('درخواست گزارش بستن صندوق نامعتبر است؛ تاریخ‌ها و صفحه‌بندی را بررسی کنید.', 'REPORT_INVALID')

type Normalized = {
  fromJalali: string
  toJalali: string
  from: Date
  toExclusive: Date
  includeLegacyCustody: boolean
  includeLegacyCashSessions: boolean
  includeBlueV1: boolean
  take: number
  hash: string
}

type Snapshot = {
  token: string
  identity: string
  hash: string
  take: number
  range: CashClosingHistoryResult['range']
  snapshotAt: string
  expiresAtMs: number
  rows: CashClosingHistoryRow[]
  legacyRows: CashClosingHistoryRow[]
  totals: CashClosingHistoryTotals
  warnings: string[]
  bytes: number
}
const snapshots = new Map<string, Snapshot>()
let materializing = false

function onlyFields(raw: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid()
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !fields.has(key))) throw invalid()
  return value
}

function normalize(raw: Record<string, unknown>): Normalized {
  if (typeof raw.fromJalali !== 'string' || typeof raw.toJalali !== 'string') throw invalid()
  const fromJalali = toLatinDigits(raw.fromJalali).trim()
  const toJalali = toLatinDigits(raw.toJalali).trim()
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(fromJalali) || !/^\d{4}\/\d{2}\/\d{2}$/.test(toJalali) ||
      !isValidJalaliDate(fromJalali) || !isValidJalaliDate(toJalali) || fromJalali > toJalali) throw invalid()
  const flag = (value: unknown) => {
    if (value === undefined) return true
    if (typeof value !== 'boolean') throw invalid()
    return value
  }
  const includeLegacyCustody = flag(raw.includeLegacyCustody)
  const includeLegacyCashSessions = flag(raw.includeLegacyCashSessions)
  const includeBlueV1 = flag(raw.includeBlueV1)
  const take = raw.take === undefined ? TAKE_DEFAULT : raw.take
  if (typeof take !== 'number' || !Number.isSafeInteger(take) || take < 1 || take > TAKE_MAX) throw invalid()
  const from = jalaliStartOfDay(fromJalali)
  const toExclusive = jalaliStartOfDay(toJalali)
  toExclusive.setDate(toExclusive.getDate() + 1)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(toExclusive.getTime())) throw invalid()
  const hash = createHash('sha256').update(JSON.stringify({ fromJalali, toJalali, includeLegacyCustody, includeLegacyCashSessions, includeBlueV1, take })).digest('hex')
  return { fromJalali, toJalali, from, toExclusive, includeLegacyCustody, includeLegacyCashSessions, includeBlueV1, take, hash }
}

function eventTypes(options: Normalized): string[] {
  return [...BLUE_HANDOVERS, 'BLUE_FINAL_CLOSE_COMMITTED',
    ...(options.includeLegacyCustody ? [...OLD_HANDOVERS, 'FINAL_CLOSE'] : [])]
}

function chunk<T>(rows: T[], size = 350): T[][] {
  const parts: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) parts.push(rows.slice(offset, offset + size))
  return parts
}
function ids(raw: unknown[]): number[] {
  return [...new Set(raw.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0))]
}
function idOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null
}
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length > 32_000) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}
function iso(raw: unknown): string | null {
  if (!(raw instanceof Date) || !Number.isFinite(raw.getTime())) return null
  return raw.toISOString()
}
function safeAmount(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw !== 'number' && typeof raw !== 'bigint' && typeof raw !== 'string') return null
  const n = Number(raw)
  // A report-reference can be negative after refunds; unlike a physical
  // count, its sign must be preserved exactly as stored in the snapshot.
  return Number.isSafeInteger(n) ? n : null
}

function sameStoredAmount(left: unknown, right: unknown): boolean {
  return left == null ? right == null : safeAmount(left) !== null && safeAmount(left) === safeAmount(right)
}
function validBlueReference(row: any): boolean {
  if (row?.calculationVersion === CUSTODY_REFERENCE_VERSION) return blueEvidenceFault(row) === null
  // Frozen V1/V2 predate the digest. Keep their historical structural checks;
  // do not relabel those rows as freshly signed V3 or recompute their figure.
  if (!row || ![CUSTODY_REFERENCE_PREVIOUS_VERSION, CUSTODY_REFERENCE_LEGACY_VERSION].includes(row.calculationVersion) ||
      typeof row.referenceFromDay !== 'string' || typeof row.referenceToDay !== 'string' ||
      !/^\d{4}\/\d{2}\/\d{2}$/.test(row.referenceFromDay) || !/^\d{4}\/\d{2}\/\d{2}$/.test(row.referenceToDay) ||
      !isValidJalaliDate(row.referenceFromDay) || !isValidJalaliDate(row.referenceToDay) ||
      row.referenceFromDay > row.referenceToDay || !['TODAY', 'PRIOR_AND_TODAY'].includes(row.scopeKind) ||
      (row.referenceStatus !== 'AVAILABLE' && row.referenceStatus !== 'PENDING_RECONCILIATION') ||
      (row.referenceStatus === 'AVAILABLE' ? safeAmount(row.referenceAmount) === null : row.referenceAmount != null) ||
      [row.knownSubtotal, row.ambiguousLegacyCredit, row.destinationUnknownReceived]
        .some((value) => value != null && safeAmount(value) === null)) return false
  return true
}
function validPhysicalCount(row: any, absent: boolean): boolean {
  if (!row) return false
  if (absent) return ['ABSENT_UNCOUNTED', 'SYSTEM_ABSENCE_ZERO'].includes(row.countOrigin) &&
    row.humanAmount == null && row.arithmeticAmount == null &&
    ['SYSTEM_ABSENCE', 'SYSTEM_ABSENCE_ZERO'].includes(row.authMethod)
  const count = safeAmount(row.humanAmount)
  return count !== null && count >= 0 && sameStoredAmount(row.humanAmount, row.arithmeticAmount) &&
    row.countOrigin === (count === 0 ? 'EXPLICIT_ZERO' : 'EXPLICIT_AMOUNT')
}

/** Verify a V3 FINAL_CLOSE's referenced baseline as well as its own digest.
 * The prior can be an IN outside the F10 date window: it must still be the
 * actual completed transfer INTO this Shift, with an intact OUT/IN pair.
 * These calculations are checks of the saved difference, never a replacement
 * reference amount displayed in F10 or a new closing event. */
function validFinalPrior(snapshot: any, shiftId: number, custodianId: number,
  snapshots: Map<number, any>, handovers: Map<number, any>, outs: Map<number, any>): boolean {
  if (snapshot.calculationVersion !== CUSTODY_REFERENCE_VERSION || snapshot.priorSnapshotId == null) return true
  const prior = snapshots.get(snapshot.priorSnapshotId)
  if (!prior || !validBlueReference(prior) || blueEvidenceFault(prior) || !validPhysicalCount(prior, false)) return false
  if (prior.role === 'OPENING') {
    if (prior.shiftId !== shiftId || prior.handoverId != null || prior.priorSnapshotId != null ||
        prior.actorUserId !== custodianId) return false
  } else if (prior.role === 'IN') {
    const handover = handovers.get(prior.handoverId)
    if (!handover || handover.status !== 'COMPLETED' || handover.toShiftId !== shiftId ||
        handover.finalCustodianUserId !== custodianId || prior.actorUserId !== custodianId ||
        bluePairFault(outs.get(prior.handoverId), prior, handover)) return false
  } else return false
  const periodOf = (row: any) => ({
    count: {
      origin: row.countOrigin, humanAmount: safeAmount(row.humanAmount),
      arithmeticAmount: safeAmount(row.arithmeticAmount)
    } as CustodyObservation,
    reference: {
      status: row.referenceStatus, referenceAmount: safeAmount(row.referenceAmount),
      knownSubtotal: safeAmount(row.knownSubtotal),
      destinationUnknownReceived: safeAmount(row.destinationUnknownReceived),
      ambiguousLegacyCredit: safeAmount(row.ambiguousLegacyCredit),
      calculationVersion: row.calculationVersion, warnings: []
    } as CustodyReference,
    scopeKey: `${row.referenceFromDay}:${row.referenceToDay}:${row.scopeKind}:${row.calculationVersion}`
  })
  const expected = reconcileCustodyPeriod({ start: periodOf(prior), end: periodOf(snapshot) })
  return sameStoredAmount(snapshot.rawDifference, expected.rawDifference) &&
    sameStoredAmount(snapshot.inheritedDifference, expected.inheritedDifference) &&
    sameStoredAmount(snapshot.freshDifference, expected.freshDifference) &&
    snapshot.freshStatus === expected.freshStatus
}

/** Do not hold a Prisma transaction across pagination or file export. The
 * complete, minimal evidence read is one snapshot; only projected rows stay
 * in bounded Main memory afterward. Never use an array of Prisma promises as
 * $transaction input: those promises may run before BEGIN. */
async function readEvidence(options: Normalized): Promise<{
  events: any[]; sessions: any[]; handovers: any[]; metas: any[]; shifts: any[];
  snapshots: any[]; resolutions: any[]; managerNotes: any[]; users: any[]; systemResolutions: any[];
  firstSessionByShift: Array<{ shiftId: number; _min: { id: number | null } }>
  firstSessionByRange: Array<{ fromDate: Date; dayJalali: string; _min: { id: number | null } }>
}> {
  return prisma.$transaction(async (tx: any) => {
    const at = { gte: options.from, lt: options.toExclusive }
    const eventWhere = { type: { in: eventTypes(options) }, at }
    const sessionWhere = { OR: [{ closedAt: at }, { closedAt: null, createdAt: at }] }
    const eventCount = await tx.custodyEvent.count({ where: eventWhere })
    if (eventCount > CASH_HISTORY_MAX_EVIDENCE) throw tooLarge()
    const sessionCount = options.includeLegacyCashSessions ? await tx.cashSession.count({ where: sessionWhere }) : 0
    if (eventCount + sessionCount > CASH_HISTORY_MAX_EVIDENCE) throw tooLarge()
    const events = await tx.custodyEvent.findMany({ where: eventWhere,
      select: { id: true, type: true, shiftId: true, handoverId: true, payloadJson: true, at: true },
      orderBy: [{ at: 'desc' }, { id: 'desc' }], take: CASH_HISTORY_MAX_EVIDENCE + 1 })
    const sessions = options.includeLegacyCashSessions ? await tx.cashSession.findMany({ where: sessionWhere,
      select: { id: true, shiftId: true, closedAt: true, createdAt: true, closedBy: true, fromDate: true, toDate: true, dayJalali: true, note: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CASH_HISTORY_MAX_EVIDENCE + 1 }) : []
    if (events.length + sessions.length > CASH_HISTORY_MAX_EVIDENCE) throw tooLarge()
    const handoverSelect = {
      id: true, status: true, resolutionKind: true, resolutionReason: true, fromShiftId: true, toShiftId: true,
      fromUserId: true, finalCustodianUserId: true, selectedRecipientUserId: true, finishedAt: true
    } as const
    const handoverIds = ids(events.map((r: any) => r.handoverId))
    const handovers: any[] = []
    for (const part of chunk(handoverIds)) handovers.push(...await tx.custodyHandover.findMany({ where: { id: { in: part } }, select: handoverSelect }))
    const payloads: Array<Record<string, unknown> | null> = events.map((e: any) => jsonObject(e.payloadJson))
    const snapshotIds = ids(payloads.flatMap((p) => [idOf(p?.outSnapshotId), idOf(p?.inSnapshotId), idOf(p?.snapshotId)]))
    const snapshotSelect = {
      id: true, handoverId: true, shiftId: true, role: true, actorUserId: true, authMethod: true,
      countOrigin: true, humanAmount: true, arithmeticAmount: true, priorSnapshotId: true,
      referenceStatus: true, referenceAmount: true, knownSubtotal: true,
      destinationUnknownReceived: true, ambiguousLegacyCredit: true,
      referenceFromDay: true, referenceToDay: true, scopeKind: true, calculationVersion: true,
      sourceHash: true, sourceScope: true, financialRevision: true, epochAtCount: true,
      rawDifference: true, inheritedDifference: true, freshDifference: true,
      freshStatus: true, idempotencyKey: true, evidenceDigest: true, operationalDay: true
    } as const
    const blueSnapshots: any[] = []
    for (const part of chunk(snapshotIds)) blueSnapshots.push(...await tx.custodyBlueSnapshot.findMany({ where: { id: { in: part } }, select: snapshotSelect }))
    // FINAL_CLOSE may reference an opening or IN witness outside the selected
    // F10 date window. Fetch only those first-degree links in this SAME read
    // transaction; otherwise a damaged/missing prior could leave a known V3
    // close on-screen while its inherited difference has no valid source.
    const loadedSnapshotIds = new Set(snapshotIds)
    const finalPriors = ids(blueSnapshots.filter((row) => row.role === 'FINAL_CLOSE' &&
      row.calculationVersion === CUSTODY_REFERENCE_VERSION).map((row) => row.priorSnapshotId))
      .filter((id) => !loadedSnapshotIds.has(id))
    for (const part of chunk(finalPriors)) blueSnapshots.push(...await tx.custodyBlueSnapshot.findMany({
      where: { id: { in: part } }, select: snapshotSelect
    }))
    const finalPriorSet = new Set(finalPriors)
    const priorInHandoverIds = ids(blueSnapshots.filter((row) => finalPriorSet.has(row.id) && row.role === 'IN')
      .map((row) => row.handoverId))
    const knownHandoverIds = new Set(handoverIds)
    const missingHandoverIds = priorInHandoverIds.filter((id) => !knownHandoverIds.has(id))
    for (const part of chunk(missingHandoverIds)) handovers.push(...await tx.custodyHandover.findMany({
      where: { id: { in: part } }, select: handoverSelect
    }))
    for (const part of chunk(priorInHandoverIds)) blueSnapshots.push(...await tx.custodyBlueSnapshot.findMany({
      where: { handoverId: { in: part }, role: 'OUT' }, select: snapshotSelect
    }))
    const inIds = ids(payloads.flatMap((p) => [idOf(p?.inSnapshotId), idOf(p?.snapshotId)]))
    const resolutions: any[] = []
    for (const part of chunk(inIds)) {
      resolutions.push(...await tx.custodyBlueResolution.findMany({ where: { snapshotId: { in: part } }, select: {
        id: true, snapshotId: true, managerUserId: true, decisionKind: true, effectiveReferenceAmount: true, at: true
      }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: CASH_HISTORY_MAX_EVIDENCE + 1 - resolutions.length }))
      if (resolutions.length > CASH_HISTORY_MAX_EVIDENCE) throw tooLarge()
    }
    const managerNotes = await readBlueNotesForSnapshots(tx, snapshotIds)
    const shiftIds = ids([
      ...events.map((r: any) => r.shiftId), ...sessions.map((r: any) => r.shiftId),
      ...handovers.flatMap((h) => [h.fromShiftId, h.toShiftId])
    ])
    const metas: any[] = [], shifts: any[] = []
    for (const part of chunk(shiftIds)) {
      metas.push(...await tx.custodyShiftMeta.findMany({ where: { shiftId: { in: part } }, select: {
        shiftId: true, custodianUserId: true, planTitle: true, endKind: true, cashSessionId: true
      } }))
      shifts.push(...await tx.shift.findMany({ where: { id: { in: part } }, select: { id: true, name: true, userId: true } }))
    }
    const systemResolutions: any[] = []
    for (const part of chunk(ids(sessions.map((s: any) => s.id)))) systemResolutions.push(...await tx.custodyResolution.findMany({ where: { cashSessionId: { in: part } }, select: { shiftId: true, cashSessionId: true } }))
    const firstSessionByShift: Array<{ shiftId: number; _min: { id: number | null } }> = []
    for (const part of chunk(ids(sessions.map((s: any) => s.shiftId)))) firstSessionByShift.push(...await tx.cashSession.groupBy({
      by: ['shiftId'], where: { shiftId: { in: part } }, _min: { id: true }
    }))
    const firstSessionByRange: Array<{ fromDate: Date; dayJalali: string; _min: { id: number | null } }> = []
    const noShiftDates = [...new Map(sessions.filter((s: any) => s.shiftId == null && iso(s.fromDate))
      .map((s: any) => [iso(s.fromDate), s.fromDate])).values()]
    for (const part of chunk(noShiftDates)) {
      firstSessionByRange.push(...await tx.cashSession.groupBy({
        by: ['fromDate', 'dayJalali'], where: { shiftId: null, fromDate: { in: part } }, _min: { id: true }
      }))
      if (firstSessionByRange.length > CASH_HISTORY_MAX_EVIDENCE) throw tooLarge()
    }
    const userIds = ids([
      ...handovers.flatMap((h) => [h.fromUserId, h.finalCustodianUserId]),
      ...metas.map((m) => m.custodianUserId), ...shifts.map((s) => s.userId),
      ...sessions.map((s: any) => s.closedBy), ...resolutions.map((r) => r.managerUserId),
      ...managerNotes.map((n) => n.managerUserId)
    ])
    const users: any[] = []
    for (const part of chunk(userIds)) users.push(...await tx.user.findMany({ where: { id: { in: part } }, select: { id: true, displayName: true } }))
    return { events, sessions, handovers, snapshots: blueSnapshots, resolutions, managerNotes,
      metas, shifts, users, systemResolutions, firstSessionByShift, firstSessionByRange }
  }, READ_TX_OPTIONS)
}

function orderRows(rows: CashClosingHistoryRow[]): CashClosingHistoryRow[] {
  return rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.source.localeCompare(a.source) || b.sourceId - a.sourceId)
}

function project(raw: Awaited<ReturnType<typeof readEvidence>>, options: Normalized) {
  const handovers = new Map<number, any>(raw.handovers.map((h) => [h.id, h]))
  const blue = new Map<number, any>(raw.snapshots.map((s) => [s.id, s]))
  const outs = new Map<number, any>(raw.snapshots.filter((s) => s.role === 'OUT' && s.handoverId != null)
    .map((s) => [s.handoverId, s]))
  const metas = new Map<number, any>(raw.metas.map((m) => [m.shiftId, m]))
  const shifts = new Map<number, any>(raw.shifts.map((s) => [s.id, s]))
  const users = new Map<number, any>(raw.users.map((u) => [u.id, u]))
  const notes = new Map<number, CashClosingHistoryRow['managerNotes']>()
  for (const note of raw.managerNotes) {
    const at = iso(note.at)
    if (!at) throw new BusinessError('زمان یادداشت مدیر نامعتبر است؛ گزارش ناقص نمایش داده نمی‌شود.', 'REPORT_EVIDENCE_INVALID')
    const items = notes.get(note.snapshotId) ?? []
    items.push({ id: note.id, snapshotId: note.snapshotId, at, text: note.text,
      managerUserId: note.managerUserId, managerCurrentName: users.get(note.managerUserId)?.displayName ?? null })
    notes.set(note.snapshotId, items)
  }
  const decisions = new Map<number, any>()
  for (const row of raw.resolutions) if (!decisions.has(row.snapshotId)) decisions.set(row.snapshotId, row)
  const linkedCashSessions = new Set<number>()
  const seenHandovers = new Set<number>(), seenCloses = new Set<number>()
  const sessionsById = new Map<number, any>(raw.sessions.map((s) => [s.id, s]))
  const firstByShift = new Map<number, number>(raw.firstSessionByShift.map((s) => [s.shiftId, s._min.id ?? 0]))
  const rangeKey = (row: any) => `range:${iso(row?.fromDate)}:${String(row?.dayJalali ?? '')}`
  const firstByRange = new Map<string, number>(raw.firstSessionByRange.map((s) => [rangeKey(s), s._min.id ?? 0]))
  const warnings: string[] = []
  let quarantinedEvidence = 0
  const rows: CashClosingHistoryRow[] = []
  const legacyRows: CashClosingHistoryRow[] = []
  const person = (userId: number | null, shiftId: number | null, presence: CashClosingHistoryPerson['presence']): CashClosingHistoryPerson | null => {
    if (userId == null && shiftId == null) return null
    return {
      userId, currentName: userId == null ? null : users.get(userId)?.displayName ?? null,
      shiftId, scheduleTitleSnapshot: shiftId == null ? null : metas.get(shiftId)?.planTitle ?? null, presence
    }
  }
  for (const event of raw.events) {
    const eventAt = iso(event.at)
    if (!eventAt) throw new BusinessError('زمان یک سند تکمیل صندوق نامعتبر است؛ گزارش ناقص نمایش داده نمی‌شود.', 'REPORT_EVIDENCE_INVALID')
    const isClose = FINAL_CLOSES.includes(event.type as typeof FINAL_CLOSES[number])
    const isBlue = event.type.startsWith('BLUE_')
    const handoverId = idOf(event.handoverId)
    const payload = jsonObject(event.payloadJson)
    const handover = handoverId == null ? null : handovers.get(handoverId)
    const shiftId = idOf(event.shiftId)
    const kind: CashClosingHistoryRow['kind'] = isClose ? 'FINAL_CLOSE'
      : event.type.includes('EMERGENCY') ? 'EMERGENCY_COVER'
      : event.type.includes('OVERRIDE') ? 'MASTER_OVERRIDE' : 'HANDOVER'
    const expectedKind: Record<string, string> = {
      BLUE_HANDOVER_COMMITTED: 'BLUE_RECEIVER_ACCEPTED',
      BLUE_EMERGENCY_COVER_COMMITTED: 'BLUE_EMERGENCY_COVER',
      BLUE_MASTER_OVERRIDE_COMMITTED: 'BLUE_MASTER_OVERRIDE',
      HANDOVER_ACCEPT: 'RECEIVER_ACCEPTED',
      HANDOVER_ACCEPT_WITH_DIFFERENCE: 'RECEIVER_ACCEPTED_WITH_DIFFERENCE',
      EMERGENCY_COVER_COMPLETED: 'EMERGENCY_COVER_COMPLETED',
      MASTER_OVERRIDE_COMPLETED: 'MASTER_OVERRIDE_COMPLETED'
    }
    const inId = idOf(payload?.inSnapshotId)
    const outId = idOf(payload?.outSnapshotId)
    const finalId = idOf(payload?.snapshotId)
    const targetId = isClose ? finalId : inId
    const snapshot = targetId == null ? null : blue.get(targetId)
    const outgoing = outId == null ? null : blue.get(outId)
    const fromShiftId = handover ? idOf(handover.fromShiftId) : shiftId
    const toShiftId = handover ? idOf(handover.toShiftId) : null
    const fromUserId = handover ? idOf(handover.fromUserId) :
      fromShiftId == null ? null : idOf(metas.get(fromShiftId)?.custodianUserId ?? shifts.get(fromShiftId)?.userId)
    const toUserId = handover ? idOf(handover.finalCustodianUserId) : null
    const absent = isBlue && (kind === 'EMERGENCY_COVER' || kind === 'MASTER_OVERRIDE')
    const from = person(fromUserId, fromShiftId, absent ? 'ABSENT_UNCOUNTED' : isClose ? 'UNKNOWN' : 'COUNTED')
    const to = isClose ? null : person(toUserId, toShiftId, 'COUNTED')
    let evidenceWarning: string | null = null
    if (isClose) {
      const meta = shiftId == null ? null : metas.get(shiftId)
      if (!shiftId || !meta || meta.endKind !== (isBlue ? 'BLUE_FINAL_CLOSE' : 'FINAL_CLOSE'))
        evidenceWarning = 'سند پایان مسئولیت با رویداد بستن سازگار نیست.'
      if (!isBlue) {
        const linkedId = idOf(payload?.cashSessionId)
        if (!linkedId || meta?.cashSessionId !== linkedId)
          evidenceWarning = 'شناسهٔ بستن قدیمی و سند پایان مسئولیت با هم سازگار نیستند.'
        else linkedCashSessions.add(linkedId)
      }
    } else if (!handoverId || !handover || handover.status !== 'COMPLETED' ||
      handover.resolutionKind !== expectedKind[event.type] || !fromShiftId || !fromUserId || !toShiftId || !toUserId ||
      (isBlue && (shiftId !== toShiftId || idOf(payload?.fromShiftId) !== fromShiftId ||
        idOf(payload?.toShiftId) !== toShiftId))) {
      evidenceWarning = 'سند تأیید تحویل با رویداد تکمیل سازگار نیست.'
    }
    if (isBlue && !evidenceWarning) {
      // The normal V2 writer counts both OUT and IN on the *old* open Shift,
      // then creates the new Shift at confirmation. Emergency/override instead
      // creates its IN on the new Shift inside the same transaction. Some
      // immutable V1 IN documents used the destination Shift; accept those
      // ONLY with the full version-aware chain, never by relabeling them V2.
      const v1 = snapshot?.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION
      const incomingShiftValid = v1
        ? snapshot?.shiftId === fromShiftId || snapshot?.shiftId === toShiftId
        : snapshot?.shiftId === (absent ? toShiftId : fromShiftId)
      const peopleValid = isClose
        ? metas.get(shiftId!)?.custodianUserId === shifts.get(shiftId!)?.userId &&
          snapshot?.actorUserId === fromUserId
        : metas.get(fromShiftId!)?.custodianUserId === fromUserId &&
          shifts.get(fromShiftId!)?.userId === fromUserId &&
          metas.get(toShiftId!)?.custodianUserId === toUserId &&
          shifts.get(toShiftId!)?.userId === toUserId &&
          snapshot?.actorUserId === toUserId &&
          (absent ? outgoing?.actorUserId === toUserId : outgoing?.actorUserId === fromUserId)
      if (!snapshot || !validBlueReference(snapshot) || !validPhysicalCount(snapshot, false) || !peopleValid ||
          (isClose
            ? snapshot.role !== 'FINAL_CLOSE' || snapshot.shiftId !== shiftId || snapshot.handoverId != null ||
              !validFinalPrior(snapshot, shiftId!, fromUserId!, blue, handovers, outs)
            : !outgoing || !validBlueReference(outgoing) || !validPhysicalCount(outgoing, absent) ||
              snapshot.role !== 'IN' || outgoing.role !== 'OUT' || snapshot.handoverId !== handoverId ||
              outgoing.handoverId !== handoverId || !incomingShiftValid || outgoing.shiftId !== fromShiftId ||
              snapshot.priorSnapshotId !== outgoing.id || snapshot.sourceHash !== outgoing.sourceHash ||
              snapshot.sourceScope !== outgoing.sourceScope ||
              snapshot.calculationVersion !== outgoing.calculationVersion ||
              snapshot.referenceFromDay !== outgoing.referenceFromDay ||
              snapshot.referenceToDay !== outgoing.referenceToDay || snapshot.scopeKind !== outgoing.scopeKind ||
              snapshot.referenceStatus !== outgoing.referenceStatus ||
              !sameStoredAmount(snapshot.referenceAmount, outgoing.referenceAmount) ||
              !sameStoredAmount(snapshot.knownSubtotal, outgoing.knownSubtotal) ||
              !sameStoredAmount(snapshot.ambiguousLegacyCredit, outgoing.ambiguousLegacyCredit) ||
              !sameStoredAmount(snapshot.destinationUnknownReceived, outgoing.destinationUnknownReceived) ||
              snapshot.financialRevision !== outgoing.financialRevision)) {
        evidenceWarning = 'پیوند، مبلغ یا دامنهٔ اسناد مرجع آبی با رویداد تکمیل سازگار نیست.'
      }
      if (!evidenceWarning && !isClose && snapshot?.calculationVersion === CUSTODY_REFERENCE_VERSION &&
          bluePairFault(outgoing, snapshot, handover))
        evidenceWarning = 'نسخهٔ v3 اسناد OUT/IN با digest و پیوند واقعی تحویل سازگار نیست.'
    }
    let era: CashClosingHistoryRow['era'] = 'PRE_BLUE'
    let reference: CashClosingHistoryRow['reference'] = {
      state: 'NOT_RECORDED', amount: null, knownSubtotal: null,
      fromDay: null, toDay: null, scopeKind: null, snapshotId: null, calculationVersion: null
    }
    if (isBlue && snapshot) {
      era = snapshot.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? 'BLUE_V1'
        : snapshot.calculationVersion === CUSTODY_REFERENCE_PREVIOUS_VERSION ? 'BLUE_V2' : 'BLUE_V3'
      const fromDay = snapshot.referenceFromDay
      const toDay = snapshot.referenceToDay
      const scopeKind = snapshot.scopeKind
      const amount = safeAmount(snapshot.referenceAmount)
      const available = snapshot.referenceStatus === 'AVAILABLE' && amount !== null
      const pending = snapshot.referenceStatus === 'PENDING_RECONCILIATION' && snapshot.referenceAmount == null
      if (!available && !pending ||
          ![CUSTODY_REFERENCE_VERSION, CUSTODY_REFERENCE_PREVIOUS_VERSION, CUSTODY_REFERENCE_LEGACY_VERSION].includes(snapshot.calculationVersion) ||
          typeof fromDay !== 'string' || typeof toDay !== 'string' ||
          !isValidJalaliDate(fromDay) || !isValidJalaliDate(toDay) || fromDay > toDay ||
          !['TODAY', 'PRIOR_AND_TODAY'].includes(scopeKind)) {
        evidenceWarning = 'وضعیت، نسخه یا دامنهٔ مبلغ مرجع ذخیره‌شده ناسازگار است.'
      }
      reference = {
        state: pending ? era === 'BLUE_V1' ? 'PENDING_V1' : era === 'BLUE_V2' ? 'PENDING_V2' : 'PENDING_V3'
          : era === 'BLUE_V1' ? 'KNOWN_V1' : era === 'BLUE_V2' ? 'KNOWN_V2' : 'KNOWN_V3',
        amount: available ? amount : null,
        knownSubtotal: pending ? safeAmount(snapshot.knownSubtotal) : null,
        fromDay: fromDay ?? null, toDay: toDay ?? null,
        scopeKind: scopeKind === 'TODAY' || scopeKind === 'PRIOR_AND_TODAY' ? scopeKind : null,
        snapshotId: snapshot.id, calculationVersion: snapshot.calculationVersion
      }
    } else if (isBlue) evidenceWarning = evidenceWarning ?? 'سند مبلغ مرجع آبی پیدا نشد.'
    if (evidenceWarning) {
      // Keep the immutable event/snapshots for the manager's evidence review,
      // but never present a forged/invalid chain as a completed F10 outcome.
      // The separate warning counter prevents silent disappearance.
      quarantinedEvidence++
      continue
    }
    // Deduplicate only after checking the evidence. A malformed later event
    // must not mask an earlier valid commit for the same handover/Shift.
    if (isClose) {
      if (shiftId != null && seenCloses.has(shiftId)) { warnings.push('سند بستن نهایی تکراری بود؛ تنها یک بار شمرده شد.'); continue }
      if (shiftId != null) seenCloses.add(shiftId)
    } else {
      if (handoverId != null && seenHandovers.has(handoverId)) { warnings.push('سند تحویل تکراری بود؛ تنها یک بار شمرده شد.'); continue }
      if (handoverId != null) seenHandovers.add(handoverId)
    }
    // Hiding V1 is an explicit source filter. Never label it V2 or recalculate it.
    if (!options.includeBlueV1 && era === 'BLUE_V1') continue
    const decision = snapshot ? decisions.get(snapshot.id) : null
    const decisionAmount = decision ? safeAmount(decision.effectiveReferenceAmount) : null
    const laterDecision = decision && decisionAmount != null && iso(decision.at) ? {
      at: iso(decision.at)!, managerUserId: decision.managerUserId,
      managerCurrentName: users.get(decision.managerUserId)?.displayName ?? null,
      amount: decisionAmount, kind: decision.decisionKind
    } : null
    rows.push({
      source: 'CUSTODY_EVENT', sourceId: event.id, occurredAt: eventAt,
      occurredDayJalali: toJalaliDate(event.at), kind, era,
      handoverId, shiftId: isClose ? shiftId : fromShiftId, from, to, reference, laterDecision,
      reason: !isClose ? String(handover?.resolutionReason ?? payload?.reason ?? '').trim().slice(0, 1000) || null : null,
      managerNotes: [...new Set([outId, targetId].filter((id): id is number => id != null))]
        .flatMap((id) => notes.get(id) ?? []).sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id),
      evidenceWarning, legacyRepeat: false
    })
  }
  const systemSessions = new Set<number>(raw.systemResolutions.map((r) => r.cashSessionId))
  for (const session of raw.sessions) {
    // Custody final-close sessions already have their own commit event. An
    // unresolved-recovery session is NOT a real close. Neither becomes a
    // second historical close merely because a CashSession row exists.
    if (linkedCashSessions.has(session.id) || systemSessions.has(session.id) ||
        (session.shiftId != null && metas.has(session.shiftId))) continue
    const occurredAt = iso(session.closedAt) ?? iso(session.createdAt)
    if (!occurredAt) throw new BusinessError('زمان یک سند قدیمی صندوق نامعتبر است؛ گزارش ناقص نمایش داده نمی‌شود.', 'REPORT_EVIDENCE_INVALID')
    // Same shift or same no-shift range can be explicitly closed a second time.
    // Keep that real historical record visible, but do not call the correction
    // a new genuine final close or silently duplicate its count.
    const shiftId = idOf(session.shiftId)
    // A range-only old close has no shift owner. Use its stored closer when
    // available; never invent a person from today's active shift.
    const fromUserId = shiftId == null ? idOf(session.closedBy) : idOf(shifts.get(shiftId)?.userId ?? session.closedBy)
    legacyRows.push({
      source: 'CASH_SESSION', sourceId: session.id, occurredAt,
      occurredDayJalali: toJalaliDate(new Date(occurredAt)),
      kind: 'LEGACY_CLOSE', era: 'PRE_BLUE', handoverId: null, shiftId,
      from: person(fromUserId, shiftId, 'UNKNOWN'), to: null,
      reference: { state: 'NOT_RECORDED', amount: null, knownSubtotal: null, fromDay: null, toDay: null,
        scopeKind: null, snapshotId: null, calculationVersion: null }, laterDecision: null,
      reason: typeof session.note === 'string' ? session.note.slice(0, 1000) || null : null,
      managerNotes: [], evidenceWarning: null, legacyRepeat: false
    })
  }
  // A second close must be identified by the original committed row (oldest
  // session ID), not by a descending query. This also survives old imports.
  const groups = new Map<string, CashClosingHistoryRow[]>()
  for (const row of legacyRows) {
    const session = sessionsById.get(row.sourceId)
    const key = session?.shiftId == null ? rangeKey(session) : `shift:${session.shiftId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  for (const entries of groups.values()) {
    entries.sort((a, b) => a.sourceId - b.sourceId)
    entries.forEach((row) => {
      // A prior close can be outside the selected Jalali range. An in-range
      // repeat must NOT become a new genuine close just because the first
      // occurrence is not on this page (or even in this date range).
      row.legacyRepeat = row.shiftId != null ? row.sourceId !== firstByShift.get(row.shiftId) :
        row.sourceId !== firstByRange.get(rangeKey(sessionsById.get(row.sourceId)))
    })
  }
  orderRows(rows); orderRows(legacyRows)
  const totals: CashClosingHistoryTotals = {
    handovers: 0, handoversByKind: { normal: 0, emergency: 0, override: 0 }, finalClosings: 0,
    custodyFinalClosings: 0,
    legacyCloses: legacyRows.filter((r) => !r.legacyRepeat).length,
    legacyCorrections: legacyRows.filter((r) => r.legacyRepeat).length,
    amountKnownV3: 0, amountPendingV3: 0, amountKnownV2: 0, amountPendingV2: 0,
    amountKnownV1: 0, amountPendingV1: 0,
    amountNotRecorded: 0, amountInconsistent: quarantinedEvidence
  }
  for (const row of rows) {
    if (row.kind === 'FINAL_CLOSE') totals.custodyFinalClosings++
    else {
      totals.handovers++
      if (row.kind === 'HANDOVER') totals.handoversByKind.normal++
      else if (row.kind === 'EMERGENCY_COVER') totals.handoversByKind.emergency++
      else if (row.kind === 'MASTER_OVERRIDE') totals.handoversByKind.override++
    }
  }
  // D4's inclusive product option: the two headline counters cover ALL
  // genuinely completed outcomes, while old CashSessions remain a clearly
  // labeled, independently paged source with no invented blue amount.
  totals.finalClosings = totals.custodyFinalClosings + totals.legacyCloses
  for (const row of [...rows, ...legacyRows]) {
    if (row.reference.state === 'KNOWN_V3') totals.amountKnownV3++
    if (row.reference.state === 'PENDING_V3') totals.amountPendingV3++
    if (row.reference.state === 'KNOWN_V2') totals.amountKnownV2++
    if (row.reference.state === 'PENDING_V2') totals.amountPendingV2++
    if (row.reference.state === 'KNOWN_V1') totals.amountKnownV1++
    if (row.reference.state === 'PENDING_V1') totals.amountPendingV1++
    if (row.reference.state === 'NOT_RECORDED') totals.amountNotRecorded++
    if (row.reference.state === 'INCONSISTENT') totals.amountInconsistent++
  }
  if (totals.amountInconsistent) warnings.push(`${totals.amountInconsistent} شاهد ناسازگار از ردیف‌ها و شمارنده‌های رویداد واقعی کنار گذاشته شد؛ اصل سند برای بررسی مدیر محفوظ است.`)
  return { rows, legacyRows, totals, warnings: [...new Set(warnings)] }
}

function cleanup(now: number) {
  for (const [token, item] of snapshots) if (item.expiresAtMs <= now) snapshots.delete(token)
}
function getSnapshot(token: unknown, identity: string, hash?: string): Snapshot {
  if (typeof token !== 'string' || token.length < 30 || token.length > 128) throw expired()
  cleanup(Date.now())
  const item = snapshots.get(token)
  if (!item || item.identity !== identity || (hash !== undefined && item.hash !== hash)) throw expired()
  return item
}
function signedCursor(item: Snapshot, stream: CashClosingHistoryStream, offset: number): string {
  const signature = createHmac('sha256', CURSOR_KEY).update(`${item.token}:${stream}:${offset}:${item.take}`).digest('base64url')
  return `${stream}.${offset}.${signature}`
}
function cursorOffset(item: Snapshot, cursor: unknown): { stream: CashClosingHistoryStream; offset: number } {
  if (typeof cursor !== 'string' || cursor.length > 150) throw invalid()
  const match = /^(CUSTODY|LEGACY)\.([1-9]\d*)\.([A-Za-z0-9_-]{43})$/.exec(cursor)
  if (!match) throw invalid()
  const stream = match[1] as CashClosingHistoryStream
  const offset = Number(match[2])
  const limit = stream === 'CUSTODY' ? item.rows.length : item.legacyRows.length
  if (!Number.isSafeInteger(offset) || offset < 1 || offset >= limit || offset % item.take !== 0) throw invalid()
  const expected = signedCursor(item, stream, offset).split('.')[2]
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]))) throw invalid()
  return { stream, offset }
}
function slice(item: Snapshot, stream: CashClosingHistoryStream, offset: number) {
  const rows = stream === 'CUSTODY' ? item.rows : item.legacyRows
  const page = rows.slice(offset, offset + item.take)
  return { rows: page, page: { returned: page.length, nextCursor: offset + item.take < rows.length ? signedCursor(item, stream, offset + item.take) : null } }
}
function response(item: Snapshot, cursor?: unknown): CashClosingHistoryResult {
  const wanted = cursor == null ? null : cursorOffset(item, cursor)
  const primary = !wanted || wanted.stream === 'CUSTODY' ? slice(item, 'CUSTODY', wanted?.offset ?? 0) : { rows: [], page: { returned: 0, nextCursor: null } }
  const legacy = !wanted || wanted.stream === 'LEGACY' ? slice(item, 'LEGACY', wanted?.offset ?? 0) : { rows: [], page: { returned: 0, nextCursor: null } }
  return {
    range: item.range, snapshotToken: item.token, snapshotAt: item.snapshotAt,
    expiresAt: new Date(item.expiresAtMs).toISOString(), totals: item.totals,
    rows: primary.rows, page: primary.page,
    legacy: { rows: legacy.rows, page: legacy.page }, warnings: item.warnings
  }
}

export const cashClosingHistoryService = {
  async query(input: CashClosingHistoryQuery): Promise<CashClosingHistoryResult> {
    const identity = currentManagerSessionIdentity('دیدن گزارش تاریخی بستن صندوق')
    const raw = onlyFields(input, QUERY_FIELDS)
    const options = normalize(raw)
    if (raw.snapshotToken !== undefined) {
      const existing = getSnapshot(raw.snapshotToken, identity, options.hash)
      if (raw.take !== undefined && raw.take !== existing.take) throw invalid()
      return response(existing, raw.cursor)
    }
    if (raw.cursor !== undefined) throw invalid()
    if (materializing) throw new BusinessError('گزارش دیگری در حال آماده‌شدن است؛ دوباره تلاش کنید. صندوق و فروش منتظر گزارش نمی‌مانند.', 'REPORT_BUSY')
    materializing = true
    try {
      const evidence = await readEvidence(options)
      // An idle expiry, logout or re-login during the read must not publish an
      // old privileged snapshot into the next manager session.
      if (currentManagerSessionIdentity('دیدن گزارش تاریخی بستن صندوق') !== identity) throw expired()
      const projected = project(evidence, options)
      if (projected.rows.length + projected.legacyRows.length > CASH_HISTORY_MAX_EVIDENCE) throw tooLarge()
      const range: CashClosingHistoryResult['range'] = {
        fromJalali: options.fromJalali, toJalali: options.toJalali,
        fromIso: options.from.toISOString(), toExclusiveIso: options.toExclusive.toISOString(),
        dayBasis: 'LOCAL_CALENDAR_DAY'
      }
      const bytes = Buffer.byteLength(JSON.stringify({ ...projected, range }), 'utf8')
      if (bytes > MAX_SNAPSHOT_BYTES) throw tooLarge()
      const now = Date.now()
      cleanup(now)
      const item: Snapshot = {
        token: randomBytes(32).toString('base64url'), identity,
        hash: options.hash, take: options.take, range, snapshotAt: new Date(now).toISOString(),
        expiresAtMs: now + SNAPSHOT_TTL_MS, bytes, ...projected
      }
      for (const [token] of snapshots) {
        const occupied = [...snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0)
        if (snapshots.size < MAX_SNAPSHOTS && occupied + bytes <= MAX_CACHE_BYTES) break
        snapshots.delete(token) // oldest; callers get an explicit expiry
      }
      snapshots.set(item.token, item)
      return response(item)
    } finally { materializing = false }
  },

  /** Export takes a token only; the renderer cannot provide titles, rows,
   * totals, cursor, date, path or a financial amount to the file writer. */
  exportData(input: unknown) {
    const identity = currentManagerSessionIdentity('دریافت گزارش تاریخی بستن صندوق')
    const raw = onlyFields(input, EXPORT_FIELDS)
    if (raw.format !== 'csv') throw invalid()
    const item = getSnapshot(raw.snapshotToken, identity)
    const all = [...item.rows, ...item.legacyRows]
    const columns = [
      'منبع سند', 'شناسه سند', 'زمان تکمیل', 'نوع رویداد', 'مسئول قبلی (نام فعلی)', 'شناسه مسئول قبلی',
      'نشست قبلی', 'مسئول بعدی (نام فعلی)', 'شناسه مسئول بعدی', 'نشست بعدی',
      'وضعیت مرجع آبی لحظه رویداد', 'مبلغ مرجع آبی (ریال)', 'بازه مرجع آبی',
      'نسخه محاسبه', 'تعیین تکلیف بعدی مدیر', 'تاریخ تصمیم مدیر',
      'هشدار سند', 'بستن تکراری/اصلاحیه', 'یادداشت‌های اختیاری مدیر روی اسناد آبی'
    ]
    const line = (row: CashClosingHistoryRow) => [
      row.source, row.sourceId, row.occurredAt, row.kind, row.from?.currentName ?? '', row.from?.userId ?? '',
      row.from?.shiftId ?? '', row.to?.currentName ?? '', row.to?.userId ?? '', row.to?.shiftId ?? '',
      row.reference.state, row.reference.amount ?? '',
      row.reference.fromDay ? `${row.reference.fromDay} تا ${row.reference.toDay}` : '',
      row.reference.calculationVersion ?? '', row.laterDecision?.amount ?? '', row.laterDecision?.at ?? '',
      row.evidenceWarning ?? '', row.legacyRepeat ? 'بله؛ خارج از شمارنده بستن نهایی' : '',
      row.managerNotes.map((note) => `سند ${note.snapshotId} · ${note.managerCurrentName ?? `مدیر #${note.managerUserId}`} · ${note.at}: ${note.text}`).join(' | ')
    ]
    return {
      fileName: 'cash-closing-history', format: 'csv' as const, ask: true,
      title: `گزارش بستن و تحویل صندوق | ${item.range.fromJalali} تا ${item.range.toJalali} | روز تقویمی محلی | نسخه ${item.snapshotAt} | تحویل واقعی ${item.totals.handovers} | بستن نهایی ${item.totals.finalClosings} | بستن قدیمی ${item.totals.legacyCloses}`,
      headers: columns, rows: orderRows(all).map(line)
    }
  }
}
