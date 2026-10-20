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
  '20271020680000_sale_invoice_item_quantity_domain_guard',
  '20271020690000_safe_integer_return_quantity_domain_guard',
  '20271020700000_validate_sale_return_history',
  '20271020710000_guard_active_return_deletion',
  '20271020720000_guard_exchange_return_line_reversals',
  '20271020730000_guard_exchange_return_line_allocation_scope',
  '20271020740000_guard_exchange_return_line_cumulative_snapshots',
  '20271020750000_guard_exchange_funding_event_immutability',
  '20271020760000_guard_exchange_funding_event_reversals',
  '20271020770000_guard_allocated_return_physical_snapshots'
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
const corruptQuantity = join(dir, 'corrupt-quantity-copy.db')
const corruptUnsafeQuantity = join(dir, 'corrupt-unsafe-quantity-copy.db')
const corruptReturnQuantity = join(dir, 'corrupt-return-quantity-copy.db')
const corruptReturnScope = join(dir, 'corrupt-return-scope-copy.db')
const corruptReturnVariant = join(dir, 'corrupt-return-variant-copy.db')
const corruptReturnCap = join(dir, 'corrupt-return-cap-copy.db')
copyFileSync(file, copy)
copyFileSync(file, corrupt)
copyFileSync(file, corruptQuantity)
copyFileSync(file, corruptUnsafeQuantity)
copyFileSync(file, corruptReturnQuantity)
copyFileSync(file, corruptReturnScope)
copyFileSync(file, corruptReturnVariant)
copyFileSync(file, corruptReturnCap)
const badQuantityDb = open(corruptQuantity)
badQuantityDb.db.prepare(`INSERT INTO "SaleInvoiceItem"
  (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
  VALUES (?, ?, 1.5, 100, 0, 0, 150)`).run(retailSale, retailVariant)
await assert.rejects(() => applyMigrations(badQuantityDb.client, corruptQuantity, { touchFile: false }),
  (e) => e.message.includes('20271020690000_safe_integer_return_quantity_domain_guard') && e.message.includes('نسخه‌ی پشتیبان'),
  'upgrading an installed DB with fractional historical sold quantity must fail closed')
