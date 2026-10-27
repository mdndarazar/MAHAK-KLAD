/**
 * Discount Policy 80 / S03-S10 bounded-exhaustive test runner.
 * One process invocation = one fresh isolated SQLite DB and one scenario branch.
 * No production source, live DB, staging, or reset is modified.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const scenario = String(process.env.MAHK_D80_SCENARIO ?? 'S03').toUpperCase()
const caseKey = process.env.MAHK_D80_CASE ?? ''
const mode = String(process.env.MAHK_D80_MODE ?? 'CASH').toUpperCase()
const modes = ['CASH', 'CARD', 'CARD_TO_CARD', 'STORE_CREDIT', 'NONE']
assert.ok(['S03','S04','S05','S06','S07','S08','S09','S10'].includes(scenario), `unknown scenario ${scenario}`)
assert.ok(modes.includes(mode) || (scenario === 'S10' && mode === 'OVER_CAP_CONTROL'), `unknown return mode ${mode}`)

const L = (unitPrice, qty=1, discount=0) => ({ unitPrice, qty, discount })
const permute = arr => arr.length < 2 ? [arr] : arr.flatMap((x,i) => permute([...arr.slice(0,i),...arr.slice(i+1)]).map(p => [x,...p]))
function scenarioCases(id) {
  if (id === 'S03') {
    const lines=[L(100000),L(100000)]
    return [
      {key:'A-only',lines,invoiceDiscount:20000,steps:[[{i:0,q:1}]]},
      {key:'B-only',lines,invoiceDiscount:20000,steps:[[{i:1,q:1}]]},
      {key:'A-then-B',lines,invoiceDiscount:20000,steps:[[{i:0,q:1}],[{i:1,q:1}]]},
      {key:'B-then-A',lines,invoiceDiscount:20000,steps:[[{i:1,q:1}],[{i:0,q:1}]]},
      {key:'full-return',lines,invoiceDiscount:20000,steps:[[{i:0,q:1},{i:1,q:1}]],full:true},
    ]
  }
  if (id === 'S04') {
    const lines=[L(100001),L(200003),L(300007)], invoiceDiscount=Math.round(lines.reduce((s,x)=>s+x.unitPrice*x.qty,0)*0.07)
    const singles=lines.map((_,i)=>({key:`item-${i+1}-only`,lines,invoiceDiscount,steps:[[{i,q:1}]]}))
    const orders=permute([0,1,2]).map((order,n)=>({key:`order-${n+1}-${order.map(i=>String.fromCharCode(65+i)).join('')}`,lines,invoiceDiscount,steps:order.map(i=>[{i,q:1}])}))
    return [...singles,...orders,{key:'full-return',lines,invoiceDiscount,steps:[lines.map((_,i)=>({i,q:1}))],full:true}]
  }
  if (id === 'S05') {
    const lines=Array.from({length:10},()=>L(100000)), invoiceDiscount=100000
    return [...lines.map((_,i)=>({key:`item-${String(i+1).padStart(2,'0')}-only`,lines,invoiceDiscount,steps:[[{i,q:1}]]})),
      {key:'full-return',lines,invoiceDiscount,steps:[lines.map((_,i)=>({i,q:1}))],full:true}]
  }
  if (id === 'S06') {
    const prices=[100001,110003,120007,130009,140011,150013,160017,170021,180023,190027]
    const lines=prices.map(p=>L(p)), invoiceDiscount=12345
    return [...lines.map((_,i)=>({key:`item-${String(i+1).padStart(2,'0')}-only`,lines,invoiceDiscount,steps:[[{i,q:1}]]})),
      {key:'first-to-last',lines,invoiceDiscount,steps:prices.map((_,i)=>[{i,q:1}])},
      {key:'last-to-first',lines,invoiceDiscount,steps:prices.map((_,i)=>[{i:prices.length-1-i,q:1}])},
      {key:'full-return',lines,invoiceDiscount,steps:[prices.map((_,i)=>({i,q:1}))],full:true}]
  }
  if (id === 'S07') {
    const lines=[L(100000,3)], invoiceDiscount=30000
    return [
      {key:'qty-1-then-1-then-1',lines,invoiceDiscount,steps:[[{i:0,q:1}],[{i:0,q:1}],[{i:0,q:1}]]},
      {key:'qty-2-then-1',lines,invoiceDiscount,steps:[[{i:0,q:2}],[{i:0,q:1}]]},
      {key:'qty-3-full',lines,invoiceDiscount,steps:[[{i:0,q:3}]],full:true},
    ]
  }
  if (id === 'S08') {
    const lines=[L(100000,1,10000),L(200000)], invoiceDiscount=20000
    return [
      {key:'both-discounts-item-A',lines,invoiceDiscount,steps:[[{i:0,q:1}]]},
      {key:'invoice-only-item-B',lines,invoiceDiscount,steps:[[{i:1,q:1}]]},
      {key:'A-then-B-no-double-count',lines,invoiceDiscount,steps:[[{i:0,q:1}],[{i:1,q:1}]]},
      {key:'B-then-A-no-double-count',lines,invoiceDiscount,steps:[[{i:1,q:1}],[{i:0,q:1}]]},
      {key:'full-return-no-double-count',lines,invoiceDiscount,steps:[[{i:0,q:1},{i:1,q:1}]],full:true},
    ]
  }
  if (id === 'S09') {
    const lines=[L(100000,1,10000),L(100000),L(100000)]
    return [
      {key:'discounted-A-only',lines,invoiceDiscount:0,steps:[[{i:0,q:1}]]},
      {key:'undiscounted-B-only',lines,invoiceDiscount:0,steps:[[{i:1,q:1}]]},
      {key:'discounted-then-undiscounted',lines,invoiceDiscount:0,steps:[[{i:0,q:1}],[{i:1,q:1}]]},
      {key:'undiscounted-then-discounted',lines,invoiceDiscount:0,steps:[[{i:1,q:1}],[{i:0,q:1}]]},
      {key:'all-including-undiscounted-C',lines,invoiceDiscount:0,steps:[[{i:0,q:1},{i:1,q:1},{i:2,q:1}]],full:true},
    ]
  }
  if (id === 'S10') {
    const lines=[L(100000)]
    return [
      {key:'below-ceiling-9pct',lines,invoiceDiscount:9000,steps:[[{i:0,q:1}]]},
      {key:'at-ceiling-10pct',lines,invoiceDiscount:10000,steps:[[{i:0,q:1}]]},
      {key:'over-ceiling-11pct-control',lines,invoiceDiscount:11000,steps:[],rejectSale:true},
    ]
  }
  throw new Error(`No cases for ${id}`)
}
const cases=scenarioCases(scenario)
const spec=cases.find(x=>x.key===caseKey)
assert.ok(spec, `case ${caseKey} not present in ${scenario}`)
assert.ok(spec.rejectSale ? mode==='OVER_CAP_CONTROL' : modes.includes(mode), `bad mode for ${scenario}/${caseKey}`)
const dir=mkdtempSync(join(tmpdir(),`mahak-d80-${scenario.toLowerCase()}-`))
process.env.HARNESS_DIR=dir
process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {salesService}=await import('../../src/main/services/SalesService.ts')
const {cardTransferService}=await import('../../src/main/services/CardTransferService.ts')
const {physicalMovementForCustodyShift}=await import('../../src/main/services/CustodyAggregateService.ts')
const {DEFAULT_MANAGER_PASSWORD,SETTING_KEYS}=await import('../../src/shared/receipt.ts')
const {toJalaliDate}=await import('../../src/shared/jalali.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db
const userId=seed.user(`Discount80 ${scenario} ${caseKey} ${mode}`)
const shiftId=seed.insert('Shift',{name:`D80 ${scenario} ${caseKey} ${mode}`,number:83000+['S03','S04','S05','S06','S07','S08','S09','S10'].indexOf(scenario)*1000+cases.indexOf(spec)*10+Math.max(0,modes.indexOf(mode)),dayJalali:toJalaliDate(new Date()),openedAt:Date.now(),userId})
const cash=seed.insert('PaymentMethod',{key:`D80-${scenario}-${caseKey}-${mode}-CASH`,label:'isolated cash',kind:'CASH',isActive:1,sortOrder:1})
const card=seed.insert('PaymentMethod',{key:`D80-${scenario}-${caseKey}-${mode}-CARD`,label:'isolated POS',kind:'CARD',isActive:1,sortOrder:2})
const n=x=>Number(x??0)
const category=seed.category(`discount80-${scenario}-${caseKey}-${mode}`)
const variants=spec.lines.map((line,i)=>{
  const product=seed.product(`Discount80 ${scenario} ${caseKey} item ${i+1}`,category)
  const id=seed.variant(product,`D80-${scenario}-${cases.indexOf(spec)}-${i}-${mode}`)
  sql.prepare('UPDATE "ProductVariant" SET stock=20,salePrice=? WHERE id=?').run(line.unitPrice,id)
  return id
})
const baseItems=spec.lines.map(l=>l.unitPrice*l.qty-l.discount)
const baseTotal=baseItems.reduce((a,b)=>a+b,0)
const grossTotal=spec.lines.reduce((s,l)=>s+l.unitPrice*l.qty,0)
const netTotal=baseTotal-spec.invoiceDiscount
// Independent largest-remainder oracle: invoice discount is pooled proportionally over line bases.
const alloc=baseItems.map((base,i)=>{const exact=netTotal*base/baseTotal;return {i,share:Math.floor(exact),remainder:exact-Math.floor(exact)}})
let left=netTotal-alloc.reduce((s,x)=>s+x.share,0)
for(const x of [...alloc].sort((a,b)=>b.remainder-a.remainder||a.i-b.i)){if(left<=0)break;x.share++;left--}
const netByLine=alloc.map(x=>x.share)
const initialQty=spec.lines.reduce((s,l)=>s+l.qty,0)
const expected={cash:0,card:0,refundCash:0,refundCard:0}
const checkpoints=[]
const moneyLedger=()=>{
  const p=seed.one(`SELECT COALESCE(SUM(CASE WHEN m.kind='CASH' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) cash, COALESCE(SUM(CASE WHEN m.kind='CARD' AND p.kind='CASH' AND p.voidedAt IS NULL THEN p.amount ELSE 0 END),0) card FROM "Payment" p JOIN "PaymentMethod" m ON m.id=p.methodId WHERE p.createdShiftId=?`,shiftId)
  const c=seed.one(`SELECT COALESCE(SUM(amount),0) amount FROM "CashMovement" WHERE shiftId=? AND type IN ('RETURN_REFUND','EXCHANGE_REFUND')`,shiftId)
  const r=seed.one(`SELECT COALESCE(SUM(refundAmount),0) amount FROM "SaleReturn" WHERE shiftId=? AND refundMethod='CARD' AND voidedAt IS NULL`,shiftId)
  return {cash:n(p.cash),card:n(p.card),refundCash:n(c.amount),refundCard:n(r.amount)}
}
const stockState=()=>{
  const actual=variants.reduce((s,id)=>s+n(seed.one('SELECT stock FROM "ProductVariant" WHERE id=?',id).stock),0)
  const ledger=variants.reduce((s,id)=>s+n(seed.one('SELECT COALESCE(SUM(delta),0) delta FROM "StockMovement" WHERE variantId=?',id).delta),0)
  return {actual,ledger}
}
let soldStock=0,restocked=0
async function checkpoint(label){
  const report=await salesService.reportRows({shiftId})
  const actualService={cash:n(report.totals.cashTotal),card:n(report.totals.cardTotal),refundCash:n(report.totals.refundCashTotal),refundCard:n(report.totals.refundCardTotal)}
  const actualRaw=moneyLedger()
  assert.deepEqual(actualService,expected,`${label}: service money totals`)
  assert.deepEqual(actualRaw,expected,`${label}: raw ledger totals`)
  const blue=n(await physicalMovementForCustodyShift(shiftId))
  const expectedBlue=expected.cash+expected.card-expected.refundCash-expected.refundCard
  assert.equal(blue,expectedBlue,`${label}: blue`) 
  const stock=stockState(), expectedStock=20*variants.length-soldStock+restocked
  assert.equal(stock.actual,expectedStock,`${label}: stock`) 
  assert.equal(stock.actual,20*variants.length+stock.ledger,`${label}: stock ledger`) 
  const event={label,expected:{...expected,blue:expectedBlue},actualService,actualRaw,blue,stock,expectedStock,
    counts:{invoices:seed.count('SaleInvoice','shiftId=?',shiftId),returns:seed.count('SaleReturn','shiftId=?',shiftId),payments:seed.count('Payment','createdShiftId=?',shiftId),cashMovements:seed.count('CashMovement','shiftId=?',shiftId),credits:seed.count('StoreCredit'),checks:seed.count('Payment',`createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`,shiftId)}}
  checkpoints.push(event);return event
}
const result={generatedAt:new Date().toISOString(),scenario:`D80-${scenario}`,case:caseKey,mode,fixture:{gross:grossTotal,lineDiscount:spec.lines.reduce((s,l)=>s+l.discount,0),invoiceDiscount:spec.invoiceDiscount,net:netTotal,lines:spec.lines.map((l,i)=>({...l,netShare:netByLine[i]}))},isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING',allocations:[],returns:[],credits:[],managerTransfers:[],checkpoints,findings:[]}
let sale=null,items=[]
try{
  if(scenario==='S10') seed.setting(SETTING_KEYS.discountPolicy,{mode:'FREE',fixedMode:'PERCENT',fixedValue:0,allowLine:true,allowInvoice:true,maxPercent:10,maxAmount:0})
  await checkpoint('initial isolated DB')
  try {
    sale=await salesService.create({userId,shiftId,lines:spec.lines.map((l,i)=>({variantId:variants[i],qty:l.qty,unitPrice:l.unitPrice,discount:l.discount,tax:0})),invoiceDiscount:spec.invoiceDiscount,payments:spec.rejectSale?[]:[{methodId:cash,amount:netTotal,destination:'CASH'}],saleRequestIdempotencyKey:`d80-${scenario}-${caseKey}-${mode}`})
  } catch(e) {
    const message=String(e?.message??e)
    if(spec.rejectSale){
      assert.match(message,/سقف مجاز|بیشتر است/,'over-cap sale must be rejected because it exceeds isolated 10% ceiling')
      assert.equal(seed.count('SaleInvoice'),0,'over-cap rejection creates no invoice')
      assert.equal(seed.count('Payment'),0,'over-cap rejection creates no payment')
      assert.equal(stockState().actual,20*variants.length,'over-cap rejection does not change stock')
      result.sale={rejected:true,message,mutationFree:true}
      result.status='PASS';result.operationOutcome='OVER_CAP_REJECTED_MUTATION_FREE'
      result.final={expected:{...expected,blue:0},actual:moneyLedger(),blue:n(await physicalMovementForCustodyShift(shiftId)),stock:stockState(),invoices:0,returns:0,payments:0,credits:0,checks:0}
    } else throw e
  }
  if(sale){
    assert.ok(!spec.rejectSale,'over-ceiling sale was unexpectedly accepted')
    const inv=seed.one('SELECT id,grandTotal,discountTotal,paidTotal,status,settledAt FROM "SaleInvoice" WHERE id=?',sale.id)
    items=seed.rows('SELECT id,variantId,qty,unitPrice,discount,lineTotal FROM "SaleInvoiceItem" WHERE invoiceId=? ORDER BY id',sale.id)
    assert.equal(n(inv.grandTotal),netTotal,'sale net')
    assert.equal(n(inv.discountTotal),result.fixture.lineDiscount+spec.invoiceDiscount,'discount total recorded')
    assert.equal(n(inv.paidTotal),netTotal,'sale actually paid in full')
    assert.equal(items.length,spec.lines.length)
    for(let i=0;i<items.length;i++){
      assert.equal(n(items[i].qty),spec.lines[i].qty)
      assert.equal(n(items[i].discount),spec.lines[i].discount)
      assert.equal(n(items[i].lineTotal),baseItems[i])
      result.allocations.push({saleItemId:n(items[i].id),gross:spec.lines[i].unitPrice*spec.lines[i].qty,lineDiscount:spec.lines[i].discount,lineBase:baseItems[i],invoiceDiscountShare:baseItems[i]-netByLine[i],netShare:netByLine[i]})
    }
    expected.cash+=netTotal;soldStock=initialQty
    result.sale={id:n(inv.id),gross:grossTotal,lineDiscount:result.fixture.lineDiscount,invoiceDiscount:spec.invoiceDiscount,totalDiscount:n(inv.discountTotal),net:n(inv.grandTotal),paid:n(inv.paidTotal),settled:inv.settledAt!=null}
    await checkpoint('sale recorded and paid: gross, direct/invoice discount, net and stock')
    const returnedQty=Array(spec.lines.length).fill(0)
    for(let si=0;si<spec.steps.length;si++){
      const step=spec.steps[si]
      const stepTotal=step.reduce((sum,t)=>{
        const before=returnedQty[t.i],after=before+t.q
        const cumulative=q=>Math.floor((netByLine[t.i]*q/spec.lines[t.i].qty)+0.5)
        return sum+cumulative(after)-cumulative(before)
      },0)
      const input={userId,shiftId,invoiceId:n(inv.id),full:spec.full===true&&si===0,lines:step.map(t=>({saleItemId:n(items[t.i].id),qty:t.q}))}
      if(mode==='CASH')Object.assign(input,{refundMethod:'CASH',refundAmount:stepTotal})
      if(mode==='CARD')Object.assign(input,{refundMethod:'CARD',refundAmount:stepTotal,cardPosOverride:{acknowledgedNoReverse:true,reason:`D80 ${scenario} ${caseKey} card refund`,managerPassword:DEFAULT_MANAGER_PASSWORD}})
      if(mode==='CARD_TO_CARD')Object.assign(input,{refundMethod:'CARD_TO_CARD',refundAmount:stepTotal})
      if(mode==='STORE_CREDIT')Object.assign(input,{refundMethod:'STORE_CREDIT',refundAmount:stepTotal,creditDays:30})
      if(mode==='NONE')Object.assign(input,{refundMethod:'NONE',confirmOverpay:true,overpayAsCredit:true,overpayManagerPassword:DEFAULT_MANAGER_PASSWORD})
      const returned=await salesService.createReturn(input)
      const row=seed.one('SELECT id,total,refundMethod,refundAmount,refundStoreCreditAmount,voidedAt FROM "SaleReturn" WHERE id=?',returned.id)
      assert.equal(n(row.total),stepTotal,`${caseKey} ${mode} step ${si+1}: return value must equal net discount allocation`)
      const returnItems=seed.rows('SELECT saleItemId,qty,unitPrice,lineTotal,restockedQty FROM "SaleReturnItem" WHERE returnId=? ORDER BY id',returned.id)
      assert.equal(returnItems.reduce((s,x)=>s+n(x.qty),0),step.reduce((s,x)=>s+x.q,0),'returned quantity')
      assert.equal(returnItems.reduce((s,x)=>s+n(x.lineTotal),0),stepTotal,'returned item net snapshots add up to the return value')
      result.returns.push({id:n(row.id),step:si+1,expectedNet:stepTotal,actualNet:n(row.total),refundMethod:row.refundMethod,refundAmount:n(row.refundAmount),refundStoreCreditAmount:n(row.refundStoreCreditAmount),items:returnItems})
      if(mode==='CASH')expected.refundCash+=n(row.refundAmount)
      if(mode==='CARD')expected.refundCard+=n(row.refundAmount)
      if(mode==='CARD_TO_CARD'){
        const req=seed.one('SELECT id,status,amount,paidAmount,paidMethod,trackingNo FROM "CardTransferRequest" WHERE returnId=?',row.id)
        assert.ok(req,`C2C request for step ${si+1}`);assert.equal(req.status,'PENDING');assert.equal(n(req.amount),stepTotal)
        await checkpoint(`${caseKey} ${mode} step ${si+1}: manager C2C request pending, goods held`)
        await cardTransferService.pay({id:n(req.id),paidAmount:stepTotal,userId,managerPassword:DEFAULT_MANAGER_PASSWORD,trackingNo:`D80-${scenario}-${si+1}`})
        const paid=seed.one('SELECT id,status,amount,paidAmount,paidMethod FROM "CardTransferRequest" WHERE id=?',req.id)
        assert.equal(paid.status,'PAID');assert.equal(n(paid.paidAmount),stepTotal)
        result.managerTransfers.push({id:n(paid.id),status:paid.status,amount:n(paid.amount),paidAmount:n(paid.paidAmount),method:paid.paidMethod})
        restocked+=step.reduce((s,t)=>s+t.q,0)
      } else {
        if(mode==='STORE_CREDIT'||mode==='NONE'){
          const cs=seed.rows('SELECT id,amount,status,expiresAt,returnId FROM "StoreCredit" WHERE returnId=? ORDER BY id',row.id)
          const creditAmount=cs.reduce((s,c)=>s+n(c.amount),0)
          assert.equal(creditAmount,stepTotal,`${mode}: returned money-backed amount becomes equal credit`)
          result.credits.push(...cs.map(c=>({id:n(c.id),amount:n(c.amount),status:c.status,expiresAt:c.expiresAt==null?null:n(c.expiresAt),returnId:n(c.returnId)})))
        }
        restocked+=step.reduce((s,t)=>s+t.q,0)
      }
      for(const t of step)returnedQty[t.i]+=t.q
      await checkpoint(`${caseKey} ${mode} step ${si+1}: return, settlement, stock and credit reconciled`)
    }
    const configuredQty=Array(spec.lines.length).fill(0)
    for(const step of spec.steps)for(const t of step)configuredQty[t.i]+=t.q
    assert.deepEqual(returnedQty,configuredQty,'case returns exactly its configured quantities (partial-return cases remain partial)')
    const caseReturnRight=result.returns.reduce((s,x)=>s+x.expectedNet,0)
    const customerValue=mode==='CARD_TO_CARD'?result.managerTransfers.reduce((s,x)=>s+x.paidAmount,0):
      mode==='STORE_CREDIT'||mode==='NONE'?result.credits.reduce((s,x)=>s+x.amount,0):
      mode==='CASH'?expected.refundCash:expected.refundCard
    assert.equal(customerValue,caseReturnRight,`${mode}: total customer refund/credit equals only the returned items' net paid share`)
    result.policyAssessment={expectedNetReturnRight:caseReturnRight,actualCustomerValue:customerValue,discountReturned:0,deviations:[]}
    result.status='PASS';result.operationOutcome='COMPLETED'
  }
} catch(e) {
  result.status='FAIL';result.unexpectedError=String(e?.stack??e);throw e
} finally {
  if(!result.final)result.final={expected:{...expected,blue:expected.cash+expected.card-expected.refundCash-expected.refundCard},actual:moneyLedger(),blue:n(await physicalMovementForCustodyShift(shiftId)),stock:stockState(),invoices:seed.count('SaleInvoice','shiftId=?',shiftId),returns:seed.count('SaleReturn','shiftId=?',shiftId),payments:seed.count('Payment','createdShiftId=?',shiftId),credits:seed.count('StoreCredit'),checks:seed.count('Payment',`createdShiftId=? AND methodId IN (SELECT id FROM "PaymentMethod" WHERE UPPER(kind) IN ('CHECK','CHEQUE'))`,shiftId)}
  const out=resolve(process.cwd(),'reports');mkdirSync(out,{recursive:true})
  const stem=`deep-e2e-discount-policy-80-${scenario.toLowerCase()}-${caseKey.toLowerCase()}-${mode.toLowerCase().replaceAll('_','-')}`
  writeFileSync(join(out,`${stem}.json`),JSON.stringify(result,null,2)+'\n')
  writeFileSync(join(out,`${stem}.md`),[
    `# Discount Policy 80 — ${scenario} / ${caseKey} / ${mode}`,'',
    `**Status:** ${result.status}; isolated SQLite database per branch.`,
    `**Fixture:** gross=${grossTotal}; direct line discount=${result.fixture.lineDiscount}; invoice discount=${spec.invoiceDiscount}; net=${netTotal}.`,
    `**Sale:** ${JSON.stringify(result.sale??null)}`,
    `**Per-item discount/net allocation:** ${JSON.stringify(result.allocations)}`,
    `**Returns:** ${JSON.stringify(result.returns)}`,
    `**Credits:** ${JSON.stringify(result.credits)}`,
    `**Policy assessment:** ${JSON.stringify(result.policyAssessment??null)}`,
    `**Final reconciliation:** ${JSON.stringify(result.final)}`,
    'Only test code and isolated test DB were used; no production/live/staging DB or policy was changed.'
  ].join('\n')+'\n')
}
