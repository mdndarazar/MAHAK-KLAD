/**
 * CSV from the REAL manager IPC export: initial blue evidence is immutable and
 * unknown until resolved; each later decision is a separate row on that SAME
 * handover/day. System absence stays a distinct, unclaimed OUT witness.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s414-custody-blue-export-content.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-blue-export-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const day = toJalaliDate(new Date())
const manager = seed.user('مدیر S414')
const giver = seed.user('مسئول قدیمی S414')
const recipient = seed.user('گیرنده S414')
await custodyService.setPin({ userId: manager, newPassword: 'Manager414!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager414!' })
for (const [id, temp, pin] of [[giver, 'Giver414!', 'Giver4144!'], [recipient, 'Receiver414!', 'Receiver4144!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager, managerPassword: 'Manager414!', reason: 'شاهد خروجی مرجع و تصمیم افزایشی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
const opened = await custodyService.open({ userId: giver, password: 'Giver4144!', operationalTotal: 501_000_000 })
const cash = seed.insert('PaymentMethod', { key: 'S414_CASH', label: 'cash', kind: 'CASH', isActive: 1 })
const legacy = seed.insert('PaymentMethod', { key: 'S414_OLD_CREDIT', label: 'legacy', kind: 'CREDIT', isActive: 0 })
for (const [receiptNo, amount, methodId, destination] of [[414001, 500_000_000, cash, 'CASH'], [414002, 1_000_000, legacy, null]]) {
  const inv = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET goodsTotal=?, paidTotal=?, issuedAtJalali=?, userId=?, shiftId=? WHERE id=?')
    .run(amount, amount, day, giver, opened.shiftId, inv.id)
  seed.insert('Payment', { invoiceId: inv.id, methodId, amount, seq: 1, kind: 'CASH', destination,
    paidAt: Date.now(), paidAtJalali: day, createdByUserId: giver, createdShiftId: opened.shiftId })
}
const one = await custodyService.handoverStart({ password: 'Giver4144!', operationalTotal: 501_000_000,
  toUserId: recipient, blueReference: true, idempotencyKey: 's414:one' })
await custodyService.handoverCountBlue({ handoverId: one.id, password: 'Receiver4144!', operationalTotal: 501_000_000 })
await custodyService.handoverConfirmBlue({ handoverId: one.id, password: 'Receiver4144!' })
const original = seed.one('SELECT id, referenceAmount, rawDifference FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', one.id, 'IN')
const electron = await import('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
electron.BrowserWindow.fromWebContents = () => ({ isDestroyed: () => false })
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const sender = { id: 414, isDestroyed: () => false, once: () => {} }
const { registerIpcHandlers } = await import('../../src/main/ipc/index.ts')
const { IPC } = await import('@shared/ipc')
registerIpcHandlers()
const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload)
const scope = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), take: 50 }
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  checks++; console.log(`  ✓ ${label}`)
}
const untrusted = await invoke(IPC.custodyReportExport, scope)
eq('an employee cannot export blue evidence', untrusted.ok, false)
eq('manager authenticates via Main session', (await invoke(IPC.managerVerify, { password: '1111' })).ok, true)
// A CSV parser for content assertions including quoted Persian descriptions.
function parseCsv(path) {
  const text = readFileSync(path, 'utf8').replace(/^\ufeff/, '')
  const rows = []; let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell); cell = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else if (char !== '\r' || quoted) cell += char
  }
  row.push(cell); rows.push(row)
  return rows
}
let exportNo = 0
async function exportRows() {
  const filePath = join(dir, `blue-${++exportNo}.csv`)
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  const result = await invoke(IPC.custodyReportExport, { ...scope, rows: [['renderer-invented']], title: 'fake manager title' })
  eq(`export #${exportNo} succeeds in CSV`, result.ok && result.data.format, 'csv')
  const all = parseCsv(filePath)
  eq('renderer cannot insert fabricated rows', all.some((row) => row.includes('renderer-invented')), false)
  return all
}
const before = await exportRows()
const initialOf = (rows, handoverId) => rows.find((row) => row[0] === 'شمارش و مرجع آبی اولیه' && row[2]?.startsWith(`تحویل ${handoverId} /`))
const decisionOf = (rows, handoverId) => rows.find((row) => row[0] === 'تصمیم افزایشی مرجع آبی' && row[2]?.startsWith(`تحویل ${handoverId} /`))
const initialBefore = initialOf(before, one.id)
eq('initial export preserves physical count', initialBefore?.[4], '501000000')
eq('initial reference remains unknown rather than guessed zero', initialBefore?.[5], '')
eq('initial raw difference remains unknown', initialBefore?.[6], '')
eq('initial evidence says PENDING_RECONCILIATION', initialBefore?.[7], 'PENDING_RECONCILIATION')
eq('initial evidence contains definite 500M', initialBefore?.[8]?.includes('بخش معلوم 500000000'), true)
eq('initial evidence isolates ambiguous 1M', initialBefore?.[8]?.includes('پرداخت مبهم 1000000'), true)
eq('no manager decision exported before decision', decisionOf(before, one.id), undefined)
const received = await custodyBlueResolutionService.resolve({ snapshotId: original.id, managerUserId: manager, password: 'Manager414!',
  decisionKind: 'RECEIVED_CARD', evidenceDay: day, evidenceReference: 'رسید کارت‌خوان شماره 414002 همین روز',
  reason: 'این یک میلیون در همان بازه از طریق کارت‌خوان فروشگاه دریافت شده است',
  idempotencyKey: 's414:export:received:original' })
eq('same-period card proof includes ambiguous million', received.referenceAmount, 501_000_000)
const after = await exportRows()
eq('original initial row is unchanged byte-for-byte after decision', JSON.stringify(initialOf(after, one.id)), JSON.stringify(initialBefore))
const decision = decisionOf(after, one.id)
eq('decision attached to SAME initial handover', decision?.[2]?.startsWith(`تحویل ${one.id} / سند ${original.id}`), true)
eq('decision reference includes received 1M', decision?.[5], '501000000')
eq('decision raw difference becomes zero', decision?.[6], '0')
eq('decision is independently marked RESOLVED', decision?.[7], 'RESOLVED')
eq('export names proven card receipt and document', decision?.[8]?.includes('RECEIVED_CARD') && decision?.[8]?.includes('414002'), true)
eq('fresh difference remains unknown without initial comparable evidence', decision?.[8]?.includes('اختلاف تازه نامعلوم'), true)
eq('snapshot remains immutable and unknown in storage', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', original.id).referenceAmount, null)
const two = await custodyService.handoverStart({ password: 'Receiver4144!', operationalTotal: 501_000_000,
  toUserId: manager, blueReference: true, idempotencyKey: 's414:two' })
await custodyService.handoverCountBlue({ handoverId: two.id, password: 'Manager414!', operationalTotal: 501_000_000 })
await custodyService.handoverConfirmBlue({ handoverId: two.id, password: 'Manager414!' })
const other = seed.one('SELECT id FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', two.id, 'IN')
await custodyBlueResolutionService.resolve({ snapshotId: other.id, managerUserId: manager, password: 'Manager414!',
  decisionKind: 'NOT_RECEIVED', evidenceDay: day, evidenceReference: 'دفتر مغایرت پرداخت شماره 414002',
  reason: 'بررسی دوم نشان داد این وجه در این تحویل هنوز دریافت نشده است',
  idempotencyKey: 's414:export:notreceived:other' })
const cover = await custodyService.emergencyCover({ userId: recipient, password: 'Receiver4144!', operationalTotal: 501_000_000,
  reason: 'مدیر به‌عنوان مسئول حاضر نیست؛ کارمند با شمارش تازه مسئول می‌شود.' })
const final = await exportRows()
const notReceived = decisionOf(final, two.id)
eq('NOT_RECEIVED keeps separate 500M reference', notReceived?.[5], '500000000')
eq('NOT_RECEIVED reports positive 1M, without blame', notReceived?.[6], '1000000')
eq('second decision is tied only to second handover', notReceived?.[2]?.startsWith(`تحویل ${two.id} / سند ${other.id}`), true)
eq('first resolved export is untouched by second decision', JSON.stringify(decisionOf(final, one.id)), JSON.stringify(decision))
const absence = final.find((row) => row[0] === 'غیبت تحویل‌دهنده؛ شمارش خروجی انجام نشده' && row[2]?.startsWith(`تحویل ${cover.handoverId} /`))
eq('absence without an outgoing count gets its OWN export row', !!absence, true)
eq('absence row has no fabricated human amount', absence?.[4], '')
eq('absence row never claims PIN from missing worker', absence?.[8]?.includes('بدون PIN فرد غایب'), true)
eq('absence export never calls a missing count system zero', absence?.[8]?.includes('صفر سیستمی'), false)
const absenceHandover = final.find((row) => row[0] === 'پوشش غیبت؛ خروج بدون شمارش' && row[2]?.includes(`نشست ${seed.one('SELECT fromShiftId FROM "CustodyHandover" WHERE id=?', cover.handoverId)?.fromShiftId} → ${cover.shiftId}`))
eq('absence handover row exists without claiming receiver counted old side', !!absenceHandover, true)
eq('cash-era outgoing count field is hidden in absence export', absenceHandover?.[4], '')
eq('new worker real count still appears separately', initialOf(final, cover.handoverId)?.[4], '501000000')
console.log(`\n✓ ${checks} checks passed`)
