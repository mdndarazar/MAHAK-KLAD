/**
 * A destination-less cleared receipt has its own proof, independent of a
 * historical CREDIT/null proof. Both components must be documented before
 * the same immutable blue snapshot can get one append-only final decision.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s430-custody-unknown-destination-manager-proof.mjs
 */
import { calculateCustodyReference } from '../../src/shared/custodyReference.ts'
import { observationOf } from '../../src/shared/custodyPeriod.ts'
import { resolvedCustodySnapshot } from '../../src/shared/custodyResolution.ts'
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); checks++; console.log(`  ✓ ${label}`) }
function rejects(label, work) { let bad = false; try { work() } catch { bad = true }; eq(label, bad, true) }
const from = calculateCustodyReference({ cashReceived: 500_000_000, cardReceived: 0, otherReceived: 0,
  destinationUnknownReceived: 1_000_000, ambiguousLegacyCredit: 0, refundCash: 0, refundCard: 0 })
const count = observationOf(501_000_000, false)
const args = { reference: from, count, scopeKey: '1405/07/22:1405/07/22:TODAY:sales-blue-v2', start: null }
const cash = resolvedCustodySnapshot({ ...args, decision: 'NO_LEGACY_CREDIT', destinationDecision: 'RECEIVED_CASH' })
eq('proved store CASH makes the effective blue reference 501M', cash.effectiveReferenceAmount, 501_000_000)
eq('matching blind count means raw difference zero', cash.comparison.rawDifference, 0)
eq('without prior count no fresh difference is attributed', cash.comparison.freshDifference, null)
const card = resolvedCustodySnapshot({ ...args, decision: 'NO_LEGACY_CREDIT', destinationDecision: 'RECEIVED_CARD' })
eq('proved store CARD has the same combined blue reference', card.effectiveReferenceAmount, 501_000_000)
const outside = resolvedCustodySnapshot({ ...args, decision: 'NO_LEGACY_CREDIT', destinationDecision: 'NOT_RECEIVED' })
eq('proof of non-store receipt leaves blue reference 500M', outside.effectiveReferenceAmount, 500_000_000)
eq('physical 501M then has real positive 1M raw difference', outside.comparison.rawDifference, 1_000_000)
eq('resolved reference does not rewrite frozen unknown reference', from.referenceAmount, null)
const mixed = calculateCustodyReference({ cashReceived: 500_000_000, cardReceived: 0, otherReceived: 0,
  destinationUnknownReceived: 1_000_000, ambiguousLegacyCredit: 200_000, refundCash: 0, refundCard: 0 })
