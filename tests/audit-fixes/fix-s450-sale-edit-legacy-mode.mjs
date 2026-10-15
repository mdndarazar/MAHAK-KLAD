/**
 * A sale edit with custody never configured remains unchanged: no PIN/fence
 * requirement is introduced for the ordinary legacy session.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s450-sale-edit-legacy-mode.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-legacy-edit-s450-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) { assert.deepEqual(actual, expected, label); checks++; console.log(`  ✓ ${label}`) }
const user = seed.user('مدیرِ شیفت قدیمی S450')
const product = seed.product('کالای قدیمی S450'), variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=?, salePrice=? WHERE id=?').run(10, 1_000_000, variant)
const line = (qty) => ({ variantId: variant, qty, unitPrice: 1_000_000, discount: 0, tax: 0 })
eq('custody has never been configured', await custodyService.isGoverned(), false)
const invoice = await salesService.create({ userId: user, deductInventory: true, lines: [line(1)], payments: [] })
eq('legacy invoice stock decreases', seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant)?.stock, 9)
eq('ordinary legacy session remains outside governed custody', await custodyService.isGoverned(), false)
const changed = await salesService.update({ id: invoice.id, userId: user, shiftId: invoice.shiftId,
  keepPayments: true, lines: [line(2)] })
eq('legacy sale edit succeeds without a custody fence', [changed.id, Number(changed.grandTotal)], [invoice.id, 2_000_000])
eq('legacy edit has exactly the same stock delta', seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant)?.stock, 8)
eq('legacy edit keeps owner and shift', seed.one('SELECT userId,shiftId FROM "SaleInvoice" WHERE id=?', invoice.id),
  { userId: user, shiftId: invoice.shiftId })
eq('legacy edit did not start a custody handover or lock the drawer', seed.one('SELECT state FROM "CustodyState" WHERE key=?', 'MAIN')?.state, 'NO_SESSION')

// The form witness is exclusively for governed custody. The ordinary IPC edit
// keeps working with an active legacy staff session and no token at all.
const { toJalaliDate } = await import('@shared/jalali')
seed.insert('Shift', { name: 'نشست قدیمی', number: 1, dayJalali: toJalaliDate(new Date()),
  openedAt: Date.now() - 3600_000, userId: user, staffConfirmed: 1 })
const electron = await import('electron'), handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 4509, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const form = await invoke(IPC.saleGet, { id: invoice.id, forEdit: true })
eq('legacy edit form opens without a token', [form.ok, 'editFormToken' in form.data], [true, false])
const ipcEdit = await invoke(IPC.saleUpdate, { id: invoice.id, keepPayments: true, lines: [line(3)] })
eq('legacy IPC edit succeeds without a token', ipcEdit.ok, true)
eq('legacy IPC edit uses the same stock delta', seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant)?.stock, 7)
eq('legacy IPC edit preserves invoice owner', seed.one('SELECT userId,shiftId FROM "SaleInvoice" WHERE id=?', invoice.id),
  { userId: user, shiftId: invoice.shiftId })
eq('legacy IPC edit does not create custody', await custodyService.isGoverned(), false)
console.log(`\n✓ ${checks} legacy edit checks passed`)
