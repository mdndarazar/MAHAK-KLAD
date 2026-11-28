/**
 * دفتر آزمون ۴-۱۳۷ — با حضانت روشن و صندوقِ تحویل‌نشده، ثبت/ویرایش خرید و اصلاح موجودی همان قاعده و همان کد
 * (`CUSTODY_AUTH_REQUIRED`) را دارند، ولی پیام نام همان کار را می‌برد: «برای ثبت خرید، …»، «برای اصلاح موجودی، …».
 * پیام فروش و `CustodyService.ts` همان. پایگاه موقت و جدا (همان الگوی ابزار حجم).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
register(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-hooks.mjs').href, import.meta.url)
const mock = await import(pathToFileURL(REPO + '/tests/audit-fixes/support/s129-electron-mock.mjs').href)
const dir = mock.state.userData
mkdirSync(join(dir, 'data'), { recursive: true })
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'data', 'shop.db')
const handlers = new Map()
mock.ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
mock.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
const sender = { id: 777137, isDestroyed: () => false, once: () => {} }
const imp = (p) => import(pathToFileURL(REPO + p).href)

const { harnessClient } = await imp('/test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await imp('/test/harness/seed.mjs')
const { registerIpcHandlers } = await imp('/src/main/ipc/index.ts')
const { notePanelUnlocked } = await imp('/src/main/services/panelSession.ts')
const { IPC } = await imp('/src/shared/ipc.ts')
const { DEFAULT_MANAGER_PASSWORD: PW } = await imp('/src/shared/receipt.ts')
const { PANEL_KEYS } = await imp('/src/shared/panels.ts')
const { custodyService } = await imp('/src/main/services/CustodyService.ts')

const db = harnessClient()
const seed = makeSeeder(db)
registerIpcHandlers()
const invoke = async (channel, payload) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler ' + channel)
  try {
    return await fn({ sender }, payload)
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), code: e?.code ?? 'THROWN' }
  }
}
const OWNER_PIN = 'Owner-Pin-4137!'
const owner = seed.user('مالک فروشگاه')
const pid = seed.product('کالای ۴-۱۳۷', seed.category('پوشاک'))
const variantId = seed.variant(pid, 'سایز')
await custodyService.setPin({ userId: owner, newPassword: OWNER_PIN, currentPassword: PW })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: owner, managerPassword: OWNER_PIN })
for (const k of [PANEL_KEYS.purchase, PANEL_KEYS.products]) notePanelUnlocked(k, 'PANEL', sender.id)
const TAIL = '، ابتدا مسئول حاضر صندوق باید با رمز شخصی و شمارش فیزیکی صندوق را تحویل بگیرد.'
const msgOf = (r) => String(r?.error ?? r?.message ?? '')

await test('purchase with no drawer taken over: same rule and code, purchase wording', async () => {
  const r = await invoke(IPC.purchaseCreate, { panelPassword: PW, supplierName: 'تولیدی آزمون', settlementType: 'ACCOUNT', paidTotal: 0, lines: [{ variantId, qty: 1, unitPrice: 60_000 }] })
  assert.equal(r?.ok, false)
  assert.equal(msgOf(r), 'برای ثبت خرید' + TAIL)
  assert.equal(r.code, 'CUSTODY_AUTH_REQUIRED')
  assert.equal(seed.one('SELECT COUNT(*) AS n FROM "PurchaseInvoice"').n, 0, 'nothing written')
})

await test('stock adjustment with no drawer taken over: stock-adjustment wording', async () => {
  const r = await invoke(IPC.stockAdjust, { variantId, delta: 1, reason: 'آزمون', managerPassword: PW, panelPassword: PW })
  assert.equal(r?.ok, false)
  assert.equal(msgOf(r), 'برای اصلاح موجودی' + TAIL)
  assert.equal(r.code, 'CUSTODY_AUTH_REQUIRED')
})

await test('the sale message itself is unchanged', async () => {
  let message = ''
  let code = ''
  try {
    await custodyService.actorForFinancialOperation()
  } catch (e) {
    message = String(e?.message ?? e)
    code = e?.code
  }
  assert.equal(message, 'برای ثبت فروش' + TAIL)
  assert.equal(code, 'CUSTODY_AUTH_REQUIRED')
})