assert.equal(read(badQuantityDb.db, 'SELECT COUNT(*) n FROM "_prisma_migrations" WHERE migration_name=? AND finished_at IS NOT NULL',
  '20271020690000_safe_integer_return_quantity_domain_guard')[0].n, 0,
'corrupt quantity migration failure must not be recorded as finished')
assert.equal(read(badQuantityDb.db, 'SELECT qty FROM "SaleInvoiceItem" WHERE invoiceId=? AND qty=1.5', retailSale).length, 1,
'failed migration does not rewrite or silently round an invalid historical quantity')
assert.equal(read(badQuantityDb.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
badQuantityDb.db.close()
const badUnsafeQuantityDb = open(corruptUnsafeQuantity)
badUnsafeQuantityDb.db.prepare(`INSERT INTO "SaleInvoiceItem"
  (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
  VALUES (?, ?, 9007199254740992, 100, 0, 0, 0)`).run(retailSale, retailVariant)
await assert.rejects(() => applyMigrations(badUnsafeQuantityDb.client, corruptUnsafeQuantity, { touchFile: false }),
  (e) => e.message.includes('20271020690000_safe_integer_return_quantity_domain_guard') && e.message.includes('نسخه‌ی پشتیبان'),
  'upgrading an installed DB with a historical quantity beyond MAX_SAFE_INTEGER must fail closed')
assert.equal(read(badUnsafeQuantityDb.db, 'SELECT COUNT(*) n FROM "_prisma_migrations" WHERE migration_name=? AND finished_at IS NOT NULL',
  '20271020690000_safe_integer_return_quantity_domain_guard')[0].n, 0,
'unsafe quantity migration failure must not be recorded as finished')
assert.equal(read(badUnsafeQuantityDb.db, 'SELECT CAST(qty AS TEXT) AS qty FROM "SaleInvoiceItem" WHERE invoiceId=? AND qty=9007199254740992', retailSale)[0].qty,
  '9007199254740992', 'failed migration preserves the exact historical out-of-range value for reconciliation')
assert.equal(read(badUnsafeQuantityDb.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
badUnsafeQuantityDb.db.close()
const badReturnQuantityDb = open(corruptReturnQuantity)
badReturnQuantityDb.db.prepare('UPDATE "SaleReturnItem" SET qty=1.5 WHERE id=?').run(retailRetItem)
await assert.rejects(() => applyMigrations(badReturnQuantityDb.client, corruptReturnQuantity, { touchFile: false }),
  (e) => e.message.includes('20271020690000_safe_integer_return_quantity_domain_guard') && e.message.includes('نسخه‌ی پشتیبان'),
  'upgrading an installed DB with fractional historical return quantity must fail closed')
assert.equal(read(badReturnQuantityDb.db, 'SELECT COUNT(*) n FROM "_prisma_migrations" WHERE migration_name=? AND finished_at IS NOT NULL',
  '20271020690000_safe_integer_return_quantity_domain_guard')[0].n, 0,
'corrupt return quantity migration failure must not be recorded as finished')
assert.equal(read(badReturnQuantityDb.db, 'SELECT qty FROM "SaleReturnItem" WHERE id=? AND qty=1.5', retailRetItem).length, 1,
'failed migration does not rewrite or silently round an invalid historical return quantity')
assert.equal(read(badReturnQuantityDb.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
badReturnQuantityDb.db.close()
const badReturnScopeDb = open(corruptReturnScope)
const badScopeReturnId = Number(badReturnScopeDb.db.prepare(`INSERT INTO "SaleReturn"
  (invoiceId, returnedAtJalali, kind, refundMethod, refundAmount)
  VALUES (?, ?, 'RETURN', 'NONE', 0)`).run(retailSale, day).lastInsertRowid)
const badScopeReturnItemId = Number(badReturnScopeDb.db.prepare(`INSERT INTO "SaleReturnItem"
  (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
  VALUES (?, ?, ?, 1, 100, 100)`).run(badScopeReturnId, saleItemId, warehouseVariant).lastInsertRowid)
await assert.rejects(() => applyMigrations(badReturnScopeDb.client, corruptReturnScope, { touchFile: false }),
  (e) => e.message.includes('20271020700000_validate_sale_return_history') && e.message.includes('نسخه‌ی پشتیبان'),
  'upgrading an installed DB with a return item linked to another invoice must fail closed')
assert.equal(read(badReturnScopeDb.db, 'SELECT COUNT(*) n FROM "_prisma_migrations" WHERE migration_name=? AND finished_at IS NOT NULL',
  '20271020700000_validate_sale_return_history')[0].n, 0,
'bad invoice scope migration failure must not be recorded as finished')
assert.equal(Number(read(badReturnScopeDb.db, 'SELECT COUNT(*) n FROM "SaleReturnItem" WHERE id=?', badScopeReturnItemId)[0].n), 1,
'failed scope validation preserves the source row for reconciliation')
assert.equal(read(badReturnScopeDb.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
badReturnScopeDb.db.close()
const badReturnVariantDb = open(corruptReturnVariant)
const badVariantReturnId = Number(badReturnVariantDb.db.prepare(`INSERT INTO "SaleReturn"
  (invoiceId, returnedAtJalali, kind, refundMethod, refundAmount)
  VALUES (?, ?, 'RETURN', 'NONE', 0)`).run(retailSale, day).lastInsertRowid)
const badVariantReturnItemId = Number(badReturnVariantDb.db.prepare(`INSERT INTO "SaleReturnItem"
  (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
  VALUES (?, ?, ?, 1, 100, 100)`).run(badVariantReturnId, retailItem, warehouseVariant).lastInsertRowid)
await assert.rejects(() => applyMigrations(badReturnVariantDb.client, corruptReturnVariant, { touchFile: false }),
  (e) => e.message.includes('20271020700000_validate_sale_return_history') && e.message.includes('نسخه‌ی پشتیبان'),
  'upgrading an installed DB with a return item variant mismatch must fail closed')
assert.equal(read(badReturnVariantDb.db, 'SELECT COUNT(*) n FROM "_prisma_migrations" WHERE migration_name=? AND finished_at IS NOT NULL',
  '20271020700000_validate_sale_return_history')[0].n, 0,
'bad variant scope migration failure must not be recorded as finished')
assert.equal(Number(read(badReturnVariantDb.db, 'SELECT COUNT(*) n FROM "SaleReturnItem" WHERE id=?', badVariantReturnItemId)[0].n), 1,
'failed variant validation preserves historical evidence')
assert.equal(read(badReturnVariantDb.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
badReturnVariantDb.db.close()
const badReturnCapDb = open(corruptReturnCap)
badReturnCapDb.db.prepare(`INSERT INTO "ReturnCorrection"
  (returnId, kind, status, reason, correctingUserId, correctingShiftId, originalDayJalali, operationalDayJalali)
  VALUES (?, 'VOID_RECONCILIATION', 'POSTED', 'correction does not void physical return', ?, ?, ?, ?)`)
  .run(retailRet, userId, shiftId, day, day)
const overCapReturnId = Number(badReturnCapDb.db.prepare(`INSERT INTO "SaleReturn"
  (invoiceId, returnedAtJalali, kind, refundMethod, refundAmount)
  VALUES (?, ?, 'RETURN', 'NONE', 0)`).run(retailSale, day).lastInsertRowid)
const overCapReturnItemId = Number(badReturnCapDb.db.prepare(`INSERT INTO "SaleReturnItem"
  (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
  VALUES (?, ?, ?, 1, 100, 100)`).run(overCapReturnId, retailItem, retailVariant).lastInsertRowid)
await assert.rejects(() => applyMigrations(badReturnCapDb.client, corruptReturnCap, { touchFile: false }),
  (e) => e.message.includes('20271020700000_validate_sale_return_history') && e.message.includes('نسخه‌ی پشتیبان'),
  'upgrading an installed DB with active return quantity above sold quantity must fail closed')
assert.equal(read(badReturnCapDb.db, 'SELECT COUNT(*) n FROM "_prisma_migrations" WHERE migration_name=? AND finished_at IS NOT NULL',
  '20271020700000_validate_sale_return_history')[0].n, 0,
'over-cap migration failure must not be recorded as finished')
assert.equal(Number(read(badReturnCapDb.db, 'SELECT COUNT(*) n FROM "SaleReturnItem" WHERE id=?', overCapReturnItemId)[0].n), 1,
'failed active-cap validation preserves historical evidence')
assert.equal(read(badReturnCapDb.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok')
badReturnCapDb.db.close()
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
const upgradedNoReturnItemId = Number(upgraded.db.prepare(`INSERT INTO "SaleInvoiceItem"
  (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
  VALUES (?, ?, 1, 100, 0, 0, 100)`).run(retailSale, retailVariant).lastInsertRowid)
assert.throws(() => upgraded.db.prepare('UPDATE "SaleInvoiceItem" SET qty=1.5 WHERE id=?')
  .run(upgradedNoReturnItemId), /sale invoice item quantity/,
'upgraded databases enforce sold-quantity domain on an item without returns')
assert.throws(() => upgraded.db.prepare(`INSERT INTO "SaleInvoiceItem"
  (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
  VALUES (?, ?, 1.5, 100, 0, 0, 150)`).run(retailSale, retailVariant), /sale invoice item quantity/,
'upgraded databases reject fractional sold quantity on insert')
assert.throws(() => upgraded.db.prepare('UPDATE "SaleInvoiceItem" SET qty=9007199254740992 WHERE id=?')
  .run(upgradedNoReturnItemId), /sale invoice item quantity/,
'upgraded databases reject sold quantities outside the JavaScript exact-integer range')
assert.throws(() => upgraded.db.prepare(`INSERT INTO "SaleInvoiceItem"
  (invoiceId, variantId, qty, unitPrice, discount, tax, lineTotal)
  VALUES (?, ?, 9007199254740992, 100, 0, 0, 0)`).run(retailSale, retailVariant),
/sale invoice item quantity/,
'upgraded databases reject unsafe sold quantities on insert')
const upgradedOverCapReturnId = Number(upgraded.db.prepare(`INSERT INTO "SaleReturn"
  (invoiceId, returnedAtJalali, kind, refundMethod, refundAmount)
  VALUES (?, ?, 'RETURN', 'NONE', 0)`).run(retailSale, day).lastInsertRowid)
assert.throws(() => upgraded.db.prepare(`INSERT INTO "SaleReturnItem"
  (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
  VALUES (?, ?, ?, 1, 100, 100)`).run(upgradedOverCapReturnId, retailItem, retailVariant),
/active sale return quantity exceeds sold quantity/,
'upgraded databases enforce the active return cap on a second physical return')
const upgradedVoidedReturnId = Number(upgraded.db.prepare(`INSERT INTO "SaleReturn"
  (invoiceId, returnedAtJalali, kind, refundMethod, refundAmount, voidedAt)
  VALUES (?, ?, 'RETURN', 'NONE', 0, ?)`).run(retailSale, day, Date.now()).lastInsertRowid)
assert.throws(() => upgraded.db.prepare(`INSERT INTO "SaleReturnItem"
  (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
  VALUES (?, ?, ?, 9007199254740992, 100, 100)`)
  .run(upgradedVoidedReturnId, upgradedNoReturnItemId, retailVariant),
/sale return item quantity/,
'upgraded databases reject unsafe quantity even in a voided historical row')
const upgradedSafeReturnItemId = Number(upgraded.db.prepare(`INSERT INTO "SaleReturnItem"
  (returnId, saleItemId, variantId, qty, unitPrice, lineTotal)
  VALUES (?, ?, ?, 1, 100, 100)`)
  .run(upgradedVoidedReturnId, upgradedNoReturnItemId, retailVariant).lastInsertRowid)
assert.throws(() => upgraded.db.prepare('UPDATE "SaleReturnItem" SET qty=9007199254740992 WHERE id=?')
  .run(upgradedSafeReturnItemId), /sale return item quantity/,
'upgraded databases reject unsafe returned quantity on update')
assert.throws(() => upgraded.db.prepare('DELETE FROM "SaleReturnItem" WHERE id=?').run(retailRetItem),
  /active sale return item deletion/,
'upgraded databases preserve active return-item evidence against direct deletion')
assert.throws(() => upgraded.db.prepare('DELETE FROM "SaleReturn" WHERE id=?').run(retailRet),
  /active sale return deletion/,
'upgraded databases preserve active return parent and cascade evidence against deletion')
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
