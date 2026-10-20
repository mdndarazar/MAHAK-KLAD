/** Upgrade a COPY of an installed pre-source-ledger database with old physical
 * receipts. No backfill, rewrites or shop database; transactional failure and
 * startup rerun are checked through the real migration runner.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-receipt-source-upgrade.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.cwd()
const stage = '20271020620000_return_goods_receipt_sources'
const stages = [
  '20271020620000_return_goods_receipt_sources',
  '20271020630000_exchange_funding_events',
  '20271020640000_exchange_funding_line_allocations',
  '20271020650000_exchange_funding_return_line_allocations',
  '20271020660000_sale_return_item_scope_quantity_guards',
  '20271020670000_sale_return_request_idempotency',
  '20271020680000_sale_invoice_item_quantity_domain_guard'
]
const allNames = readdirSync(join(root, 'prisma/migrations'))
  .filter((n) => n !== 'migration_lock.toml').sort()
const older = allNames.filter((n) => n < stage)
assert.deepEqual(allNames.filter((n) => n >= stage), stages, 'extend this upgrade test when another migration is added')
const dir = mkdtempSync(join(tmpdir(), 'mahak-receipt-upgrade-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'unused-runner.db')
const oldPath = join(dir, 'installed-resources', 'prisma', 'migrations')
for (const n of older) {
  mkdirSync(join(oldPath, n), { recursive: true })
  writeFileSync(join(oldPath, n, 'migration.sql'), readFileSync(join(root, 'prisma/migrations', n, 'migration.sql')))
}
const { applyMigrations } = await import('../../src/main/db/migrator.ts')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { introspect } = await import('../../test/harness/schema.mjs')
const { toJalaliDate } = await import('@shared/jalali')
const file = join(dir, 'installed-before-source-ledger.db')
const open = (path) => {
  const db = new DatabaseSync(path)
  const client = {
    async $executeRawUnsafe(query, ...p) { return db.prepare(query).run(...p).changes },
    async $queryRawUnsafe(query, ...p) { return db.prepare(query).all(...p) }
  }
  return { db, client }
}
const installed = open(file)
const resourcesBefore = process.resourcesPath
try {
  process.resourcesPath = join(dir, 'installed-resources')
  const report = await applyMigrations(installed.client, file, { touchFile: false })
  assert.deepEqual(report.applied, older)
  assert.deepEqual(report.skipped, [])
} finally {
  if (resourcesBefore === undefined) delete process.resourcesPath
  else process.resourcesPath = resourcesBefore
}
const seed = makeSeeder({ $harness: { db: installed.db, tables: introspect(installed.db) } })
const day = toJalaliDate(new Date())
const userId = seed.user('installed receipt clerk')
const shiftId = seed.insert('Shift', { name: 'open shift', number: 1, userId,
  dayJalali: day, openedAt: Date.now() - 10_000 })
const category = seed.category('historic physical receipt')
const warehouseVariant = seed.variant(seed.product('old branch item', category))
const retailVariant = seed.variant(seed.product('old store item', category))
const code = seed.one('SELECT code FROM \"ProductVariant\" WHERE id=?', warehouseVariant).code
const house = seed.insert('SecondaryWarehouse', { name: 'old branch', isActive: 1 })
const stockRow = seed.insert('SecondaryStockItem', { name: 'old row', code, warehouseId: house, qty: 2 })
seed.insert('SecondaryStockLog', { itemId: stockRow, warehouseId: house, name: 'old row', code,
  warehouseName: 'old branch', action: 'SALE_WHOLESALE_RESTORE', qtyBefore: 0, qtyAfter: 2, delta: 2 })
const sale = seed.insert('SaleInvoice', { receiptNo: 920001, orderType: 'WHOLESALE',
  userId, shiftId, issuedAtJalali: day, grandTotal: 200, paidTotal: 0 })
const saleItemId = seed.insert('SaleInvoiceItem', { invoiceId: sale, variantId: warehouseVariant,
  qty: 2, unitPrice: 100, lineTotal: 200 })
const ret = seed.insert('SaleReturn', { invoiceId: sale, kind: 'RETURN', userId, shiftId,
  returnedAtJalali: day, total: 200, refundMethod: 'NONE', refundAmount: 0,
  goodsReceiptRequired: 1, restockPending: 0 })
const retItem = seed.insert('SaleReturnItem', { returnId: ret, saleItemId, variantId: warehouseVariant,
  qty: 2, restockedQty: 2, unitPrice: 100, lineTotal: 200 })
const receipts = [1, 2].map((n) => seed.insert('ReturnGoodsReceipt', {
  eventKey: `installed-branch-receipt-${n}`, returnId: ret, returnItemId: retItem,
  variantId: warehouseVariant, qty: 1, actorUserId: userId,
  witnessKind: 'SCAN', witnessRef: code
}))
const allocationId = seed.insert('SaleItemStockAllocation', { invoiceId: sale, saleItemId,
  variantId: warehouseVariant, sourceKind: 'WAREHOUSE', warehouseId: house, warehouseName: 'old branch',
  qty: 2, restoredQty: 2,
  rowDetails: JSON.stringify([{ id: stockRow, name: 'old row', code, taken: 2, remaining: 0 }]) })
// A different, old store-only receipt can still be reconciled without inventing
// a warehouse. It has no invoice source ledger at all.
installed.db.prepare('UPDATE \"ProductVariant\" SET stock=5 WHERE id=?').run(retailVariant)
const retailSale = seed.insert('SaleInvoice', { receiptNo: 920002, userId, shiftId,
  issuedAtJalali: day, grandTotal: 100, paidTotal: 0 })
const retailItem = seed.insert('SaleInvoiceItem', { invoiceId: retailSale, variantId: retailVariant,
  qty: 1, unitPrice: 100, lineTotal: 100 })
const retailRet = seed.insert('SaleReturn', { invoiceId: retailSale, kind: 'RETURN', userId, shiftId,
  returnedAtJalali: day, total: 100, refundMethod: 'NONE', refundAmount: 0,
  goodsReceiptRequired: 1, restockPending: 0 })
const retailRetItem = seed.insert('SaleReturnItem', { returnId: retailRet, saleItemId: retailItem,
  variantId: retailVariant, qty: 1, restockedQty: 1, unitPrice: 100, lineTotal: 100 })
seed.insert('ReturnGoodsReceipt', { eventKey: 'installed-store-receipt', returnId: retailRet,
  returnItemId: retailRetItem, variantId: retailVariant, qty: 1, actorUserId: userId,
  witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'seen by clerk' })
const read = (db, query, ...p) => db.prepare(query).all(...p).map((r) => ({ ...r }))
const before = (db) => ({
  invoices: read(db, 'SELECT id, receiptNo, grandTotal, paidTotal FROM \"SaleInvoice\" ORDER BY id'),
  returns: read(db, 'SELECT id, invoiceId, goodsReceiptRequired, restockPending, total FROM \"SaleReturn\" ORDER BY id'),
  items: read(db, 'SELECT id, returnId, qty, restockedQty FROM \"SaleReturnItem\" ORDER BY id'),
  receipts: read(db, 'SELECT id, eventKey, returnId, returnItemId, qty, witnessRef FROM \"ReturnGoodsReceipt\" ORDER BY id'),
  allocations: read(db, 'SELECT id, saleItemId, sourceKind, warehouseId, qty, restoredQty, rowDetails FROM \"SaleItemStockAllocation\"'),
  physical: read(db, 'SELECT id, warehouseId, qty FROM \"SecondaryStockItem\" WHERE id=?', stockRow),
  retailStock: read(db, 'SELECT id, stock FROM \"ProductVariant\" WHERE id=?', retailVariant),
  logs: read(db, 'SELECT id, itemId, action, delta FROM \"SecondaryStockLog\"')
})
const snapshot = before(installed.db)
const copy = join(dir, 'upgrade-copy.db')
const corrupt = join(dir, 'corrupt-copy.db')
copyFileSync(file, copy)
copyFileSync(file, corrupt)
const broken = open(corrupt)
broken.db.exec('CREATE TABLE \"ReturnGoodsReceiptSource\" (\"id\" INTEGER PRIMARY KEY)')
await assert.rejects(() => applyMigrations(broken.client, corrupt, { touchFile: false }),
  (e) => e.message.includes(stage) && e.message.includes('نسخه‌ی پشتیبان'))
assert.equal(read(broken.db, 'SELECT COUNT(*) n FROM \"_prisma_migrations\" WHERE migration_name=?', stage)[0].n, 0)
assert.deepEqual(before(broken.db), snapshot)
assert.equal(read(broken.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
broken.db.close()
const upgraded = open(copy)
const report = await applyMigrations(upgraded.client, copy, { touchFile: false })
assert.deepEqual(report.applied, stages)
assert.deepEqual(report.skipped, [])
assert.deepEqual(before(upgraded.db), snapshot, 'upgrade never edits old inventory, returns, allocations, credits or receipts')
assert.deepEqual(read(upgraded.db, 'SELECT * FROM \"ReturnGoodsReceiptSource\"'), [], 'historic receipts are not backfilled with guessed sources')
assert.deepEqual(read(upgraded.db, 'SELECT * FROM \"ExchangeFundingEvent\"'), [], 'historic payment rows are not backfilled with guessed funding shares')
assert.deepEqual(read(upgraded.db, 'SELECT * FROM "ExchangeFundingLineAllocation"'), [],
  'historic exchange invoices are not assigned guessed source-to-item allocations')
assert.equal(read(upgraded.db, 'SELECT COUNT(*) n FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL')[0].n, allNames.length)
assert.deepEqual(read(upgraded.db, 'PRAGMA foreign_key_check'), [])
assert.equal(read(upgraded.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
const replay = await applyMigrations(upgraded.client, copy, { touchFile: false })
assert.deepEqual(replay.applied, [])
assert.deepEqual(replay.skipped, [])
assert.deepEqual(before(upgraded.db), snapshot)
installed.db.close()
upgraded.db.close()
// Separate process: migrator imports a DB client at module load; the runtime
// service must instead open the upgraded COPY, not the throwaway runner DB.
const child = execFileSync(process.execPath,
  ['--import', './test/harness/register.mjs', 'tests/audit-fixes/support/receipt-source-upgrade-guard.mjs',
    String(ret), String(retailRet), String(stockRow), String(allocationId), String(retailVariant)],
  { cwd: root, env: { ...process.env, HARNESS_DB: copy, HARNESS_DB_EXISTING: '1' }, timeout: 120000,
    encoding: 'utf8' })
assert.match(child, /legacy warehouse receipt blocked/)
assert.match(child, /store-only historic receipt compensated/)
const original = open(file)
assert.deepEqual(before(original.db), snapshot, 'original installed fixture remains untouched')
original.db.close()
console.log(`✓ installed ${older.length}-stage DB upgraded on COPY by ${stages.join(' + ')}; old receipts untouched; conflicting copy rolled back; restart idempotent; old warehouse source blocked without guess`)
