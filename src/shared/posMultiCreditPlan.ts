import { normalizeCreditCode } from './credit'
import { intOf, type CreditPreviewLike, type PosCreditPlan } from './creditUi'

export interface PosMultiCreditRowLike {
  id: string
  code: string
  expiresAt?: Date | string | null
  restrictScope?: string | null
  preview: CreditPreviewLike | null
}

export interface PosMultiCreditPlan extends PosCreditPlan {
  appliedById: Record<string, number>
  requestedById: Record<string, number | null>
}

/**
 * Compose independent server previews for a POS basket. Dated barcodes are
 * consumed FEFO; ordinary ALL credits remain invoice-pooled, while restricted
 * credits cumulatively draw down only matching item capacities.
 */
export function posMultiCreditPlan(input: {
  payable: number
  rows: readonly PosMultiCreditRowLike[]
  lines: readonly { variantId: number; lineTotal: number }[]
  requestedInput: number | null
}): PosMultiCreditPlan {
  const payable = Math.max(0, intOf(input.payable))
  const asked = input.requestedInput == null ? 0 : Math.max(0, intOf(input.requestedInput))
  const ordered = [...input.rows]
    .map((row, index) => ({ row, index, code: normalizeCreditCode(row.code) }))
    .sort((a, b) => {
      const expiry = (row: PosMultiCreditRowLike) => {
        if (row.expiresAt == null) return Number.POSITIVE_INFINITY
        const raw = String(row.expiresAt).trim()
        // Safe DTOs expose Jalali calendar dates; comparing YYYYMMDD preserves
        // the agreed FEFO order without reinterpreting them as Gregorian dates.
        const jalali = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw)
        if (jalali) return Number(jalali[1]) * 10000 + Number(jalali[2]) * 100 + Number(jalali[3])
        const time = new Date(raw).getTime()
        return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY
      }
      return expiry(a.row) - expiry(b.row) || a.code.localeCompare(b.code) || a.index - b.index
    })
  const duplicateCounts = new Map<string, number>()
  for (const item of ordered) if (item.code) duplicateCounts.set(item.code, (duplicateCounts.get(item.code) ?? 0) + 1)
  const residualByLine = input.lines.map((line) => Math.max(0, intOf(line.lineTotal)))
  const appliedById: Record<string, number> = {}
  const requestedById: Record<string, number | null> = {}
  const notes: string[] = []
  const validRows = ordered.filter(({ row, code }) => code && (duplicateCounts.get(code) ?? 0) === 1 && row.preview?.ok)
  for (const { row } of validRows) {
    appliedById[row.id] = 0
    requestedById[row.id] = asked > 0 ? 0 : null
  }
  let remaining = payable
  let requestRemaining = asked > 0 ? asked : Number.POSITIVE_INFINITY
  const cartVariants = new Set(input.lines.map((line) => Number(line.variantId)))
  let hasInvoicePool = false

  for (const { row } of ordered) {
    if (!row.preview) continue
    notes.push(...(row.preview.notes ?? []))
    if (!row.preview.ok && row.preview.error) notes.push(row.preview.error)
  }
  for (const { row, code } of ordered) {
    if (!code || (duplicateCounts.get(code) ?? 0) > 1) {
      if (code) notes.push(`بارکد ${code} تکراری است؛ هیچ نسخه‌ای از آن مصرف نمی‌شود.`)
      continue
    }
    const preview = row.preview
    if (!preview?.ok || remaining <= 0 || requestRemaining <= 0) continue
    const restricted = String(row.restrictScope ?? 'ALL').toUpperCase() !== 'ALL'
    const eligible = restricted ? new Set(preview.eligibleVariantIds ?? []) : cartVariants
    let ceiling = Math.min(remaining, Math.max(0, intOf(preview.applied)))
    if (restricted) {
      const eligibleCapacity = input.lines.reduce((sum, line, index) =>
        sum + (eligible.has(Number(line.variantId)) ? residualByLine[index] : 0), 0)
      ceiling = Math.min(ceiling, eligibleCapacity)
    }
    const applied = Math.min(ceiling, requestRemaining)
    appliedById[row.id] = applied
    requestedById[row.id] = asked > 0 ? applied : null
    if (applied <= 0) continue
    remaining -= applied
    if (asked > 0) requestRemaining -= applied
    if (restricted) {
      let left = applied
      for (let index = 0; index < input.lines.length && left > 0; index++) {
        if (!eligible.has(Number(input.lines[index].variantId))) continue
        const consumed = Math.min(residualByLine[index], left)
        residualByLine[index] -= consumed
        left -= consumed
      }
    } else {
      hasInvoicePool = true
    }
  }

  const applied = payable - remaining
  const eligibleAny = new Set<number>()
  for (const { row } of validRows) for (const id of row.preview?.eligibleVariantIds ?? []) eligibleAny.add(Number(id))
  const excludedVariantIds = hasInvoicePool
    ? []
    : [...cartVariants].filter((id) => !eligibleAny.has(id)).sort((a, b) => a - b)
  const firstError = ordered.find(({ row, code }) => code && (duplicateCounts.get(code) ?? 0) === 1 && row.preview && !row.preview.ok)?.row.preview?.error ?? null
  return {
    applied,
    cashDue: Math.max(0, payable - applied),
    requested: asked > 0 ? applied : null,
    excludedVariantIds,
    notes: [...new Set(notes)],
    error: applied > 0 ? null : firstError,
    appliedById,
    requestedById
  }
}
