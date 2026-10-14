/**
 * Practical rehearsal through the same Main IPC channels used by the desktop:
 * real POS sales (cash + card + unpaid credit), distinct personal count PINs,
 * two handovers, immutable SQLite evidence, inherited vs new shortage.
 * No shop database, real cash, or card terminal is touched.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s423-custody-practical-pos-count-rehearsal.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-practical-count-s423-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
let checks = 0
function eq(label, got, want) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
  checks++; console.log(`  ✓ ${label}`)
}
function accepted(label, result) {
  if (!result?.ok) throw new Error(`${label}: ${result?.error ?? 'IPC response unavailable'}`)
  checks++; console.log(`  ✓ ${label}`)
  return result.data
}

const manager = seed.user('مدیر آزمون عملی')
const first = seed.user('مسئول صبح')
const noon = seed.user('مسئول ظهر')
const night = seed.user('مسئول شب')
sql.prepare('UPDATE "User" SET role=? WHERE id IN (?,?,?)').run('CASHIER', first, noon, night)
await custodyService.setPin({ userId: manager, newPassword: 'Manager423!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager423!' })
for (const [id, temporary, personal] of [
  [first, 'FirstTemp423!', 'FirstFinal423!'], [noon, 'NoonTemp423!', 'NoonFinal423!'], [night, 'NightTemp423!', 'NightFinal423!']
]) {
  await custodyService.setPin({ userId: id, newPassword: temporary, managerUserId: manager,
    managerPassword: 'Manager423!', reason: 'صدور PIN برای تمرین عملی شمارش صندوق' })
  await custodyService.setPin({ userId: id, currentPassword: temporary, newPassword: personal })
}
const cat = seed.category('دستهٔ آزمون شمارش')
const product = seed.product('کالای آزمون شمارش', cat)
function variant(price) {
  const id = seed.variant(product)
  sql.prepare('UPDATE "ProductVariant" SET salePrice=?, stock=? WHERE id=?').run(price, 50, id)
  return id
}
const cash = seed.insert('PaymentMethod', { key: 'S423_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const card = seed.insert('PaymentMethod', { key: 'S423_CARD', label: 'کارت‌خوان', kind: 'CARD', isActive: 1 })
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 423, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, input) => handlers.get(channel)({ sender }, input)
const posSale = async (price, payments, label) => accepted(label, await invoke(IPC.saleCreate, {
  deductInventory: false,
  lines: [{ variantId: variant(price), qty: 1, unitPrice: price, discount: 0, tax: 0 }],
  payments,
  splitPayment: payments.length === 2
}))
const split = (cashAmount, cardAmount) => [
  { methodId: cash, amount: cashAmount, destination: 'CASH' },
  { methodId: card, amount: cardAmount, destination: 'CARD' }
]
const snapshot = (handoverId, role) => seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', handoverId, role)

console.log('\n[1] صبح: مبلغ واقعی ۱۸٬۴۸۱٬۰۰۰ و فروش نقد/کارت ۱۹٬۴۸۱٬۰۰۰')
const opened = accepted('افتتاح با PIN مسئول صبح و شمارش واقعی',
  await invoke(IPC.custodyOpen, { userId: first, password: 'FirstFinal423!', operationalTotal: 18_481_000 }))
eq('شمارش افتتاح مستقل ثبت شد', Number(seed.one('SELECT humanAmount FROM "CustodyBlueSnapshot" WHERE shiftId=? AND role=?', opened.shiftId, 'OPENING')?.humanAmount), 18_481_000)
const morningSale = await posSale(19_481_000, split(10_000_000, 9_481_000), 'فروش ترکیبی واقعی از مسیر POS')
eq('فروش به مسئول واقعی صبح منتسب شد', seed.one('SELECT userId FROM "SaleInvoice" WHERE id=?', morningSale.id).userId, first)
eq('دو پرداخت نقد و کارت مستقل ذخیره شد', seed.count('Payment', 'invoiceId=?', morningSale.id), 2)
const firstHandover = accepted('شمارش خروج مستقل با PIN مسئول صبح',
  await invoke(IPC.custodyHandoverStart, { password: 'FirstFinal423!', operationalTotal: 18_481_000,
    toUserId: noon, idempotencyKey: 's423:morning-out' }))
eq('مرجع کل روز پیش از تحویل', Number(snapshot(firstHandover.id, 'OUT')?.referenceAmount), 19_481_000)
eq('کسری خامِ مشاهده‌شده نزد صبح', Number(snapshot(firstHandover.id, 'OUT')?.rawDifference), -1_000_000)
const wrong = await invoke(IPC.custodyHandoverCountBlue, { handoverId: firstHandover.id, password: 'WrongNoon423!', operationalTotal: 18_481_000 })
eq('PIN نادرست گیرنده شمارش نیست', wrong?.ok, false)
eq('شمارش گیرنده پس از PIN نامعتبر ثبت نشد', seed.count('CustodyBlueSnapshot', 'handoverId=? AND role=?', firstHandover.id, 'IN'), 0)
const firstIn = accepted('گیرنده خودش با PIN و مبلغ مستقل شمارش می‌کند',
  await invoke(IPC.custodyHandoverCountBlue, { handoverId: firstHandover.id, password: 'NoonFinal423!', operationalTotal: 18_481_000 }))
eq('کسری خام نزد گیرنده همچنان یک میلیون', firstIn.rawDifference, -1_000_000)
eq('کسری تازه برای گیرنده صفر', firstIn.freshDifference, 0)
const noonShift = accepted('تحویل بدون تأیید پیشینی مدیر کامل می‌شود',
  await invoke(IPC.custodyHandoverConfirmBlue, { handoverId: firstHandover.id, password: 'NoonFinal423!' }))
eq('مالک مالی اکنون مسئول ظهر است', (await custodyService.status()).custodian?.id, noon)
eq('سند تحویل اول COMPLETED است', seed.one('SELECT status FROM "CustodyHandover" WHERE id=?', firstHandover.id).status, 'COMPLETED')

console.log('\n[2] ظهر: فروش ۱۰ میلیون و نسیهٔ وصول‌نشده؛ شمارش ۲۷٬۴۸۱٬۰۰۰')
const noonSale = await posSale(10_000_000, split(6_000_000, 4_000_000), 'فروش ۱۰ میلیونی در شیفت ظهر')
eq('فاکتور ظهر به مسئول ظهر تعلق دارد', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', noonSale.id).shiftId, noonShift.shiftId)
const credit = await posSale(7_000_000, [], 'ثبت نسیهٔ ۷ میلیونی بدون وصول')
eq('نسیه بدون پرداخت ثبت می‌شود', seed.count('Payment', 'invoiceId=?', credit.id), 0)
const secondHandover = accepted('شمارش خروج مستقل ظهر',
  await invoke(IPC.custodyHandoverStart, { password: 'NoonFinal423!', operationalTotal: 27_481_000,
    toUserId: night, idempotencyKey: 's423:noon-out' }))
const out = snapshot(secondHandover.id, 'OUT')
eq('مرجع آبی کل امروز؛ نسیه بی‌وصول سهم صفر دارد', Number(out.referenceAmount), 29_481_000)
eq('اختلاف خام منفی دو میلیون', Number(out.rawDifference), -2_000_000)
eq('یک میلیون کسری پیشین محفوظ است', Number(out.inheritedDifference), -1_000_000)
eq('فقط یک میلیون کسری تازهٔ ظهر است', Number(out.freshDifference), -1_000_000)
const nightIn = accepted('شمارش مستقل نفر شب با PIN خودش',
  await invoke(IPC.custodyHandoverCountBlue, { handoverId: secondHandover.id, password: 'NightFinal423!', operationalTotal: 27_481_000 }))
eq('اختلاف خام تحویلی منفی دو میلیون', nightIn.rawDifference, -2_000_000)
eq('کسری تازه‌ای به نفر شب منتقل نمی‌شود', nightIn.freshDifference, 0)
const nightShift = accepted('نفر شب بدون قفل فروش مسئول می‌شود',
  await invoke(IPC.custodyHandoverConfirmBlue, { handoverId: secondHandover.id, password: 'NightFinal423!' }))
eq('مالک واقعی صندوق نفر شب است', (await custodyService.status()).custodian?.id, night)
const stillSelling = await posSale(1000, [{ methodId: cash, amount: 1000, destination: 'CASH' }], 'فروش پس از اختلاف همچنان ممکن است')
eq('فروش جدید فقط به شیفت نفر شب منتسب است', seed.one('SELECT shiftId FROM "SaleInvoice" WHERE id=?', stillSelling.id).shiftId, nightShift.shiftId)
eq('کسری، خودکار پروندهٔ تقصیر تولید نکرد', seed.count('CustodyDiscrepancyCase'), 0)
eq('شمارش واقعی، پول افتتاحیِ ساختگی نساخت', seed.count('CashMovement', 'type=?', 'OPENING_FLOAT'), 0)
console.log(`\n✓ ${checks} checks passed; temporary SQLite DB: ${dir}`)
