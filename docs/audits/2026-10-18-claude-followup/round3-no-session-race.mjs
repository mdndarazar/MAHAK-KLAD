import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2] ?? 'no-session'
const dir = mkdtempSync(join(tmpdir(), `no-session-${mode}-`))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')

const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { salesService } = await import('../../src/main/services/SalesService.ts')
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
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const manager = seed.user('manager')
const giver = seed.user('giver')
const receiver = seed.user('receiver')
const category = seed.category('category')
for (const id of [giver, receiver]) sql.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', id)

await custodyService.setPin({ userId: manager, currentPassword: PW, newPassword: 'Manager460!' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager460!' })
for (const [id, temporary, permanent] of [[giver, 'GiverTemp460!', 'GiverFinal460!'], [receiver, 'RecvTemp460!', 'RecvFinal460!']]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager, managerPassword: 'Manager460!', reason: 'midday permission setup' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: permanent })
}
await settingsService.saveCustodySchedulingWorkflow({
  shift: { ...(await settingsService.shiftConfig()), custodyMode: 'SINGLE_SHIFT', singleShiftCustodianUserId: giver, singleShiftAllowMidDayHandover: true },
  reason: 'explicit midday permission for custody test', managerUserId: manager, managerPassword: 'Manager460!'
})
const opened = await custodyService.open({ userId: giver, password: 'GiverFinal460!', operationalTotal: 0 })
const product = seed.product('item', category)
const variant = seed.variant(product)
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
const snapshot = () => ({ corrections: seed.count('ReturnCorrection'), effects: seed.count('ReturnCorrectionEffect'), movements: seed.count('CashMovement'), stock: Number(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?', variant).stock), shifts: seed.rows('SELECT id,closedAt,userId FROM "Shift" ORDER BY id'), state: seed.one('SELECT state,activeShiftId FROM "CustodyState" WHERE key=?', 'MAIN') })
let finalClose = null
let correction = null
if (mode === 'no-session') {
  finalClose = await custodyService.finalClose({ password: 'RecvFinal460!', operationalTotal: 0 })
  const before = snapshot()
  correction = { result: await invoke(IPC.saleReturnCorrection, payload), before, after: snapshot() }
} else if (mode === 'race') {
  const originalShiftForNow = shiftService.shiftForNow
  let release
  let resolveReached
  const reached = new Promise(resolve => { resolveReached = resolve })
  const gate = new Promise(resolve => { release = resolve })
  shiftService.shiftForNow = async (...args) => {
    const actual = await originalShiftForNow.apply(shiftService, args)
    resolveReached(actual)
    await gate
    return actual
  }
  try {
    const pending = invoke(IPC.saleReturnCorrection, payload)
    const actual = await reached
    const beforeClose = snapshot()
    finalClose = await custodyService.finalClose({ password: 'RecvFinal460!', operationalTotal: 0 })
    const afterClose = snapshot()
    release()
    correction = { result: await pending, actualShift: actual?.id ?? null, beforeClose, afterClose, after: snapshot() }
  } finally {
    release()
    shiftService.shiftForNow = originalShiftForNow
  }
} else {
  throw new Error(`unknown mode: ${mode}`)
}
const expected = async shiftId => { const value = await cashboxService.expected({ shiftId }); return { expectedCash: Number(value.expectedCash), components: value.components } }
console.log(JSON.stringify({ mode, opened, handover, finalClose, correction, final: { ...snapshot(), expectedOld: await expected(opened.shiftId), expectedNew: await expected(handover.shiftId), returnRows: seed.rows('SELECT id,shiftId,refundAmount,voidedAt FROM "SaleReturn" ORDER BY id'), effects: seed.rows('SELECT correctionId,type,amount,shiftId,cashMovementId FROM "ReturnCorrectionEffect" ORDER BY id'), movements: seed.rows('SELECT type,amount,shiftId,occurredAt,refType,refId FROM "CashMovement" ORDER BY id') } }))
