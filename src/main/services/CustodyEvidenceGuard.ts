import { BusinessError } from '../errors'
import { blueEvidenceFault, bluePairFault } from './CustodyBlueIntegrity'
import { CUSTODY_REFERENCE_LEGACY_VERSION } from '@shared/custodyReference'
import { isValidJalaliDate, toJalaliDate } from '@shared/jalali'

type Fault = { shiftId: number; handoverId: number | null; snapshotId: number | null; reasonCode: string }
const pending = ['PENDING', 'RECEIVER_COUNTED', 'EMERGENCY_RECOUNT', 'MASTER_OVERRIDE_RECOUNT']
const problem = (shiftId: number, reasonCode: string, handoverId: number | null = null,
  snapshotId: number | null = null): Fault => ({ shiftId, handoverId, snapshotId, reasonCode })

/** Only the current Shift's anchor may govern financial work. A corrupt
 * historical V1 row is reported on its own terms, not reinterpreted as new V3
 * evidence. Fresh recovery starts an independent chain without erasing it. */
export async function currentEvidenceFault(tx: any, state: any): Promise<Fault | null> {
  if (!state.activeShiftId || !['ACTIVE', 'HANDOVER_PENDING', 'HANDOVER_RECOUNT'].includes(state.state)) return null
  const shiftId = state.activeShiftId
  const [shift, meta] = await Promise.all([
    tx.shift.findUnique({ where: { id: shiftId } }),
    tx.custodyShiftMeta.findUnique({ where: { shiftId } })
  ])
  if (!shift || shift.closedAt || !meta || !shift.userId || shift.userId !== meta.custodianUserId)
    return problem(shiftId, 'SHIFT_OWNER_LINK_INVALID')
  if (!isValidJalaliDate(meta.operationalDay)) return problem(shiftId, 'SHIFT_DAY_INVALID')
  if (state.state === 'ACTIVE' && state.pendingHandoverId != null)
    return problem(shiftId, 'ACTIVE_WITH_PENDING_POINTER', state.pendingHandoverId)
  if (state.state !== 'ACTIVE') {
    if (!state.pendingHandoverId) return problem(shiftId, 'PENDING_POINTER_MISSING')
    const handover = await tx.custodyHandover.findUnique({ where: { id: state.pendingHandoverId } })
    if (!handover || handover.fromShiftId !== shiftId || handover.fromUserId !== shift.userId ||
        handover.stateKey !== 'MAIN' || !pending.includes(handover.status))
      return problem(shiftId, 'PENDING_HANDOVER_LINK_INVALID', state.pendingHandoverId)
    const started = new Date(handover.startedAt)
    if (!Number.isFinite(started.getTime())) return problem(shiftId, 'HANDOVER_STARTED_AT_INVALID', handover.id)
    if (handover.protocolVersion == null && (handover.deadlineAt != null || handover.deadlinePolicyMinutes != null))
      return problem(shiftId, 'HANDOVER_DEADLINE_INVALID', handover.id)
    if (handover.protocolVersion != null) {
      const deadline = handover.deadlineAt == null ? new Date(NaN) : new Date(handover.deadlineAt)
      if (handover.protocolVersion !== 3 || !Number.isInteger(handover.deadlinePolicyMinutes) ||
          handover.deadlinePolicyMinutes < 1 || handover.deadlinePolicyMinutes > 30 ||
          !Number.isFinite(deadline.getTime()) || deadline.getTime() !== started.getTime() + handover.deadlinePolicyMinutes * 60_000)
        return problem(shiftId, 'HANDOVER_DEADLINE_INVALID', handover.id)
    }
    let watermark: any
    try { watermark = JSON.parse(String(handover.ledgerWatermark)) }
    catch { return problem(shiftId, 'HANDOVER_WATERMARK_INVALID', handover.id) }
    if (!watermark || typeof watermark !== 'object') return problem(shiftId, 'HANDOVER_WATERMARK_INVALID', handover.id)
    if (watermark.blueV1 === true) {
      const [out, incoming] = await Promise.all([
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId: handover.id, role: 'OUT' } }),
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId: handover.id, role: 'IN' } })
      ])
      if (!out) return problem(shiftId, 'BLUE_OUT_MISSING', handover.id)
      const fault = blueEvidenceFault(out)
      if (fault || out.shiftId !== shiftId || out.handoverId !== handover.id ||
          out.actorUserId !== handover.fromUserId || out.role !== 'OUT' ||
          out.authMethod !== 'CUSTODY_PIN')
        return problem(shiftId, fault ?? 'BLUE_OUT_LINK_INVALID', handover.id, out.id)
      const outCount = await tx.custodyCount.findUnique({ where: { id: handover.outCountId } })
      if (!outCount || outCount.shiftId !== shiftId || outCount.kind !== 'HANDOVER_OUT' ||
          outCount.countedByUserId !== handover.fromUserId || outCount.authMethod !== 'CUSTODY_PIN' ||
          Number(outCount.countedCash) !== Number(out.humanAmount))
        return problem(shiftId, 'BLUE_OUT_COUNT_INVALID', handover.id, out.id)
      if (handover.status === 'RECEIVER_COUNTED') {
        if (!incoming || watermark.receiverSnapshotId !== incoming.id || !watermark.receiverCountId)
          return problem(shiftId, 'BLUE_IN_LINK_MISSING', handover.id, incoming?.id ?? null)
        // The next Shift is not created until confirmation; ordinary IN lives
        // on the original Shift, even though the receiver signed it.
        if (incoming.shiftId !== shiftId && incoming.calculationVersion !== CUSTODY_REFERENCE_LEGACY_VERSION)
          return problem(shiftId, 'BLUE_IN_SHIFT_INVALID', handover.id, incoming.id)
        const pairFault = bluePairFault(out, incoming, handover)
        if (pairFault) return problem(shiftId, pairFault, handover.id, incoming.id)
        const inCount = await tx.custodyCount.findUnique({ where: { id: watermark.receiverCountId } })
        if (!inCount || inCount.shiftId !== shiftId || inCount.handoverId !== handover.id ||
            inCount.kind !== 'BLUE_HANDOVER_IN' || inCount.authMethod !== 'CUSTODY_PIN' ||
            inCount.countedByUserId !== handover.selectedRecipientUserId ||
            Number(inCount.countedCash) !== Number(incoming.humanAmount))
          return problem(shiftId, 'BLUE_IN_COUNT_INVALID', handover.id, incoming.id)
      } else if (incoming) return problem(shiftId, 'BLUE_UNEXPECTED_IN', handover.id, incoming.id)
    }
  }
  const recovery = await tx.custodyBlueSnapshot.findFirst({ where: { shiftId, role: 'RECOVERY' }, orderBy: { id: 'desc' } })
  if (recovery) {
    const fault = blueEvidenceFault(recovery)
    const managerRecovery = await tx.custodyEvidenceRecovery.findFirst({ where: {
      shiftId, recoverySnapshotId: recovery.id, outcome: 'ACTIVE_FRESH_WITNESS'
    } })
    if (managerRecovery) {
      const count = await tx.custodyCount.findFirst({ where: {
        shiftId, kind: 'EVIDENCE_RECOVERY_COUNT',
        idempotencyKey: `evidence-recovery:${managerRecovery.quarantineId}:${managerRecovery.idempotencyKey}`
      } })
      if (!count || count.countedByUserId !== managerRecovery.managerUserId ||
          count.authMethod !== 'MANAGER_CUSTODY_PIN' ||
          Number(count.countedCash) !== Number(managerRecovery.countedAmount) ||
          Number(count.countedCash) !== Number(recovery.humanAmount) ||
          recovery.actorUserId !== managerRecovery.managerUserId ||
          recovery.authMethod !== 'MANAGER_CUSTODY_PIN')
        return problem(shiftId, 'BLUE_RECOVERY_COUNT_LINK_INVALID', null, recovery.id)
    }
    return fault || recovery.handoverId != null || recovery.priorSnapshotId != null ||
        (!managerRecovery && recovery.actorUserId !== shift.userId)
      ? problem(shiftId, fault ?? 'BLUE_RECOVERY_LINK_INVALID', null, recovery.id) : null
  }
  const handover = await tx.custodyHandover.findFirst({ where: { toShiftId: shiftId, status: 'COMPLETED' }, orderBy: { id: 'desc' } })
  if (handover) {
    let watermark: any = {}
    try { watermark = JSON.parse(String(handover.ledgerWatermark)) } catch { return problem(shiftId, 'INCOMING_WATERMARK_INVALID', handover.id) }
    if (watermark?.blueV1 === true) {
      const [out, incoming] = await Promise.all([
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId: handover.id, role: 'OUT' } }),
        tx.custodyBlueSnapshot.findFirst({ where: { handoverId: handover.id, role: 'IN' } })
      ])
      const fault = bluePairFault(out, incoming, handover)
      if (fault || incoming.actorUserId !== shift.userId)
        return problem(shiftId, fault ?? 'INCOMING_CUSTODIAN_LINK_INVALID', handover.id, incoming?.id ?? null)
    }
  } else {
    const opening = await tx.custodyBlueSnapshot.findFirst({ where: { shiftId, role: 'OPENING' }, orderBy: { id: 'desc' } })
    if (opening) {
      const fault = blueEvidenceFault(opening)
      if (fault || opening.actorUserId !== shift.userId || opening.handoverId != null || opening.priorSnapshotId != null)
        return problem(shiftId, fault ?? 'OPENING_LINK_INVALID', null, opening.id)
    } else {
      const event = await tx.custodyEvent.findFirst({ where: { shiftId, type: 'OPEN' }, orderBy: { id: 'desc' } })
      let claimedBlue = false
      try { claimedBlue = JSON.parse(String(event?.payloadJson ?? '{}')).aggregateBoundary === true } catch {}
      if (claimedBlue) return problem(shiftId, 'BLUE_OPENING_MISSING')
    }
  }
  return null
}

