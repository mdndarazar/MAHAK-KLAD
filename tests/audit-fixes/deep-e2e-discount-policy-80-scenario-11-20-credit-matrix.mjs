/**
 * Discount Policy 80 / S11-S20 barcode and tender matrix.
 * One invocation uses one fresh isolated SQLite DB and one pre-declared branch.
 * Test-only; never touches production source, live DB, staging, or real money.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const scenario=String(process.env.MAHK_D80_SCENARIO??'S11').toUpperCase()
const caseKey=process.env.MAHK_D80_CASE??''
const returnMode=String(process.env.MAHK_D80_MODE??'CASH').toUpperCase()
const tender=String(process.env.MAHK_D80_TENDER??'CASH').toUpperCase()
const returnModes=['CASH','CARD','CARD_TO_CARD','STORE_CREDIT','NONE']
assert.ok(/^S(1[1-9]|20)$/.test(scenario),`invalid scenario ${scenario}`)
assert.ok(returnModes.includes(returnMode),`invalid return mode ${returnMode}`)
const L=(price,qty=1,discount=0)=>({unitPrice:price,qty,discount})
const pct=(base,p)=>Math.round(base*p/100)
function createCases(id){
 if(id==='S11')return[
  {key:'single-use-full-redemption',discountLabel:'invoice 10%',discountKind:'PERCENT',lines:[L(200000)],discount:pct(200000,10),credits:[{amount:50000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:50000}],tender:'CASH'}],return:{invoice:0,items:[0]}},
  {key:'single-use-partial-redemption',discountLabel:'invoice 10%',discountKind:'PERCENT',lines:[L(200000)],discount:pct(200000,10),credits:[{amount:100000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:50000}],tender:'CASH'}],return:{invoice:0,items:[0]}}
 ]
 if(id==='S12')return[
  {key:'single-use-pos',discountLabel:'fixed invoice discount 12,500',discountKind:'FIXED_RIAL',lines:[L(200000)],discount:12500,credits:[{amount:40000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:40000}],tender:'POS'}],return:{invoice:0,items:[0]}},
  {key:'multi-use-code-two-pos-invoices',discountLabel:'fixed invoice discount 12,500 each invoice',discountKind:'FIXED_RIAL',lines:[L(200000)],discount:12500,credits:[{amount:100000,multi:true,carry:true}],invoices:[{creditUses:[{credit:0,amount:25000}],tender:'POS'},{creditUses:[{credit:0,amount:20000}],tender:'POS'}],return:{invoice:1,items:[0]}}
 ]
 if(id==='S13')return[
  {key:'cash-heavy-75-25',discountLabel:'invoice 7.5%',discountKind:'PERCENT',lines:[L(200000)],discount:pct(200000,7.5),credits:[{amount:45000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:45000}],tender:'CASH_HEAVY'}],return:{invoice:0,items:[0]}},
  {key:'card-heavy-25-75',discountLabel:'invoice 7.5%',discountKind:'PERCENT',lines:[L(200000)],discount:pct(200000,7.5),credits:[{amount:45000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:45000}],tender:'CARD_HEAVY'}],return:{invoice:0,items:[0]}}
 ]
 if(id==='S14')return[
  {key:'small-credit-first',discountLabel:'fixed invoice discount 17,000',discountKind:'FIXED_RIAL',lines:[L(100000),L(100000)],discount:17000,credits:[{amount:25000,multi:false,carry:true},{amount:65000,multi:false,carry:true}],creditOrder:[0,1],invoices:[{creditUses:[{credit:0,amount:25000},{credit:1,amount:65000}],tender:'CASH'}],return:{invoice:0,items:[0,1]}},
  {key:'large-credit-first',discountLabel:'fixed invoice discount 17,000',discountKind:'FIXED_RIAL',lines:[L(100000),L(100000)],discount:17000,credits:[{amount:25000,multi:false,carry:true},{amount:65000,multi:false,carry:true}],creditOrder:[1,0],invoices:[{creditUses:[{credit:1,amount:65000},{credit:0,amount:25000}],tender:'CASH'}],return:{invoice:0,items:[0,1]}}
 ]
 if(id==='S15')return[
  {key:'reuse-two-live-codes-within-one-invoice',discountLabel:'invoice 10%',discountKind:'PERCENT',lines:[L(100000),L(200000)],discount:pct(300000,10),credits:[{amount:100000,multi:true,carry:true},{amount:80000,multi:true,carry:true}],invoices:[{creditUses:[{credit:0,amount:20000},{credit:0,amount:10000},{credit:1,amount:30000}],tender:'CASH'}],extraCash:30000,return:{invoice:0,items:[0]}}
 ]
 if(id==='S16'){
  const out=[]
  for(const scope of ['one-item-return','multi-item-return'])for(const saleTender of ['CASH','POS','SPLIT'])out.push({key:`${scope}-${saleTender.toLowerCase()}`,discountLabel:'fixed invoice discount 30,000',discountKind:'FIXED_RIAL',lines:[L(100000),L(100000),L(100000)],discount:30000,credits:[{amount:30000,multi:false,carry:true},{amount:30000,multi:false,carry:true},{amount:30000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:30000},{credit:1,amount:30000},{credit:2,amount:30000}],tender:saleTender}],return:{invoice:0,items:scope==='one-item-return'?[0]:[0,1]}})
  return out
 }
 if(id==='S17')return[
  {key:'partial-use-three-unequal-codes',discountLabel:'invoice 6%',discountKind:'PERCENT',lines:[L(300000)],discount:pct(300000,6),credits:[{amount:30000,multi:false,carry:true},{amount:50000,multi:false,carry:true},{amount:70000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:10000},{credit:1,amount:20000},{credit:2,amount:30000}],tender:'CASH'}],return:{invoice:0,items:[0]}},
  {key:'forward-order-spend',discountLabel:'fixed invoice discount 17,000',discountKind:'FIXED_RIAL',lines:[L(300000)],discount:17000,credits:[{amount:20000,multi:false,carry:true},{amount:40000,multi:false,carry:true},{amount:60000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:20000},{credit:1,amount:40000},{credit:2,amount:60000}],tender:'CASH'}],return:{invoice:0,items:[0]}},
  {key:'reverse-order-spend',discountLabel:'fixed invoice discount 17,000',discountKind:'FIXED_RIAL',lines:[L(300000)],discount:17000,credits:[{amount:20000,multi:false,carry:true},{amount:40000,multi:false,carry:true},{amount:60000,multi:false,carry:true}],invoices:[{creditUses:[{credit:2,amount:60000},{credit:1,amount:40000},{credit:0,amount:20000}],tender:'CASH'}],return:{invoice:0,items:[0]}},
  {key:'zero-balance-exact-tender',discountLabel:'fixed invoice discount 10,000',discountKind:'FIXED_RIAL',lines:[L(160000)],discount:10000,credits:[{amount:30000,multi:false,carry:true},{amount:50000,multi:false,carry:true},{amount:70000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0,amount:30000},{credit:1,amount:50000},{credit:2,amount:70000}],tender:'CASH'}],return:{invoice:0,items:[0]}},
  {key:'credit-value-over-sale-amount',discountLabel:'invoice 10%',discountKind:'PERCENT',lines:[L(200000)],discount:pct(200000,10),credits:[{amount:70000,multi:false,carry:true},{amount:60000,multi:false,carry:true},{amount:60000,multi:false,carry:true}],invoices:[{creditUses:[{credit:0},{credit:1},{credit:2}],tender:'CASH'}],return:{invoice:0,items:[0]}}
 ]
 if(id==='S18')return[
  {key:'six-single-use-fully-spent',discountLabel:'fixed invoice discount 40,000',discountKind:'FIXED_RIAL',lines:[L(400000)],discount:40000,credits:Array.from({length:6},()=>({amount:10000,multi:false,carry:true})),invoices:[{creditUses:Array.from({length:6},(_,credit)=>({credit,amount:10000})),tender:'CASH'}],return:{invoice:0,items:[0]}},
  {key:'six-single-use-partially-spent',discountLabel:'fixed invoice discount 40,000',discountKind:'FIXED_RIAL',lines:[L(400000)],discount:40000,credits:Array.from({length:6},()=>({amount:20000,multi:false,carry:true})),invoices:[{creditUses:Array.from({length:6},(_,credit)=>({credit,amount:10000})),tender:'CASH'}],return:{invoice:0,items:[0]}}
 ]
 if(id==='S19')return[
  {key:'six-multi-use-partial-redemption',discountLabel:'invoice 9%',discountKind:'PERCENT',lines:[L(400000)],discount:pct(400000,9),credits:Array.from({length:6},()=>({amount:30000,multi:true,carry:true})),invoices:[{creditUses:Array.from({length:6},(_,credit)=>({credit,amount:10000})),tender:'CASH'}],return:{invoice:0,items:[0]}}
 ]
 if(id==='S20')return[
  {key:'multiuse-credit-used-again-on-second-invoice',discountLabel:'fixed invoice discount 12,345 on both invoices',discountKind:'FIXED_RIAL',lines:[L(100000)],discount:12345,credits:[{amount:100000,multi:true,carry:true}],invoices:[{creditUses:[{credit:0,amount:20000}],tender:'POS'},{creditUses:[{credit:0,amount:30000}],tender:'POS'}],return:{invoice:1,items:[0]}}
 ]
 throw new Error('scenario missing '+id)
}
const specs=createCases(scenario),spec=specs.find(x=>x.key===caseKey)
assert.ok(spec,`unknown ${scenario} case ${caseKey}`)
const dir=mkdtempSync(join(tmpdir(),`mahak-d80-${scenario.toLowerCase()}-`));process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {storeCreditService}=await import('../../src/main/services/StoreCreditService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user(`D80 ${scenario} ${caseKey} ${returnMode}`)
const shiftId=seed.insert('Shift',{name:`D80 ${scenario} ${caseKey} ${returnMode}`,number:91100+Number(scenario.slice(1))*100+specs.indexOf(spec)*10+returnModes.indexOf(returnMode),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`D80-${scenario}-${caseKey}-${returnMode}-CASH`,label:'audit cash',kind:'CASH',isActive:1,sortOrder:1})
const card=seed.insert('PaymentMethod',{key:`D80-${scenario}-${caseKey}-${returnMode}-CARD`,label:'audit POS',kind:'CARD',isActive:1,sortOrder:2})
const category=seed.category(`discount80-${scenario}-${caseKey}-${returnMode}`)
const variants=[],creditRows=[],checkpoints=[],invoices=[]
let productNo=0,expectedStock=0
const expected={cash:0,card:0,refundCash:0,refundCard:0}
const createVariant=(price,label)=>{const p=seed.product(`D80 ${scenario} ${caseKey} ${++productNo} ${label}`,category),id=seed.variant(p,`D80-${scenario}-${specs.indexOf(spec)}-${productNo}-${returnMode}`);sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(price,id);variants.push({id,price,label});expectedStock+=20;return id}
const rawFinancial=()=>{const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash,COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId);const c=seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId);const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId);return{cash:n(p.cash),card:n(p.card),refundCash:n(c.amount),refundCard:n(r.amount)}}
const stockSnapshot=()=>variants.map(v=>{const actual=n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',v.id).stock),ledger=n(seed.one('SELECT COALESCE(SUM(delta),0) d FROM "StockMovement" WHERE variantId=?',v.id).d);return{variantId:v.id,label:v.label,expected:expectedStockByVariant.get(v.id),actual,ledger}})
const expectedStockByVariant=new Map()
const deliveryFor=creditId=>{const d=seed.one('SELECT id,status,handoffType,createdAt,deliveredAt,userId,note,policyVersion FROM "StoreCreditDelivery" WHERE creditId=? ORDER BY id DESC LIMIT 1',creditId);return d?{id:n(d.id),status:d.status,handoffType:d.handoffType,createdAt:n(d.createdAt),deliveredAt:d.deliveredAt==null?null:n(d.deliveredAt),userId:d.userId==null?null:n(d.userId),note:d.note,policyVersion:d.policyVersion}:null}
async function checkpoint(label){const report=await salesService.reportRows({shiftId});const service={cash:n(report.totals.cashTotal),card:n(report.totals.cardTotal),refundCash:n(report.totals.refundCashTotal),refundCard:n(report.totals.refundCardTotal)};const raw=rawFinancial();assert.deepEqual(service,expected,`${label}: service financial totals`);assert.deepEqual(raw,expected,`${label}: raw financial documents`);const blue=n(await physicalMovementForCustodyShift(shiftId)),blueExpected=expected.cash+expected.card-expected.refundCash-expected.refundCard;assert.equal(blue,blueExpected,`${label}: blue reconciliation`);const stocks=stockSnapshot();for(const s of stocks){assert.equal(s.actual,s.expected,`${label}: expected inventory ${s.label}`);assert.equal(s.actual,20+s.ledger,`${label}: inventory ledger ${s.label}`)}const credits=seed.rows('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope,source,returnId,exchangeInvoiceId FROM "StoreCredit" ORDER BY id').map(c=>({id:n(c.id),code:c.code,amount:n(c.amount),usedAmount:n(c.usedAmount),usedCount:n(c.usedCount),status:c.status,expiresAt:c.expiresAt==null?null:n(c.expiresAt),restrictScope:c.restrictScope,source:c.source,returnId:c.returnId==null?null:n(c.returnId),exchangeInvoiceId:c.exchangeInvoiceId==null?null:n(c.exchangeInvoiceId),delivery:deliveryFor(c.id)}));checkpoints.push({label,expected:{...expected,blue:blueExpected},actualService:service,actualRaw:raw,blue,stocks,credits,counts:{invoices:seed.count('SaleInvoice','shiftId=?',shiftId),returns:seed.count('SaleReturn','shiftId=?',shiftId),payments:seed.count('Payment','createdShiftId=?',shiftId),credits:seed.count('StoreCredit'),deliveries:seed.count('StoreCreditDelivery'),checks:seed.count('Payment',`createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`,shiftId)}});return credits}
function allocateNet(lines,discount){const bases=lines.map(x=>x.unitPrice*x.qty-x.discount),base=bases.reduce((a,b)=>a+b,0),net=base-discount;const parts=bases.map((x,i)=>({i,v:Math.floor(net*x/base),r:net*x/base-Math.floor(net*x/base)}));let left=net-parts.reduce((s,x)=>s+x.v,0);for(const p of [...parts].sort((a,b)=>b.r-a.r||a.i-b.i)){if(left<=0)break;p.v++;left--}return{base,net,shares:parts.map(p=>p.v)}}
const result={generatedAt:new Date().toISOString(),campaign:'Discount Policy 80',scenario:`D80-${scenario}`,case:caseKey,returnMode,fixture:{discountLabel:spec.discountLabel,discountKind:spec.discountKind,lines:spec.lines,invoiceDiscount:spec.discount},saleTenders:spec.invoices.map(x=>x.tender),isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING',creditIssue:[],sales:[],redemptions:[],returns:[],sourceCreditSuccessors:[],managerTransfers:[],checkpoints,findings:[]}
let finalError=null,underfundedSale=false
try{
 await checkpoint('fresh isolated DB')
 for(const c of spec.credits){const issued=await storeCreditService.issueManual({amount:c.amount,multiUse:c.multi,maxUses:c.multi?20:null,carryRemainder:c.carry,restrictScope:'ALL',days:30,userId,managerPassword:DEFAULT_MANAGER_PASSWORD});const row=seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope,source FROM "StoreCredit" WHERE id=?',issued.id);assert.equal(row.restrictScope,'ALL');const cr={id:n(row.id),code:row.code,amount:n(row.amount),multiUse:c.multi,carryRemainder:c.carry,usedAmount:n(row.usedAmount),usedCount:n(row.usedCount),status:row.status,expiresAt:row.expiresAt==null?null:n(row.expiresAt),restrictScope:row.restrictScope,source:row.source};creditRows.push(cr);result.creditIssue.push(cr)}
 await checkpoint('all test-only ALL barcodes issued')
 const invoiceItemsById=[]
 for(let invoiceIndex=0;invoiceIndex<spec.invoices.length;invoiceIndex++){
   const invSpec=spec.invoices[invoiceIndex],lines=spec.lines.map((l,i)=>({variantId:createVariant(l.unitPrice,`inv${invoiceIndex+1}-item${i+1}`),qty:l.qty,unitPrice:l.unitPrice,discount:l.discount,tax:0}))
   const calc=allocateNet(spec.lines,spec.discount),requestedCredit=invSpec.creditUses.reduce((s,u)=>s+(u.amount??creditRows[u.credit].amount),0)
   let creditUses=invSpec.creditUses.map(u=>({code:creditRows[u.credit].code,...(u.amount!=null?{requestedAmount:u.amount}:{})}))
   if(spec.creditOrder)creditUses=[...creditUses]
   let paidNeed=Math.max(0,calc.net-Math.min(calc.net,requestedCredit))
   let cashAmount=0,cardAmount=0
   const saleTender=invSpec.tender??'CASH'
   if(saleTender==='CASH')cashAmount=paidNeed
   else if(saleTender==='POS')cardAmount=paidNeed
   else if(saleTender==='SPLIT'){cashAmount=Math.floor(paidNeed/2);cardAmount=paidNeed-cashAmount}
   else if(saleTender==='CASH_HEAVY'){cashAmount=Math.floor(paidNeed*.75);cardAmount=paidNeed-cashAmount}
   else if(saleTender==='CARD_HEAVY'){cashAmount=Math.floor(paidNeed*.25);cardAmount=paidNeed-cashAmount}
   else throw new Error('unsupported sale tender '+saleTender)
   if(invoiceIndex===0&&spec.extraCash)cashAmount+=spec.extraCash
   const payments=[...(cashAmount?[{methodId:cash,amount:cashAmount,destination:'CASH'}]:[]),...(cardAmount?[{methodId:card,amount:cardAmount,destination:'CARD'}]:[])]
   const sale=await salesService.create({userId,shiftId,lines,invoiceDiscount:spec.discount,payments,storeCredits:creditUses,saleRequestIdempotencyKey:`d80-${scenario}-${caseKey}-${returnMode}-sale-${invoiceIndex+1}`})
   const invoice=seed.one('SELECT id,grandTotal,discountTotal,paidTotal,status,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
   const saleItems=seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
   assert.equal(n(invoice.grandTotal),calc.net,`invoice ${invoiceIndex+1} net after direct/amount discount`)
   assert.equal(n(invoice.discountTotal),spec.lines.reduce((s,l)=>s+l.discount,0)+spec.discount,`invoice ${invoiceIndex+1} discount total`)
   assert.equal(saleItems.length,spec.lines.length)
   for(let i=0;i<saleItems.length;i++){assert.equal(n(saleItems[i].lineTotal),spec.lines[i].unitPrice*spec.lines[i].qty-spec.lines[i].discount);expectedStockByVariant.set(n(saleItems[i].variantId),20-spec.lines[i].qty);expectedStock-=spec.lines[i].qty}
   expected.cash+=cashAmount;expected.card+=cardAmount
   const redemptionRows=seed.rows('SELECT id,creditId,invoiceId,amount,reversedAt FROM "StoreCreditRedemption" WHERE invoiceId=? ORDER BY id',sale.id).map(x=>({id:n(x.id),creditId:n(x.creditId),invoiceId:n(x.invoiceId),amount:n(x.amount),reversedAt:x.reversedAt}))
   const redAmount=redemptionRows.reduce((s,x)=>s+x.amount,0)
   assert.equal(redAmount,n(sale.storeCreditApplied??redAmount),'raw barcode redemption total equals sale service result')
   result.redemptions.push(...redemptionRows)
   result.sales.push({id:n(invoice.id),invoiceIndex:invoiceIndex+1,gross:spec.lines.reduce((s,l)=>s+l.unitPrice*l.qty,0),lineDiscount:spec.lines.reduce((s,l)=>s+l.discount,0),invoiceDiscount:spec.discount,totalDiscount:n(invoice.discountTotal),net:n(invoice.grandTotal),paid:n(invoice.paidTotal),storeCreditRequested:Math.min(calc.net,requestedCredit),storeCreditApplied:n(sale.storeCreditApplied??redAmount),cashTender:cashAmount,posTender:cardAmount,tender:saleTender,settled:invoice.settledAt!=null,items:saleItems.map((it,i)=>({id:n(it.id),variantId:n(it.variantId),qty:n(it.qty),gross:spec.lines[i].unitPrice*spec.lines[i].qty,lineDiscount:spec.lines[i].discount,netShare:calc.shares[i]}))})
   invoiceItemsById.push(saleItems)
   if(n(sale.storeCreditApplied??redAmount)!==Math.min(calc.net,requestedCredit)){
     result.status='POLICY_MISMATCH';result.operationOutcome='BARCODE_REDEMPTION_SHORTFALL_RECORDED'
     result.findings.push({kind:'barcode-redemption-shortfall',invoiceId:n(invoice.id),requestedCredit:Math.min(calc.net,requestedCredit),actualCreditApplied:n(sale.storeCreditApplied??redAmount),supplementalCash:spec.extraCash??0,explanation:'Actual barcode application did not match the three requested redemption shares. The discrepancy remains explicit; any added cash tender is separately shown.'})
   }
   await checkpoint(`invoice ${invoiceIndex+1} sold, barcode redemption + cash/POS reconciled`)
   if(n(invoice.paidTotal)!==calc.net){
     underfundedSale=true;result.status='POLICY_MISMATCH';result.operationOutcome='SALE_SETTLED_AMOUNT_MISMATCH_RETURN_NOT_ATTEMPTED'
     result.findings.push({kind:'settlement-mismatch',invoiceId:n(invoice.id),expectedNet:calc.net,recordedPaidTotal:n(invoice.paidTotal),expectedCreditFromInputs:Math.min(calc.net,requestedCredit),actualCreditApplied:n(sale.storeCreditApplied??redAmount),cashPaid:cashAmount,posPaid:cardAmount,invoiceStatus:invoice.status,settledAt:invoice.settledAt,explanation:'Credit tender was submitted more than once for the same barcode on this invoice; the test records the settlement mismatch and deliberately does not collect the shortfall or continue to a return.'})
     break
   }
   assert.ok(invoice.settledAt!=null)
 }
 if(!underfundedSale){
 const targetInvoiceIndex=spec.return.invoice, saleRecord=result.sales[targetInvoiceIndex], saleItems=invoiceItemsById[targetInvoiceIndex], returnedSpec=spec.return.items.map(i=>({i,q:spec.lines[i].qty}))
 const calc=allocateNet(spec.lines,spec.discount),returnTotal=returnedSpec.reduce((s,t)=>s+calc.shares[t.i],0)
 const sourceRows=seed.rows('SELECT amount FROM "StoreCreditRedemption" WHERE invoiceId=? AND reversedAt IS NULL ORDER BY id',saleRecord.id)
 const sourceAvailable=sourceRows.reduce((s,r)=>s+n(r.amount),0)
 const expectedSourceReturn=Math.min(returnTotal,sourceAvailable)
 const expectedMoneyRight=returnTotal-expectedSourceReturn
 const returnInput={userId,shiftId,invoiceId:saleRecord.id,full:returnTotal===calc.net,lines:returnedSpec.map(t=>({saleItemId:n(saleItems[t.i].id),qty:t.q}))}
 if(returnMode==='CASH')Object.assign(returnInput,{refundMethod:'CASH',refundAmount:expectedMoneyRight})
 if(returnMode==='CARD')Object.assign(returnInput,{refundMethod:'CARD',refundAmount:expectedMoneyRight,cardPosOverride:{acknowledgedNoReverse:true,reason:`D80 ${scenario} ${caseKey} POS return`,managerPassword:DEFAULT_MANAGER_PASSWORD}})
 if(returnMode==='CARD_TO_CARD')Object.assign(returnInput,{refundMethod:'CARD_TO_CARD',refundAmount:expectedMoneyRight})
 if(returnMode==='STORE_CREDIT')Object.assign(returnInput,{refundMethod:'STORE_CREDIT',refundAmount:expectedMoneyRight,creditDays:30})
 if(returnMode==='NONE')Object.assign(returnInput,{refundMethod:'NONE',confirmOverpay:true,overpayAsCredit:true,overpayManagerPassword:DEFAULT_MANAGER_PASSWORD})
 let returned
 try{returned=await salesService.createReturn(returnInput)}catch(e){finalError=String(e?.message??e);result.operationOutcome='RETURN_BLOCKED';result.findings.push({kind:'return-blocked',message:finalError})}
 if(returned){
   const row=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,exchangeSettlement,voidedAt FROM "SaleReturn" WHERE id=?',returned.id)
   assert.equal(n(row.total),returnTotal,'official return total must equal net value of selected discounted item(s)')
   const sourceSuccessors=(returned.sourceCreditSuccessors??[]).map(x=>({id:n(x.id),code:x.code,amount:n(x.amount),status:x.status,expiresAt:x.expiresAt??null}))
   result.sourceCreditSuccessors=sourceSuccessors
   const transferRow=returnMode==='CARD_TO_CARD'?seed.one('SELECT id,status,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE returnId=?',row.id):null
   if(transferRow){assert.equal(transferRow.status,'PENDING');result.managerTransfers.push({id:n(transferRow.id),status:transferRow.status,amount:n(transferRow.amount)});await checkpoint('C2C request pending; source and cash ledgers retained');await cardTransferService.pay({id:n(transferRow.id),paidAmount:n(transferRow.amount),userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`D80-${scenario}-${caseKey}`});const paid=seed.one('SELECT id,status,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE id=?',transferRow.id);assert.equal(paid.status,'PAID');result.managerTransfers.push({id:n(paid.id),status:paid.status,amount:n(paid.amount),paidAmount:n(paid.paidAmount),method:paid.paidMethod,trackingNo:paid.trackingNo})}
   if(returnMode==='CASH')expected.refundCash+=n(row.refundAmount)
   if(returnMode==='CARD')expected.refundCard+=n(row.refundAmount)
   const returnCredits=seed.rows('SELECT id,code,amount,usedAmount,status,expiresAt,source,returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id',row.id).map(c=>({id:n(c.id),code:c.code,amount:n(c.amount),usedAmount:n(c.usedAmount),status:c.status,expiresAt:c.expiresAt==null?null:n(c.expiresAt),source:c.source,returnId:c.returnId==null?null:n(c.returnId),delivery:deliveryFor(c.id)}))
   const returnCreditValue=returnCredits.reduce((s,c)=>s+c.amount,0)
   const sourceAlloc=seed.rows('SELECT id,redemptionId,sourceCreditId,amount,creditRestored FROM "CreditReturnAllocation" WHERE returnId=? ORDER BY id',row.id).map(a=>({id:n(a.id),redemptionId:n(a.redemptionId),sourceCreditId:n(a.sourceCreditId),amount:n(a.amount),creditRestored:!!a.creditRestored}))
   const sourceCreditReturned=n(returned.returnCreditAmount)
   assert.equal(sourceCreditReturned,expectedSourceReturn,'ALL credit restoration remains pooled at invoice level; no per-item share is fabricated')
   const managerPaid=returnMode==='CARD_TO_CARD'?n(seed.one('SELECT COALESCE(SUM(paidAmount),0) amount FROM "CardTransferRequest" WHERE returnId=? AND status=\'PAID\'',row.id).amount):0
   const actualMoneyRefund=returnMode==='CASH'||returnMode==='CARD'?n(row.refundAmount):managerPaid
   const overpayCredit=returned.overpayCredit?.amount?n(returned.overpayCredit.amount):0
   const overpayCreditId=returned.overpayCredit?.id==null?null:n(returned.overpayCredit.id)
   const nonSourceCredits=returnCredits.filter(c=>!sourceSuccessors.some(s=>s.id===c.id)&&c.id!==overpayCreditId).reduce((s,c)=>s+c.amount,0)
   const benefit=sourceCreditReturned+actualMoneyRefund+nonSourceCredits+overpayCredit
   assert.ok(benefit<=returnTotal,`refund+source credit+new credit ${benefit} must not exceed returned net ${returnTotal}`)
   if(benefit!==returnTotal){result.status='POLICY_MISMATCH';result.operationOutcome='RETURN_VALUE_NOT_FULLY_RECONCILED';result.findings.push({kind:'return-entitlement-shortfall',expectedNet:returnTotal,actualCustomerValue:benefit,shortfall:returnTotal-benefit,sourceCreditReturned,realMoneyRefund:actualMoneyRefund,newMoneyBackedCredit:nonSourceCredits+overpayCredit,refundMode:returnMode,explanation:'The returned discounted value was not fully restored as original credit, real-money refund, or the policy-approved no-expiry credit for the money-backed share.'})}
   if(returnMode==='CARD_TO_CARD'&&transferRow)assert.equal(n(transferRow.amount),Math.max(0,returnTotal-sourceCreditReturned),'C2C request is backed by money after barcode-source restoration')
   const returnItems=seed.rows('SELECT saleItemId,qty,unitPrice,lineTotal,restockedQty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',row.id).map(x=>({saleItemId:n(x.saleItemId),qty:n(x.qty),unitPrice:n(x.unitPrice),lineTotal:n(x.lineTotal),restockedQty:n(x.restockedQty)}))
   for(const t of returnedSpec){const vId=n(saleItems[t.i].variantId);if(returnMode==='CARD_TO_CARD'){}else expectedStockByVariant.set(vId,expectedStockByVariant.get(vId)+t.q);expectedStock+=returnMode==='CARD_TO_CARD'?0:t.q}
   result.returns.push({id:n(row.id),invoiceId:n(saleRecord.id),expectedNet:returnTotal,actualNet:n(row.total),expectedSourceCreditReturn:expectedSourceReturn,expectedMoneyBackedRight:expectedMoneyRight,refundMethod:row.refundMethod,refundAmount:n(row.refundAmount),refundStoreCreditAmount:n(row.refundStoreCreditAmount),sourceCreditReturned,sourceCreditRestoredAmount:n(returned.sourceCreditRestoredAmount),sourceCreditSuccessors:sourceSuccessors,creditReturnAllocations:sourceAlloc,createdCredits:returnCredits,noMethodCreditExpected:returnMode==='NONE'?expectedMoneyRight:null,overpayCreditAmount:overpayCredit,customerValue:benefit,items:returnItems})
   if(returnMode==='CARD_TO_CARD'){
      for(const t of returnedSpec){const vId=n(saleItems[t.i].variantId);expectedStockByVariant.set(vId,expectedStockByVariant.get(vId)+t.q);expectedStock+=t.q}
   }
   await checkpoint(`official return ${returnMode}, expected net ${returnTotal}, source credits and stock reconciled`)
 }
 }
 // Explicit code state, per-source successors, usage count, remaining value and scope are captured.
 result.finalCreditState=creditRows.map(c=>{const r=seed.one('SELECT id,code,amount,usedAmount,usedCount,status,expiresAt,restrictScope,source FROM "StoreCredit" WHERE id=?',c.id);return{id:n(r.id),code:r.code,amount:n(r.amount),usedAmount:n(r.usedAmount),usedCount:n(r.usedCount),status:r.status,expiresAt:r.expiresAt==null?null:n(r.expiresAt),restrictScope:r.restrictScope,source:r.source,delivery:deliveryFor(c.id)}})
 if(returnMode==='CARD_TO_CARD'&&result.returns.length){for(const m of result.managerTransfers.filter(x=>x.status==='PAID'))assert.equal(m.paidAmount,m.amount)}
 if(result.status!=='POLICY_MISMATCH')result.status=finalError?'BLOCKED':'PASS'
 result.operationOutcome=result.operationOutcome??'COMPLETED'
} catch(e){result.status='FAIL';result.unexpectedError=String(e?.stack??e);throw e}
finally{
 result.final={expected:{...expected,blue:expected.cash+expected.card-expected.refundCash-expected.refundCard},actual:rawFinancial(),blue:n(await physicalMovementForCustodyShift(shiftId)),stocks:stockSnapshot(),invoiceCount:seed.count('SaleInvoice','shiftId=?',shiftId),returnCount:seed.count('SaleReturn','shiftId=?',shiftId),paymentCount:seed.count('Payment','createdShiftId=?',shiftId),creditCount:seed.count('StoreCredit'),deliveryCount:seed.count('StoreCreditDelivery'),checkCount:seed.count('Payment',`createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`,shiftId)}
 const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true})
 const suffix=tender.toLowerCase().replaceAll('_','-')
 const stem=`deep-e2e-discount-policy-80-${scenario.toLowerCase()}-${caseKey.toLowerCase()}-${suffix}-${returnMode.toLowerCase().replaceAll('_','-')}`
 writeFileSync(join(out,`${stem}.json`),JSON.stringify(result,null,2)+'\n')
 writeFileSync(join(out,`${stem}.md`),[
  `# بررسی تخفیف ۸۰ — ${scenario} / ${caseKey} / tender ${tender} / refund ${returnMode}`,'',
  `**وضعیت:** ${result.status}; DB SQLite تازه و ایزوله.`,`**Fixture تخفیف:** ${spec.discountLabel}؛ نوع ورودی ${spec.discountKind}؛ مبلغ ثبت‌شده ${spec.discount.toLocaleString('fa-IR')} ریال.`,
  `**فروش‌ها:** ${JSON.stringify(result.sales)}`,`**مصرف کدها:** ${JSON.stringify(result.redemptions)}`,`**برگشت:** ${JSON.stringify(result.returns)}`,`**ماندهٔ کدهای مبدأ:** ${JSON.stringify(result.finalCreditState??[])}`,`**تطبیق نهایی:** ${JSON.stringify(result.final)}`,`**مغایرت/رد ثبت‌شده:** ${JSON.stringify(result.findings)}`,
  'کدهای اعتبار ALL به‌صورت pool کل فاکتور درنظر گرفته شدند؛ هیچ سهم per-item ساختگی برای ALL اعمال نشده است. فقط DB تست ایزوله استفاده شد.'
 ].join('\n')+'\n')
}
if(result.status==='FAIL')process.exitCode=1
