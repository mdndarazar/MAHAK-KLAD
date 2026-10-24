// Deterministic race probe (temp copy only). Same setup as round3-no-session-race.mjs;
// race branch fixed so the gate cannot hang if the hook is never reached.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode = process.argv[2] ?? 'race'
const dir = mkdtempSync(join(tmpdir(), `race2-${mode}-`))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const watchdog = setTimeout(()=>{ console.log(JSON.stringify({mode, watchdog:'timeout 20s'})); process.exit(2) }, 20000)
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { shiftService } = await import('../../src/main/services/ShiftService.ts')
const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
const { DEFAULT_MANAGER_PASSWORD: PW, SETTING_KEYS } = await import('@shared/receipt')
const { PANEL_KEYS } = await import('@shared/panels')
const { IPC } = await import('@shared/ipc')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 7901, isDestroyed: () => false, once: () => {} }
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const db = harnessClient(); const seed = makeSeeder(db); const sql = db.$harness.db
const manager = seed.user('manager'), giver = seed.user('giver'), receiver = seed.user('receiver'), category = seed.category('category')
for (const id of [giver, receiver]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)
await custodyService.setPin({ userId: manager, currentPassword: PW, newPassword: 'Manager460!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager460!' })
for (const [id, t, p] of [[giver, 'GiverTemp460!', 'GiverFinal460!'], [receiver, 'RecvTemp460!', 'RecvFinal460!']]) {
 await custodyService.setPin({ userId: id, newPassword: t, managerUserId: manager, managerPassword: 'Manager460!', reason: 'setup' })
 await custodyService.setPin({ userId: id, currentPassword: t, newPassword: p })
}
await settingsService.saveCustodySchedulingWorkflow({ shift: { ...(await settingsService.shiftConfig()), custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: giver, singleShiftAllowMidDayHandover: true }, reason: 'midday permission', managerUserId: manager, managerPassword: 'Manager460!' })
const opened = await custodyService.open({ userId: giver, password: 'GiverFinal460!', operationalTotal: 0 })
const product = seed.product('item', category); const variant = seed.variant(product)
sql.prepare('UPDATE "ProductVariant" SET stock=10,salePrice=1000000 WHERE id=?').run(variant)
const cash = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
seed.setting(SETTING_KEYS.panelLocks, { [PANEL_KEYS.salesReturn]: false })
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
registerIpcHandlers()
await invoke(IPC.managerPanelVerify, { panel: PANEL_KEYS.salesReturn, password: PW })
const sale = await invoke(IPC.saleCreate, { lines: [{ variantId: variant, qty: 1, unitPrice: 1000000, discount: 0, tax: 0 }], payments: [{ methodId: cash, amount: 1000000, destination: 'CASH' }], saleOperatorMode: 'OPERATOR_PIN', saleOperatorUserId: giver, saleOperatorPassword: 'GiverFinal460!', userId: 999, shiftId: 999, custodyFence: { epoch: 0 } })
const saleItemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=?', sale.data.id).id
const ret = await invoke(IPC.saleReturn, { invoiceId: sale.data.id, full: true, lines: [{ saleItemId, qty: 1 }], refundMethod: 'CASH', refundAmount: 1000000, userId: 999, goodsReceiptRequired: false, protocol: { goodsReceiptRequired: false } })
const goods = await invoke(IPC.returnGoodsItems, { returnId: ret.data.id })
await invoke(IPC.returnGoodsReceive, { returnId: ret.data.id, returnItemId: goods.data.items[0].id, qty: 1, eventKey: `goods-event-${mode}-unique`, witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'physical receipt witness', physicalConfirmed: true, userId: 999 })
let handover = await custodyService.handoverStart({ password: 'GiverFinal460!', operationalTotal: 0, toUserId: receiver, blueReference: true, idempotencyKey: `handover-${mode}` })
await custodyService.handoverCountBlue({ handoverId: handover.id, password: 'RecvFinal460!', operationalTotal: 0 })
handover = await custodyService.handoverConfirmBlue({ handoverId: handover.id, password: 'RecvFinal460!' })
const payload = { id: ret.data.id, reason: 'test correction after custody', panelPassword: PW, approverUserId: manager, approverPassword: 'Manager460!', cashRecovered: 600000, userId: 999, shiftId: 999, custodyFence: { epoch: 0 } }
const snapshot = () => ({ stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant).stock), corrections: seed.count('ReturnCorrection'), movements: seed.rows('SELECT id,type,amount,shiftId,occurredAt,refType,refId FROM "CashMovement" ORDER BY id'), shifts: seed.rows('SELECT id,closedAt,userId FROM "Shift" ORDER BY id'), state: seed.one('SELECT state,activeShiftId,epoch FROM "CustodyState" WHERE key=?', 'MAIN') })
const safe = async p => { try { return await p } catch (e) { return { thrown: String(e?.message ?? e).split('\n')[0], code: e?.code ?? null } } }
let out = {}
if (mode === 'control-no-race') {
 // sequential control: correction BEFORE finalClose (both should succeed, close must include it)
 const corr = await invoke(IPC.saleReturnCorrection, payload)
 const fc = await safe(custodyService.finalClose({ password: 'RecvFinal460!', operationalTotal: 600000 }))
 out = { corr, finalClose: fc, after: snapshot() }
} else if (mode === 'race') {
 const orig = shiftService.shiftForNow
 let release, resolveReached
 const reached = new Promise(r => { resolveReached = r }); const gate = new Promise(r => { release = r })
 let hookCalls = 0
 shiftService.shiftForNow = async (...args) => { hookCalls++; const actual = await orig.apply(shiftService, args); if (hookCalls === 1) { resolveReached(actual); await gate } return actual }
 try {
  const pending = invoke(IPC.saleReturnCorrection, payload)
  const first = await Promise.race([reached.then(a => ({ reached: true, shiftId: a?.id ?? null })), pending.then(r => ({ reached: false, earlyResult: r }))])
  if (!first.reached) { out = { first, hookCalls, note: 'operation finished/failed before reaching the gate' } }
  else {
   const beforeClose = snapshot()
   const fc = await safe(custodyService.finalClose({ password: 'RecvFinal460!', operationalTotal: 0 }))
   const afterClose = snapshot()
   release()
   const result = await pending
   out = { first, hookCalls, beforeClose, finalClose: fc, afterClose, correctionResult: result, after: snapshot() }
  }
 } finally { release(); shiftService.shiftForNow = orig }
}
const exp = async shiftId => { try { const v = await cashboxService.expected({ shiftId }); return Number(v.expectedCash) } catch (e) { return String(e?.message ?? e).split('\n')[0] } }
out.expectedCash = { oldShift: await exp(opened.shiftId), handoverShift: await exp(handover.shiftId) }
out.ids = { openedShift: opened.shiftId, handoverShift: handover.shiftId }
clearTimeout(watchdog)
console.log(JSON.stringify({ mode, ...out }))
