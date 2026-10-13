import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { salesService } from './SalesService'
import { toJalaliDate } from '@shared/jalali'
import {
  custodyPhysicalMovement,
  reconcileCustodyBoundary,
  type CustodyBoundaryReconciliation
} from '@shared/custodyReconciliation'

/**
 * Main-process adapter for the aggregate custody contract.
 *
 * The source report is read in Main and only its explicitly classified CASH and
 * CARD/POS legs are used.  In particular, this never promotes `CREDIT`, a
 * manager account, store credit, or a destination-unknown value into physical
 * drawer/POS money merely because it is present in a sales-report total.
 */
export async function physicalMovementForCustodyShift(shiftId: number): Promise<number> {
  if (!Number.isSafeInteger(shiftId) || shiftId <= 0) throw new BusinessError('شناسه شیفت برای محاسبهٔ حضانت نامعتبر است.')
  const report = await salesService.reportRows({ shiftId })
  const totals = report.totals
  return custodyPhysicalMovement({
    cashReceived: totals.cashTotal,
    posReceived: totals.cardTotal,
    cashRefunded: totals.refundCashTotal,
    posRefunded: totals.refundCardTotal
  })
}

export const AGGREGATE_CALCULATION_VERSION = 'aggregate-v2'

/** CHAINED = reconciled against the accepted baseline of the same source
 * segment. ADOPTION = first aggregate observation of a segment that had no
 * baseline: evidence-neutral (expected = observed, no delta, no case). */
export type AggregateBaselineSource = 'CHAINED' | 'ADOPTION'

export type AggregateBoundaryInput = {
  /** OPENING | HANDOVER | EMERGENCY_COVER | MASTER_OVERRIDE | FINAL_CLOSE | MORNING_OPENING */
  boundaryKind: string
  fromShiftId?: number | null
  toShiftId?: number | null
  handoverId?: number | null
  observedOperationalTotal: number
  countedByUserId: number
  authMethod: string
  idempotencyKey: string
  operationalDay?: string
  /** Net physical movement of the *whole* source segment (fromShiftId) at
   * this observation. A baseline adopted mid-segment carries its own
   * `sourceMovementOffset`, which is subtracted here. */
  physicalMovement: number
  /**
   * GLOBAL_LATEST — legacy v1 chaining (latest boundary anywhere). Used only by
   * OPENING, whose physical movement is always zero.
   * SOURCE_SEGMENT — the accepted baseline of `fromShiftId` (a boundary whose
   * toShiftId is that segment). A stale boundary of another, earlier chain is
   * never used to reconcile a segment that was opened cash-only.
   */
  priorScope?: 'GLOBAL_LATEST' | 'SOURCE_SEGMENT'
  /** SOURCE_SEGMENT without a baseline: true = record this real count as an
   * evidence-neutral ADOPTION; false = fail closed. */
  bootstrapWithoutBaseline?: boolean
}

export type AggregateBoundaryRecord = CustodyBoundaryReconciliation & {
  id: number
  previousBoundaryId: number | null
  discrepancyCaseId: number | null
  baselineSource: AggregateBaselineSource | null
  replayed: boolean
}

function asWhole(value: unknown, label: string, allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!allowNegative && value < 0))
    throw new BusinessError(`${label} باید عدد صحیح ریالی${allowNegative ? '' : 'ِ صفر یا مثبت'} باشد.`)
  return value
}

/**
 * The only accepted aggregate baseline of a live segment: the latest boundary
 * that *started* (or was adopted for) this Shift. Boundaries are written only
 * by successful transactions, so a canceled handover can never appear here.
 */
export async function segmentAggregateBaseline(db: any, shiftId: number) {
  if (!Number.isSafeInteger(shiftId) || shiftId <= 0) return null
  return (db as any).custodyAggregateBoundary.findFirst({
    where: { toShiftId: shiftId },
    orderBy: [{ at: 'desc' }, { id: 'desc' }]
  })
}

/** Pure preview used before a write transaction; the write re-derives and the
 * caller compares, so a concurrent change fails closed (CUSTODY_STALE). */
export function previewSegmentBoundary(baseline: any | null, segmentMovement: number, observedTotal: number) {
  const observed = asWhole(observedTotal, 'شمارش مجموع کشو و کارت‌خوان')
  const movement = asWhole(segmentMovement, 'حرکت فیزیکی', true)
  if (!baseline) {
    return { bootstrap: true as const, effectiveMovement: 0, operationalExpectedTotal: observed, newDifference: 0 }
  }
  const effectiveMovement = movement - Number(baseline.sourceMovementOffset ?? 0)
  const operationalExpectedTotal = Number(baseline.observedOperationalTotal) + effectiveMovement
  return { bootstrap: false as const, effectiveMovement, operationalExpectedTotal, newDifference: observed - operationalExpectedTotal }
}

