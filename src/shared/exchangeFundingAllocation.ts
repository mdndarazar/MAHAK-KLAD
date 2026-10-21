/**
 * Deterministic allocation for the approved gift-first exchange policy.
 *
 * This is intentionally a pure planning primitive: callers must provide only
 * source amounts already proven by the funding ledger, and must persist the
 * resulting allocations atomically with the exchange. It does not infer cash,
 * restore a credit, issue a credit, or authorize a refund.
 * All amounts are integer rials.
 */
export type ExchangeFundingPlan = {
  giftCarry: number
  realMoneyCarry: number
  giftRemainder: number
  realMoneyRemainder: number
  unfundedReplacement: number
}

export type ExchangeFundingRealMoneyKind = 'SOURCE_N' | 'SOURCE_B' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE'
export type ExchangeFundingFloorShare = {
  sourceEventId: number
  sourceKind: 'SOURCE_GIFT' | ExchangeFundingRealMoneyKind
  available: number
}

export type ExchangeFundingFloorAllocation = {
  sourceEventId: number
  sourceKind: 'SOURCE_GIFT' | ExchangeFundingRealMoneyKind
  carry: number
  remainder: number
}

/** S1/S7 final-design allocation: floor the cumulative gift proportion first,
 * then assign the exact balancing Rial(s) to proven real-money tenders
 * (cash/card/cleared cheque). Within the gift and real-money groups, cumulative
 * floors partition the group amount across immutable source events. This is
 * deliberately distinct from gift-first and largest-remainder allocation;
 * it is a read/plan primitive only.
 */
export function allocateExchangeFundingProportionalFloor(input: {
  replacementTotal: number
  sources: readonly ExchangeFundingFloorShare[]
}): { giftCarry: number; cashCarry: number; allocations: ExchangeFundingFloorAllocation[] } {
  const { replacementTotal, sources } = input
  if (!Number.isSafeInteger(replacementTotal) || replacementTotal < 0 || !Array.isArray(sources))
    throw new RangeError('Exchange funding amounts must be non-negative safe integer rials')

  const seen = new Set<number>()
  let giftTotal = 0n
  let cashTotal = 0n
  for (const source of sources) {
    if (!source || !Number.isSafeInteger(source.sourceEventId) || source.sourceEventId <= 0 ||
        seen.has(source.sourceEventId) || !Number.isSafeInteger(source.available) || source.available < 0 ||
        !['SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'].includes(source.sourceKind))
      throw new RangeError('Exchange funding shares must be unique and proven')
    seen.add(source.sourceEventId)
    if (source.sourceKind === 'SOURCE_GIFT') giftTotal += BigInt(source.available)
    else cashTotal += BigInt(source.available)
  }
  const sourceTotal = giftTotal + cashTotal
  if (sourceTotal > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(replacementTotal) > sourceTotal)
    throw new RangeError('Replacement value exceeds proven gift/cash sources')
  if (replacementTotal > 0 && sourceTotal === 0n)
    throw new RangeError('Non-zero replacement requires proven funding')

  const giftCarry = sourceTotal === 0n
    ? 0
    : Number((giftTotal * BigInt(replacementTotal)) / sourceTotal)
  const cashCarry = replacementTotal - giftCarry
  if (BigInt(giftCarry) > giftTotal || BigInt(cashCarry) > cashTotal)
    throw new RangeError('Proportional funding carry exceeds its proven source kind')

  const allocations: ExchangeFundingFloorAllocation[] = []
  for (const group of ['GIFT', 'REAL'] as const) {
    const members = [...sources].filter((row) => group === 'GIFT'
      ? row.sourceKind === 'SOURCE_GIFT' : row.sourceKind !== 'SOURCE_GIFT')
      .sort((left, right) => left.sourceEventId - right.sourceEventId)
    const groupTotal = group === 'GIFT' ? giftTotal : cashTotal
    const groupCarry = group === 'GIFT' ? giftCarry : cashCarry
    let cumulativeAvailable = 0n
    let priorCarry = 0n
    for (const source of members) {
      cumulativeAvailable += BigInt(source.available)
      const cumulativeCarry = groupTotal === 0n ? 0n
        : (cumulativeAvailable * BigInt(groupCarry)) / groupTotal
      const carry = Number(cumulativeCarry - priorCarry)
      allocations.push({ sourceEventId: source.sourceEventId, sourceKind: source.sourceKind,
        carry, remainder: source.available - carry })
      priorCarry = cumulativeCarry
    }
  }
  if (allocations.reduce((sum, row) => sum + row.carry, 0) !== replacementTotal ||
      allocations.some((row) => row.carry < 0 || row.remainder < 0))
    throw new RangeError('Proportional funding allocation does not reconcile exactly')
  return { giftCarry, cashCarry, allocations }
}

