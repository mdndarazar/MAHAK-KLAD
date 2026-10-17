/* A separate OS process means a separate SQLite connection. Unlike two
 * concurrent promises in prismaLite's *single* test connection, this actually
 * exercises SQLite's one-writer serialization/unique constraints. Never run
 * this on a customer database. */
const [invoiceId, saleItemId, userId, shiftId] = process.argv.slice(2).map(Number)
try {
  const { salesService } = await import('../../../src/main/services/SalesService.ts')
  const result = await salesService.createReturn({ invoiceId, full: false,
    lines: [{ saleItemId, qty: 1 }], refundMethod: 'CARD_TO_CARD', refundAmount: 40,
    userId, shiftId })
  console.log(JSON.stringify({ ok: true, returnId: result.id, gift: result.creditOpportunity?.restored ?? 0 }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message, type: e.code ?? null }))
}