function replayRecord(replay: any, existingCase: any): AggregateBoundaryRecord {
  return {
    id: replay.id,
    previousBoundaryId: replay.previousBoundaryId ?? null,
    physicalMovement: Number(replay.physicalMovement),
    operationalExpectedTotal: Number(replay.operationalExpectedTotal),
    theoreticalExpectedTotal: Number(replay.theoreticalExpectedTotal),
    observedTotal: Number(replay.observedOperationalTotal),
    newDifference: Number(replay.newDifference),
    totalTheoreticalDifference: Number(replay.totalTheoreticalDifference),
    discrepancyCaseId: existingCase?.id ?? null,
    baselineSource: (replay.baselineSource ?? null) as AggregateBaselineSource | null,
    replayed: true
  }
}

/**
 * Persist a custody observation and, only when its delta is new, an immutable
 * discrepancy case.  A segment without an aggregate baseline adopts this real
 * count neutrally instead of manufacturing an accusation from cash-only or
 * pre-rollout history.
 *
 * Caller responsibility: have already fenced financial writers and calculated
 * `physicalMovement` from the source segment that is ending.
 */
export async function recordAggregateBoundary(tx: any, input: AggregateBoundaryInput): Promise<AggregateBoundaryRecord> {
  const observedOperationalTotal = asWhole(input.observedOperationalTotal, 'شمارش مجموع کشو و کارت‌خوان')
  const physicalMovement = asWhole(input.physicalMovement, 'حرکت فیزیکی', true)
  const countedByUserId = asWhole(input.countedByUserId, 'شناسه شمارش‌کننده')
  const idempotencyKey = String(input.idempotencyKey ?? '').trim()
  if (!idempotencyKey || idempotencyKey.length > 190) throw new BusinessError('کلید یکتای شمارش حضانت نامعتبر است.')
  const scope = input.priorScope ?? 'GLOBAL_LATEST'

  const stores: any = tx as any
  const replay = await stores.custodyAggregateBoundary.findUnique({ where: { idempotencyKey } })
  if (replay) return replayRecord(replay, await stores.custodyDiscrepancyCase.findUnique({ where: { boundaryId: replay.id } }))

  let prior: any = null
  let movement = 0
  if (scope === 'SOURCE_SEGMENT') {
    const fromShiftId = asWhole(input.fromShiftId, 'شناسه بخش مبدأ حضانت')
    prior = await segmentAggregateBaseline(stores, fromShiftId)
    if (!prior && input.bootstrapWithoutBaseline !== true)
      throw new BusinessError('برای این بخش صندوق هنوز شمارش پایهٔ مجموع کشو و کارت‌خوان ثبت نشده است.', 'CUSTODY_AGGREGATE_BASELINE_REQUIRED')
    movement = prior ? physicalMovement - Number(prior.sourceMovementOffset ?? 0) : 0
  } else {
    prior = await stores.custodyAggregateBoundary.findFirst({ orderBy: [{ at: 'desc' }, { id: 'desc' }] })
    /** The initial rollout is deliberately evidence-neutral. A historical
     * cash-only row is not silently reinterpreted as an aggregate POS count. */
    movement = prior ? physicalMovement : 0
  }
  const baselineSource: AggregateBaselineSource = prior ? 'CHAINED' : 'ADOPTION'
  const priorAcceptedObservedTotal = prior ? Number(prior.observedOperationalTotal) : observedOperationalTotal
  const priorTheoreticalTotal = prior ? Number(prior.theoreticalExpectedTotal) : observedOperationalTotal
  const reconciliation = reconcileCustodyBoundary({
    priorAcceptedObservedTotal,
    priorTheoreticalTotal,
    movement: movement >= 0
      ? { cashReceived: movement }
      : { cashRefunded: -movement },
    observedTotal: observedOperationalTotal
  })
  const operationalDay = String(input.operationalDay ?? toJalaliDate(new Date()))
  const boundary = await stores.custodyAggregateBoundary.create({
    data: {
      boundaryKind: String(input.boundaryKind),
      fromShiftId: input.fromShiftId ?? null,
      toShiftId: input.toShiftId ?? null,
      handoverId: input.handoverId ?? null,
      previousBoundaryId: prior?.id ?? null,
      priorAcceptedObservedTotal: BigInt(priorAcceptedObservedTotal),
      priorTheoreticalTotal: BigInt(priorTheoreticalTotal),
      /** Stored movement is exactly what was reconciled (zero for adoption). */
      physicalMovement: BigInt(scope === 'SOURCE_SEGMENT' ? movement : physicalMovement),
      operationalExpectedTotal: BigInt(reconciliation.operationalExpectedTotal),
      theoreticalExpectedTotal: BigInt(reconciliation.theoreticalExpectedTotal),
      observedOperationalTotal: BigInt(observedOperationalTotal),
      newDifference: BigInt(reconciliation.newDifference),
      totalTheoreticalDifference: BigInt(reconciliation.totalTheoreticalDifference),
      countedByUserId,
      authMethod: String(input.authMethod),
      calculationVersion: AGGREGATE_CALCULATION_VERSION,
      idempotencyKey,
      operationalDay,
      baselineSource,
      sourceMovementOffset: BigInt(0)
    }
  })
  const discrepancy = reconciliation.newDifference === 0
    ? null
    : await stores.custodyDiscrepancyCase.create({
        data: {
          boundaryId: boundary.id,
          status: 'OPEN',
          boundaryKind: String(input.boundaryKind),
          fromShiftId: input.fromShiftId ?? null,
          toShiftId: input.toShiftId ?? null,
          operationalExpectedTotal: BigInt(reconciliation.operationalExpectedTotal),
          theoreticalExpectedTotal: BigInt(reconciliation.theoreticalExpectedTotal),
          observedOperationalTotal: BigInt(observedOperationalTotal),
          differenceAmount: BigInt(reconciliation.newDifference),
          totalTheoreticalDifference: BigInt(reconciliation.totalTheoreticalDifference),
          operationalDay
        }
      })
  return {
    id: boundary.id,
    previousBoundaryId: prior?.id ?? null,
    ...reconciliation,
    physicalMovement: scope === 'SOURCE_SEGMENT' ? movement : reconciliation.physicalMovement,
    discrepancyCaseId: discrepancy?.id ?? null,
    baselineSource,
    replayed: false
  }
}

