import { randomBytes } from 'node:crypto'
import { BusinessError } from '../errors'
import { prisma } from '../db/client'
import type { CustodyFence } from '../services/CustodyService'

/**
 * A form-open witness, NOT an authentication token. Custody PIN, the Main-owned
 * actor, financial gates and the transaction's custody fence still decide who
 * may write. Keep these witnesses only in Main memory and only for the window
 * that read the invoice; a restart simply requires reopening the edit form.
 */
type SaleEditFormGrant = {
  token: string
  invoiceId: number
  shiftId: number
  actorUserId: number
  issuedEpoch: number
  expiresAt: number
  saving: boolean
}

const TTL_MS = 12 * 60 * 60 * 1000
const MAX_FORMS_PER_WINDOW = 32
const grantsByWindow = new Map<number, Map<number, SaleEditFormGrant>>()

export function staleSaleEditForm(): BusinessError {
  return new BusinessError(
    'فرم ویرایش قدیمی، استفاده‌شده یا نامعتبر است. اطلاعات واردشده را نگه دارید و فقط پس از تصمیم خودتان فاکتور را دوباره باز و وضعیت ذخیره را بررسی کنید.',
    'SALE_EDIT_FORM_STALE'
  )
}

/** `owner` comes only from the authenticated IPC sender context, never from a payload. */
export function issueSaleEditFormGrant(owner: number, invoiceId: number, fence: CustodyFence): string {
  if (!Number.isSafeInteger(owner) || owner <= 0 || !Number.isSafeInteger(invoiceId) || invoiceId <= 0)
    throw staleSaleEditForm()
  const now = Date.now()
  const bucket = grantsByWindow.get(owner) ?? new Map<number, SaleEditFormGrant>()
  for (const [id, grant] of bucket) if (grant.expiresAt <= now && !grant.saving) bucket.delete(id)
  // Do not issue a second view of this invoice while its first edit is still
  // committing; the new view could contain pre-commit data with a fresh token.
  if (bucket.get(invoiceId)?.saving) throw staleSaleEditForm()
  bucket.delete(invoiceId) // a new explicit read supersedes the old form in this window
  while (bucket.size >= MAX_FORMS_PER_WINDOW) {
    const oldestIdle = [...bucket].find(([, grant]) => !grant.saving)
    if (!oldestIdle) throw staleSaleEditForm()
    bucket.delete(oldestIdle[0])
  }
  const token = randomBytes(32).toString('hex')
  bucket.set(invoiceId, {
    token, invoiceId,
    shiftId: fence.expectedShiftId,
    actorUserId: fence.expectedActorUserId,
    issuedEpoch: fence.epoch,
    expiresAt: now + TTL_MS,
    saving: false
  })
  grantsByWindow.set(owner, bucket)
  return token
}

/** Reserve synchronously, before the first await, to prevent concurrent replay. */
export function reserveSaleEditFormGrant(owner: number, invoiceId: number, token: unknown): SaleEditFormGrant | null {
  if (token == null) return null // a legacy (never-governed) edit has no form witness
  const grant = grantsByWindow.get(owner)?.get(invoiceId)
  if (typeof token !== 'string' || !grant || grant.token !== token || grant.expiresAt <= Date.now() || grant.saving)
    throw staleSaleEditForm()
  grant.saving = true
  return grant
}

/** A Main actor acquired *after* reservation must still be the grant's actor. */
export function assertSaleEditFormActor(grant: SaleEditFormGrant | null, fence: CustodyFence | null): void {
  if (fence) {
    if (!grant || grant.actorUserId !== fence.expectedActorUserId || grant.shiftId !== fence.expectedShiftId ||
        fence.epoch < grant.issuedEpoch) throw staleSaleEditForm()
  } else if (grant) {
    // Switching the feature flag cannot turn an old governed form into a legacy edit.
    throw staleSaleEditForm()
  }
}

/**
 * A handover START/CANCEL advances the raw epoch while the same worker still
 * owns the drawer, so it must not expire that worker's form. An *effective*
 * administrative reset, even if it restores the same shift, is a different
 * responsibility boundary. Its append-only event records a changed epoch;
 * a healthy no-op review records identical before/after epochs. No migrations
 * and no custody-state writes are needed for this read-only distinction.
 *
 * A reset racing after this check is caught by SalesService's in-TX fence.
 */
export async function assertNoEffectiveSaleEditReset(grant: SaleEditFormGrant | null, fence: CustodyFence | null): Promise<void> {
  if (!grant || !fence || fence.epoch === grant.issuedEpoch) return
  const resets = await prisma.custodyEvent.findMany({
    where: { type: 'CUSTODY_SHIFT_RESET_REVIEW', shiftId: grant.shiftId, epochAfter: { gt: grant.issuedEpoch } },
    select: { epochBefore: true, epochAfter: true }
  })
  if (resets.some((row: { epochAfter: number | null; epochBefore: number | null }) =>
    row.epochAfter !== row.epochBefore)) throw staleSaleEditForm()
}

/** Only a successfully committed sale consumes a grant. Failed validation is retryable. */
export function finishSaleEditFormGrant(owner: number, grant: SaleEditFormGrant | null, committed: boolean): void {
  if (!grant) return
  const bucket = grantsByWindow.get(owner)
  if (bucket?.get(grant.invoiceId) !== grant) return // a later explicit read replaced it
  if (committed) {
    bucket.delete(grant.invoiceId)
    if (bucket.size === 0) grantsByWindow.delete(owner)
  } else {
    grant.saving = false
  }
}

/** webContents destruction revokes this window's witnesses, never another's. */
export function clearSaleEditFormGrants(owner: number): void {
  grantsByWindow.delete(owner)
}

export type { SaleEditFormGrant }
