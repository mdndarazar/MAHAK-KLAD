/**
 * طرح ۱۴۰۵ · مورد ۱۲ — گواهی اعتبار برگشت و تعویض: چاپ دوبارهٔ فروشنده و چاپگر گواهی (معماری §۴-۳).
 *
 * طرح مالک: فروشنده بی مدیر، **یک بار**، فقط در **همان شیفتِ صدور** (یا همان روز اگر شیفت نبود) و با
 * **دلیل** («چاپ ناقص»، یا «سایر» با توضیح دست‌کم ۱۰ حرف) گواهی را دوباره چاپ می‌کند؛ مدیر هر روز در تب
 * «چاپ دوباره» می‌بیند. این پرونده جدا از `StoreCreditService.ts` است (شرط ۲ اصل «الف»): `markPrinted`، مبلغ،
 * صدور و مصرف اعتبار دست نمی‌خورند و فقط ردیف‌های `CREDIT_REPRINT` با `auditOrThrow` نوشته می‌شوند.
 *
 *  - `reserveSellerReprint`: در **یک تراکنش** شرط‌ها را می‌سنجد و ردیف `after.path = 'SELLER_CERTIFICATE'`
 *    می‌نویسد. دو رایانهٔ هم‌زمان را SQLite پشت‌سرهم می‌کند؛ پس از نوشتن هم یک بار دیگر شمرده می‌شود.
 *  - `releaseSellerReprint`: فقط وقتی ویندوز چاپ را قطعاً رد یا لغو کرد؛ نتیجهٔ نامعلوم «چاپ‌شده» است.
 *  - چاپگر گواهی: تنظیم `credit.certificatePrinter`؛ نام‌های مجازی (PDF، XPS، OneNote، Fax) پذیرفته نمی‌شوند.
 *    تشخیص فقط از روی نام است؛ «مانع» است، نه «سد» (همین در راهنمای مالک آمده است).
 */
import { randomBytes } from 'node:crypto'
import { prisma } from '../db/client'
import { TX_OPTIONS } from '../db/tx'
import { BusinessError } from '../errors'
import { audit, auditOrThrow } from './AuditService'
import { AuditAction } from '@shared/enums'
import { SETTING_KEYS } from '@shared/receipt'
import { faDigits, toClock, toJalaliDate } from '@shared/jalali'
import { listPrintersDetailed, pickPrinter, printerNotFoundMessage } from '../print/target'

export const SELLER_REPRINT_PATH = 'SELLER_CERTIFICATE'
export const SELLER_REPRINT_RELEASED_PATH = 'SELLER_CERTIFICATE_RELEASED'
export const SELLER_REPRINT_REASONS = Object.freeze({ INCOMPLETE: 'چاپ ناقص', OTHER: 'سایر' } as const)
export type SellerReprintReason = keyof typeof SELLER_REPRINT_REASONS
export const SELLER_REPRINT_MIN_EXPLANATION = 10
export const CERTIFICATE_PRINTER_NEEDED = 'چاپگر گواهی را در تنظیمات تعیین کنید (چاپگر مجازی مثل PDF، XPS، OneNote یا Fax پذیرفته نیست).'
/** پیام فروشنده پس از چاپ بی پنجره: «به صف رفت»، نه «چاپ شد» (`PrintService.ts`، silent). */
export const SELLER_REPRINT_QUEUED_MESSAGE = 'چاپ به صف چاپگر رفت. اگر کاغذ بیرون نیامد، به مدیر بگویید.'
export const FIRST_PRINT_QUEUED_MESSAGE = 'گواهی به صف چاپگر رفت. اگر کاغذ کامل بیرون نیامد، «چاپ دوباره (با دلیل)» را بزنید؛ این کار فقط یک بار و فقط در همین شیفت ممکن است.'

