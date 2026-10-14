import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { custodyService } from './CustodyService'
import { isValidJalaliDate } from '@shared/jalali'
import { CUSTODY_REFERENCE_VERSION, CUSTODY_REFERENCE_LEGACY_VERSION, type CustodyReference } from '@shared/custodyReference'
import { observationOf, systemAbsenceZero, type CustodyObservation } from '@shared/custodyPeriod'
import { resolvedCustodySnapshot, type CustodyBlueDecision, type CustodyCreditDecision } from '@shared/custodyResolution'

function idOf(raw: unknown, name: string) {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) throw new BusinessError(`${name} نامعتبر است.`)
  return n
}
function rialOf(raw: unknown, name: string): number | null {
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new BusinessError(`${name} از محدودهٔ مبلغ معتبر خارج است.`)
  return n
}
function asReference(row: any): CustodyReference {
  if (row.calculationVersion !== CUSTODY_REFERENCE_VERSION && row.calculationVersion !== CUSTODY_REFERENCE_LEGACY_VERSION)
    throw new BusinessError('نسخهٔ محاسبهٔ مرجع با نسخهٔ جاری سازگار نیست.', 'BLUE_VERSION_MISMATCH')
  return {
    status: row.referenceStatus as CustodyReference['status'],
    referenceAmount: rialOf(row.referenceAmount, 'مرجع'),
    knownSubtotal: rialOf(row.knownSubtotal, 'بخش معلوم'),
    destinationUnknownReceived: row.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? null : rialOf(row.destinationUnknownReceived, 'مقصد نامشخص'),
    ambiguousLegacyCredit: rialOf(row.ambiguousLegacyCredit, 'بخش مبهم'),
    calculationVersion: row.calculationVersion,
    sourceScope: row.sourceScope ?? undefined,
    sourceHash: row.sourceHash ?? undefined,
    warnings: []
  }
}
function asObservation(row: any): CustodyObservation {
  if (row.countOrigin === 'SYSTEM_ABSENCE_ZERO') return systemAbsenceZero()
  if (row.countOrigin === 'EMPTY_OPTIONAL') return observationOf(null, true)
  const amount = rialOf(row.humanAmount, 'شمارش واقعی')
  if (amount == null) throw new BusinessError('سند شمارش واقعی بدون مبلغ معتبر است.', 'BLUE_COUNT_INVALID')
  const count = observationOf(amount, false)
  if (row.countOrigin !== count.origin) throw new BusinessError('منشأ شمارش و مبلغ آن سازگار نیستند.', 'BLUE_COUNT_INVALID')
  return count
}
function scopeOf(row: any) {
  return `${row.referenceFromDay}:${row.referenceToDay}:${row.scopeKind}:${row.calculationVersion}`
}
function textOf(raw: unknown, label: string, min: number, max: number) {
  const text = String(raw ?? '').trim()
  if (text.length < min || text.length > max) throw new BusinessError(`${label} باید ${min} تا ${max} نویسه باشد.`)
  return text
}