export function allocateExchangeFundingGiftFirst(input: {
  giftAvailable: number
  realMoneyAvailable: number
  replacementTotal: number
}): ExchangeFundingPlan {
  const values = [input.giftAvailable, input.realMoneyAvailable, input.replacementTotal]
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError('Exchange funding amounts must be non-negative safe integer rials')
  }

  const giftCarry = Math.min(input.giftAvailable, input.replacementTotal)
  const remainingReplacement = input.replacementTotal - giftCarry
  const realMoneyCarry = Math.min(input.realMoneyAvailable, remainingReplacement)

  return {
    giftCarry,
    realMoneyCarry,
    giftRemainder: input.giftAvailable - giftCarry,
    realMoneyRemainder: input.realMoneyAvailable - realMoneyCarry,
    unfundedReplacement: remainingReplacement - realMoneyCarry
  }
}

/** Split an integer-rial target across source shares by largest remainder.
 * IDs provide a stable tie-break, so replaying the same snapshot yields the
 * same allocations without converting Rial values to floating point.
 */
export function allocateExchangeFundingProRata(
  target: number,
  shares: Array<{ id: number; available: number }>
): Array<{ id: number; amount: number }> {
  if (!Number.isSafeInteger(target) || target < 0 || !Array.isArray(shares)) {
    throw new RangeError('Exchange funding allocation must use non-negative safe integer rials')
  }
  const seen = new Set<number>()
  let denominator = 0n
  for (const share of shares) {
    if (!share || !Number.isSafeInteger(share.id) || share.id <= 0 || seen.has(share.id) ||
        !Number.isSafeInteger(share.available) || share.available < 0) {
      throw new RangeError('Exchange funding shares must have unique IDs and non-negative safe integer rials')
    }
    seen.add(share.id)
    denominator += BigInt(share.available)
  }
  if (denominator > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(target) > denominator) {
    throw new RangeError('Exchange funding target exceeds the proven source shares')
  }
  if (target === 0) return shares.map(({ id }) => ({ id, amount: 0 }))
  if (denominator === 0n) throw new RangeError('Exchange funding target has no proven source shares')

  const rows = shares.map((share, index) => {
    const numerator = BigInt(target) * BigInt(share.available)
    return {
      index,
      id: share.id,
      amount: Number(numerator / denominator),
      remainder: numerator % denominator
    }
  })
  const allocated = rows.reduce((sum, row) => sum + row.amount, 0)
  let remaining = target - allocated
  const remainderOrder = [...rows].sort((left, right) =>
    left.remainder === right.remainder
      ? left.id - right.id
      : left.remainder > right.remainder ? -1 : 1
  )
  for (const row of remainderOrder) {
    if (remaining <= 0) break
    row.amount += 1
    remaining -= 1
  }
  if (remaining !== 0) throw new RangeError('Exchange funding allocation did not reconcile exactly')

  return rows.sort((left, right) => left.index - right.index)
    .map(({ id, amount }) => ({ id, amount }))
}

export type ExchangeFundingLineAllocation = {
  sourceEventId: number
  saleItemId: number
  sourceKind: 'SOURCE_GIFT' | 'SOURCE_N' | 'SOURCE_B' | 'SOURCE_CASH' | 'SOURCE_CARD' | 'SOURCE_CHEQUE'
  amount: number
}

/** Partition fully proven exchange funding shares across the replacement's
 * immutable sale-item values. This is a read/plan primitive only; callers must
 * persist the result atomically before it can authorize any later return.
 * Incomplete funding (debt/unknown), overpay, or a line-total mismatch is
 * rejected rather than silently assigned to an item. Deterministic rounding
 * uses stable source-event and item IDs; all amounts remain integer rials.
 */
