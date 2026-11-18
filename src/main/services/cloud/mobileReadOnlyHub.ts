/**
 * Experimental read-only PWA server, NOT started by Electron. Bind loopback only
 * behind a correctly configured HTTPS reverse proxy. This includes basic hub
 * member management and optional in-process approval, but not real desktop
 * transport, pairing, notifications, live reports or shop database connection.
 * The host must isolate identity/SQLite work from the POS thread, secure the
 * proxy and provision the owner. Multiple exact configured HTTPS origins can be
 * accepted at once, but this does not configure or authenticate any proxy,
 * overlay or tunnel. Do not enable production access with this.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import { mobileHtml, mobileCss, mobileJs, mobileManifest, mobileWorker } from './mobilePwaAssets'
import { icon192, icon512 } from './mobilePwaIcons'
import { isInvoiceDate, parseInvoicePage } from './invoiceFactsValidation'
import { normalizeMobileOrigins } from './mobileOrigins'

type Session = { id: string; role: string; username: string }
type Identity = {
  login(username: string, password: string): { ok: true; token: string } | { ok: false }
  logout(token: string): boolean
  whoAmI(token: string): Session | null
  authorize(token: string, panel: string, permission: 'VIEW'): Session | null
  listMembers(token: string): { username: string; role: string; status: string; acl: { panel: string; view: boolean; approve: boolean }[] }[] | null
  createInvite(token: string, pin: string, role: 'MANAGER' | 'VIEWER', acl: { panel: string; view: boolean; approve: boolean }[]): { ok: true; invite: string } | { ok: false }
  acceptInvite(invite: string, username: string, password: string, pin: string): boolean
  approveMember(token: string, pin: string, username: string): boolean
  removeMember(token: string, pin: string, username: string): { ok: true; memberId: string } | { ok: false }
  panic?(token: string, pin: string): boolean
  panicClose?(token: string, pin: string): boolean
}
type Reader = {
  latestBoundaryTotals(): Promise<unknown>
  openShiftsPage(afterId: number, limit: number): Promise<unknown>
  // Optional experimental, on-demand raw facts; not a desktop financial report.
  invoiceFactsPage?(fromDay: string, toDay: string, afterId: number, limit: number): Promise<unknown>
}
type ApprovalController = {
  list(token: string): { requestId: string; panel: string; code: string }[]
  approve(token: string, requestId: string, code: string, pin: string): boolean | Promise<boolean>
}
type Options = { origin?: string; origins?: readonly string[]; identity: Identity; reader: Reader; drainRevocations?: () => { remaining: boolean } | Promise<{ remaining: boolean }>; approval?: ApprovalController }
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const MAX_BODY = 8192
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
function header(req: IncomingMessage, name: string): string | null {
  const values: string[] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1])
  return values.length === 1 ? values[0] : null
}
function cookie(req: IncomingMessage): string | null {
  const raw = header(req, 'cookie')
  if (!raw) return null
  const found = raw.split(';').map(s => s.trim()).filter(s => s.startsWith('mahak_session='))
  if (found.length !== 1) return null
  const value = found[0].slice('mahak_session='.length)
  return TOKEN.test(value) ? value : null
}
function text(v: unknown, max = 256): string {
  if (typeof v !== 'string' || Buffer.byteLength(v,'utf8') > max) throw new Error('Invalid snapshot')
  return v
}
function id(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('Invalid snapshot')
  return v as number
}
function amount(v: unknown): string {
  const s = text(v,100)
  if (!/^-?(0|[1-9][0-9]*)$/.test(s)) throw new Error('Invalid snapshot')
  return s
}
function boundary(v: unknown) {
  if (v === null) return null
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid snapshot')
  const a = v as Record<string, unknown>
  if (a.source !== 'HISTORICAL_BOUNDARY') throw new Error('Invalid snapshot')
  return { source:'HISTORICAL_BOUNDARY', id:id(a.id), atDatabaseValue:text(a.atDatabaseValue), kind:text(a.kind), operationalDay:text(a.operationalDay),
    theoreticalExpectedTotal:amount(a.theoreticalExpectedTotal), observedOperationalTotal:amount(a.observedOperationalTotal), totalTheoreticalDifference:amount(a.totalTheoreticalDifference) }
}
function shifts(v: unknown) {
  if (!Array.isArray(v) || v.length > 200) throw new Error('Invalid snapshot')
  return v.map(a => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Invalid snapshot')
    return { id:id(a.id), name:text(a.name), number:id(a.number), operationalDay:text(a.operationalDay), openedAtDatabaseValue:text(a.openedAtDatabaseValue) }
  })
}
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve,reject) => {
    let size = 0, done = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { if (!done) { done=true; reject(new Error('timeout')); req.destroy() } },5000)
    const fail = () => { if (!done) { done=true; clearTimeout(timer); reject(new Error('invalid body')) } }
    req.on('data',(chunk: Buffer) => { if (done) return; size+=chunk.length; if (size>MAX_BODY) { fail(); req.destroy(); return }; chunks.push(chunk) })
    req.on('aborted',fail);req.on('error',fail)
    req.on('end',() => {
      if (done) return
      done=true;clearTimeout(timer)
      try { const obj: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('invalid'); resolve(obj as Record<string,unknown>) }
      catch { reject(new Error('invalid body')) }
    })
  })
}
export function createMobileReadOnlyHandler(options: Options) {
  if (!options || !options.identity || !options.reader) throw new Error('Invalid HTTPS origin or dependencies')
  // A request must use a configured Host; its Origin must match that same Host,
  // not merely any other configured route. Proxies must preserve Host exactly.
  const allowedOrigins=normalizeMobileOrigins(options.origin,options.origins)
  const originsByHost=new Map(allowedOrigins.map(value=>[new URL(value).host,value]))
  // Shared across sessions so many clients cannot fan out DB reads. The real
  // query must settle before releasing the slot; never queue expensive reads.
  let invoiceBusy=false, lastInvoiceRead=-Infinity
  // Bounds both per-source login attempts and total in-memory source records. A
  // proxy must enforce its own limits; it may collapse all clients to one source.
  const attempts = new Map<string,{start:number; count:number}>()
  function loginAllowed(source: string): boolean {
    const now = Date.now()
    for (const [key,record] of attempts) if (now - record.start >= 60_000) attempts.delete(key)
    let record = attempts.get(source)
    if (!record) { if (attempts.size >= 2048) return false; record={start:now,count:0}; attempts.set(source,record) }
    if (record.count >= 30) return false
    record.count++;return true
  }
  const assets: Record<string,{ type:string; body:string|Buffer }> = {
    '/':{type:'text/html; charset=utf-8',body:mobileHtml},'/mobile.css':{type:'text/css; charset=utf-8',body:mobileCss},
    '/mobile.js':{type:'application/javascript; charset=utf-8',body:mobileJs},'/manifest.webmanifest':{type:'application/manifest+json; charset=utf-8',body:mobileManifest},
    '/mobile-sw.js':{type:'application/javascript; charset=utf-8',body:mobileWorker},'/icon-192.png':{type:'image/png',body:icon192},'/icon-512.png':{type:'image/png',body:icon512}
  }
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY')
    res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',CSP);res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()')
    const send = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value))
    }
    try {
      const host=header(req,'host'), expectedOrigin=host ? originsByHost.get(host) : undefined
      if (!expectedOrigin) { send(421,{error:'آدرس معتبر نیست'}); return }
      const path = req.url ?? ''
      if (req.method === 'GET' && Object.hasOwn(assets,path)) {
        const asset=assets[path];res.writeHead(200,{'content-type':asset.type});res.end(asset.body);return
      }
      if (req.method === 'POST') {
        if (header(req,'origin') !== expectedOrigin || header(req,'x-mahak-request') !== '1') { send(403,{error:'درخواست مجاز نیست'});return }
        if (path === '/api/login') {
          if (!loginAllowed(req.socket.remoteAddress ?? 'unknown')) { send(429,{error:'تعداد تلاش‌ها زیاد است؛ بعداً دوباره تلاش کنید'});return }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(header(req,'content-type') ?? '')) { send(400,{error:'درخواست معتبر نیست'});return }
          let data: Record<string, unknown>
          try { data=await readBody(req) } catch { send(400,{error:'درخواست معتبر نیست'});return }
          if (Object.keys(data).sort().join(',') !== 'password,username' || typeof data.username !== 'string' || typeof data.password !== 'string' ||
              data.username.length > 64 || Buffer.byteLength(data.password,'utf8') > 128) { send(400,{error:'درخواست معتبر نیست'});return }
          const result=options.identity.login(data.username,data.password)
          if (!result.ok || !TOKEN.test(result.token)) { send(401,{error:'نام کاربری یا رمز ورود معتبر نیست'});return }
          res.setHeader('set-cookie',`mahak_session=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict`)
          send(200,{ok:true});return
        }
        if (path === '/api/logout') {
          const token=cookie(req)
          if (token) options.identity.logout(token)
          res.setHeader('set-cookie','mahak_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0')
          send(200,{ok:true});return
        }
        if (path === '/api/panic' || path === '/api/panic/close') {
          if (!/^application\/json(?:\s*;|\s*$)/i.test(header(req,'content-type') ?? '')) { send(400,{error:'درخواست معتبر نیست'});return }
          const token=cookie(req), principal=token ? options.identity.whoAmI(token) : null
          if (!token || !principal) { send(401,{error:'لطفاً وارد شوید'});return }
          if (principal.role!=='OWNER') { send(403,{error:'فقط مالک مجاز است'});return }
          // An HTTPS proxy commonly collapses all clients onto one source IP.
          // Unrelated login/invitation traffic must not exhaust the owner's
          // emergency quota. PIN failures still use identity's persistent lockout.
          if (!loginAllowed(`panic:${principal.id}`)) { send(429,{error:'تعداد تلاش‌ها زیاد است؛ بعداً دوباره تلاش کنید'});return }
          const closeOnly=path === '/api/panic/close'
          const operation=closeOnly ? options.identity.panicClose : options.identity.panic
          if (typeof operation!=='function' || typeof options.drainRevocations!=='function') { send(503,{error:'کانال توقف اضطراری فعال نیست'});return }
          let data:Record<string,unknown>
          try { data=await readBody(req) } catch { send(400,{error:'درخواست معتبر نیست'});return }
          if (Object.keys(data).join(',')!=='pin' || typeof data.pin!=='string' || !/^[0-9]{6}$/.test(data.pin)) { send(400,{error:'PIN معتبر نیست'});return }
          if (!operation.call(options.identity,token,data.pin)) { send(403,{error:'توقف اضطراری تأیید نشد'});return }
          // P2 durably latches and invalidates sessions; P1 keeps sessions and
          // only queues revocation. Both wait for ACK and retry after failure.
          if (!closeOnly) res.setHeader('set-cookie','mahak_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0')
          try {
            const drained=await options.drainRevocations()
            if (!drained || drained.remaining!==false) {send(503,{error:'توقف ثبت شد؛ تحویل ابطال هنوز کامل نیست'});return}
          } catch {send(503,{error:'توقف ثبت شد؛ تحویل ابطال هنوز کامل نیست'});return}
          send(200,{ok:true});return
        }
        if (path === '/api/approve' && options.approval) {
          if (!loginAllowed(req.socket.remoteAddress ?? 'unknown')) { send(429,{error:'تعداد تلاش‌ها زیاد است؛ بعداً دوباره تلاش کنید'});return }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(header(req,'content-type') ?? '')) { send(400,{error:'درخواست معتبر نیست'});return }
          let data: Record<string,unknown>
          try { data=await readBody(req) } catch { send(400,{error:'درخواست معتبر نیست'});return }
          const token=cookie(req), principal=token ? options.identity.whoAmI(token) : null
          if (!token || !principal) { send(401,{error:'لطفاً وارد شوید'});return }
          if (Object.keys(data).sort().join(',') !== 'code,pin,requestId' || typeof data.requestId !== 'string' ||
              typeof data.code !== 'string' || typeof data.pin !== 'string') { send(400,{error:'درخواست معتبر نیست'});return }
          if (await options.approval.approve(token,data.requestId,data.code,data.pin) !== true) { send(403,{error:'تأیید انجام نشد؛ کد، PIN و دسترسی را بررسی کنید'});return }
          send(200,{ok:true});return
        }
        if (path === '/api/invoices' && options.reader.invoiceFactsPage) {
          const token=cookie(req), principal=token ? options.identity.whoAmI(token) : null
          if (!token || !principal) { send(401,{error:'لطفاً وارد شوید'});return }
          if (!options.identity.authorize(token,'invoices','VIEW')) { send(403,{error:'اجازه مشاهده این بخش را ندارید'});return }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(header(req,'content-type') ?? '')) { send(400,{error:'درخواست معتبر نیست'});return }
          let data: Record<string,unknown>
          try { data=await readBody(req) } catch { send(400,{error:'درخواست معتبر نیست'});return }
          if (Object.keys(data).sort().join(',') !== 'afterId,fromDay,toDay' || !isInvoiceDate(data.fromDay) || !isInvoiceDate(data.toDay) ||
              data.fromDay > data.toDay || !Number.isSafeInteger(data.afterId) || (data.afterId as number) < 0) { send(400,{error:'درخواست معتبر نیست'});return }
          if (!options.identity.authorize(token,'invoices','VIEW')) { send(403,{error:'اجازه مشاهده این بخش را ندارید'});return }
          const now=performance.now()
          if (invoiceBusy || now < lastInvoiceRead || now-lastInvoiceRead < 10_000) { send(429,{error:'برای دریافت دوباره کمی صبر کنید'});return }
          invoiceBusy=true;lastInvoiceRead=now
          try {
            const result=parseInvoicePage(await options.reader.invoiceFactsPage(data.fromDay,data.toDay,data.afterId as number,50),data.fromDay,data.toDay,data.afterId as number)
            // Membership and permissions may change while the read is pending.
            if (!options.identity.authorize(token,'invoices','VIEW')) { send(403,{error:'اجازه مشاهده این بخش را ندارید'});return }
            send(200,{invoices:result,hasMore:result.length===50});return
          } finally { invoiceBusy=false }
        }
        if (path === '/api/invite/accept' || path === '/api/invite/create' || path === '/api/member/approve' || path === '/api/member/remove') {
          if (!loginAllowed(req.socket.remoteAddress ?? 'unknown')) { send(429,{error:'تعداد تلاش‌ها زیاد است؛ بعداً دوباره تلاش کنید'});return }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(header(req,'content-type') ?? '')) { send(400,{error:'درخواست معتبر نیست'});return }
          let data: Record<string,unknown>
          try { data=await readBody(req) } catch { send(400,{error:'درخواست معتبر نیست'});return }
          if (path === '/api/invite/accept') {
            if (Object.keys(data).sort().join(',') !== 'invite,password,pin,username' || typeof data.invite !== 'string' || typeof data.username !== 'string' ||
                typeof data.password !== 'string' || typeof data.pin !== 'string' || !options.identity.acceptInvite(data.invite,data.username,data.password,data.pin)) {
              send(400,{error:'دعوت یا اطلاعات ورود معتبر نیست'});return
            }
            send(200,{ok:true});return
          }
          const token=cookie(req), principal=token ? options.identity.whoAmI(token) : null
          if (!token || !principal) { send(401,{error:'لطفاً وارد شوید'});return }
          if (principal.role !== 'OWNER') { send(403,{error:'فقط مالک مجاز است'});return }
          if (path === '/api/invite/create') {
            if (Object.keys(data).sort().join(',') !== 'acl,pin,role' || typeof data.pin !== 'string' ||
                (data.role !== 'MANAGER' && data.role !== 'VIEWER') || !Array.isArray(data.acl) ||
                data.acl.some((a: any) => !a || typeof a !== 'object' || Array.isArray(a) ||
                  Object.keys(a).sort().join(',') !== 'approve,panel,view' || (a.panel === 'custody' && a.approve !== false))) {
              send(400,{error:'درخواست معتبر نیست'});return
            }
            const result=options.identity.createInvite(token,data.pin,data.role,data.acl)
            if (!result.ok) { send(403,{error:'دعوت ساخته نشد؛ PIN، دسترسی‌ها یا سقف اعضا را بررسی کنید'});return }
            send(200,{invite:result.invite});return
          }
          if (Object.keys(data).sort().join(',') !== 'pin,username' || typeof data.pin !== 'string' || typeof data.username !== 'string') { send(400,{error:'درخواست معتبر نیست'});return }
          if (path === '/api/member/approve') {
            if (!options.identity.approveMember(token,data.pin,data.username)) { send(403,{error:'تأیید انجام نشد'});return }
            send(200,{ok:true});return
          }
          // Removing a member also requires a trusted desktop revocation bridge.
          // Never report success until all queued revocations have been applied.
          if (typeof options.drainRevocations !== 'function') { send(503,{error:'کانال ابطال مجوز فعال نیست'});return }
          const result=options.identity.removeMember(token,data.pin,data.username)
          if (!result.ok) { send(403,{error:'حذف انجام نشد'});return }
          try {
            const drained=await options.drainRevocations()
            if (!drained || drained.remaining !== false) { send(503,{error:'حذف ثبت شد اما ابطال مجوزها هنوز کامل نیست'});return }
          } catch { send(503,{error:'حذف ثبت شد اما ابطال مجوزها هنوز کامل نیست'});return }
          send(200,{ok:true});return
        }
      }
      if (req.method === 'GET' && (path === '/api/session' || path === '/api/capabilities' || path === '/api/members' || path === '/api/custody' || path === '/api/shifts' || (path === '/api/requests' && options.approval))) {
        const token=cookie(req), user=token ? options.identity.whoAmI(token) : null
        if (!token || !user) { send(401,{error:'لطفاً وارد شوید'});return }
        if (path === '/api/session') {
          // Do not expose internal member identifiers to the mobile client.
          send(200,{user:{username:text(user.username,256),role:text(user.role,32)}});return
        }
        if (path === '/api/capabilities') {
          send(200,{invoices:typeof options.reader.invoiceFactsPage === 'function' && !!options.identity.authorize(token,'invoices','VIEW'),
            ...(user.role==='OWNER' && typeof options.identity.panic==='function' && typeof options.drainRevocations==='function' ? {panic:true} : {}),
            ...(user.role==='OWNER' && typeof options.identity.panicClose==='function' && typeof options.drainRevocations==='function' ? {panicClose:true} : {})});return
        }
        if (path === '/api/members') {
          if (user.role !== 'OWNER') { send(403,{error:'فقط مالک مجاز است'});return }
          const members=options.identity.listMembers(token)
          if (!members) { send(403,{error:'فقط مالک مجاز است'});return }
          send(200,{members});return
        }
        if (path === '/api/requests' && options.approval) {
          const list=options.approval.list(token)
          if (!Array.isArray(list) || list.length > 200) throw new Error('Invalid request list')
          const requests=list.map(r=>{
            if (!r || typeof r.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(r.requestId) ||
                typeof r.panel !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.panel) ||
                typeof r.code !== 'string' || !/^[0-9]{6}$/.test(r.code)) throw new Error('Invalid request')
            return {requestId:r.requestId,panel:r.panel,code:r.code}
          })
          send(200,{requests});return
        }
        const panel=path === '/api/custody' ? 'custody' : 'shifts'
        if (!options.identity.authorize(token,panel,'VIEW')) { send(403,{error:'اجازه مشاهده این بخش را ندارید'});return }
        if (panel === 'custody') {
          const result=boundary(await options.reader.latestBoundaryTotals())
          if (!options.identity.authorize(token,panel,'VIEW')) { send(403,{error:'اجازه مشاهده این بخش را ندارید'});return }
          send(200,{boundary:result});return
        }
        const list=shifts(await options.reader.openShiftsPage(0,200))
        if (!options.identity.authorize(token,panel,'VIEW')) { send(403,{error:'اجازه مشاهده این بخش را ندارید'});return }
        send(200,{shifts:list,hasMore:list.length===200});return
      }
      send(404,{error:'یافت نشد'})
    } catch { send(503,{error:'سرویس موقتاً در دسترس نیست'}) }
  }
}
/** Explicit loopback-only listener; not started automatically. */
export async function startMobileReadOnlyHub(options: Options, port = 0) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
  const handler=createMobileReadOnlyHandler(options)
  const server=createServer((req,res) => { void handler(req,res) })
  await new Promise<void>((resolve,reject) => { server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve()}) })
  const address=server.address()
  if (!address || typeof address === 'string') { server.close();throw new Error('Invalid listener') }
  return {
    port:address.port,
    close:() => new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())),
    // Only for terminating an isolated hub process; aborts active requests.
    closeNow:() => { server.closeAllConnections(); return new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())) }
  }
}