const VIRTUAL = /pdf|xps|one\s*note|fax|document\s*writer|print\s*to\s*file/i
/** چاپگر مجازی (فایل یا نرم‌افزار)، از روی نام. */
export function isVirtualPrinterName(name: unknown): boolean {
  const s = String(name ?? '').trim()
  return !!s && VIRTUAL.test(s)
}

const CERT_KEY = SETTING_KEYS.creditCertificatePrinter
const SEEN_KEY = SETTING_KEYS.creditSellerReprintSeenAt
const parse = (v: unknown): any => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return null } }

async function readSetting(key: string): Promise<any> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row ? parse(row.value) : null
}
async function writeSetting(key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  await prisma.setting.upsert({ where: { key }, create: { key, value: text }, update: { value: text } })
}

/** نام ذخیره‌شدهٔ چاپگر گواهی؛ خالی یعنی «چاپگر پیش‌فرض ویندوز، اگر واقعی باشد». */
export async function readCertificatePrinter(): Promise<string> {
  const v = await readSetting(CERT_KEY)
  return typeof v?.printerName === 'string' ? v.printerName.trim() : ''
}

/** انتخاب مدیر در «تنظیمات › چاپ». نام باید روی همین رایانه باشد و مجازی نباشد. */
export async function saveCertificatePrinter(input: { printerName?: unknown; userId?: number | null }): Promise<{ printerName: string }> {
  const printerName = String(input?.printerName ?? '').trim().slice(0, 200)
  if (printerName) {
    if (isVirtualPrinterName(printerName)) throw new BusinessError(`«${printerName}» چاپگر مجازی است؛ گواهی اعتبار فقط با چاپگر واقعی چاپ می‌شود.`)
    const printers = await listPrintersDetailed()
    if (!printers.some((p) => p.name === printerName)) throw new BusinessError(printerNotFoundMessage(printerName))
  }
  const before = await readCertificatePrinter()
  if (before === printerName) return { printerName }
  await writeSetting(CERT_KEY, { printerName })
  await audit(prisma, {
    action: AuditAction.SETTINGS_UPDATE,
    entity: 'Setting',
    userId: input?.userId ?? null,
    before: JSON.stringify({ key: CERT_KEY, printerName: before }),
    after: JSON.stringify({ key: CERT_KEY, printerName }),
    note: printerName ? `چاپگر گواهی اعتبار: «${printerName}»` : 'چاپگر گواهی اعتبار: چاپگر پیش‌فرض ویندوز (اگر مجازی نباشد)'
  })
  return { printerName }
}

/** چاپگر مسیر گواهی فروشنده: انتخاب مدیر؛ وگرنه چاپگر پیش‌فرض ویندوز اگر مجازی نباشد. */
export async function certificatePrinterDevice(): Promise<string> {
  const saved = await readCertificatePrinter()
  if (saved && isVirtualPrinterName(saved)) throw new BusinessError(CERTIFICATE_PRINTER_NEEDED)
  const printers = await listPrintersDetailed()
  if (!saved && !printers.some((p) => p.isDefault)) throw new BusinessError(CERTIFICATE_PRINTER_NEEDED)
  const { deviceName } = pickPrinter(printers, '', saved)
  if (isVirtualPrinterName(deviceName)) throw new BusinessError(CERTIFICATE_PRINTER_NEEDED)
  return deviceName
}

type Reservation = { id: number; key: string | null; at: Date; userId: number | null; after: any }
/** رزروهای «چاپ دوبارهٔ فروشنده» که آزاد نشده‌اند. */
async function activeReservations(client: any, creditId: number): Promise<Reservation[]> {
  const rows = await client.auditLog.findMany({
    where: { action: AuditAction.CREDIT_REPRINT, entity: 'StoreCredit', entityId: creditId, after: { contains: `"path":"${SELLER_REPRINT_PATH}` } },
    select: { id: true, at: true, userId: true, after: true },
    orderBy: { id: 'asc' }
  })
  const reserved: Reservation[] = []
  const released = new Set<number>()
  for (const row of rows) {
    const a = parse(row.after)
    if (a?.path === SELLER_REPRINT_PATH) reserved.push({ id: row.id, key: typeof a.reservationKey === 'string' ? a.reservationKey : null, at: new Date(row.at), userId: row.userId ?? null, after: a })
    else if (a?.path === SELLER_REPRINT_RELEASED_PATH && Number.isSafeInteger(a.releasedFrom)) released.add(a.releasedFrom)
  }
  return reserved.filter((r) => !released.has(r.id))
}

