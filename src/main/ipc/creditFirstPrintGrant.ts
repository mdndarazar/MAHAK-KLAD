import { randomBytes } from 'node:crypto'
import { BusinessError } from '../errors'

/**
 * A first-print permit belongs to the issuing WINDOW, shift actor, document
 * and credit source (return/exchange versus paid OVERPAY). It is neither the
 * spendable code nor permission to print another credit. No persistent grant:
 * after an app restart, the manager can print from the case with a password.
 * Print failure never cancels/reissues the credit.
 */
type GrantKind = 'RETURN' | 'OVERPAY'
interface Grant {
  token: string
  kind: GrantKind
  creditId: number
  documentId: number
  actorUserId: number
  expiresAt: number
  printing: boolean
}

const TTL_MS = 5 * 60_000
const MAX_PER_WINDOW = 32
const byWindow = new Map<number, Map<number, Grant>>()
const validId = (n: number) => Number.isSafeInteger(n) && n > 0
const denied = () => new BusinessError(
  'مجوز چاپ اول این کد مربوط به این سند/پنجره/کارمند نیست یا قبلاً استفاده شده است؛ مدیر از پروندهٔ اعتبار چاپ را پیگیری کند.'
)

/** Only called after a successfully committed issuance result. */
function issueGrant(owner: number, actorUserId: number, kind: GrantKind, documentId: number, creditId: number): string | null {
  if (![owner, actorUserId, documentId, creditId].every(validId)) return null
  const bucket = byWindow.get(owner) ?? new Map<number, Grant>()
  const now = Date.now()
  for (const [id, grant] of bucket) if (grant.expiresAt <= now && !grant.printing) bucket.delete(id)
  // Never evict an in-flight print, even when many sales are issued quickly.
  while (bucket.size >= MAX_PER_WINDOW) {
    const idle = [...bucket].find(([, grant]) => !grant.printing)
    if (!idle) return null // issuance still succeeds; manager can print
    bucket.delete(idle[0])
  }
  const token = randomBytes(32).toString('hex')
  bucket.set(creditId, { token, kind, creditId, documentId, actorUserId, expiresAt: now + TTL_MS, printing: false })
  byWindow.set(owner, bucket)
  return token
}

export function issueCreditFirstPrintGrant(owner: number, actorUserId: number, returnId: number, creditId: number): string | null {
  return issueGrant(owner, actorUserId, 'RETURN', returnId, creditId)
}

export function issueOverpayFirstPrintGrant(owner: number, actorUserId: number, invoiceId: number, creditId: number): string | null {
  return issueGrant(owner, actorUserId, 'OVERPAY', invoiceId, creditId)
}

/** Reserve synchronously (before any awaited DB read) to stop double-print. */
function reserveGrant(owner: number, input: {
  kind: GrantKind; creditId: number; documentId: number; actorUserId: number; token: unknown
}): Grant {
  const grant = byWindow.get(owner)?.get(input.creditId)
  if (typeof input.token !== 'string' || !grant || grant.token !== input.token ||
      grant.kind !== input.kind || grant.creditId !== input.creditId || grant.documentId !== input.documentId ||
      grant.actorUserId !== input.actorUserId || grant.expiresAt <= Date.now() || grant.printing)
    throw denied()
  grant.printing = true
  return grant
}

export function reserveCreditFirstPrintGrant(
  owner: number, input: { creditId: number; returnId: number; actorUserId: number; token: unknown }
): Grant {
  return reserveGrant(owner, { ...input, kind: 'RETURN', documentId: input.returnId })
}

export function reserveOverpayFirstPrintGrant(
  owner: number, input: { creditId: number; invoiceId: number; actorUserId: number; token: unknown }
): Grant {
  return reserveGrant(owner, { ...input, kind: 'OVERPAY', documentId: input.invoiceId })
}

/** A definite user cancellation sends no paper; every other outcome consumes
 * the permit, including UNKNOWN and post-spool counter/audit failure. */
export function finishCreditFirstPrintGrant(owner: number, grant: Grant | null, definitelyCanceled: boolean): void {
  if (!grant) return
  const bucket = byWindow.get(owner)
  if (bucket?.get(grant.creditId) !== grant) return
  if (definitelyCanceled && grant.expiresAt > Date.now()) grant.printing = false
  else bucket.delete(grant.creditId)
  if (bucket.size === 0) byWindow.delete(owner)
}

export function clearCreditFirstPrintGrants(owner: number): void {
  byWindow.delete(owner)
}
