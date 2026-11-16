/**
 * Read-only building block for a future remote mirror. This module is not
 * started by the application and does not transmit, persist, or acknowledge
 * anything. It accepts the existing Prisma client, never opens a database.
 *
 * Only the fixed SELECT statements below can be executed. No arbitrary SQL
 * enters this interface. Neither audit payloads/notes nor credentials are read.
 * A boundary is a historical value, not a live cash-count calculation. Boundary
 * amounts are sensitive and require authorization before any future exposure.
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

type HistoricalBoundaryTotals = {
  source: 'HISTORICAL_BOUNDARY'
  id: number
  atDatabaseValue: string
  kind: string
  operationalDay: string
  theoreticalExpectedTotal: string
  observedOperationalTotal: string
  totalTheoreticalDifference: string
}
type OpenShift = {
  id: number
  name: string
  number: number
  operationalDay: string
  openedAtDatabaseValue: string
}

/** Raw current invoice rows, not sales totals or an immutable invoice snapshot. */
type InvoiceFact = {
  id: number
  receiptNo: number
  issuedAtJalali: string
  status: string
  orderType: string
  voided: boolean
  grandTotal: string
  paidTotal: string
  customerName: string | null
  customerPhone: string | null
  sellerName: string | null
}

const AUDIT_PAGE = `SELECT CAST(a."id" AS TEXT) AS "id", CAST(a."at" AS TEXT) AS "at",
  a."action", a."entity" FROM "AuditLog" AS a
  WHERE a."id" > ? ORDER BY a."id" ASC LIMIT ?`
const LAST_BOUNDARY = `SELECT CAST(b."id" AS TEXT) AS "id", CAST(b."at" AS TEXT) AS "at",
  b."boundaryKind" AS "kind", b."operationalDay",
  CAST(b."totalTheoreticalDifference" AS TEXT) AS "totalTheoreticalDifference"
  FROM "CustodyAggregateBoundary" AS b ORDER BY b."id" DESC LIMIT 1`
const LAST_BOUNDARY_TOTALS = `SELECT CAST(b."id" AS TEXT) AS "id", CAST(b."at" AS TEXT) AS "at",
  b."boundaryKind" AS "kind", b."operationalDay",
  CAST(b."theoreticalExpectedTotal" AS TEXT) AS "theoreticalExpectedTotal",
  CAST(b."observedOperationalTotal" AS TEXT) AS "observedOperationalTotal",
  CAST(b."totalTheoreticalDifference" AS TEXT) AS "totalTheoreticalDifference"
  FROM "CustodyAggregateBoundary" AS b ORDER BY b."id" DESC LIMIT 1`
const OPEN_SHIFTS_PAGE = `SELECT CAST(s."id" AS TEXT) AS "id", s."name",
  CAST(s."number" AS TEXT) AS "number", s."dayJalali" AS "operationalDay",
  CAST(s."openedAt" AS TEXT) AS "openedAtDatabaseValue"
  FROM "Shift" AS s WHERE s."closedAt" IS NULL AND s."id" > ? ORDER BY s."id" ASC LIMIT ?`