/** کد اعتبار اگر در توضیح فروشنده تایپ شده باشد، پوشانده می‌شود (مثل ردیف‌های اعتبار در AuditLog). */
function redactCode(text: string, codes: Array<string | null | undefined>): string {
  let out = text
  for (const code of codes) {
    const c = String(code ?? '').trim()
    if (c.length >= 4) out = out.split(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('[کد پنهان]')
  }
  return out
}

/**
 * رزرو یک «چاپ دوبارهٔ فروشنده» پیش از چاپ. شرط‌ها و ثبت دلیل در یک تراکنش‌اند؛ هر خطا یعنی هیچ ردیفی
 * نوشته نشد و چاپی انجام نمی‌شود.
 */
export async function reserveSellerReprint(input: {
  creditId: unknown
  userId?: number | null
  reasonCode: unknown
  explanation?: unknown
  now?: Date
}): Promise<{ auditId: number; creditId: number }> {
  const creditId = Math.round(Number(input?.creditId))
  if (!Number.isSafeInteger(creditId) || creditId <= 0) throw new BusinessError('اعتبار برای چاپ دوباره مشخص نشده است.')
  const reasonCode = String(input?.reasonCode ?? '') as SellerReprintReason
  if (!Object.prototype.hasOwnProperty.call(SELLER_REPRINT_REASONS, reasonCode)) throw new BusinessError('دلیل چاپ دوباره را انتخاب کنید: «چاپ ناقص» یا «سایر».')
  const explanationRaw = String(input?.explanation ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  if (reasonCode === 'OTHER' && explanationRaw.replace(/\s/g, '').length < SELLER_REPRINT_MIN_EXPLANATION)
    throw new BusinessError('برای «سایر» توضیح دست‌کم ۱۰ حرفی بنویسید.')
  const now = input?.now ?? new Date()
  const reservationKey = randomBytes(8).toString('hex')
  return prisma.$transaction(async (tx: any) => {
    const credit = await tx.storeCredit.findUnique({
      where: { id: creditId },
      select: { id: true, code: true, legacyCode: true, status: true, returnId: true, exchangeInvoiceId: true, printCount: true, issuedAt: true }
    })
    if (!credit || (credit.returnId == null && credit.exchangeInvoiceId == null))
      throw new BusinessError('فروشنده فقط گواهی اعتبارِ برگشت یا تعویض را می‌تواند دوباره چاپ کند.')
    if (!['ACTIVE', 'DRAFT'].includes(String(credit.status)))
      throw new BusinessError('این اعتبار دیگر قابل مصرف نیست؛ چاپ دوباره ممکن نیست.')
    if (Number(credit.printCount ?? 0) <= 0)
      throw new BusinessError('گواهی هنوز چاپ نشده است؛ ابتدا «چاپ گواهی بارکد» را بزنید.')
    const ret = credit.returnId != null
      ? await tx.saleReturn.findUnique({ where: { id: credit.returnId }, select: { id: true, shiftId: true, returnedAt: true } })
      : await tx.saleReturn.findFirst({ where: { storeCreditId: credit.id }, select: { id: true, shiftId: true, returnedAt: true } })
    const issueShiftId: number | null = ret?.shiftId ?? null
    if (issueShiftId != null) {
      const shift = await tx.shift.findUnique({ where: { id: issueShiftId }, select: { id: true, closedAt: true } })
      if (!shift || shift.closedAt)
        throw new BusinessError('چاپ دوبارهٔ فروشنده فقط در همان شیفتِ صدور اعتبار ممکن است و آن شیفت بسته شده است. از مدیر بخواهید از «مدیریت اعتبار» چاپ کند.')
    } else {
      const issued = ret?.returnedAt ?? credit.issuedAt
      if (!issued || toJalaliDate(new Date(issued)) !== toJalaliDate(now))
        throw new BusinessError('چاپ دوبارهٔ فروشنده فقط در همان روزِ صدور اعتبار ممکن است. از مدیر بخواهید از «مدیریت اعتبار» چاپ کند.')
    }
    if ((await activeReservations(tx, creditId)).length)
      throw new BusinessError('چاپ دوبارهٔ فروشنده برای این اعتبار یک بار انجام شده است. برای نسخهٔ دیگر از مدیر بخواهید از «مدیریت اعتبار» چاپ کند.')
    const explanation = redactCode(explanationRaw, [credit.code, credit.legacyCode])
    await auditOrThrow(tx, {
      action: AuditAction.CREDIT_REPRINT,
      entity: 'StoreCredit',
      entityId: creditId,
      userId: input?.userId ?? null,
      after: JSON.stringify({
        path: SELLER_REPRINT_PATH, sellerReprint: true, reasonCode, explanation, issueShiftId,
        printCountBefore: Number(credit.printCount ?? 0), reservationKey
      }),
      note: `چاپ دوبارهٔ گواهی اعتبار #${creditId} به دست فروشنده · دلیل: ${SELLER_REPRINT_REASONS[reasonCode]}`
    })
    const active = await activeReservations(tx, creditId)
    const mine = active.find((r) => r.key === reservationKey)
    if (!mine || active.length !== 1) throw new BusinessError('چاپ دوبارهٔ هم‌زمان از رایانهٔ دیگری ثبت شد؛ فقط یکی پذیرفته است.')
    return { auditId: mine.id, creditId }
  }, TX_OPTIONS)
}

/** فقط وقتی چاپ قطعاً انجام نشد (لغو یا رد، یا چاپگر پیدا نشد): رزرو آزاد می‌شود تا فروشنده دوباره بزند. */
export async function releaseSellerReprint(input: { auditId: number; creditId: number; userId?: number | null }): Promise<boolean> {
  return prisma.$transaction(async (tx: any) => {
    const active = await activeReservations(tx, input.creditId)
    if (!active.some((r) => r.id === input.auditId)) return false
    await auditOrThrow(tx, {
      action: AuditAction.CREDIT_REPRINT,
      entity: 'StoreCredit',
      entityId: input.creditId,
      userId: input.userId ?? null,
      after: JSON.stringify({ path: SELLER_REPRINT_RELEASED_PATH, releasedFrom: input.auditId }),
      note: `چاپ دوبارهٔ فروشنده برای اعتبار #${input.creditId} انجام نشد و دوباره آزاد شد`
    })
    return true
  }, TX_OPTIONS)
}

export interface SellerReprintRow {
  auditId: number
  creditId: number
  publicReference: string
  at: number
  atJalali: string
  atTime: string
  sellerName: string
  shiftName: string | null
  reasonLabel: string
  explanation: string
  printNo: number
  amount: number
  docLabel: string
  released: boolean
  used: Array<{ byName: string; shiftName: string | null; atJalali: string; atTime: string }>
  deliveryRecorded: boolean | null
  suspicious: boolean
  sameSeller: boolean
  isNew: boolean
}

/** تب «چاپ دوباره» در «مدیریت اعتبار» (فقط خواندن). */
export async function sellerReprintList(input: { take?: number } = {}): Promise<{ rows: SellerReprintRow[]; newCount: number; seenAt: string | null }> {
  const take = Math.min(2000, Math.max(1, Math.round(Number(input?.take) || 500)))
  const db: any = prisma
  const logRows = await db.auditLog.findMany({
    where: { action: AuditAction.CREDIT_REPRINT, entity: 'StoreCredit', after: { contains: `"path":"${SELLER_REPRINT_PATH}` } },
    select: { id: true, at: true, userId: true, entityId: true, after: true },
    orderBy: { id: 'desc' },
    take: take * 2
  })
  const released = new Set<number>()
  const reservations: Array<{ id: number; at: Date; userId: number | null; creditId: number; a: any }> = []
  for (const row of logRows) {
    const a = parse(row.after)
    if (a?.path === SELLER_REPRINT_RELEASED_PATH && Number.isSafeInteger(a.releasedFrom)) released.add(a.releasedFrom)
    else if (a?.path === SELLER_REPRINT_PATH && row.entityId) reservations.push({ id: row.id, at: new Date(row.at), userId: row.userId ?? null, creditId: row.entityId, a })
  }
  const list = reservations.slice(0, take)
  const creditIds = [...new Set(list.map((r) => r.creditId))]
  const credits = new Map<number, any>()
  for (const c of creditIds.length ? await db.storeCredit.findMany({ where: { id: { in: creditIds } }, select: { id: true, amount: true, returnId: true, exchangeInvoiceId: true } }) : []) credits.set(c.id, c)
  const returnIds = [...new Set([...credits.values()].map((c) => c.returnId).filter((id: unknown) => Number.isSafeInteger(id)))] as number[]
  const returns = new Map<number, any>()
  for (const r of returnIds.length ? await db.saleReturn.findMany({ where: { id: { in: returnIds } }, select: { id: true, kind: true, invoiceId: true, shiftId: true } }) : []) returns.set(r.id, r)
  const invoiceIds = [...new Set([...returns.values()].map((r) => r.invoiceId))] as number[]
  const invoices = new Map<number, number>()
  for (const i of invoiceIds.length ? await db.saleInvoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, receiptNo: true } }) : []) invoices.set(i.id, i.receiptNo)
  const redemptions = creditIds.length ? await db.storeCreditRedemption.findMany({ where: { creditId: { in: creditIds }, reversedAt: null }, select: { creditId: true, userId: true, shiftId: true, at: true } }) : []
  const deliveries = new Map<number, string>()
  for (const d of creditIds.length ? await db.storeCreditDelivery.findMany({ where: { creditId: { in: creditIds } }, select: { creditId: true, status: true } }) : []) deliveries.set(d.creditId, String(d.status))
  const shiftIds = new Set<number>()
  for (const r of list) if (Number.isSafeInteger(r.a?.issueShiftId)) shiftIds.add(r.a.issueShiftId)
  for (const r of redemptions) if (r.shiftId) shiftIds.add(r.shiftId)
  const shifts = new Map<number, string>()
  for (const s of shiftIds.size ? await db.shift.findMany({ where: { id: { in: [...shiftIds] } }, select: { id: true, name: true } }) : []) shifts.set(s.id, String(s.name ?? ''))
  const userIds = new Set<number>()
  for (const r of list) if (r.userId) userIds.add(r.userId)
  for (const r of redemptions) if (r.userId) userIds.add(r.userId)
  const users = new Map<number, string>()
  for (const u of userIds.size ? await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true, username: true } }) : []) users.set(u.id, String(u.displayName || u.username || ''))
  const seen = await readSetting(SEEN_KEY)
  const seenAt = typeof seen?.at === 'string' ? seen.at : null
  const seenMs = seenAt ? new Date(seenAt).getTime() : 0

  const rows: SellerReprintRow[] = list.map((r) => {
    const credit = credits.get(r.creditId)
    const ret = credit?.returnId != null ? returns.get(credit.returnId) : undefined
    const receipt = ret ? invoices.get(ret.invoiceId) : undefined
    const used = redemptions
      .filter((x: any) => x.creditId === r.creditId && new Date(x.at).getTime() >= r.at.getTime())
      .map((x: any) => ({ byName: x.userId ? users.get(x.userId) ?? `کاربر ${x.userId}` : 'نامشخص', shiftName: x.shiftId ? shifts.get(x.shiftId) ?? null : null, atJalali: toJalaliDate(new Date(x.at)), atTime: toClock(new Date(x.at), false), userId: x.userId ?? null }))
    const isReleased = released.has(r.id)
    const sameSeller = !isReleased && used.some((u: any) => u.userId != null && u.userId === r.userId)
    const deliveryStatus = deliveries.get(r.creditId)
    return {
      auditId: r.id,
      creditId: r.creditId,
      publicReference: `اعتبار #${faDigits(r.creditId)}`,
      at: r.at.getTime(),
      atJalali: toJalaliDate(r.at),
      atTime: toClock(r.at, false),
      sellerName: r.userId ? users.get(r.userId) ?? `کاربر ${r.userId}` : 'نامشخص',
      shiftName: Number.isSafeInteger(r.a?.issueShiftId) ? shifts.get(r.a.issueShiftId) ?? null : null,
      reasonLabel: SELLER_REPRINT_REASONS[r.a?.reasonCode as SellerReprintReason] ?? 'نامشخص',
      explanation: typeof r.a?.explanation === 'string' ? r.a.explanation : '',
      printNo: Math.max(0, Number(r.a?.printCountBefore) || 0) + 1,
      amount: Number(credit?.amount ?? 0),
      docLabel: ret ? `${ret.kind === 'EXCHANGE' ? 'تعویض' : 'برگشت'}${receipt != null ? ` · فاکتور ${faDigits(receipt)}` : ''}` : credit?.exchangeInvoiceId ? 'تعویض' : '—',
      released: isReleased,
      used: used.map(({ userId: _u, ...rest }: any) => rest),
      deliveryRecorded: deliveryStatus == null ? null : deliveryStatus !== 'PENDING',
      suspicious: !isReleased && used.length > 0,
      sameSeller,
      isNew: r.at.getTime() > seenMs
    }
  })
  return { rows, newCount: rows.filter((x) => x.isNew && !x.released).length, seenAt }
}