rejects('credit-only proof cannot silently settle destination ambiguity', () => resolvedCustodySnapshot({ ...args, reference: mixed, decision: 'RECEIVED_CARD' }))
rejects('destination-only proof cannot silently settle credit ambiguity', () => resolvedCustodySnapshot({ ...args, reference: mixed, destinationDecision: 'RECEIVED_CASH' }))
const both = resolvedCustodySnapshot({ ...args, reference: mixed, decision: 'NOT_RECEIVED', destinationDecision: 'RECEIVED_CARD' })
eq('combined proof includes only the destination component', both.effectiveReferenceAmount, 501_000_000)
eq('original mixed snapshot stays pending', mixed.status, 'PENDING_RECONCILIATION')
// Main integration: report truth, a finished handover, append-only manager
// proof for a REAL destination-less cleared cheque, and continuing custody.
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const dir = mkdtempSync(join(tmpdir(), 'mahak-destination-proof-s430-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { custodyBlueResolutionService } = await import('../../src/main/services/CustodyBlueResolutionService.ts')
const { toJalaliDate } = await import('@shared/jalali')
const seed = makeSeeder(harnessClient())
const sql = harnessClient().$harness.db
const today = toJalaliDate(new Date())
const manager = seed.user('مدیر S430')
const giver = seed.user('تحویل‌دهنده S430')
const receiver = seed.user('گیرنده S430')
await custodyService.setPin({ userId: manager, newPassword: 'Manager430!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager430!' })
for (const [id, temp, pin] of [[giver, 'Giver430Temp!', 'Giver430Final!'], [receiver, 'Receiver430Temp!', 'Receiver430Final!']]) {
  await custodyService.setPin({ userId: id, newPassword: temp, managerUserId: manager,
    managerPassword: 'Manager430!', reason: 'تست شاهد مقصد نامعلوم' })
  await custodyService.setPin({ userId: id, currentPassword: temp, newPassword: pin })
}
const opened = await custodyService.open({ userId: giver, password: 'Giver430Final!', operationalTotal: 501_000_000 })
const cashMethod = seed.insert('PaymentMethod', { key: 'S430_CASH', label: 'نقد', kind: 'CASH', isActive: 1 })
const chequeMethod = seed.insert('PaymentMethod', { key: 'S430_CHEQUE', label: 'چک', kind: 'CUSTOM', isActive: 1 })
const creditMethod = seed.insert('PaymentMethod', { key: 'S430_OLD_CREDIT', label: 'اعتبار قدیمی', kind: 'CREDIT', isActive: 0 })
function payment(receiptNo, amount, methodId, { kind = 'CASH', destination = 'CASH', chequeStatus = null } = {}) {
  const invoice = seed.invoice({ receiptNo, grandTotal: amount, status: 'SETTLED' })
  sql.prepare('UPDATE "SaleInvoice" SET issuedAtJalali=?, goodsTotal=?, paidTotal=?, userId=?, shiftId=? WHERE id=?')
    .run(today, amount, amount, giver, opened.shiftId, invoice.id)
  seed.insert('Payment', { invoiceId: invoice.id, methodId, amount, seq: 1, kind, destination, chequeStatus,
    paidAt: Date.now(), paidAtJalali: today, createdShiftId: opened.shiftId,
    clearedAt: kind === 'CHEQUE' ? Date.now() : null,
    clearedAtJalali: kind === 'CHEQUE' ? today : null,
    clearedShiftId: kind === 'CHEQUE' ? opened.shiftId : null })
}
payment(430001, 500_000_000, cashMethod)
payment(430002, 1_000_000, chequeMethod, { kind: 'CHEQUE', destination: null, chequeStatus: 'CLEARED' })
async function handover(from, to, fromPin, toPin, key) {
  const h = await custodyService.handoverStart({ password: fromPin, operationalTotal: 501_000_000,
    toUserId: to, blueReference: true, idempotencyKey: key })
  await custodyService.handoverCountBlue({ handoverId: h.id, password: toPin, operationalTotal: 501_000_000 })
  await custodyService.handoverConfirmBlue({ handoverId: h.id, password: toPin })
  return seed.one('SELECT * FROM "CustodyBlueSnapshot" WHERE handoverId=? AND role=?', h.id, 'IN')
}
const first = await handover(giver, receiver, 'Giver430Final!', 'Receiver430Final!', 's430:cash-proof')
eq('frozen snapshot contains known 500M', Number(first.knownSubtotal), 500_000_000)
eq('frozen snapshot isolates destination-unknown 1M', Number(first.destinationUnknownReceived), 1_000_000)
eq('first handover reference remains unknown until proof', first.referenceAmount, null)
const proofCash = { snapshotId: first.id, managerUserId: manager, password: 'Manager430!',
  decisionKind: 'NO_LEGACY_CREDIT', evidenceDay: today, evidenceReference: 'receipt for cheque no 430002',
  destinationDecisionKind: 'RECEIVED_CASH', destinationEvidenceDay: today,
  destinationEvidenceReference: 'drawer deposit proof for cheque no 430002',
  reason: 'مدرک وصول همین چک به کشوی فروشگاه و تطبیق همان روز', idempotencyKey: 's430:decision:cash-proof' }
const decidedCash = await custodyBlueResolutionService.resolve(proofCash)
eq('same frozen handover resolves to 501M with proved cash', decidedCash.referenceAmount, 501_000_000)
eq('501M physical vs proved 501M is raw zero', decidedCash.rawDifference, 0)
eq('fresh remains unknown without an earlier known baseline', decidedCash.freshDifference, null)
eq('manager proof is exactly one append-only resolution', seed.count('CustodyBlueResolution', 'snapshotId=?', first.id), 1)
eq('original handover reference is never rewritten', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', first.id).referenceAmount, null)
eq('idempotent replay of same destination proof is safe', (await custodyBlueResolutionService.resolve(proofCash)).replayed, true)
let collisionCode = ''
try { await custodyBlueResolutionService.resolve({ ...proofCash,
  destinationEvidenceReference: 'a DIFFERENT destination receipt 430002' }) } catch (error) { collisionCode = error?.code }
eq('idempotency key cannot silently overwrite destination document', collisionCode, 'BLUE_ALREADY_RESOLVED')
const pendingList = await custodyBlueResolutionService.pendingList()
const resolvedListRow = pendingList.rows.find((row) => row.snapshotId === first.id)
eq('manager list labels completed destination proof RESOLVED', resolvedListRow?.status, 'RESOLVED')
eq('manager list displays separate destination decision', resolvedListRow?.decision?.destinationKind, 'RECEIVED_CASH')
const timeline = await custodyService.report({ managerUserId: manager, managerPassword: 'Manager430!' })
const viewed = timeline.handovers.find((row) => row.blue?.incoming?.id === first.id)?.blue
eq('manager timeline preserves unknown ORIGINAL reference', viewed?.originalReferenceAmount, null)
eq('manager timeline shows decision on same handover', viewed?.decision?.destinationKind, 'RECEIVED_CASH')
eq('manager timeline names destination-specific document', viewed?.decision?.destinationEvidenceReference, proofCash.destinationEvidenceReference)
const second = await handover(receiver, giver, 'Receiver430Final!', 'Giver430Final!', 's430:not-store')
const notStore = await custodyBlueResolutionService.resolve({ ...proofCash, snapshotId: second.id,
  destinationDecisionKind: 'NOT_RECEIVED', destinationEvidenceReference: 'bank statement proves not received by shop',
  reason: 'مدارک عدم دریافت در صندوق یا کارت‌خوان همان بازه بررسی شد', idempotencyKey: 's430:decision:not-store' })
eq('proof of non-store receipt keeps reference at 500M', notStore.referenceAmount, 500_000_000)
eq('physical 501M then has real positive 1M RAW variance', notStore.rawDifference, 1_000_000)
eq('new owner keeps custody after positive variance', (await custodyService.status()).custodian?.id, giver)
// Mixed evidence: a partial proof must be rejected; one final row documents
// BOTH components, with each evidence reference/day preserved separately.
payment(430003, 200_000, creditMethod, { destination: null })
const third = await handover(giver, receiver, 'Giver430Final!', 'Receiver430Final!', 's430:mixed')
let partialCode = ''
try { await custodyBlueResolutionService.resolve({ ...proofCash, snapshotId: third.id,
  decisionKind: 'RECEIVED_CARD', destinationDecisionKind: undefined,
  idempotencyKey: 's430:decision:partial' }) } catch (error) { partialCode = error?.code }
eq('partial credit proof on mixed snapshot is refused', partialCode, 'BLUE_OTHER_UNRESOLVED')
eq('refused partial proof creates no decision', seed.count('CustodyBlueResolution', 'snapshotId=?', third.id), 0)
let outOfRangeCode = ''
try { await custodyBlueResolutionService.resolve({ ...proofCash, snapshotId: third.id,
  decisionKind: 'NOT_RECEIVED', destinationDecisionKind: 'RECEIVED_CARD',
  destinationEvidenceDay: toJalaliDate(new Date(Date.now() - 24 * 60 * 60_000)),
  idempotencyKey: 's430:decision:wrong-day' }) } catch (error) { outOfRangeCode = error?.code }
eq('destination proof from outside original day is rejected', outOfRangeCode, 'BLUE_EVIDENCE_OUT_OF_SCOPE')
eq('wrong-day proof did not create decision', seed.count('CustodyBlueResolution', 'snapshotId=?', third.id), 0)
const bothProof = await custodyBlueResolutionService.resolve({ ...proofCash, snapshotId: third.id,
  decisionKind: 'NOT_RECEIVED', destinationDecisionKind: 'RECEIVED_CARD',
  destinationEvidenceReference: 'POS receipt 430002 from same handover day',
  reason: 'چک در کارت‌خوان وصول شد؛ اعتبار جداگانه دریافت نشده است', idempotencyKey: 's430:decision:mixed' })
eq('mixed proof adds only the proved destination receipt', bothProof.referenceAmount, 501_000_000)
const decisionRow = seed.one('SELECT * FROM "CustodyBlueResolution" WHERE snapshotId=?', third.id)
eq('decision records separate destination kind', decisionRow.destinationDecisionKind, 'RECEIVED_CARD')
eq('decision records separate destination amount', Number(decisionRow.destinationAmbiguousAmount), 1_000_000)
eq('decision records separate destination document', decisionRow.destinationEvidenceReference, 'POS receipt 430002 from same handover day')
eq('decision retains credit choice separately', decisionRow.decisionKind, 'NOT_RECEIVED')
eq('original mixed snapshot is unchanged', seed.one('SELECT referenceAmount FROM "CustodyBlueSnapshot" WHERE id=?', third.id).referenceAmount, null)
const { notePanelUnlocked } = await import('../../src/main/services/panelSession.ts')
const electron = await import('electron')
electron.BrowserWindow.getFocusedWindow = () => null
electron.BrowserWindow.getAllWindows = () => []
const path = join(dir, 'destination-proofs.csv')
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
notePanelUnlocked('test', 'MANAGER')
const exported = await custodyService.exportReport({ managerSession: true,
  from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })
eq('manager audit export writes CSV with independent proofs', exported.format, 'csv')
const { readFileSync } = await import('node:fs')
const csv = readFileSync(path, 'utf8')
eq('export keeps destination amount separate in original handover row', csv.includes('مقصد نامشخص 1000000'), true)
eq('export identifies destination proof on same original snapshot', csv.includes('مقصد نامشخص RECEIVED_CARD') && csv.includes('POS receipt 430002 from same handover day'), true)
eq('export also identifies separate credit decision', csv.includes('NOT_RECEIVED') && csv.includes('تصمیم افزایشی مرجع آبی'), true)
const managerUi = readFileSync(new URL('../../src/renderer/src/components/BlueResolutionPanel.tsx', import.meta.url), 'utf8')
eq('manager UI collects a distinct decision for destination proof', managerUi.includes('destinationDecisionKind'), true)
eq('manager UI collects a distinct document for destination proof', managerUi.includes('destinationEvidenceReference'), true)
console.log(`\n✓ ${checks} checks passed`)
