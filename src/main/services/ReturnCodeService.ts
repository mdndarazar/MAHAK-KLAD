import { randomInt } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'

/** Receipt codes and StoreCredit codes are different credentials. A receipt code
 * has an expiry for LOOKUP, but its identity is reserved forever (even if the
 * invoice is subsequently purged). The unique registry also resolves races
 * between two concurrent issuers; a read of unexpired invoices cannot do that.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MIN_LENGTH = 4
const MAX_LENGTH = 12
const MAX_TRIES = 40

type Client = Prisma.TransactionClient | typeof prisma

export const DAY_MS = 24 * 60 * 60 * 1000

/** یک کد رندوم با طول دلخواه (فقط حروف بزرگ و ارقام غیرمشابه). */
export function randomReturnCode(length = 6): string {
  const len = Math.min(Math.max(Math.round(length) || 6, MIN_LENGTH), MAX_LENGTH)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(0, ALPHABET.length)]
  return out
}

/** نرمال‌سازی ورودی کاربر: حروف کوچک، فاصله و کاراکتر اضافه‌ی اسکنر پاک می‌شود. */
export function normalizeReturnCode(input: string): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/** پایان اعتبار کد بر اساس تاریخ صدور و تعداد روز تنظیم‌شده. */
export function returnCodeExpiry(issuedAt: Date, days: number): Date {
  const d = Math.min(Math.max(Math.round(days) || 7, 1), 365)
  return new Date(issuedAt.getTime() + d * DAY_MS)
}

/** Attempt one reservation in the SAME transaction as the invoice creation.
 * A duplicate is a collision, not permission to reuse an expired code. Exported
 * to make the database uniqueness (including legacy/voided codes) testable.
 */
export async function reserveReturnCodeCandidate(client: Client, code: string, issuedAt: Date): Promise<boolean> {
  if (code !== normalizeReturnCode(code) || code.length < MIN_LENGTH || code.length > MAX_LENGTH)
    throw new BusinessError('کد رسید نامعتبر است.')
  // Defensive for databases that received invoices after the registry migration
  // through an older application version. Never rely on the expiry here.
  const old = await client.saleInvoice.findFirst({ where: { returnCode: code }, select: { id: true } })
  if (old) return false
  try {
    await client.receiptCodeReservation.create({ data: { code, createdAt: issuedAt, source: 'ISSUED' } })
    return true
  } catch (error: any) {
    if (error?.code === 'P2002' || /unique constraint/i.test(String(error?.message ?? ''))) return false
    throw error
  }
}

/** Bind the tombstone to the invoice. The link is not a cascading FK: it must
 * survive invoice deletion. A failure rolls back both sale and reservation.
 */
export async function attachReturnCodeReservation(client: Client, code: string, invoiceId: number): Promise<void> {
  const linked = await client.receiptCodeReservation.updateMany({
    where: { code, source: 'ISSUED', invoiceId: null },
    data: { invoiceId }
  })
  if (linked.count !== 1) throw new BusinessError('ثبت کد رسید تکمیل نشد؛ فاکتور ثبت نشد. دوباره تلاش کنید.')
}

/** Generate and RESERVE a historically unique receipt code. Must be called in
 * the enclosing invoice transaction, then attached to that same invoice. No
 * unchecked time-based fallback: fail closed if all candidates are occupied.
 */
export async function generateReturnCode(
  client: Client,
  opts: { length?: number; days?: number; issuedAt?: Date } = {}
): Promise<{ code: string; expiresAt: Date }> {
  const issuedAt = opts.issuedAt ?? new Date()
  const expiresAt = returnCodeExpiry(issuedAt, opts.days ?? 7)
  let length = opts.length ?? 6

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (attempt > 0 && attempt % 10 === 0 && length < MAX_LENGTH) length++
    const code = randomReturnCode(length)
    if (await reserveReturnCodeCandidate(client, code, issuedAt)) return { code, expiresAt }
  }
  throw new BusinessError('برای کد رسید یکتا ظرفیت کافی پیدا نشد؛ هیچ فاکتوری ثبت نشد. دوباره تلاش کنید.')
}