/** «دیدم»: زمان آخرین بازبینی مدیر در `Setting` (بی migration). */
export async function markSellerReprintsSeen(input: { now?: Date } = {}): Promise<{ seenAt: string }> {
  const seenAt = (input?.now ?? new Date()).toISOString()
  await writeSetting(SEEN_KEY, { at: seenAt })
  return { seenAt }
}

/** ستون «شیفت» دفتر مصرف در جزئیات اعتبار (فقط نمایشی؛ داده از قبل ثبت می‌شود). */
export async function withRedemptionShifts<T>(detail: T): Promise<T> {
  const list = (detail as any)?.redemptions
  if (!Array.isArray(list) || !list.length) return detail
  const ids = list.map((r: any) => Number(r?.id)).filter((id: number) => Number.isSafeInteger(id) && id > 0)
  if (!ids.length) return detail
  const db: any = prisma
  const rows = await db.storeCreditRedemption.findMany({ where: { id: { in: ids } }, select: { id: true, shiftId: true } })
  const shiftOf = new Map<number, number>(rows.filter((r: any) => r.shiftId).map((r: any) => [r.id, r.shiftId]))
  const shiftIds = [...new Set(shiftOf.values())]
  const names = new Map<number, string>()
  for (const s of shiftIds.length ? await db.shift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, name: true } }) : []) names.set(s.id, String(s.name ?? ''))
  return { ...(detail as any), redemptions: list.map((r: any) => ({ ...r, shiftName: shiftOf.has(r.id) ? names.get(shiftOf.get(r.id)!) ?? null : null })) }
}
