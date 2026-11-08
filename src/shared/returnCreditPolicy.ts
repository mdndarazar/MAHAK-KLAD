import { CreditRestrictScope, normalizeRestrictScope, parseIdList } from './credit'

/**
 * The single source-of-truth policy for returning credit-funded sales.
 *
 * ALL-scope barcode value is an invoice-level pool: it is never apportioned to
 * sale items, neither pro-rata nor by any other per-item split. On a return,
 * matching restricted manager credit is restored only from eligible returned
 * goods; ordinary ALL credit is then restored from the remaining funded return
 * value, before any real-money refund right is calculated.
 *
 * Keep this policy shared by every return/exchange path. New workflows must call
 * planReturnCreditSources rather than implementing their own source ordering.
 */
export const RETURN_CREDIT_POLICY_VERSION = 1
export const RETURN_CREDIT_POLICY_KEY = 'POOLED_ALL_CREDIT_RESTRICTED_MANAGER_ONLY'

export type ReturnCreditLine = {
  saleItemId: number
  variantId: number
  value: number
  categoryPath: number[]
}

export type ReturnCreditSource = {
  redemptionId: number
  creditId: number
  amount: number
  priorAmount?: number
  /** Source expiry drives FEFO allocation; null/no expiry sorts after dated sources. */
  expiresAt?: Date | string | null
  restrictScope?: string | null
  restrictVariantIdsJson?: string | null
  restrictCategoryIdsJson?: string | null
}

export type ReturnCreditShare = {
  redemptionId: number
  creditId: number
  amount: number
  /** null means pooled invoice-level ALL credit; it is deliberately not item-tagged. */
  saleItemId: number | null
}

export type ReturnCreditPlan = {
  policyVersion: number
  fundedReturning: number
  credit: number
  realMoneyRight: number
  shares: ReturnCreditShare[]
}

