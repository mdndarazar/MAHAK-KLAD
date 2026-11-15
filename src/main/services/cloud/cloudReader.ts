/**
 * Read-only building block for a future remote mirror. This module is not
 * started by the application and does not transmit, persist, or acknowledge
 * anything. It accepts the existing Prisma client, never opens a database.
 *
 * Only the two fixed SELECT statements below can be executed. No arbitrary SQL
 * enters this interface. Neither audit payloads/notes nor credentials are read.
 * A boundary is a historical value, not a live cash-count calculation.
 */
type ReadClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
}

type AuditEvent = { id: number; at: string; action: string; entity: string }
type Boundary = {
  id: number
  at: string
  kind: string
  operationalDay: string
  totalTheoreticalDifference: string
}

const AUDIT_PAGE = `SELECT CAST(a."id" AS TEXT) AS "id", CAST(a."at" AS TEXT) AS "at",
  a."action", a."entity" FROM "AuditLog" AS a
  WHERE a."id" > ? ORDER BY a."id" ASC LIMIT ?`
const LAST_BOUNDARY = `SELECT CAST(b."id" AS TEXT) AS "id", CAST(b."at" AS TEXT) AS "at",
  b."boundaryKind" AS "kind", b."operationalDay",
  CAST(b."totalTheoreticalDifference" AS TEXT) AS "totalTheoreticalDifference"
  FROM "CustodyAggregateBoundary" AS b ORDER BY b."id" DESC LIMIT 1`

function safeId(value: unknown, allowZero = false): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid database ID')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1)) throw new Error('Invalid database ID')
  return id
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid database value')
  return value
}
function integerText(value: unknown): string {
  const v = text(value)
  if (!/^-?(0|[1-9][0-9]*)$/.test(v)) throw new Error('Invalid database amount')
  return v
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('Invalid database response')
  }
  return value as Record<string, unknown>[]
}

export function createCloudReader(client: ReadClient, timeoutMs = 2000) {
  if (!client || typeof client.$queryRawUnsafe !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('Invalid cloud reader configuration')
  }
  let inFlight = false
  async function read(sql: string, values: (number)[]): Promise<Record<string, unknown>[]> {
    if (inFlight) throw new Error('Cloud reader busy')
    inFlight = true
    // The timeout is not a database cancellation. Keep the single-flight lock
    // until the real query settles, even if the caller has already timed out.
    const query = Promise.resolve().then(() => client.$queryRawUnsafe(sql, ...values))
    void query.then(() => { inFlight = false }, () => { inFlight = false })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        query,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cloud reader timeout')), timeoutMs) })
      ])
      return rows(result)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return {
    async auditPage(afterId: number, limit = 200): Promise<AuditEvent[]> {
      if (!Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid audit cursor or page size')
      const result = await read(AUDIT_PAGE, [afterId, limit])
      if (result.length > limit) throw new Error('Invalid audit page')
      let previous = afterId
      return result.map((row) => {
        const id = safeId(row.id)
        if (id <= previous) throw new Error('Invalid audit ordering')
        previous = id
        return { id, at: text(row.at), action: text(row.action), entity: text(row.entity) }
      })
    },
    async latestBoundary(): Promise<Boundary | null> {
      const result = await read(LAST_BOUNDARY, [])
      if (result.length > 1) throw new Error('Invalid boundary response')
      if (!result.length) return null
      const row = result[0]
      return {
        id: safeId(row.id), at: text(row.at), kind: text(row.kind),
        operationalDay: text(row.operationalDay), totalTheoreticalDifference: integerText(row.totalTheoreticalDifference)
      }
    }
  }
}
