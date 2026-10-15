/** A pre-blue aggregate handover may have NO prior baseline/candidate. Its
 * receiver's physical count was adopted neutrally, yet the immutable handover
 * stores expected=count and difference=0. Only manager report/CSV projection
 * should hide that invented comparison; normal/blue handovers stay unchanged.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s453-custody-historical-adoption-projection.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-adoption-view-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
let checks = 0
function eq(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  checks++; console.log(`  ✓ ${label}`)
}

const manager = seed.user('مدیر S440')
const giver = seed.user('تحویل‌دهنده S440')
const receiver = seed.user('گیرنده S440')
const nextOwner = seed.user('مسئول بعدی S440')
await custodyService.setPin({ userId: manager, newPassword: 'Manager440!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager440!' })
for (const [id, temp, pin] of [[giver, 'Giver440Temp!', 'Giver440Final!'],
  [receiver, 'Receiver440Temp!', 'Receiver440Final!'], [nextOwner, 'Next440Temp!', 'Next440Final!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager,
    managerPassword: 'Manager440!', reason: 'تست پروجکشن شمارش تحویل قدیمی' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
await custodyService.open({ userId: giver, password: 'Giver440Final!', countedCash: 0 })
const adopted = await custodyService.handoverStart({ password: 'Giver440Final!', operationalTotal: 5_000_000,
  toUserId: receiver, idempotencyKey: 's440:historical-pending' })
// Model a genuine older persisted aggregate attempt, predating giver-candidate
// capture. Only the TEST fixture removes the pending candidate; product code
// and all immutable completed records are never changed.
const watermark = JSON.parse(seed.one('SELECT ledgerWatermark FROM "CustodyHandover" WHERE id=?', adopted.id).ledgerWatermark)
delete watermark.aggregateAdoptionCandidate
sql.prepare('UPDATE "CustodyHandover" SET ledgerWatermark=? WHERE id=?').run(JSON.stringify(watermark), adopted.id)
await custodyService.handoverAccept({ handoverId: adopted.id, password: 'Receiver440Final!', operationalTotal: 5_000_000 })
const historical = seed.one('SELECT expectedAtStart, differenceCash, countedAtStart, ledgerWatermark, status FROM "CustodyHandover" WHERE id=?', adopted.id)
eq('historical handover completed', historical.status, 'COMPLETED')
eq('old immutable expected uses receiver count as neutral start', Number(historical.expectedAtStart), 5_000_000)
eq('old immutable difference stores synthetic zero', Number(historical.differenceCash), 0)
eq('historical watermark attests ADOPT_RECEIVER', JSON.parse(historical.ledgerWatermark).aggregateBootstrap, 'ADOPT_RECEIVER')
const receiverCount = seed.one('SELECT expectedCash, differenceCash, countedCash FROM "CustodyCount" WHERE handoverId=? AND kind=?', adopted.id, 'HANDOVER_AGGREGATE_ADOPTION_RECOUNT')
eq('authoritative count has no expected reference', receiverCount?.expectedCash, null)
eq('authoritative count has no difference', receiverCount?.differenceCash, null)
eq('authoritative count keeps real physical money', Number(receiverCount?.countedCash), 5_000_000)

const chained = await custodyService.handoverStart({ password: 'Receiver440Final!', operationalTotal: 5_000_000,
  toUserId: nextOwner, idempotencyKey: 's440:real-comparison' })
await custodyService.handoverAccept({ handoverId: chained.id, password: 'Next440Final!', operationalTotal: 5_000_000 })
const blue = await custodyService.handoverStart({ password: 'Next440Final!', operationalTotal: 5_000_000,
  toUserId: manager, blueReference: true, idempotencyKey: 's440:blue-remains-separate' })
await custodyService.handoverCountBlue({ handoverId: blue.id, password: 'Manager440!', operationalTotal: 5_000_000 })
await custodyService.handoverConfirmBlue({ handoverId: blue.id, password: 'Manager440!' })
eq('new and historical transfers leave drawer active', (await custodyService.status()).state, 'ACTIVE')

const scope = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }
const report = await custodyService.report({ ...scope, managerUserId: manager, managerPassword: 'Manager440!' })
const adoptedView = report.handovers.find((row) => row.id === adopted.id)
eq('neutral adoption is recognized only in historical view', adoptedView?.unbasedAdoption, true)
eq('old giver physical count stays visible', Number(adoptedView?.countedAtStart), 5_000_000)
eq('synthetic historical expected is not projected', adoptedView?.expectedAtStart, null)
eq('synthetic historical difference is not projected', adoptedView?.differenceCash, null)
const normalView = report.handovers.find((row) => row.id === chained.id)
eq('a real chained handover is not tagged as adoption', normalView?.unbasedAdoption, false)
eq('a real chained expected remains visible', Number(normalView?.expectedAtStart), 5_000_000)
eq('a real chained zero difference remains visible', Number(normalView?.differenceCash), 0)
const blueView = report.handovers.find((row) => row.id === blue.id)
eq('new Blue handover is not misclassified as adoption', blueView?.unbasedAdoption, false)
eq('new Blue handover retains separate immutable snapshots', blueView?.blue?.incoming != null, true)
eq('new Blue handover does not expose cash-era expected column', blueView?.expectedAtStart, null)
eq('new Blue handover does not expose cash-era difference column', blueView?.differenceCash, null)

const electron = await import('electron')
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const path = join(dir, 'historical-adoption.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
notePanelUnlocked('test', 'MANAGER')
const exported = await custodyService.exportReport({ ...scope, managerSession: true })
eq('manager CSV export succeeds', exported.format, 'csv')
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell); cell = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else if (char !== '\r' || quoted) cell += char
  }
  row.push(cell); rows.push(row)
  return rows
}
const rows = parseCsv(readFileSync(path, 'utf8').replace(/^\ufeff/, ''))
const handoverRow = (row) => rows.find((entry) => entry[0] === (row.blue ? 'تحویل آبی' : 'تحویل') &&
  entry[2] === `نشست ${row.fromShiftId} → ${row.toShiftId}`)
const adoptionCsv = handoverRow(adoptedView)
eq('historical CSV keeps physical giver count', adoptionCsv?.[4], '5000000')
eq('historical CSV does not fabricate expected', adoptionCsv?.[5], '')
eq('historical CSV does not fabricate zero difference', adoptionCsv?.[6], '')
eq('historical CSV explains why reference is unknown', adoptionCsv?.[8]?.includes('مبنای قبلی نامعلوم'), true)
const normalCsv = handoverRow(normalView)
eq('normal CSV retains real expected', normalCsv?.[5], '5000000')
eq('normal CSV retains real zero', normalCsv?.[6], '0')
const blueCsv = handoverRow(blueView)
eq('Blue CSV keeps its own witness rows', rows.some((entry) => entry[0] === 'شمارش و مرجع آبی اولیه' && entry[2]?.includes(`تحویل ${blue.id} /`)), true)
eq('Blue CSV does not borrow an aggregate expected', blueCsv?.[5], '')
const after = seed.one('SELECT expectedAtStart, differenceCash, ledgerWatermark FROM "CustodyHandover" WHERE id=?', adopted.id)
eq('read-only projection left old stored expected intact', Number(after.expectedAtStart), 5_000_000)
eq('read-only projection left old stored difference intact', Number(after.differenceCash), 0)
eq('read-only projection never rewrote watermark', after.ledgerWatermark, historical.ledgerWatermark)
console.log(`\n✓ ${checks} historical adoption projection checks passed`)