const INVOICE_FACTS_PAGE = `SELECT CAST(i."id" AS TEXT) AS "id", CAST(i."receiptNo" AS TEXT) AS "receiptNo",
  i."issuedAtJalali", i."status", i."orderType", CASE WHEN i."voidedAt" IS NULL THEN '0' ELSE '1' END AS "voided",
  CAST(i."grandTotal" AS TEXT) AS "grandTotal", CAST(i."paidTotal" AS TEXT) AS "paidTotal",
  c."name" AS "customerName", c."phone" AS "customerPhone", u."displayName" AS "sellerName"
  FROM "SaleInvoice" AS i LEFT JOIN "Customer" AS c ON c."id" = i."customerId"
  LEFT JOIN "User" AS u ON u."id" = i."userId"
  WHERE i."issuedAtJalali" >= ? AND i."issuedAtJalali" <= ? AND i."id" > ? ORDER BY i."id" ASC LIMIT ?`

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
function boundedText(value: unknown): string {
  const v = text(value)
  if (Buffer.byteLength(v, 'utf8') > 512) throw new Error('Database text too large')
  return v
}
function nullableText(value: unknown): string | null {
  return value === null ? null : boundedText(value)
}
function jalaliDate(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])$/.test(value)
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
  let pendingQuery: Promise<unknown> | null = null
  async function read(sql: string, values: (number | string)[]): Promise<Record<string, unknown>[]> {
    if (inFlight) throw new Error('Cloud reader busy')
    inFlight = true
    // The timeout is not a database cancellation. Keep the single-flight lock
    // until the real query settles, even if the caller has already timed out.
    const query = Promise.resolve().then(() => client.$queryRawUnsafe(sql, ...values))
    pendingQuery = query
    const clear = () => { if (pendingQuery === query) { pendingQuery = null; inFlight = false } }
    void query.then(clear, clear)
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
    /** Wait for the actual query, including one whose public call timed out.
     * The caller must prevent new reads while waiting; this does not cancel SQL. */
    async waitForIdle(): Promise<void> {
      const query = pendingQuery
      if (query) await query.then(() => {}, () => {})
    },
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
    },
    /** Historical saved values only. This is not the current open-shift total. */
    async latestBoundaryTotals(): Promise<HistoricalBoundaryTotals | null> {
      const result = await read(LAST_BOUNDARY_TOTALS, [])
      if (result.length > 1) throw new Error('Invalid boundary response')
      if (!result.length) return null
      const row = result[0]
      return {
        source: 'HISTORICAL_BOUNDARY', id: safeId(row.id), atDatabaseValue: text(row.at),
        kind: text(row.kind), operationalDay: text(row.operationalDay),
        theoreticalExpectedTotal: integerText(row.theoreticalExpectedTotal),
        observedOperationalTotal: integerText(row.observedOperationalTotal),
        totalTheoreticalDifference: integerText(row.totalTheoreticalDifference)
      }
    },
    /**
     * On-demand raw invoice facts, including voided/draft rows. This deliberately
     * does not claim to match a desktop sales report, compute revenue, or resolve
     * return/exchange history. Customer and seller names are current profile data,
     * not historical snapshots. A caller must enforce current VIEW ACL before and
     * after reading. This is neither a durable change feed nor a cross-page snapshot.
     */
    async invoiceFactsPage(fromDay: string, toDay: string, afterId: number, limit = 200): Promise<InvoiceFact[]> {
      if (!jalaliDate(fromDay) || !jalaliDate(toDay) || fromDay > toDay ||
          !Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new Error('Invalid invoice date range, cursor or page size')
      }
      const result = await read(INVOICE_FACTS_PAGE, [fromDay, toDay, afterId, limit])
      if (result.length > limit) throw new Error('Invalid invoice page')
      let previous = afterId
      return result.map(row => {
        const id = safeId(row.id)
        if (id <= previous || !jalaliDate(row.issuedAtJalali) || row.issuedAtJalali < fromDay || row.issuedAtJalali > toDay ||
            (row.voided !== '0' && row.voided !== '1')) throw new Error('Invalid invoice response')
        previous = id
        return {
          id, receiptNo: safeId(row.receiptNo, true), issuedAtJalali: row.issuedAtJalali,
          status: boundedText(row.status), orderType: boundedText(row.orderType), voided: row.voided === '1',
          grandTotal: integerText(row.grandTotal), paidTotal: integerText(row.paidTotal),
          customerName: nullableText(row.customerName), customerPhone: nullableText(row.customerPhone), sellerName: nullableText(row.sellerName)
        }
      })
    },
    /** A read-only on-demand listing, not a change cursor or a consistent snapshot. */
    async openShiftsPage(afterId: number, limit = 200): Promise<OpenShift[]> {
      if (!Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid shift cursor or page size')
      const result = await read(OPEN_SHIFTS_PAGE, [afterId, limit])
      if (result.length > limit) throw new Error('Invalid shift page')
      let previous = afterId
      return result.map((row) => {
        const id = safeId(row.id)
        if (id <= previous) throw new Error('Invalid shift ordering')
        previous = id
        return {
          id, name: text(row.name), number: safeId(row.number, true),
          operationalDay: text(row.operationalDay), openedAtDatabaseValue: text(row.openedAtDatabaseValue)
        }
      })
    }
  }
}
