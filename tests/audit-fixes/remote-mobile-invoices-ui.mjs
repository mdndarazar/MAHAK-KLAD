import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mobileHtml,mobileJs,mobileWorker } from '../../src/main/services/cloud/mobilePwaAssets.ts'

// Structural/script test with a minimal fake DOM. Not a real browser, PWA install or phone.
function fixture({enabled=true,initialSession=null}={}) {
 const elements=new Map(),calls=[],overrides=new Map();let nextInvoice=null,firstSession=true
 class Element {
  constructor(id=''){this.id=id;this.hidden=false;this.value='';this.checked=false;this.children=[];this.events={};this._text=''}
  addEventListener(event,handler){this.events[event]=handler}
  appendChild(child){this.children.push(child)}
  set textContent(value){this._text=String(value);this.children=[]}
  get textContent(){return this._text}
  fire(event){return this.events[event]({preventDefault(){}})}
 }
 const el=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id)}
 for(const id of ['dashboard','owner-tools','invoice-tools','invoice-acl-label','invoice-next'])el(id).hidden=true
 const response=(value,status=200)=>({ok:status>=200&&status<300,json:async()=>value})
 const fetch=async(path,options={})=>{
  calls.push({path,options})
  if(path==='/api/session'&&firstSession){firstSession=false;if(initialSession)return await initialSession}
  if(overrides.has(path))return await overrides.get(path)
  if(path==='/api/login')return response({ok:true})
  if(path==='/api/session')return response({user:{username:'owner',role:'OWNER'}})
  if(path==='/api/capabilities')return response({invoices:enabled})
  if(path==='/api/custody')return response({boundary:null})
  if(path==='/api/shifts')return response({shifts:[],hasMore:false})
  if(path==='/api/members')return response({members:[]})
  if(path==='/api/requests')return response({error:'unavailable'},404)
  if(path==='/api/logout')return response({ok:true})
  if(path==='/api/invoices')return nextInvoice ? await nextInvoice : response({invoices:[],hasMore:false})
  throw new Error('Unexpected API '+path)
 }
 const document={getElementById:el,createElement:()=>new Element()}
 vm.runInNewContext(mobileJs,{document,navigator:{},fetch,console},{timeout:1000})
 const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve()}
 return {el,calls,flush,response,setInvoice:value=>{nextInvoice=value},setResponse:(path,value)=>overrides.set(path,value)}
}
await test('invoice UI is capability-gated and does not cache or render HTML',()=>{
 assert.match(mobileHtml,/id="invoice-tools" hidden/);assert.match(mobileHtml,/فهرست خام فاکتورها/)
 assert.match(mobileHtml,/پیش‌نویس و اسناد باطل/);assert.ok(!mobileJs.includes('innerHTML'));assert.ok(!mobileJs.includes('localStorage'))
 assert.ok(!mobileWorker.includes('caches.'));assert.ok(!mobileWorker.includes('/api/'))
})
await test('owner can display bounded raw facts through text nodes',async()=>{
 const f=fixture();await f.flush();assert.equal(f.el('invoice-tools').hidden,false);assert.equal(f.el('invoice-acl-label').hidden,false)
 f.el('invoice-from').value='1405/01/01';f.el('invoice-to').value='1405/01/03'
 f.setInvoice(Promise.resolve(f.response({invoices:[{id:3,receiptNo:42,issuedAtJalali:'1405/01/02',status:'DRAFT',voided:true,orderType:'EXCHANGE',grandTotal:'9007199254740993',paidTotal:'3',customerName:'<img onerror=attack>',customerPhone:null,sellerName:null}],hasMore:false})))
 await f.el('invoice-form').fire('submit');const result=f.el('invoice-results').children.map(e=>e.textContent).join(' ')
 assert.match(result,/<img onerror=attack>/);assert.match(result,/باطل/);assert.match(result,/9007199254740993/)
 const call=f.calls.find(c=>c.path==='/api/invoices');assert.deepEqual(JSON.parse(call.options.body),{fromDay:'1405/01/01',toDay:'1405/01/03',afterId:0})
 assert.equal(f.el('invoice-next').hidden,true)
})
await test('logout discards a late invoice response and clears displayed details',async()=>{
 const f=fixture();await f.flush();f.el('invoice-from').value='1405/01/01';f.el('invoice-to').value='1405/01/03'
 let release;f.setInvoice(new Promise(r=>{release=r}))
 const pending=f.el('invoice-form').fire('submit');await f.flush();await f.el('logout').fire('click')
 release(f.response({invoices:[{id:1,receiptNo:1,issuedAtJalali:'1405/01/02',status:'SETTLED',voided:false,orderType:'INTERNAL',grandTotal:'1',paidTotal:'1',customerName:'PRIVATE-CUSTOMER',customerPhone:null,sellerName:null}],hasMore:false}));await pending
 assert.equal(f.el('dashboard').hidden,true);assert.equal(f.el('invoice-tools').hidden,true)
 assert.equal(f.el('invoice-results').textContent,'');assert.deepEqual(f.el('invoice-results').children,[])
})
await test('logout discards late custody, shifts, requests and members responses',async()=>{
 for(const [path,body,element] of [
  ['/api/custody',{boundary:{operationalDay:'PRIVATE-CUSTODY',atDatabaseValue:'x',theoreticalExpectedTotal:'1',observedOperationalTotal:'1',totalTheoreticalDifference:'0'}},'custody'],
  ['/api/shifts',{shifts:[{name:'PRIVATE-SHIFT',number:1,operationalDay:'x'}],hasMore:false},'shifts'],
  ['/api/requests',{requests:[{requestId:'request',panel:'PRIVATE-REQUEST',code:'123456'}]},'request-id'],
  ['/api/members',{members:[{username:'PRIVATE-MEMBER',role:'MANAGER',status:'ACTIVE'}]},'members']
 ]){
  const f=fixture();await f.flush();let release
  f.setResponse(path,new Promise(resolve=>{release=resolve}))
  const refresh=f.el('reload').fire('click');await f.flush()
  await f.el('logout').fire('click');release(f.response(body));await refresh
  assert.equal(f.el('dashboard').hidden,true)
  assert.equal(f.el(element).textContent,'');assert.deepEqual(f.el(element).children,[])
 }
})
await test('logout discards a late invitation code',async()=>{
 const f=fixture();await f.flush();let release
 f.setResponse('/api/invite/create',new Promise(resolve=>{release=resolve}))
 const pending=f.el('invite-form').fire('submit');await f.flush();await f.el('logout').fire('click')
 release(f.response({invite:'SECRET-INVITE'}));await pending
 assert.equal(f.el('invite-result').textContent,'');assert.equal(f.el('message').textContent,'')
})
await test('late action results cannot update a logged-out view or start follow-up requests',async()=>{
 for(const [path,id,event,status] of [
  ['/api/approve','approval-form','submit',200],
  ['/api/member/approve','member-form','submit',200],
  ['/api/member/remove','remove-member','click',200],
  ['/api/member/remove','remove-member','click',403]
 ]){
  const f=fixture();await f.flush();let release
  f.setResponse(path,new Promise(resolve=>{release=resolve}))
  const pending=f.el(id).fire(event);await f.flush();await f.el('logout').fire('click')
  const calls=f.calls.length;release(f.response({error:'PRIVATE-ERROR'},status));await pending;await f.flush()
  assert.equal(f.el('message').textContent,'');assert.equal(f.calls.length,calls)
  assert.equal(f.el('dashboard').hidden,true)
 }
})
await test('capability loss discards a late invoice response without logging out',async()=>{
 const f=fixture();await f.flush();let release
 f.setInvoice(new Promise(resolve=>{release=resolve}))
 f.el('invoice-from').value='1405/01/01';f.el('invoice-to').value='1405/01/03'
 const pending=f.el('invoice-form').fire('submit');await f.flush()
 f.setResponse('/api/capabilities',Promise.resolve(f.response({invoices:false})))
 await f.el('reload').fire('click')
 release(f.response({invoices:[{id:1,customerName:'PRIVATE-CUSTOMER'}],hasMore:false}));await pending
 assert.equal(f.el('dashboard').hidden,false);assert.equal(f.el('invoice-tools').hidden,true)
 assert.equal(f.el('invoice-results').textContent,'');assert.deepEqual(f.el('invoice-results').children,[])
})
await test('capability refresh does not invalidate another action in the same session',async()=>{
 const f=fixture({enabled:false});await f.flush();let release
 f.setResponse('/api/invite/create',new Promise(resolve=>{release=resolve}))
 const pending=f.el('invite-form').fire('submit');await f.flush();await f.el('reload').fire('click')
 release(f.response({invite:'INVITE'}));await pending
 assert.equal(f.el('invite-result').textContent,'INVITE')
})
await test('late initial session check cannot overwrite a newer login',async()=>{
 let release;const initialSession=new Promise(resolve=>{release=resolve})
 const f=fixture({initialSession});f.el('username').value='owner';f.el('password').value='password'
 await f.el('login-form').fire('submit');await f.flush()
 assert.equal(f.el('dashboard').hidden,false);assert.match(f.el('user').textContent,/owner/)
 release(f.response({error:'unauthorized'},401));await f.flush()
 assert.equal(f.el('dashboard').hidden,false);assert.match(f.el('user').textContent,/owner/)
})
await test('overlapping logins send only one credential request and permit logout after login',async()=>{
 const f=fixture();await f.flush();let release
 f.setResponse('/api/login',new Promise(resolve=>{release=resolve}))
 const first=f.el('login-form').fire('submit');await f.flush()
 await f.el('login-form').fire('submit');assert.equal(f.calls.filter(c=>c.path==='/api/login').length,1)
 release(f.response({ok:true}));await first;await f.flush()
 await f.el('logout').fire('click');assert.equal(f.el('dashboard').hidden,true)
})
await test('no invoice capability means no invoice read or invite permission',async()=>{
 const f=fixture({enabled:false});await f.flush();assert.equal(f.el('invoice-tools').hidden,true);assert.equal(f.el('invoice-acl-label').hidden,true)
 await f.el('invoice-form').fire('submit');assert.ok(!f.calls.some(c=>c.path==='/api/invoices'))
})