export function allocateExchangeFundingByLine(
  lines: Array<{ saleItemId: number; amount: number }>,
  sources: Array<{
    sourceEventId: number
    sourceKind: ExchangeFundingLineAllocation['sourceKind']
    amount: number
  }>
): ExchangeFundingLineAllocation[] {
  if (!Array.isArray(lines) || !Array.isArray(sources))
    throw new RangeError('Exchange line funding requires line and source arrays')
  const lineIds = new Set<number>()
  let lineTotal = 0n
  for (const line of lines) {
    if (!line || !Number.isSafeInteger(line.saleItemId) || line.saleItemId <= 0 || lineIds.has(line.saleItemId) ||
        !Number.isSafeInteger(line.amount) || line.amount < 0)
      throw new RangeError('Exchange sale items must have unique IDs and non-negative safe integer rials')
    lineIds.add(line.saleItemId)
    lineTotal += BigInt(line.amount)
  }

  const sourceIds = new Set<number>()
  let sourceTotal = 0n
  const provenKinds = new Set(['SOURCE_GIFT', 'SOURCE_N', 'SOURCE_B', 'SOURCE_CASH', 'SOURCE_CARD', 'SOURCE_CHEQUE'])
  for (const source of sources) {
    if (!source || !Number.isSafeInteger(source.sourceEventId) || source.sourceEventId <= 0 ||
        sourceIds.has(source.sourceEventId) || !provenKinds.has(source.sourceKind) ||
        !Number.isSafeInteger(source.amount) || source.amount < 0)
      throw new RangeError('Exchange sources must be unique proven shares with non-negative safe integer rials')
    sourceIds.add(source.sourceEventId)
    sourceTotal += BigInt(source.amount)
  }
  if (lineTotal > BigInt(Number.MAX_SAFE_INTEGER) || sourceTotal > BigInt(Number.MAX_SAFE_INTEGER) ||
      lineTotal !== sourceTotal)
    throw new RangeError('Proven exchange funding must reconcile exactly to replacement line values')
  if (lineTotal === 0n) return []
  if (!lines.length || !sources.length)
    throw new RangeError('Non-zero replacement lines require proven funding sources')

  const orderedLines = [...lines].sort((left, right) => left.saleItemId - right.saleItemId)
  const orderedSources = [...sources].sort((left, right) => left.sourceEventId - right.sourceEventId)
  const cells: Array<Array<{
    floor: bigint
    remainder: bigint
    roundingEdge?: { to: number; reverseIndex: number; capacity: number }
  }>> = []
  const rowNeeds: number[] = []
  const columnFloorTotals = orderedLines.map(() => 0n)
  const denominator = lineTotal

  for (const source of orderedSources) {
    let rowFloorTotal = 0n
    const row = orderedLines.map((line, columnIndex) => {
      const numerator = BigInt(source.amount) * BigInt(line.amount)
      const floor = numerator / denominator
      const remainder = numerator % denominator
      rowFloorTotal += floor
      columnFloorTotals[columnIndex] += floor
      return { floor, remainder }
    })
    const rowNeed = BigInt(source.amount) - rowFloorTotal
    if (rowNeed < 0n || rowNeed > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError('Exchange source rounding remainder is invalid')
    rowNeeds.push(Number(rowNeed))
    cells.push(row)
  }

  const columnNeeds = orderedLines.map((line, index) => {
    const need = BigInt(line.amount) - columnFloorTotals[index]
    if (need < 0n || need > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError('Exchange item rounding remainder is invalid')
    return Number(need)
  })
  const expectedFlow = rowNeeds.reduce((sum, need) => sum + need, 0)
  if (expectedFlow !== columnNeeds.reduce((sum, need) => sum + need, 0))
    throw new RangeError('Exchange source and item rounding remainders do not reconcile')

  // Allocate the one-rial floor/ceil residuals as a deterministic bipartite
  // b-matching. Independent per-source rounding can overfill a line (for
  // example two one-rial sources and two one-rial items); this preserves both
  // margins exactly while each cell remains within one rial of its pro-rata
  // value. Traversal is stable by source ID, then fractional remainder and item ID.
  type ResidualEdge = { to: number; reverseIndex: number; capacity: number }
  const sourceNode = 0
  const rowStart = 1
  const columnStart = rowStart + orderedSources.length
  const sinkNode = columnStart + orderedLines.length
  const graph: ResidualEdge[][] = Array.from({ length: sinkNode + 1 }, () => [])
  const addEdge = (from: number, to: number, capacity: number): ResidualEdge => {
    const forward: ResidualEdge = { to, reverseIndex: graph[to].length, capacity }
    const reverse: ResidualEdge = { to: from, reverseIndex: graph[from].length, capacity: 0 }
    graph[from].push(forward)
    graph[to].push(reverse)
    return forward
  }

  rowNeeds.forEach((need, rowIndex) => {
    if (need > 0) addEdge(sourceNode, rowStart + rowIndex, need)
  })
  const candidates: Array<{ rowIndex: number; columnIndex: number; remainder: bigint }> = []
  cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    if (cell.remainder > 0n) candidates.push({ rowIndex, columnIndex, remainder: cell.remainder })
  }))
  candidates.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1
    const sourceDifference = orderedSources[left.rowIndex].sourceEventId - orderedSources[right.rowIndex].sourceEventId
    return sourceDifference || orderedLines[left.columnIndex].saleItemId - orderedLines[right.columnIndex].saleItemId
  })
  for (const candidate of candidates) {
    const edge = addEdge(rowStart + candidate.rowIndex, columnStart + candidate.columnIndex, 1)
    cells[candidate.rowIndex][candidate.columnIndex].roundingEdge = edge
  }
  columnNeeds.forEach((need, columnIndex) => {
    if (need > 0) addEdge(columnStart + columnIndex, sinkNode, need)
  })

  let flow = 0
  while (true) {
    const levels = Array(graph.length).fill(-1)
    const queue = [sourceNode]
    levels[sourceNode] = 0
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor]
      for (const edge of graph[node]) {
        if (edge.capacity > 0 && levels[edge.to] < 0) {
          levels[edge.to] = levels[node] + 1
          queue.push(edge.to)
        }
      }
    }
    if (levels[sinkNode] < 0) break
    const nextEdge = Array(graph.length).fill(0)
    const send = (node: number, limit: number): number => {
      if (node === sinkNode) return limit
      for (; nextEdge[node] < graph[node].length; nextEdge[node]++) {
        const edge = graph[node][nextEdge[node]]
        if (edge.capacity <= 0 || levels[edge.to] !== levels[node] + 1) continue
        const sent = send(edge.to, Math.min(limit, edge.capacity))
        if (sent > 0) {
          edge.capacity -= sent
          graph[edge.to][edge.reverseIndex].capacity += sent
          return sent
        }
      }
      return 0
    }
    let sent = 0
    while ((sent = send(sourceNode, Number.MAX_SAFE_INTEGER)) > 0) flow += sent
  }
  if (flow !== expectedFlow)
    throw new RangeError('Exchange line rounding could not satisfy both exact totals')

  const allocations: ExchangeFundingLineAllocation[] = []
  const bySource = new Map<number, bigint>(orderedSources.map((source) => [source.sourceEventId, 0n]))
  const byLine = new Map<number, bigint>(orderedLines.map((line) => [line.saleItemId, 0n]))
  cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    const roundedUp = cell.roundingEdge?.capacity === 0 ? 1n : 0n
    const amountBig = cell.floor + roundedUp
    const amount = Number(amountBig)
    const source = orderedSources[rowIndex]
    const line = orderedLines[columnIndex]
    if (amountBig > 0n) allocations.push({ sourceEventId: source.sourceEventId, saleItemId: line.saleItemId,
      sourceKind: source.sourceKind, amount })
    bySource.set(source.sourceEventId, (bySource.get(source.sourceEventId) ?? 0n) + amountBig)
    byLine.set(line.saleItemId, (byLine.get(line.saleItemId) ?? 0n) + amountBig)
  }))
  if (orderedSources.some((source) => bySource.get(source.sourceEventId) !== BigInt(source.amount)) ||
      orderedLines.some((line) => byLine.get(line.saleItemId) !== BigInt(line.amount)))
    throw new RangeError('Exchange line funding did not reconcile exactly')

  return allocations
}
