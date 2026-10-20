/** Renderer-supplied flags cannot disable the new receipt protocol. Test the
 * actual Main IPC path, session actor, ordinary non-bank goods intake, and UI
 * reachability for returns/exchanges without a card-transfer request.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-goods-ipc-cutover.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-goods-ipc-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 61001, isDestroyed: () => false, once: () => {} }
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
const { PANEL_KEYS } = await import('@shared/panels')
const { SETTING_KEYS } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('real cashier')
const cat = seed.category('ipc goods')
const product = seed.product('witnessed item', cat)
const variantId = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=10, salePrice=100 WHERE id=?').run(variantId)
const shiftId = seed.insert('Shift', { name: 'cashier', number: 1, userId,
  openedAt: Date.now() - 10_000, dayJalali: toJalaliDate(new Date()) })
seed.setting(SETTING_KEYS.panelLocks, { [PANEL_KEYS.salesReturn]: false })
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const sale = await salesService.create({ userId, shiftId,
  lines: [{ variantId, qty: 1, unitPrice: 100, discount: 0, tax: 0 }], payments: [] })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.id).id
const result = await invoke(IPC.saleReturn, { invoiceId: sale.id, full: true,
  lines: [{ saleItemId, qty: 1 }], refundMethod: 'NONE',
  idempotencyKey: 'return-request:goods-ipc-cutover-0001',
  userId: 999_999, goodsReceiptRequired: false,
  protocol: { goodsReceiptRequired: false } })
assert.equal(result.ok, true, JSON.stringify(result))
const ret = result.data
assert.equal(ret.goodsReceiptRequired, true)
assert.equal(ret.restockPending, true)
assert.equal(seed.one('SELECT goodsReceiptRequired FROM "SaleReturn" WHERE id=?', ret.id).goodsReceiptRequired, 1)
assert.equal(seed.one('SELECT userId FROM "SaleReturn" WHERE id=?', ret.id).userId, userId)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock, 9)
const goods = await invoke(IPC.returnGoodsItems, { returnId: ret.id })
assert.equal(goods.ok, true)
assert.equal(goods.data.managed, true)
assert.equal(goods.data.items[0].pending, 1)
const witness = await invoke(IPC.returnGoodsReceive, { returnId: ret.id, returnItemId: goods.data.items[0].id,
  qty: 1, eventKey: 'ipc-noncard-witness-unique', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'یک کالا واقعاً تحویل شد', physicalConfirmed: true,
  actorUserId: 999_999 })
assert.equal(witness.ok, true, JSON.stringify(witness))
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variantId).stock, 10)
assert.equal(seed.one('SELECT actorUserId FROM "ReturnGoodsReceipt" WHERE id=?', witness.data.id).actorUserId, userId)
assert.equal(seed.one('SELECT COUNT(*) n FROM "ReturnEntitlement" WHERE returnId=?', ret.id).n, 0)
console.log('✓ live IPC NONE: forged protocol/actor ignored, authenticated goods receipt moves stock once')
const root = resolve(new URL('../../', import.meta.url).pathname)
const ui = readFileSync(join(root, 'src/renderer/src/pages/SalesReturn.tsx'), 'utf8')
const intake = readFileSync(join(root, 'src/renderer/src/components/ReturnGoodsIntake.tsx'), 'utf8')
assert.match(ui, /retResult\.restockPending\s*&&\s*retResult\.goodsReceiptRequired/)
assert.match(ui, /exResult\.restockPending/)
assert.match(ui, /exResult\.goodsReceiptRequired/)
assert.match(ui, /r\.corrected/)
assert.match(intake, /!goods\.corrected/)
console.log('✓ cashier can reach non-bank return/exchange intake; corrected paper cannot show action')
