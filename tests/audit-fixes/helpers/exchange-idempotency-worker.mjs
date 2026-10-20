/* Separate OS process/SQLite connection for an exchange idempotency race. */
const [requestJson] = process.argv.slice(2)
try {
  const request = JSON.parse(requestJson)
  const { salesService } = await import('../../../src/main/services/SalesService.ts')
  // Parent opens two independent clients before releasing either mutation.
  console.log(JSON.stringify({ ready: true }))
  await new Promise((resolve) => process.stdin.once('data', resolve))
  const result = await salesService.createExchange(request, { requireIdempotencyKey: true })
  console.log(JSON.stringify({
    ok: true,
    returnId: result.returnId,
    exchangeInvoiceId: result.exchangeInvoiceId,
    replayed: result.replayed === true
  }))
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: String(error?.message ?? error),
    code: error?.code ?? null,
    stack: String(error?.stack ?? '')
  }))
}
