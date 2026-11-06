/* Verify manager bulk discount can target one category only (plus descendants). */
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'mahak-category-scoped-discount-'))
process.env.HARNESS_DIR=dir;process.env.HARNESS_DB=join(dir,'isolated.db')
const {harnessClient}=await import('../../test/harness/stubs/prismaClient.mjs')
const {makeSeeder}=await import('../../test/harness/seed.mjs')
const {priceAdjustService}=await import('../../src/main/services/PriceAdjustService.ts')
const {DEFAULT_MANAGER_PASSWORD}=await import('../../src/shared/receipt.ts')
const db=harnessClient(),seed=makeSeeder(db),sql=db.$harness.db,n=x=>Number(x??0)
const userId=seed.user('category discount test')
const root=seed.category('Selected category')
const child=seed.category('Selected subcategory',root)
const outside=seed.category('Other category')
function variant(name,categoryId){const p=seed.product(`category-discount-${name}`,categoryId),v=seed.variant(p,name);sql.prepare('UPDATE "ProductVariant" SET salePrice=10000000,stock=10 WHERE id=?').run(v);return v}
const included=variant('root-item',root),descendant=variant('descendant-item',child),excluded=variant('outside-item',outside)
const result={case:'one-category-percent-discount',isolatedDatabase:process.env.HARNESS_DB,status:'RUNNING'}
try{
 const input={kind:'DISCOUNT',mode:'PERCENT',value:10,scope:'CATEGORY',categoryId:root,target:'SALE',userId,password:DEFAULT_MANAGER_PASSWORD,note:'only selected category probe'}
 const preview=await priceAdjustService.preview(input)
 assert.equal(preview.count,2);assert.equal(preview.changedCount,2);assert.equal(preview.lines.reduce((s,l)=>s+l.oldPrice,0),20_000_000);assert.equal(preview.lines.reduce((s,l)=>s+l.newPrice,0),18_000_000)
 const applied=await priceAdjustService.apply(input)
 const prices=[included,descendant,excluded].map(id=>n(seed.one('SELECT salePrice FROM "ProductVariant" WHERE id=?',id).salePrice))
 assert.deepEqual(prices,[9_000_000,9_000_000,10_000_000]);assert.equal(applied.changedCount,2)
 result.status='PASS';result.scope={selectedCategory:root,selectedCategoryName:'Selected category',includesDescendants:true,previewCount:preview.count,changedCount:applied.changedCount,appliedPrices:{selectedCategoryItem:prices[0],childCategoryItem:prices[1],outsideCategoryItem:prices[2]},batchTitle:applied.title}
}catch(error){result.status='FAIL';result.failure={message:String(error?.message??error),stack:String(error?.stack??'')}}
finally{
 const outdir=resolve(process.cwd(),'reports','deep-e2e-category-scoped-manager-discount');mkdirSync(outdir,{recursive:true})
 writeFileSync(join(outdir,'result.json'),JSON.stringify(result,null,2)+'\n')
 const md=[
 '# تست تخفیف مدیر روی یک دستهٔ مشخص','',`**نتیجه:** ${result.status}`,`**SQLite موقت:** ${result.isolatedDatabase}`,'',
 'مدیر با `PriceAdjustService`، نوع تخفیف `DISCOUNT`، درصد ۱۰ و scope=`CATEGORY` فقط دستهٔ انتخابی را اعمال کرد. در این پیاده‌سازی زیردسته‌های آن دسته هم داخل دامنه‌اند؛ دستهٔ مستقل دیگر دست‌نخورده ماند.',
 '',`- دستهٔ انتخابی و قلم داخل آن: قیمت ۱۰٬۰۰۰٬۰۰۰ ← ۹٬۰۰۰٬۰۰۰ ریال.`,`- زیردستهٔ دستهٔ انتخابی: قیمت ۱۰٬۰۰۰٬۰۰۰ ← ۹٬۰۰۰٬۰۰۰ ریال.`,`- دستهٔ دیگر: قیمت ۱۰٬۰۰۰٬۰۰۰ ریال باقی ماند.`,`- پیش‌نمایش: ${result.scope?.previewCount??'—'} قلم؛ اعمال: ${result.scope?.changedCount??'—'} قلم.`,
 '', 'تفکیک مهم: این امکان در ماژول «تغییر گروهی قیمت» هست و قیمت SKUها را تغییر می‌دهد. در `DiscountPolicy` مربوط به تخفیفِ کل فاکتور، قاعدهٔ manager invoice-discount برای یک دستهٔ خاص تنظیم نشده است. فقط SQLite ایزوله؛ production تغییر نکرد.'
 ]
 writeFileSync(join(outdir,'summary.md'),md.join('\n')+'\n')
 await db.$disconnect?.();if(result.status!=='PASS')process.exitCode=1
}
