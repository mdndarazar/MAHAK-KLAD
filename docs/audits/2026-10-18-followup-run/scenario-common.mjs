import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.HARNESS_DIR = mkdtempSync(join(tmpdir(), `s-${process.argv[2] ?? 'x'}-`))
process.env.HARNESS_DB = join(process.env.HARNESS_DIR, 'shop.db')
export const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
export const { makeSeeder } = await import('../../test/harness/seed.mjs')
export const { salesService } = await import('../../src/main/services/SalesService.ts')
export const { issueStoreCredit, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
export const { cashboxService } = await import('../../src/main/services/CashboxService.ts')
export const { toJalaliDate } = await import('@shared/jalali')
export const db = harnessClient(), seed = makeSeeder(db), sql = db.$harness.db
export const userId = seed.user(`scenario-${process.argv[2] ?? 'x'}`), cat = seed.category('c')
export const shiftId = seed.insert('Shift', { name:'s', number:1, userId, openedAt:Date.now()-60000, dayJalali:toJalaliDate(new Date()), staffConfirmed:1 })
export const cash = seed.insert('PaymentMethod',{key:'CASH',kind:'CASH',label:'Cash',isActive:1})
export const v = p => { const id=seed.variant(seed.product('p',cat)); sql.prepare('UPDATE "ProductVariant" SET salePrice=?,stock=10 WHERE id=?').run(p,id); return id }
export const line = (id,p) => ({variantId:id,qty:1,unitPrice:p,discount:0,tax:0})
export const rows = (q,...a) => seed.rows(q,...a).map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='bigint'?Number(v):v])))
export const attempt = async (fn) => { try { return {ok:true,value:await fn()} } catch(e) { return {ok:false,error:String(e?.message??e).split('\n')[0],code:e?.code??null} } }
export const snap = () => ({
 returns: rows('SELECT id,invoiceId,kind,total,refundAmount,refundMethod,creditRestored,goodsReceiptRequired FROM "SaleReturn" ORDER BY id'),
 credits: rows('SELECT id,amount,source,status,usedAmount,expiresAt,returnId,sourceInvoiceId FROM "StoreCredit" ORDER BY id'),
 allocations: rows('SELECT returnId,invoiceId,kind,amount,successorCreditId,parentCreditId,rootCreditId,originalExpiresAt FROM "CreditReturnAllocation" ORDER BY id'),
 deliveries: rows('SELECT creditId,status,sourceKind,originCreditId FROM "CreditDelivery" ORDER BY id'),
 redemptions: rows('SELECT invoiceId,creditId,amount,reversedAt FROM "StoreCreditRedemption" ORDER BY id'),
 stock: rows('SELECT id,stock FROM "ProductVariant" ORDER BY id'),
 movements: rows('SELECT type,amount,shiftId,refType,refId FROM "CashMovement" ORDER BY id')
})
