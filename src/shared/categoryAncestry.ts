export interface CategoryParentRow {
  id: number
  parentId: number | null
}

/**
 * Validate the category parent graph and return its parent map. There is no
 * contractual depth limit: traversal stops only at a real root, and malformed
 * parent references or cycles fail instead of producing a truncated path.
 */
export function categoryParentMap(rows: readonly CategoryParentRow[]): Map<number, number | null> {
  const parentById = new Map<number, number | null>()
  for (const row of rows) {
    const id = Number(row.id)
    const parentId = row.parentId == null ? null : Number(row.parentId)
    if (!Number.isSafeInteger(id) || id <= 0 || parentById.has(id))
      throw new Error('شناسهٔ یکی از دسته‌ها معتبر یا یکتا نیست؛ زنجیرهٔ دسته قابل استفاده نیست.')
    if (parentId != null && (!Number.isSafeInteger(parentId) || parentId <= 0))
      throw new Error(`شناسهٔ والد دستهٔ ${id} معتبر نیست؛ زنجیرهٔ دسته قابل استفاده نیست.`)
    parentById.set(id, parentId)
  }

  for (const [id, parentId] of parentById) {
    if (parentId != null && !parentById.has(parentId))
      throw new Error(`والد دستهٔ ${id} (دستهٔ ${parentId}) در فهرست پیدا نشد؛ عملیات متوقف شد.`)
  }

  // Iterative tri-color walk avoids both a depth cap and recursive stack limits.
  const state = new Map<number, 1 | 2>() // 1 = current path, 2 = fully checked
  for (const start of parentById.keys()) {
    if (state.get(start) === 2) continue
    const path: number[] = []
    let current: number | null = start
    while (current != null) {
      const currentState = state.get(current)
      if (currentState === 2) break
      if (currentState === 1)
        throw new Error(`چرخه در زنجیرهٔ والدهای دستهٔ ${current} پیدا شد؛ عملیات متوقف شد.`)
      state.set(current, 1)
      path.push(current)
      current = parentById.get(current) ?? null
    }
    for (const id of path) state.set(id, 2)
  }
  return parentById
}

/** Category itself followed by every ancestor, with strict missing/cycle checks. */
export function categoryAncestryPath(
  categoryId: number | null,
  parentById: ReadonlyMap<number, number | null>
): number[] {
  const path: number[] = []
  const seen = new Set<number>()
  let current = categoryId == null ? null : Number(categoryId)
  while (current != null) {
    if (!Number.isSafeInteger(current) || current <= 0)
      throw new Error('شناسهٔ دستهٔ کالا معتبر نیست؛ محدودهٔ اعتبار قابل بررسی نیست.')
    if (seen.has(current))
      throw new Error(`چرخه در زنجیرهٔ والدهای دستهٔ ${current} پیدا شد؛ محدودهٔ اعتبار قابل بررسی نیست.`)
    if (!parentById.has(current))
      throw new Error(`دستهٔ ${current} در زنجیرهٔ والدها پیدا نشد؛ محدودهٔ اعتبار قابل بررسی نیست.`)
    seen.add(current)
    path.push(current)
    current = parentById.get(current) ?? null
  }
  return path
}
