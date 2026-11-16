/** Fixed DTO validation for the experimental invoice read path. No database or I/O. */
export function isInvoiceDate(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])$/.test(value)
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value,'utf8') > max) throw new Error('Invalid invoice value')
  return value
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid invoice value')
  return value as number
}
function amount(value: unknown): string {
  const result=text(value,100)
  if (!/^-?(0|[1-9][0-9]*)$/.test(result)) throw new Error('Invalid invoice amount')
  return result
}
/** Copy only allowlisted fields; never forward extra private data across IPC. */
export function parseInvoicePage(value: unknown, from: string, to: string, afterId: number) {
  if (!isInvoiceDate(from) || !isInvoiceDate(to) || from > to || !Number.isSafeInteger(afterId) || afterId < 0 ||
      !Array.isArray(value) || value.length > 50) throw new Error('Invalid invoice page')
  let prior=afterId
  return value.map(a => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !Number.isSafeInteger(a.id) || a.id <= prior ||
        !isInvoiceDate(a.issuedAtJalali) || a.issuedAtJalali < from || a.issuedAtJalali > to || typeof a.voided !== 'boolean') throw new Error('Invalid invoice page')
    prior=a.id
    const optional=(v:unknown) => v === null ? null : text(v,512)
    return { id:id(a.id), receiptNo:id(a.receiptNo), issuedAtJalali:a.issuedAtJalali, status:text(a.status,512),
      orderType:text(a.orderType,512), voided:a.voided, grandTotal:amount(a.grandTotal), paidTotal:amount(a.paidTotal),
      customerName:optional(a.customerName), customerPhone:optional(a.customerPhone), sellerName:optional(a.sellerName) }
  })
}