function validRial(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function returnCreditSourceMatchesLine(source: ReturnCreditSource, line: ReturnCreditLine): boolean {
  const scope = normalizeRestrictScope(source.restrictScope)
  if (scope === CreditRestrictScope.ALL) return true
  if (scope === CreditRestrictScope.VARIANTS)
    return parseIdList(source.restrictVariantIdsJson).includes(line.variantId)
  const allowed = new Set(parseIdList(source.restrictCategoryIdsJson))
  return line.categoryPath.some((id) => allowed.has(id))
}

/**
 * Plan source-credit restoration for one return. Debt is taken off first,
 * assigning invoice-level debt to non-qualifying goods before qualifying goods
 * so a restricted manager credit is not silently consumed by an unrelated item.
 * Restricted sources are matched to eligible lines; ALL sources draw only from
 * the invoice pool and therefore receive no saleItemId in the returned shares.
 */
export function planReturnCreditSources(input: {
  lines: readonly ReturnCreditLine[]
  sources: readonly ReturnCreditSource[]
  debtReduction?: number
}): ReturnCreditPlan {
  const lines = [...(input.lines ?? [])].slice().sort((a, b) => a.saleItemId - b.saleItemId)
  const expiryTime = (value: Date | string | null | undefined): number => {
    if (value == null) return Number.POSITIVE_INFINITY
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
    if (!Number.isFinite(time)) throw new RangeError('Return credit source expiry is invalid')
    return time
  }
  const sources = [...(input.sources ?? [])].slice().sort((a, b) =>
    expiryTime(a.expiresAt) - expiryTime(b.expiresAt) || a.redemptionId - b.redemptionId)
  const debtReduction = input.debtReduction ?? 0
  if (!validRial(debtReduction) || (lines.length === 0 && (sources.length > 0 || debtReduction > 0)))
    throw new RangeError('Return credit policy input is incomplete')
  const lineIds = new Set<number>()
  for (const line of lines) {
    if (!Number.isSafeInteger(line.saleItemId) || line.saleItemId <= 0 ||
        !Number.isSafeInteger(line.variantId) || line.variantId <= 0 || !validRial(line.value) ||
        !Array.isArray(line.categoryPath) || line.categoryPath.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        lineIds.has(line.saleItemId)) throw new RangeError('Return credit line is invalid')
    lineIds.add(line.saleItemId)
  }
  const sourceIds = new Set<number>()
  for (const source of sources) {
    const prior = source.priorAmount ?? 0
    if (!Number.isSafeInteger(source.redemptionId) || source.redemptionId <= 0 ||
        !Number.isSafeInteger(source.creditId) || source.creditId <= 0 || !validRial(source.amount) ||
        !validRial(prior) || prior > source.amount || sourceIds.has(source.redemptionId))
      throw new RangeError('Return credit source is invalid')
    const scope = normalizeRestrictScope(source.restrictScope)
    if (scope === CreditRestrictScope.VARIANTS && parseIdList(source.restrictVariantIdsJson).length === 0)
      throw new RangeError('Restricted variant credit has no scope')
    if (scope === CreditRestrictScope.CATEGORY && parseIdList(source.restrictCategoryIdsJson).length === 0)
      throw new RangeError('Restricted category credit has no scope')
    sourceIds.add(source.redemptionId)
  }
  const totalReturn = lines.reduce((sum, line) => sum + BigInt(line.value), 0n)
  if (totalReturn > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(debtReduction) > totalReturn)
    throw new RangeError('Return credit value exceeds safe invoice funding')

  const fundedByLine = new Map(lines.map((line) => [line.saleItemId, line.value]))
  let debtLeft = debtReduction
  // Debt is an invoice-level obligation. Prefer to absorb it on returned goods
  // that do not qualify for a restricted credit; stable IDs break all ties.
  const restricted = sources.filter((source) =>
    normalizeRestrictScope(source.restrictScope) !== CreditRestrictScope.ALL)
  const debtOrder = [
    ...lines.filter((line) => !restricted.some((source) => returnCreditSourceMatchesLine(source, line))),
    ...lines.filter((line) => restricted.some((source) => returnCreditSourceMatchesLine(source, line)))
  ]
  for (const line of debtOrder) {
    const debt = Math.min(debtLeft, fundedByLine.get(line.saleItemId) ?? 0)
    fundedByLine.set(line.saleItemId, (fundedByLine.get(line.saleItemId) ?? 0) - debt)
    debtLeft -= debt
    if (debtLeft === 0) break
  }
  if (debtLeft !== 0) throw new RangeError('Return debt reduction exceeds returned goods')

  const availableBySource = new Map(sources.map((source) =>
    [source.redemptionId, source.amount - (source.priorAmount ?? 0)]))
  const shares: ReturnCreditShare[] = []
  // Only the issuer-scoped exception is item-bound. Match it to eligible return
  // lines first, retaining the exact source/expiry/status identity.
  for (const source of restricted) {
    let remaining = availableBySource.get(source.redemptionId) ?? 0
    for (const line of lines) {
      if (!returnCreditSourceMatchesLine(source, line)) continue
      const availableLine = fundedByLine.get(line.saleItemId) ?? 0
      const amount = Math.min(remaining, availableLine)
      if (amount <= 0) continue
      shares.push({ redemptionId: source.redemptionId, creditId: source.creditId, amount, saleItemId: line.saleItemId })
      fundedByLine.set(line.saleItemId, availableLine - amount)
      remaining -= amount
      if (remaining === 0) break
    }
  }
  // Ordinary ALL credit is one pooled invoice source, not a set of line shares.
  // Deterministic redemption order preserves source provenance across chunks.
  for (const source of sources.filter((row) => normalizeRestrictScope(row.restrictScope) === CreditRestrictScope.ALL)) {
    const remainingValue = [...fundedByLine.values()].reduce((sum, value) => sum + value, 0)
    const available = availableBySource.get(source.redemptionId) ?? 0
    const amount = Math.min(available, remainingValue)
    if (amount > 0) shares.push({
      redemptionId: source.redemptionId,
      creditId: source.creditId,
      amount,
      saleItemId: null
    })
    let toConsume = amount
    for (const line of lines) {
      const availableLine = fundedByLine.get(line.saleItemId) ?? 0
      const consumed = Math.min(toConsume, availableLine)
      fundedByLine.set(line.saleItemId, availableLine - consumed)
      toConsume -= consumed
      if (toConsume === 0) break
    }
    if (toConsume !== 0) throw new RangeError('Pooled return credit failed to reconcile')
  }

  const credit = shares.reduce((sum, share) => sum + BigInt(share.amount), 0n)
  const fundedReturning = Number(totalReturn) - debtReduction
  if (credit > BigInt(fundedReturning) || credit > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Return credit exceeds funded returned value')
  return {
    policyVersion: RETURN_CREDIT_POLICY_VERSION,
    fundedReturning,
    credit: Number(credit),
    realMoneyRight: fundedReturning - Number(credit),
    shares
  }
}
