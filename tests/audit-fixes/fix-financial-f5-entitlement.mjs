/** F5: requested 1M, manager declares 600k, document confirms 600k,
 * verified residual 400k converted ONCE to no-expiry multi-use credit.
 * Tests the real product services against a temporary SQLite database.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-f5-entitlement.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-financial-f5-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { salesService } = await import('../../src/main/services/SalesService.ts')
const { cardTransferService } = await import('../../src/main/services/CardTransferService.ts')
const { returnGoodsService } = await import('../../src/main/services/ReturnGoodsService.ts')
const { convertCashRight, confirmCreditDelivery, reconcileBankDocument, viewReturnEntitlement } =
  await import('../../src/main/services/ReturnEntitlementService.ts')
const { findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const { debtFirstReturn, pooledCreditFirstReturn } = await import('../../src/shared/returnEntitlement.ts')
const { DEFAULT_MANAGER_PASSWORD } = await import('@shared/receipt')
const { toJalaliDate } = await import('@shared/jalali')
const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db
const userId = seed.user('manager F5')
const cat = seed.category('F5')
const product = seed.product('F5 item', cat)
const methodId = seed.insert('PaymentMethod', { key: 'CASH', label: 'Cash', kind: 'CASH', isActive: 1 })
const shiftId = seed.insert('Shift', { name: 'morning', number: 1, userId, openedAt: Date.now() - 10000, dayJalali: toJalaliDate(new Date()) })
const variant = (price) => {
  const id = seed.variant(product)
  sql.prepare('UPDATE "ProductVariant" SET stock = 100, salePrice = ? WHERE id = ?').run(price, id)
  return id
}
assert.deepEqual(debtFirstReturn(500, 500), { debtReduced: 500, residual: 0 })
assert.deepEqual(debtFirstReturn(500, 0), { debtReduced: 0, residual: 500 })
assert.deepEqual(pooledCreditFirstReturn({ purchaseTotal: 500, giftTotal: 300, previouslyReturned: 0, returning: 100 }),
  { gift: 100, cash: 0 })
assert.deepEqual(pooledCreditFirstReturn({ purchaseTotal: 500, giftTotal: 300, previouslyReturned: 100, returning: 250 }),
  { gift: 200, cash: 50 })
console.log('✓ debt_first and pooled unrestricted credit: 300 gift is restored before cash, not prorated across goods')

const v = variant(1_000_000)
const sale = await salesService.create({
  userId, shiftId,
  lines: [{ variantId: v, qty: 1, unitPrice: 1_000_000, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 1_000_000, destination: 'CASH' }]
})
const itemId = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', sale.id).id
const ret = await salesService.createReturn({
  invoiceId: sale.id, full: true,
  lines: [{ saleItemId: itemId, qty: 1 }],
  refundMethod: 'CARD_TO_CARD', refundAmount: 1_000_000, userId, shiftId
})
assert.equal(ret.cardTransfer?.amount, 1_000_000)
const requestId = ret.cardTransfer.id
let claim = await viewReturnEntitlement(ret.id)
assert.equal(claim.cashRight, 1_000_000)
assert.equal(claim.cashReserved, 1_000_000)
assert.equal(claim.open, 0)
const initialStockNote = seed.one('SELECT stockNote FROM "CardTransferRequest" WHERE id = ?', requestId).stockNote
assert.match(initialStockNote, /حضور فیزیکی بدون اسکن/)
assert.doesNotMatch(initialStockNote, /فیزیکی در فروشگاه|به موجودی قابل‌فروش برگشت/)
const requestAudit = seed.one('SELECT note FROM "AuditLog" WHERE entity = ? AND entityId = ? ORDER BY id DESC LIMIT 1',
  'CardTransferRequest', requestId).note
assert.match(requestAudit, /دریافت فیزیکی|شاهد.*کالا/,
  'the append-only audit must state the actual goods-release condition')
assert.doesNotMatch(requestAudit, /تا زدن «پرداخت شد»|فیزیکی در فروشگاه/,
  'manager declaration must never be described as the goods receipt')
const paid = await cardTransferService.pay({ id: requestId, paidAmount: 600_000,
  managerPassword: DEFAULT_MANAGER_PASSWORD, userId })
assert.equal(paid.bankEvidenceState, 'UNKNOWN_BANK')
assert.equal(paid.stockStillPending, true)
assert.equal(paid.releasedQty, 0)
assert.equal(seed.one('SELECT stockNote FROM "CardTransferRequest" WHERE id = ?', requestId).stockNote,
  initialStockNote, 'manager declaration must not announce goods received')
claim = await viewReturnEntitlement(ret.id)
assert.equal(claim.cashPaid, 0, 'typed payment is not independent bank evidence')
assert.equal(claim.cashReserved, 1_000_000, 'all of the originally requested amount remains locked')
assert.equal(claim.open, 0)
await assert.rejects(() => cardTransferService.adjust({ id: requestId, amount: -50_000,
  reason: 'تلاش اصلاح بدون شاهد بانک', managerPassword: DEFAULT_MANAGER_PASSWORD }), /دفتر حق مالی/)
await assert.rejects(() => cardTransferService.cancel({ id: requestId, reason: 'آزمون لغو با دریافت',
  releaseStock: true, managerPassword: DEFAULT_MANAGER_PASSWORD }), /مستقل از وضعیت بانک/)
await assert.rejects(() => convertCashRight({ returnId: ret.id, amount: 400_000, expectedVersion: claim.version,
  idempotencyKey: 'f5-convert-before-bank', managerPassword: DEFAULT_MANAGER_PASSWORD }), /تطبیق|باز/)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "CreditDelivery"').n, 0)
console.log('✓ manager declaration 600k leaves 400k LOCKED; no stock received and no code issued')

const goods = await returnGoodsService.items(ret.id)
assert.equal(goods.managed, true)
const good = goods.items[0]
assert.equal(good.pending, 1)
await assert.rejects(() => returnGoodsService.receive({ returnId: ret.id, returnItemId: good.id, qty: 2,
  eventKey: 'f5-receive-too-many', witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'کالای واقعی مشاهده شد',
  physicalConfirmed: true, actorUserId: userId }), /تغییر|تازه/)
const receivePayload = { returnId: ret.id, returnItemId: good.id, qty: 1,
  eventKey: 'f5-receive-good-once', witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'کالای واقعی مشاهده شد',
  physicalConfirmed: true, actorUserId: userId }
assert.equal((await returnGoodsService.receive(receivePayload)).releasedQty, 1)
const receivedNote = seed.one('SELECT stockNote, stockReleasedQty FROM "CardTransferRequest" WHERE id = ?', requestId)
assert.equal(receivedNote.stockReleasedQty, 1)
assert.match(receivedNote.stockNote, /1 عدد.*رسید فیزیکیِ شاهددار.*نتیجهٔ بانک مستقل/)
assert.equal((await returnGoodsService.receive(receivePayload)).replayed, true)
assert.equal(seed.one('SELECT stockNote FROM "CardTransferRequest" WHERE id = ?', requestId).stockNote,
  receivedNote.stockNote, 'replayed witness must not rewrite the display evidence')
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', v).stock, 100)
assert.equal((await viewReturnEntitlement(ret.id)).cashPaid, 0, 'physical receipt must NOT confirm any bank payment')
console.log('✓ witnessed physical receipt works independently, exact qty once; bank reservation remains locked')

const document = { name: 'bank-statement.pdf', bytes: Buffer.from('%PDF-1.7\nBank statement line 600000\n%%EOF\n') }
const proof = await reconcileBankDocument({ requestId, confirmedAmount: 600_000, document,
  reviewNote: 'بانک و تاریخ و مبلغ روی صورت‌حساب تطبیق داده شد',
  attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
assert.equal(proof.cashPaid, 600_000)
assert.equal(proof.cashReserved, 0)
assert.equal(proof.open, 400_000)
assert.equal(proof.replayed, false)
assert.equal((await reconcileBankDocument({ requestId, confirmedAmount: 600_000, document,
  reviewNote: 'بانک و تاریخ و مبلغ روی صورت‌حساب تطبیق داده شد',
  attestedBankAccountReview: true, managerPassword: DEFAULT_MANAGER_PASSWORD })).replayed, true)
const evidence = seed.one('SELECT sha256, documentBase64 FROM "BankStatementEvidence" WHERE requestId = ?', requestId)
assert.equal(Buffer.from(evidence.documentBase64, 'base64').toString(), Buffer.from(document.bytes).toString())
console.log('✓ bank document archived with backup-visible bytes, reviewed amount 600k; right opens by 400k')

const idempotencyKey = 'F5-CONVERT-400-ONCE'
const converted = await convertCashRight({ returnId: ret.id, amount: 400_000,
  expectedVersion: proof.version, idempotencyKey, managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId })
assert.equal(converted.deliveryStatus, 'PENDING_DELIVERY')
assert.equal((await convertCashRight({ returnId: ret.id, amount: 400_000,
  expectedVersion: proof.version, idempotencyKey, managerPassword: DEFAULT_MANAGER_PASSWORD })).replayed, true)
claim = await viewReturnEntitlement(ret.id)
assert.equal(claim.open, 0)
assert.equal(claim.cashConverted, 400_000)
const credit = seed.one('SELECT * FROM "StoreCredit" WHERE id = ?', converted.creditId)
assert.equal(credit.status, 'DRAFT')
assert.equal(credit.expiresAt, null)
assert.equal(credit.multiUse, 1)
assert.equal(credit.maxUses, 2_147_483_647)
await assert.rejects(() => findRedeemable(db, credit.code), /پیش‌نویس/)
await assert.rejects(() => convertCashRight({ returnId: ret.id, amount: 1,
  expectedVersion: claim.version, idempotencyKey: 'new-convert-after-zero', managerPassword: DEFAULT_MANAGER_PASSWORD }), /باز|بیشتر/)
console.log('✓ CAS/idempotent conversion of 400k to no-expiry multi-use DRAFT; print alone cannot spend')

const handoff = { creditId: credit.id, witnessKind: 'CUSTOMER_HANDOFF',
  witnessRef: 'تحویل مستقیم به مشتری با رسید پرونده', managerPassword: DEFAULT_MANAGER_PASSWORD, actorUserId: userId }
assert.equal((await confirmCreditDelivery(handoff)).status, 'DELIVERED')
assert.equal((await confirmCreditDelivery(handoff)).replayed, true)
for (const n of [150_000, 250_000]) {
  const id = variant(n)
  await salesService.create({ userId, shiftId,
    lines: [{ variantId: id, qty: 1, unitPrice: n, discount: 0, tax: 0 }],
    payments: [], storeCreditCode: credit.code,
    storeCreditIdempotencyKey: `f5-credit-spend-${n}` })
}
const afterSpend = seed.one('SELECT usedAmount, status FROM "StoreCredit" WHERE id = ?', credit.id)
assert.equal(Number(afterSpend.usedAmount), 400_000)
assert.equal(afterSpend.status, 'USED')
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "ReturnEntitlementEvent" WHERE entitlementId = ?',
  seed.one('SELECT id FROM "ReturnEntitlement" WHERE returnId = ?', ret.id).id).n, 6)
console.log('✓ witnessed delivery activates only successor; two purchases 150k + 250k exhaust exactly 400k')

// Multi-stage stock receipt, no bank action at all: amount and stock are
// independent origins. This also tests stale quantity and idempotent retries.
const v3 = variant(100)
const s3 = await salesService.create({ userId, shiftId,
  lines: [{ variantId: v3, qty: 3, unitPrice: 100, discount: 0, tax: 0 }],
  payments: [{ methodId, amount: 300, destination: 'CASH' }] })
const s3item = seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ?', s3.id).id
const r3 = await salesService.createReturn({ invoiceId: s3.id, full: true,
  lines: [{ saleItemId: s3item, qty: 3 }], refundMethod: 'CARD_TO_CARD', refundAmount: 300, userId, shiftId })
const g3 = (await returnGoodsService.items(r3.id)).items[0]
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', v3).stock, 97)
const g3a = { returnId: r3.id, returnItemId: g3.id, qty: 1, eventKey: 'f5-staged-receipt-001',
  witnessKind: 'SELECTED_CONFIRMED', witnessRef: 'یک کالا شمارش شد', physicalConfirmed: true, actorUserId: userId }
assert.equal((await returnGoodsService.receive(g3a)).allReceived, false)
const stageOne = seed.one('SELECT stockNote, stockReleasedQty FROM "CardTransferRequest" WHERE id = ?', r3.cardTransfer.id)
assert.equal(stageOne.stockReleasedQty, 1)
assert.match(stageOne.stockNote, /1 عدد.*رسید فیزیکیِ شاهددار.*2 عدد هنوز بدون شاهد/)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', v3).stock, 98)
assert.equal((await returnGoodsService.receive(g3a)).replayed, true)
await assert.rejects(() => returnGoodsService.receive({ ...g3a, eventKey: 'f5-staged-over-receipt', qty: 3 }), /تغییر|تازه/)
const g3b = { ...g3a, eventKey: 'f5-staged-receipt-002', qty: 2, witnessRef: 'دو کالای دیگر شمارش شد' }
assert.equal((await returnGoodsService.receive(g3b)).allReceived, true)
const stageTwo = seed.one('SELECT stockNote, stockReleasedQty FROM "CardTransferRequest" WHERE id = ?', r3.cardTransfer.id)
assert.equal(stageTwo.stockReleasedQty, 3)
assert.match(stageTwo.stockNote, /3 عدد.*رسید فیزیکیِ شاهددار.*نتیجهٔ بانک مستقل/)
assert.doesNotMatch(stageTwo.stockNote, /هنوز بدون شاهد/)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', v3).stock, 100)
assert.equal((await viewReturnEntitlement(r3.id)).cashReserved, 300)
assert.equal(seed.one('SELECT COUNT(*) AS n FROM "ReturnGoodsReceipt" WHERE returnId = ?', r3.id).n, 2)
console.log('✓ physical 3 units arrive 1+2 with witnesses; stale third rejected; no bank confirmation')

// دو قلم مستقل: رسید قلم اول نباید قلم دوم را دریافت‌شده یا موجودی آن را
// افزایش‌یافته جلوه دهد؛ پس از هر دو شاهد، درخواست یک متن/تعداد جمعی دارد.
const v4a = variant(100), v4b = variant(100)
const s4 = await salesService.create({ userId, shiftId,
  lines: [v4a, v4b].map((variantId) => ({ variantId, qty: 1, unitPrice: 100, discount: 0, tax: 0 })),
  payments: [{ methodId, amount: 200, destination: 'CASH' }] })
const saleItems4 = seed.rows('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId = ? ORDER BY id', s4.id)
const r4 = await salesService.createReturn({ invoiceId: s4.id, full: true,
  lines: saleItems4.map(({ id }) => ({ saleItemId: id, qty: 1 })),
  refundMethod: 'CARD_TO_CARD', refundAmount: 200, userId, shiftId })
const goods4 = (await returnGoodsService.items(r4.id)).items
assert.equal(goods4.length, 2)
const before4 = await returnGoodsService.receive({
  returnId: r4.id, returnItemId: goods4[0].id, qty: 1,
  eventKey: 'f5-multi-item-receipt-001', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'قلم اول جداگانه شمارش شد', physicalConfirmed: true, actorUserId: userId
})
assert.equal(before4.allReceived, false)
assert.equal(seed.one('SELECT restockPending FROM "SaleReturn" WHERE id = ?', r4.id).restockPending, 1)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', goods4[0].variantId).stock, 100)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', goods4[1].variantId).stock, 99)
const note4a = seed.one('SELECT stockNote, stockReleasedQty FROM "CardTransferRequest" WHERE id = ?', r4.cardTransfer.id)
assert.equal(note4a.stockReleasedQty, 1)
assert.match(note4a.stockNote, /1 عدد.*رسید فیزیکیِ شاهددار.*1 عدد هنوز بدون شاهد/)
const after4 = await returnGoodsService.receive({
  returnId: r4.id, returnItemId: goods4[1].id, qty: 1,
  eventKey: 'f5-multi-item-receipt-002', witnessKind: 'SELECTED_CONFIRMED',
  witnessRef: 'قلم دوم جداگانه شمارش شد', physicalConfirmed: true, actorUserId: userId
})
assert.equal(after4.allReceived, true)
assert.equal(seed.one('SELECT restockPending FROM "SaleReturn" WHERE id = ?', r4.id).restockPending, 0)
assert.equal(seed.one('SELECT stock FROM "ProductVariant" WHERE id = ?', goods4[1].variantId).stock, 100)
const note4b = seed.one('SELECT stockNote, stockReleasedQty FROM "CardTransferRequest" WHERE id = ?', r4.cardTransfer.id)
assert.equal(note4b.stockReleasedQty, 2)
assert.match(note4b.stockNote, /2 عدد.*رسید فیزیکیِ شاهددار.*نتیجهٔ بانک مستقل/)
assert.equal((await viewReturnEntitlement(r4.id)).cashReserved, 200)
console.log('✓ two different returned items received independently; pending, note and bank reservation remain truthful')