/** Append one immutable case, fence the same actual Shift, and never overwrite
 * the malformed original. A stale detection cannot create a case on a newer
 * owner/epoch. A duplicate status read leaves both case and epoch unchanged. */
export async function registerEvidenceQuarantine(tx: any, observed: any, fault: Fault) {
  const state = await tx.custodyState.findUnique({ where: { key: 'MAIN' } })
  if (!state || state.state !== observed.state || state.activeShiftId !== observed.activeShiftId ||
      state.pendingHandoverId !== observed.pendingHandoverId || state.epoch !== observed.epoch ||
      state.financialRevision !== observed.financialRevision || state.activeShiftId !== fault.shiftId)
    throw new BusinessError('وضعیت صندوق هنگام بررسی سند تغییر کرد؛ دوباره وضعیت را بگیرید.', 'CUSTODY_STALE')
  // A second corruption AFTER a documented recovery is a new occurrence, not
  // a replay of the already-settled case. The epoch fences this append-only
  // identity and a same-epoch retry still cannot duplicate it.
  const sourceKey = `${fault.shiftId}:${fault.handoverId ?? 0}:${fault.snapshotId ?? 0}:${fault.reasonCode}:${state.epoch}`
  let caseRow = await tx.custodyEvidenceQuarantine.findUnique({ where: { sourceKey } })
  if (!caseRow) caseRow = await tx.custodyEvidenceQuarantine.create({ data: {
    sourceKey, shiftId: fault.shiftId, handoverId: fault.handoverId,
    snapshotId: fault.snapshotId, reasonCode: fault.reasonCode, detectedEpoch: state.epoch
  } })
  if (state.state !== 'EVIDENCE_QUARANTINED') {
    const nextEpoch = Number(state.epoch) + 1
    const changed = await tx.custodyState.updateMany({ where: { key: 'MAIN', state: state.state,
      activeShiftId: fault.shiftId, pendingHandoverId: state.pendingHandoverId,
      epoch: state.epoch, financialRevision: state.financialRevision }, data: {
        state: 'EVIDENCE_QUARANTINED', epoch: nextEpoch, updatedAt: new Date()
      } })
    if (changed.count !== 1) throw new BusinessError('سند هم‌زمان تغییر کرد؛ پروندهٔ قرنطینه ثبت نشد.', 'CUSTODY_STALE')
    await tx.custodyEvent.create({ data: {
      type: 'CUSTODY_EVIDENCE_QUARANTINED', shiftId: fault.shiftId,
      handoverId: fault.handoverId, actorKind: 'SYSTEM',
      epochBefore: state.epoch, epochAfter: nextEpoch,
      payloadJson: JSON.stringify({ caseId: caseRow.id, snapshotId: fault.snapshotId,
        cause: fault.reasonCode, originalEvidencePreserved: true }),
      operationalDay: toJalaliDate(new Date())
    } })
  }
  return caseRow
}

/** The case log is immutable; only a distinct recovery row closes it.
 * Fail-closed on an implausibly huge inventory rather than silently ignoring
 * an older unresolved corrupt Shift. */
export async function openEvidenceCases(tx: any, shiftId?: number): Promise<any[]> {
  const cases = await tx.custodyEvidenceQuarantine.findMany({
    where: shiftId ? { shiftId } : {}, orderBy: { id: 'desc' }, take: 10_001
  })
  if (cases.length > 10_000) throw new BusinessError('پرونده‌های سند آبی بیش از سقف بررسی است؛ مدیر باید تاریخچه را بررسی کند.', 'CUSTODY_EVIDENCE_CASE_LIMIT')
  if (!cases.length) return []
  const resolved = await tx.custodyEvidenceRecovery.findMany({ where: { quarantineId: { in: cases.map((row: any) => row.id) } }, select: { quarantineId: true } })
  const settled = new Set(resolved.map((row: any) => row.quarantineId))
  return cases.filter((row: any) => !settled.has(row.id))
}
