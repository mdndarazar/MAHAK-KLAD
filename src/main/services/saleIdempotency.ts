import { createHash } from 'node:crypto'
import { normalizeCreditCode } from '@shared/credit'
import { BusinessError } from '../errors'

export type NormalizedSaleCreditTender = {
  code: string
  requestedAmount: number | null
  idempotencyKey: string | null
  inputIndex: number
}

export type SaleCreditOutcome = {
  code: string
  status: 'APPLIED' | 'UNUSED' | 'REJECTED'
  amount: number
  message: string
}

export function normalizeSaleCreditTenders(input: any, orderType: string): NormalizedSaleCreditTender[] {
  if (input?.storeCredits != null && !Array.isArray(input.storeCredits))
    throw new BusinessError('فهرست بارکدهای اعتبار معتبر نیست.')
  const hasArray = Array.isArray(input?.storeCredits)
  const hasLegacy = String(input?.storeCreditCode ?? '').trim().length > 0
  if (hasArray && hasLegacy)
    throw new BusinessError('برای ثبت اعتبار، فقط یکی از قالب‌های تک‌بارکدی یا چندبارکدی را بفرستید.')
  const rows: any[] = hasArray
    ? input.storeCredits
    : hasLegacy
      ? [{ code: input.storeCreditCode, requestedAmount: input.storeCreditAmount, idempotencyKey: input.storeCreditIdempotencyKey }]
      : []
  const max = orderType === 'INTERNAL' ? 8 : 1
  if (rows.length > max)
    throw new BusinessError(orderType === 'WHOLESALE'
      ? 'فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.'
      : `این نوع فاکتور حداکثر ${max} بارکد اعتبار می‌پذیرد.`)
  return rows.map((row, inputIndex) => {
    const code = normalizeCreditCode(row?.code)
    const requested = row?.requestedAmount == null ? null : Number(row.requestedAmount)
    if (requested != null && (!Number.isSafeInteger(requested) || requested < 0))
      throw new BusinessError('مبلغ درخواستی هر بارکد اعتبار باید عدد صحیح ریالیِ نامنفی باشد.')
    return {
      code,
      requestedAmount: requested != null && requested > 0 ? requested : null,
      idempotencyKey: String(row?.idempotencyKey ?? '').trim() || null,
      inputIndex
    }
  }).filter((row, index) => String(rows[index]?.code ?? '').trim().length > 0)
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) {
    const next = value[key]
    if (next !== undefined) out[key] = stableValue(next)
  }
  return out
}

export function saleRequestFingerprint(input: any, tenders: readonly NormalizedSaleCreditTender[]): string {
  const {
    managerPassword: _managerPassword,
    panelPassword: _panelPassword,
    saleOperatorPassword: _saleOperatorPassword,
    custodyFence: _custodyFence,
    saleRequestIdempotencyKey: _saleRequestIdempotencyKey,
    storeCreditCode: _storeCreditCode,
    storeCreditAmount: _storeCreditAmount,
    storeCreditIdempotencyKey: _storeCreditIdempotencyKey,
    storeCredits: _storeCredits,
    ...businessInput
  } = input ?? {}
  const normalizedTenders = [...tenders]
    .map(({ code, requestedAmount, idempotencyKey }) => ({ code, requestedAmount, idempotencyKey }))
    .sort((a, b) => a.code.localeCompare(b.code) || (a.requestedAmount ?? 0) - (b.requestedAmount ?? 0))
  const serialized = JSON.stringify(stableValue({ businessInput, storeCredits: normalizedTenders }))
  return createHash('sha256').update(serialized).digest('hex')
}

export function creditTenderIdempotencyKey(saleRequestKey: string | null, invoiceId: number, code: string): string {
  if (!saleRequestKey) return `sale:${invoiceId}:${code}`
  return `sale-credit:${createHash('sha256').update(`${saleRequestKey}\u0000${code}`).digest('hex')}`
}