export const custodyBlueResolutionService = {
  /** Manager-session IPC gate required. Both the frozen facts and every later
   * decision retain the original handover/day. No renderer-provided amount is
   * ever used for the manager's reference. */
  async pendingList(input: { skip?: unknown } = {}) {
    const skip = Number(input.skip ?? 0)
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > 1_000_000)
      throw new BusinessError('شمارهٔ صفحهٔ سوابق مرجع نامعتبر است.')
    const pageSize = 100
    const snapshots = await prisma.custodyBlueSnapshot.findMany({
      where: { role: { in: ['IN', 'OPENING', 'FINAL_CLOSE', 'RECOVERY'] }, referenceStatus: 'PENDING_RECONCILIATION' },
      orderBy: [{ at: 'desc' }, { id: 'desc' }], skip, take: pageSize + 1
    })
    const rows: any[] = []
    for (const snapshot of snapshots.slice(0, pageSize)) {
      const handover = snapshot.role === 'IN' && snapshot.handoverId != null
        ? await prisma.custodyHandover.findUnique({ where: { id: snapshot.handoverId } }) : null
      if (snapshot.role === 'IN' && (!handover || handover.status !== 'COMPLETED')) continue
      if (snapshot.role !== 'IN' && snapshot.handoverId != null) continue
      const decision = await prisma.custodyBlueResolution.findFirst({
        where: { snapshotId: snapshot.id }, orderBy: [{ at: 'desc' }, { id: 'desc' }]
      })
      rows.push({
        snapshotId: snapshot.id, handoverId: snapshot.handoverId,
        shiftId: snapshot.shiftId, role: snapshot.role,
        fromUserId: handover?.fromUserId ?? snapshot.actorUserId,
        toUserId: handover?.finalCustodianUserId ?? null,
        day: snapshot.operationalDay, referenceFromDay: snapshot.referenceFromDay,
        referenceToDay: snapshot.referenceToDay, calculationVersion: snapshot.calculationVersion,
        countedAmount: rialOf(snapshot.humanAmount, 'شمارش'),
        knownSubtotal: rialOf(snapshot.knownSubtotal, 'بخش معلوم'),
        destinationUnknownReceived: snapshot.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION ? null : rialOf(snapshot.destinationUnknownReceived, 'مقصد نامشخص'),
        ambiguousLegacyCredit: rialOf(snapshot.ambiguousLegacyCredit, 'بخش مبهم'),
        originalReferenceAmount: rialOf(snapshot.referenceAmount, 'مرجع اولیه'),
        status: decision ? 'RESOLVED' : 'PENDING_RECONCILIATION',
        referenceAmount: decision ? rialOf(decision.effectiveReferenceAmount, 'مرجع حل‌شده') : null,
        rawDifference: decision ? rialOf(decision.resolvedRawDifference, 'اختلاف حل‌شده') : null,
        freshDifference: decision ? rialOf(decision.resolvedFreshDifference, 'اختلاف تازه') : null,
        decision: decision ? { id: decision.id, kind: decision.decisionKind,
          destinationKind: decision.destinationDecisionKind ?? null,
          destinationEvidenceDay: decision.destinationEvidenceDay ?? null,
          destinationEvidenceReference: decision.destinationEvidenceReference ?? null,
          managerUserId: decision.managerUserId, evidenceDay: decision.evidenceDay,
          evidenceReference: decision.evidenceReference, reason: decision.reason,
          at: decision.at } : null
      })
    }
    return { rows, hasMore: snapshots.length > pageSize }
  },

  /** Main checks the named manager's own custody PIN, in addition to the
   * manager-session IPC gate. Proof is explicitly for the frozen day scope;
   * there is no retroactive edit to the payment or the handover snapshot. */
  async resolve(input: {
    snapshotId: unknown
    managerUserId: unknown
    password: unknown
    decisionKind?: unknown
    evidenceDay?: unknown
    evidenceReference?: unknown
    /** Separate proof for destination-less received cash/cheque. Required if
     * the frozen V2 snapshot has a positive unknown-destination amount. */
    destinationDecisionKind?: unknown
    destinationEvidenceDay?: unknown
    destinationEvidenceReference?: unknown
    reason: unknown
    idempotencyKey: unknown
  }) {
    const snapshotId = idOf(input.snapshotId, 'شناسه سند مرجع تحویل')
    const manager = await custodyService.verifyPin(input.managerUserId, input.password, { requireManager: true })
    const destinationDecisionKind = String(input.destinationDecisionKind ?? '').trim() as CustodyBlueDecision | ''
    const decisionKind = (String(input.decisionKind ?? '').trim() || (destinationDecisionKind ? 'NO_LEGACY_CREDIT' : '')) as CustodyCreditDecision | ''
    const proofKinds = ['RECEIVED_CASH', 'RECEIVED_CARD', 'NOT_RECEIVED']
    if (!proofKinds.includes(decisionKind) && decisionKind !== 'NO_LEGACY_CREDIT')
      throw new BusinessError('نوع تعیین تکلیف پرداخت مبهم نامعتبر است.')
    if (destinationDecisionKind && !proofKinds.includes(destinationDecisionKind))
      throw new BusinessError('نوع تعیین تکلیف مقصد نامشخص نامعتبر است.', 'BLUE_DESTINATION_DECISION_INVALID')
    const evidenceDay = String(input.evidenceDay ?? input.destinationEvidenceDay ?? '').trim()
    if (!isValidJalaliDate(evidenceDay)) throw new BusinessError('تاریخ سند اثبات به شکل شمسی معتبر نیست.')
    const evidenceReference = textOf(input.evidenceReference ?? input.destinationEvidenceReference, 'مرجع سند اثبات', 8, 300)
    const reason = textOf(input.reason, 'توضیح تصمیم مدیر', 10, 1000)
    const idempotencyKey = String(input.idempotencyKey ?? '').trim()
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) throw new BusinessError('کلید یکتای تصمیم نامعتبر است.')

    return prisma.$transaction(async (tx: any) => {
      // Acquire a SQLite writer lock before checking for existing decisions.
      // Distinct concurrent keys must not create conflicting resolutions.
      const lock = await tx.custodyState.updateMany({ where: { key: 'MAIN' }, data: { updatedAt: new Date() } })
      if (lock.count !== 1) throw new BusinessError('وضعیت صندوق برای تصمیم مدیر در دسترس نیست.', 'CUSTODY_NOT_INITIALIZED')
      const snapshot = await tx.custodyBlueSnapshot.findUnique({ where: { id: snapshotId } })
      const isTransfer = snapshot?.role === 'IN' && snapshot.handoverId != null
      const isIndependentBoundary = snapshot?.handoverId == null &&
        ['OPENING', 'FINAL_CLOSE', 'RECOVERY'].includes(snapshot?.role)
      if (!snapshot || (!isTransfer && !isIndependentBoundary))
        throw new BusinessError('فقط سند شمارش واقعیِ تحویل، افتتاح یا بستن نهایی قابل تعیین تکلیف است.', 'BLUE_SNAPSHOT_NOT_FOUND')
      if (isTransfer) {
        const handover = await tx.custodyHandover.findUnique({ where: { id: snapshot.handoverId } })
        if (!handover || handover.status !== 'COMPLETED')
          throw new BusinessError('تحویل هنوز به‌عنوان سند نهایی پذیرفته نشده است.', 'BLUE_HANDOVER_NOT_COMPLETED')
      }
      if (evidenceDay < snapshot.referenceFromDay || evidenceDay > snapshot.referenceToDay)
        throw new BusinessError('تاریخ سند اثبات باید داخل همان بازهٔ مرجع سند اولیه باشد.', 'BLUE_EVIDENCE_OUT_OF_SCOPE')
      // Preserve idempotent replays of decisions made before the upgrade, but
      // never attach a NEW partial decision to an old or mixed-ambiguity row.
      const already = await tx.custodyBlueResolution.findFirst({ where: { snapshotId }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
      if (already) {
        if (already.idempotencyKey === idempotencyKey && already.managerUserId === manager.userId &&
            already.decisionKind === decisionKind && already.evidenceDay === evidenceDay &&
            already.evidenceReference === evidenceReference && already.reason === reason &&
            (already.destinationDecisionKind ?? '') === destinationDecisionKind &&
            (already.destinationEvidenceDay ?? '') === String(input.destinationEvidenceDay ?? '').trim() &&
            (already.destinationEvidenceReference ?? '') === String(input.destinationEvidenceReference ?? '').trim())
          return { id: already.id, snapshotId, status: 'RESOLVED' as const, referenceAmount: rialOf(already.effectiveReferenceAmount, 'مرجع حل‌شده'), rawDifference: rialOf(already.resolvedRawDifference, 'اختلاف خام'), freshDifference: rialOf(already.resolvedFreshDifference, 'اختلاف تازه'), replayed: true }
        throw new BusinessError('این سند قبلاً تعیین تکلیف شده است؛ سند اصلی و تصمیم ثبت‌شده قابل بازنویسی نیستند.', 'BLUE_ALREADY_RESOLVED')
      }
      // V1 did not persist the separate UNKNOWN-destination component; its
      // known subtotal might include it. Never silently reinterpret or rewrite
      // historical V1 evidence with the corrected V2 decision formula.
      if (snapshot.calculationVersion === CUSTODY_REFERENCE_LEGACY_VERSION)
        throw new BusinessError('سند آبیِ نسخهٔ قدیمی مقصدهای نامشخص را جدا ثبت نکرده است؛ برای تعیین تکلیف این سند بررسی ویژه لازم است.', 'BLUE_LEGACY_REFERENCE_REVIEW')
      const reference = asReference(snapshot)
      const credit = reference.ambiguousLegacyCredit
      const destination = reference.destinationUnknownReceived
      if (reference.status !== 'PENDING_RECONCILIATION' || reference.knownSubtotal == null ||
          credit == null || destination == null || credit < 0 || destination < 0 || (credit === 0 && destination === 0))
        throw new BusinessError('این سند اولیه با بخش معلوم و مبلغ مبهمِ قابل اثبات هنوز کامل نیست؛ مرجع نامعلوم می‌ماند.', 'BLUE_NOT_AMBIGUOUS')
      if (destination > 0 && !destinationDecisionKind)
        throw new BusinessError('این سند وجه با مقصد نامشخص دارد؛ تصمیم فقط دربارهٔ اعتبار نمی‌تواند مرجع را قطعی کند.', 'BLUE_OTHER_UNRESOLVED')
      if (credit > 0 && !proofKinds.includes(decisionKind))
        throw new BusinessError('پرداخت اعتباری قدیمی نیز سند مستقل می‌خواهد؛ تصمیم فقط دربارهٔ مقصد کافی نیست.', 'BLUE_CREDIT_UNRESOLVED')
      if ((credit === 0 && decisionKind !== 'NO_LEGACY_CREDIT') || (destination === 0 && destinationDecisionKind))
        throw new BusinessError('برای جزء ناموجود سند نمی‌توان تصمیم تازه ساخت.', 'BLUE_COMPONENT_NOT_AMBIGUOUS')
      const destinationEvidenceDay = destination > 0 ? String(input.destinationEvidenceDay ?? '').trim() : null
      const destinationEvidenceReference = destination > 0
        ? textOf(input.destinationEvidenceReference, 'مرجع سند مقصد نامشخص', 8, 300) : null
      if (destination > 0 && (!isValidJalaliDate(destinationEvidenceDay!) || destinationEvidenceDay! < snapshot.referenceFromDay || destinationEvidenceDay! > snapshot.referenceToDay))
        throw new BusinessError('روز سند اثبات مقصد نامشخص باید در همان بازهٔ مرجع باشد.', 'BLUE_EVIDENCE_OUT_OF_SCOPE')
      const prior = snapshot.priorSnapshotId == null
        ? null : await tx.custodyBlueSnapshot.findUnique({ where: { id: snapshot.priorSnapshotId } })
      const result = resolvedCustodySnapshot({
        reference,
        count: asObservation(snapshot),
        scopeKey: scopeOf(snapshot),
        start: prior ? { reference: asReference(prior), count: asObservation(prior), scopeKey: scopeOf(prior) } : null,
        decision: decisionKind as CustodyCreditDecision,
        destinationDecision: destinationDecisionKind || undefined
      })
      const entry = await tx.custodyBlueResolution.create({ data: {
        snapshotId, managerUserId: manager.userId, authMethod: 'MANAGER_CUSTODY_PIN',
        decisionKind, evidenceDay, evidenceReference, reason,
        ambiguousAmount: BigInt(credit),
        destinationDecisionKind: destinationDecisionKind || null,
        destinationAmbiguousAmount: BigInt(destination),
        destinationEvidenceDay,
        destinationEvidenceReference,
        effectiveReferenceAmount: BigInt(result.effectiveReferenceAmount),
        resolvedRawDifference: result.comparison.rawDifference == null ? null : BigInt(result.comparison.rawDifference),
        resolvedFreshDifference: result.comparison.freshDifference == null ? null : BigInt(result.comparison.freshDifference),
        freshStatus: result.comparison.freshStatus,
        idempotencyKey
      } })
      return { id: entry.id, snapshotId, status: 'RESOLVED' as const, referenceAmount: result.effectiveReferenceAmount, rawDifference: result.comparison.rawDifference, freshDifference: result.comparison.freshDifference, replayed: false }
    })
  }
}
