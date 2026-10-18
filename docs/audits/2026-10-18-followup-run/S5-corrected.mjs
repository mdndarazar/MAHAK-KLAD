// CORRECTED S5 run (temp copy only). refundAmount=4,333,334 (not historical 4,333,333)
process.argv[2]='05-corrected'; const c=await import('./scenario-common.mjs')
const gift=await c.db.$transaction(tx=>c.issueStoreCredit(tx,{source:'MANUAL',amount:2000000,multiUse:false,maxUses:1,carryRemainder:false,days:7,userId:c.userId,note:'scenario gift'}))
const a=c.v(5000000),b=c.v(10000000)
const sale=await c.salesService.create({userId:c.userId,shiftId:c.shiftId,lines:[c.line(a,5000000),c.line(b,10000000)],payments:[{methodId:c.cash,amount:13000000,destination:'CASH'}],storeCreditCode:gift.code,storeCreditAmount:2000000,storeCreditIdempotencyKey:'s5c'})
const item=c.seed.one('SELECT id FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id).id
const before=c.snap()
const op=await c.attempt(()=>c.salesService.createReturn({invoiceId:sale.id,lines:[{saleItemId:item,qty:1}],full:false,refundMethod:'CASH',refundAmount:4333334,userId:c.userId,shiftId:c.shiftId}))
const after=c.snap()
// redeemability of any new credit (should be DRAFT / not spendable)
const newCredits=after.credits.filter(x=>x.id!==1)
const redeem=[]; for (const cr of newCredits){ const code=c.seed.one('SELECT code FROM "StoreCredit" WHERE id=?',cr.id).code; redeem.push({id:cr.id, status:cr.status, findRedeemable: await c.attempt(()=>c.db.$transaction(tx=>c.findRedeemable(tx,code))).then(r=>({ok:r.ok,error:r.ok?null:r.error.replace(/[A-Z0-9-]{6,}/g,'<redacted>')}))}) }
const leak=JSON.stringify(op).includes(gift.code)
console.log(JSON.stringify({scenario:'5-corrected',refundAmountInput:4333334,operation:{ok:op.ok,error:op.error??null,code:op.code??null},before,after,redeem,giftCodeLeakedInResult:leak}))
