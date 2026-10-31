/* Separate SQLite processes for the atomic returnUpdate-vs-createReturn race. */
const [mode, returnId, invoiceId, saleItemId, userId, shiftId] = process.argv.slice(2)
let pausedOnce = false

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const waitForInput = (expected) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`parent did not send ${expected}`)), 15_000)
  process.stdin.once('data', (chunk) => {
    clearTimeout(timer)
    if (String(chunk).trim() !== expected) reject(new Error(`expected ${expected}`))
    else resolve()
  })
})

try {
  const { prisma } = await import('../../../src/main/db/client.ts')
  const { salesService } = await import('../../../src/main/services/SalesService.ts')
  const { DEFAULT_MANAGER_PASSWORD } = await import('../../../src/shared/receipt.ts')
  const originalTransaction = prisma.$transaction.bind(prisma)

  if (mode === 'edit') {
    prisma.$transaction = (callback, options) => originalTransaction(async (tx) => {
      const originalUpdate = tx.saleReturn.update
      tx.saleReturn.update = async (args) => {
        const result = await originalUpdate(args)
        if (!pausedOnce && Number(args?.where?.id) === Number(returnId) && args?.data?.voidedAt != null) {
          pausedOnce = true
          send({ paused: true })
          await waitForInput('continue')
        }
        return result
      }
      return callback(tx)
    }, options)
  } else if (mode === 'create') {
    let announced = false
    prisma.$transaction = (callback, options) => {
      if (!announced && typeof callback === 'function') {
        announced = true
        send({ transactionAttempt: true })
      }
      return originalTransaction(callback, options)
    }
  } else {
    throw new Error('unknown worker mode')
  }

  send({ ready: true })
  await waitForInput('go')
  if (mode === 'edit') {
    const result = await salesService.returnUpdate({
      id: Number(returnId),
      lines: [{ saleItemId: Number(saleItemId), qty: 1 }],
      userId: Number(userId),
      managerPassword: DEFAULT_MANAGER_PASSWORD,
      overrideReason: 'atomic temporary void race test'
    })
    send({ ok: true, returnId: result.id })
  } else {
    const result = await salesService.createReturn({
      invoiceId: Number(invoiceId), full: false,
      lines: [{ saleItemId: Number(saleItemId), qty: 1 }],
      refundMethod: 'NONE', note: 'concurrent new return',
      userId: Number(userId), shiftId: Number(shiftId),
      idempotencyKey: 'return-request:edit-race-create-0001'
    }, { requireIdempotencyKey: true })
    send({ ok: true, returnId: result.id, replayed: result.replayed === true })
  }
} catch (error) {
  send({ ok: false, error: String(error?.message ?? error), code: error?.code ?? null })
}
