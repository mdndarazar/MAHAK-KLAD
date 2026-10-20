/* Separate OS process/SQLite connection for the return idempotency race test. */
const [invoiceId, saleItemId, userId, shiftId, idempotencyKey, quantity = '1', note = 'idempotency integration'] = process.argv.slice(2)
try {
  const { salesService } = await import('../../../src/main/services/SalesService.ts')
  // Let the parent start both independent clients before either begins a write.
  console.log(JSON.stringify({ ready: true }))
  await new Promise((resolve) => process.stdin.once('data', resolve))
  const result = await salesService.createReturn({
    invoiceId: Number(invoiceId), full: false,
    lines: [{ saleItemId: Number(saleItemId), qty: Number(quantity) }],
    refundMethod: 'NONE', note,
    userId: Number(userId), shiftId: Number(shiftId), idempotencyKey
  }, { requireIdempotencyKey: true })
  console.log(JSON.stringify({ ok: true, returnId: result.id, replayed: result.replayed === true }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error), code: error?.code ?? null,
    stack: String(error?.stack ?? '') }))
}
