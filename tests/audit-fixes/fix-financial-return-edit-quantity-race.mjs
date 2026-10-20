/** A temporary in-transaction void in returnUpdate must never expose sold
 * quantity to a competing createReturn on another SQLite connection.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-return-edit-quantity-race.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-return-edit-race-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { toJalaliDate } = await import('@shared/jalali')

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('return edit race')
const categoryId = seed.category('return edit race')
const productId = seed.product('return edit race item', categoryId)
const variantId = seed.variant(productId, 'return edit race variant')
sql.prepare('UPDATE "ProductVariant" SET stock=5, salePrice=1000 WHERE id=?').run(variantId)
const now = new Date()
const today = toJalaliDate(now)
const shiftId = seed.insert('Shift', {
  name: 'return edit race shift', number: 1, userId,
  dayJalali: today, openedAt: now.getTime() - 10_000
})
const invoice = await salesService.create({
  userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 1000, discount: 0, tax: 0 }],
  payments: []
})
const saleItemId = Number(seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', invoice.id).id)
// Model a previously received physical return consistently: sale reduced stock
// to four, then this already-returned unit brought it back to five.
sql.prepare('UPDATE "ProductVariant" SET stock=5 WHERE id=?').run(variantId)
const returnId = seed.insert('SaleReturn', {
  invoiceId: invoice.id, total: 1000, returnedAt: now, returnedAtJalali: today,
  returnedAtTime: now.toTimeString().slice(0, 8), kind: 'RETURN', userId, shiftId,
  refundMethod: 'NONE', refundAmount: 0
})
seed.insert('SaleReturnItem', {
  returnId, saleItemId, variantId, qty: 1, unitPrice: 1000, lineTotal: 1000, restockedQty: 1
})
const stockBefore = Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock)

function startWorker(mode) {
  const child = spawn(process.execPath, [
    '--import', './test/harness/register.mjs',
    'tests/audit-fixes/helpers/return-edit-race-worker.mjs',
    mode, String(returnId), String(invoice.id), String(saleItemId), String(userId), String(shiftId)
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HARNESS_DB: process.env.HARNESS_DB, HARNESS_DB_EXISTING: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const queue = []
  const waiters = []
  let stderr = ''
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      console.log(`  worker(${mode}): ${JSON.stringify(message)}`)
      const index = waiters.findIndex((waiter) => waiter.predicate(message))
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
      else queue.push(message)
    } catch { /* ignore node warnings and diagnostics */ }
  })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const closed = new Promise((resolve, reject) => child.on('close', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`${mode} worker exited ${code}: ${stderr}`))
  }))
  return {
    child,
    send: (message) => child.stdin.write(`${message}\n`),
    finishInput: () => child.stdin.end(),
    waitFor(predicate) {
      const index = queue.findIndex(predicate)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0])
      return Promise.race([
        new Promise((resolve) => waiters.push({ predicate, resolve })),
        closed.then(() => { throw new Error(`${mode} worker exited without expected message: ${stderr}`) }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`${mode} worker did not emit an expected message within 20s: ${stderr}`))
          }, 20_000)
          timer.unref()
        })
      ])
    },
    closed
  }
}

const editor = startWorker('edit')
assert.deepEqual(await editor.waitFor((message) => message.ready === true), { ready: true })
editor.send('go')
assert.deepEqual(await editor.waitFor((message) => message.paused === true), { paused: true },
  'the editor is deliberately paused after setting voidedAt but before replacing rows')
// A separate connection still observes the committed active state while the
// editor holds its uncommitted temporary void inside BEGIN IMMEDIATE.
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', returnId).voidedAt, null)

const creator = startWorker('create')
assert.deepEqual(await creator.waitFor((message) => message.ready === true), { ready: true })
creator.send('go')
creator.finishInput()
assert.deepEqual(await creator.waitFor((message) => message.transactionAttempt === true), { transactionAttempt: true })
// Let the competing writer reach SQLite while the first transaction still owns
// its write lock, then commit the edit. The second request must re-check the
// now-active return and reject at the sold cap, not exploit the temporary void.
editor.send('continue')
editor.finishInput()
const [editResult, createResult] = await Promise.all([
  editor.waitFor((message) => typeof message.ok === 'boolean'),
  creator.waitFor((message) => typeof message.ok === 'boolean')
])
await Promise.all([editor.closed, creator.closed])
assert.equal(editResult.ok, true, JSON.stringify(editResult))
assert.equal(createResult.ok, false, JSON.stringify(createResult))
assert.match(createResult.error, /تعداد.*قابل برگشت|تعداد برگشتی|quantity exceeds sold quantity/iu)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE invoiceId=?', invoice.id).n, 1)
assert.equal(seed.one('SELECT voidedAt FROM "SaleReturn" WHERE id=?', returnId).voidedAt, null)
assert.equal(Number(seed.one(`SELECT COALESCE(SUM(ri.qty),0) AS qty FROM "SaleReturnItem" ri
  JOIN "SaleReturn" r ON r.id=ri.returnId WHERE ri.saleItemId=? AND r.voidedAt IS NULL`, saleItemId).qty), 1)
assert.equal(Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock), stockBefore)
assert.equal(seed.one('SELECT COUNT(*) n FROM "SaleReturn" WHERE idempotencyKey=?',
  'return-request:edit-race-create-0001').n, 0)

console.log('✓ atomic return edit never exposes its temporary void to a concurrent physical return')