/**
 * Mid-segment bootstrap for a normal handover: the outgoing custodian's real
 * blind count becomes the segment's first baseline *at the moment it was
 * taken* (with the segment movement already reflected in it).
 *
 * MUST only be called inside the receiver's successful acceptance
 * transaction. A started-then-canceled handover therefore never leaves an
 * active baseline behind; its count stays as immutable CustodyCount evidence.
 */
export async function recordAdoptionBaseline(tx: any, input: {
  shiftId: number
  observedOperationalTotal: number
  sourceMovementOffset: number
  countedByUserId: number
  authMethod: string
  idempotencyKey: string
  operationalDay?: string
}) {
  const shiftId = asWhole(input.shiftId, 'شناسه بخش حضانت')
  const observed = asWhole(input.observedOperationalTotal, 'شمارش مجموع کشو و کارت‌خوان')
  const offset = asWhole(input.sourceMovementOffset, 'حرکت فیزیکی پیش از شمارش پایه', true)
  const countedByUserId = asWhole(input.countedByUserId, 'شناسه شمارش‌کننده')
  const idempotencyKey = String(input.idempotencyKey ?? '').trim()
  if (!idempotencyKey || idempotencyKey.length > 190) throw new BusinessError('کلید یکتای شمارش حضانت نامعتبر است.')
  const stores: any = tx as any
  const replay = await stores.custodyAggregateBoundary.findUnique({ where: { idempotencyKey } })
  if (replay) return replay
  if (await segmentAggregateBaseline(stores, shiftId))
    throw new BusinessError('برای این بخش صندوق قبلاً شمارش پایه ثبت شده است؛ عملیات هم‌زمان را تازه کنید.', 'CUSTODY_STALE')
  return stores.custodyAggregateBoundary.create({
    data: {
      boundaryKind: 'ADOPTION_BASELINE',
      fromShiftId: null,
      toShiftId: shiftId,
      handoverId: null,
      previousBoundaryId: null,
      priorAcceptedObservedTotal: BigInt(observed),
      priorTheoreticalTotal: BigInt(observed),
      physicalMovement: BigInt(0),
      operationalExpectedTotal: BigInt(observed),
      theoreticalExpectedTotal: BigInt(observed),
      observedOperationalTotal: BigInt(observed),
      newDifference: BigInt(0),
      totalTheoreticalDifference: BigInt(0),
      countedByUserId,
      authMethod: String(input.authMethod),
      calculationVersion: AGGREGATE_CALCULATION_VERSION,
      idempotencyKey,
      operationalDay: String(input.operationalDay ?? toJalaliDate(new Date())),
      baselineSource: 'ADOPTION',
      sourceMovementOffset: BigInt(offset)
    }
  })
}

/** A manager's reconciliation report may display only this Main-side result. */
export async function aggregateReferenceForShift(shiftId: number) {
  const physicalMovement = await physicalMovementForCustodyShift(shiftId)
  return { physicalMovement, calculationVersion: 'aggregate-v1' }
}

export const custodyAggregateService = {
  physicalMovementForCustodyShift,
  recordAggregateBoundary,
  recordAdoptionBaseline,
  segmentAggregateBaseline,
  previewSegmentBoundary,
  aggregateReferenceForShift
}
