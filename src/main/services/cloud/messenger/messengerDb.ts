/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — خواندن سبک از پایگاه داده برای پیام‌رسان (فقط خواندن).
 *
 * AuditLog از نشانگر به بعد، صفحهٔ حداکثر ۲۰۰ ردیف (WAL خاموش است؛ طرح §۲۶-۲ افزودهٔ ۲۵).
 * رویدادهای حضانت از جدول خودشان. هیچ نوشتنی در پایگاه داده انجام نمی‌شود.
 */
import { createHash } from 'node:crypto'
import { prisma as defaultPrisma } from '../../../db/client'
import { SETTING_KEYS, minutesOfTime, parseAccountingPolicy, parseCustodyConfig, parseOfficialTimeConfig, parseShiftConfig } from '@shared/receipt'
import { faDigits, jalaliEndOfDay, jalaliStartOfDay } from '@shared/jalali'
import { custodyBoundaryId, custodyTargetUserId, minutesAfterShiftEnd, type AuditRowLite, type CustodyCountLite, type CustodyEventLite, type DocLineLite, type IdsNeeded, type LookupData } from './messengerEvents'
import { emptyLookups, type ShiftPlanLite, type ShiftReminderSegment } from './messengerEvents'

type Client = typeof defaultPrisma
const CHUNK = 400
const chunks = <T>(list: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(String(v)).getTime())
const toNum = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v) || 0)

/** دفتر آزمون ۴-۳۳ — سند برگشت یا تعویض برای گزارش ربات (قلم‌ها از خود سند، بی کد و بارکد). */
export interface BotReturnDoc {
  lines: DocLineLite[]
  /** فقط تعویض: قلم‌های فاکتور جایگزین، شماره و مبلغش */
  replacement: DocLineLite[] | null
  exchangeReceiptNo: number | null
  exchangeGrandTotal: number | null
  /** شماره‌ها از نخستین فاکتور تا همین سند (همان ۴-۹) */
  chain: number[]
}
/** دفتر آزمون ۴-۳۳ — یک ردیف کارت‌به‌کارت مدیر (ستون‌های ثابت؛ بی یادداشت، بی دلیل آزاد و بی شمارهٔ پیگیری). */
export interface BotCardTransferRow {
  id: number; kind: string; status: string; operationKind: string; returnId: number
  sourceReceiptNo: number | null; exchangeReceiptNo: number | null; adjustsRequestId: number | null
  amount: number; userName: string; createdAtJalali: string; createdAtTime: string
  paid: boolean; paidAmount: number | null; paidAtJalali: string; paidAtTime: string; paidByUserName: string
  items: Array<{ name: string; qty: number; unitPrice: number }>
}
export interface BotCardTransferPage {
  /** شمار ردیف‌های بازه (همان شرط فهرست برنامه: ثبت یا پرداخت در بازه) */
  total: number
  rows: BotCardTransferRow[]
  /** درخواست‌های هنوز در انتظار که پیش از بازه ثبت شده‌اند */
  pendingBefore: { count: number; total: number }
}
/** دفتر آزمون ۴-۳۳ — «وضعیت الان»: صندوق دست کیست و شیفت‌های باز. */
export interface BotCustodyNow {
  holder: { name: string; since: number; shiftName: string; scheduledEndAt: number | null } | null
  handoverPending: boolean
  openShifts: Array<{ name: string; userName: string; since: number }>
}

/** همان شکل هش ردیف در `databaseFingerprint.ts`: [id, at, action, entity] */
export function auditAnchorHash(row: { id: number; at: Date | string | number; action: string; entity: string }): string {
  return createHash('sha256').update(JSON.stringify([row.id, new Date(ms(row.at)).toISOString(), row.action, row.entity]), 'utf8').digest('hex')
}

export function createMessengerDb(client: Client = defaultPrisma) {
  const db = client as any

  async function maxAuditId(): Promise<number> {
    const row = await db.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
    return row?.id ?? 0
  }
  async function auditAnchor(id: number): Promise<{ id: number; at: Date; action: string; entity: string } | null> {
    if (!id) return null
    return (await db.auditLog.findUnique({ where: { id }, select: { id: true, at: true, action: true, entity: true } })) ?? null
  }
  async function auditPage(afterId: number, take: number): Promise<AuditRowLite[]> {
    return db.auditLog.findMany({
      where: { id: { gt: afterId } }, orderBy: { id: 'asc' }, take,
      select: { id: true, at: true, userId: true, action: true, entity: true, entityId: true, after: true, note: true }
    })
  }
  async function maxCustodyEventId(): Promise<number> {
    const row = await db.custodyEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
    return row?.id ?? 0
  }
  async function custodyEventPage(afterId: number, take: number): Promise<CustodyEventLite[]> {
    return db.custodyEvent.findMany({
      where: { id: { gt: afterId } }, orderBy: { id: 'asc' }, take,
      select: { id: true, type: true, shiftId: true, handoverId: true, actorUserId: true, managerUserId: true, payloadJson: true, at: true }
    })
  }
  async function maxCustodyCountId(): Promise<number> {
    const row = await db.custodyCount.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
    return row?.id ?? 0
  }
  async function custodyCountPage(afterId: number, take: number): Promise<CustodyCountLite[]> {
    return db.custodyCount.findMany({
      where: { id: { gt: afterId } }, orderBy: { id: 'asc' }, take,
      select: { id: true, kind: true, shiftId: true, handoverId: true, countedByUserId: true, countedCash: true, expectedCash: true, differenceCash: true, at: true }
    })
  }

  /** همهٔ نام‌ها و عددهای کمکی یک صفحه، دسته‌ای. فقط ستون‌های لازم؛ تلفن و کد هرگز انتخاب نمی‌شوند. */
  async function fetchLookups(ids: IdsNeeded, custody?: { events: CustodyEventLite[]; counts: CustodyCountLite[] }): Promise<LookupData> {
    const data = emptyLookups()
    const users = new Set(ids.users), shifts = new Set(ids.shifts), invoices = new Set(ids.invoices), handovers = new Set(ids.handovers)
    const boundaries = new Set<number>()
    for (const ev of custody?.events ?? []) {
      if (ev.actorUserId) users.add(ev.actorUserId)
      if (ev.managerUserId) users.add(ev.managerUserId)
      if (ev.shiftId) shifts.add(ev.shiftId)
      if (ev.handoverId) handovers.add(ev.handoverId)
      const boundaryId = custodyBoundaryId(ev)
      if (boundaryId) boundaries.add(boundaryId)
      const target = custodyTargetUserId(ev) // دفتر آزمون ۴-۱۹
      if (target) users.add(target)
    }
    for (const c of custody?.counts ?? []) if (c.countedByUserId) users.add(c.countedByUserId)

    for (const part of chunks([...ids.payments])) {
      const rows = await db.payment.findMany({ where: { id: { in: part } }, select: { id: true, invoiceId: true, amount: true } })
      for (const p of rows) { data.payments.set(p.id, { invoiceId: p.invoiceId, amount: toNum(p.amount) }); invoices.add(p.invoiceId) }
    }
    for (const part of chunks([...ids.credits])) {
      const rows = await db.storeCredit.findMany({ where: { id: { in: part } }, select: { id: true, userId: true, issuedAt: true } })
      for (const c of rows) { data.credits.set(c.id, { userId: c.userId ?? null, issuedAt: ms(c.issuedAt) }); if (c.userId) users.add(c.userId) }
      // مرحلهٔ ۴ (مورد ۱۲): چاپ دوبارهٔ فروشنده با `sellerReprint: true` در `after` رزرو می‌شود و اگر چاپ قطعاً
      // رد شد، ردیف «آزاد شد» (`releasedFrom`) می‌آید. رزروِ آزادشده چاپ دوباره حساب نمی‌شود.
      const reserved = await db.auditLog.findMany({
        where: { action: 'CREDIT_REPRINT', entity: 'StoreCredit', entityId: { in: part }, after: { contains: '"path":"SELLER_CERTIFICATE' } },
        orderBy: { id: 'asc' }, select: { id: true, entityId: true, after: true }
      })
      const released = new Set<number>()
      const active: Array<{ id: number; creditId: number; reasonCode: string }> = []
      for (const r of reserved) {
        let a: any = null
        try { a = JSON.parse(r.after ?? 'null') } catch {}
        if (a?.path === 'SELLER_CERTIFICATE_RELEASED' && Number.isSafeInteger(a.releasedFrom)) released.add(a.releasedFrom)
        else if (a?.path === 'SELLER_CERTIFICATE' && a.sellerReprint === true && r.entityId) active.push({ id: r.id, creditId: r.entityId, reasonCode: String(a.reasonCode ?? '') })
      }
      for (const s of active) {
        if (released.has(s.id)) continue
        data.reprinted.add(s.creditId)
        // کاغذِ همین چاپ دوباره: نخستین ردیف `markPrinted` همان اعتبار پس از رزرو
        const next = await db.auditLog.findMany({
          where: { action: 'CREDIT_REPRINT', entity: 'StoreCredit', entityId: s.creditId, id: { gt: s.id } },
          orderBy: { id: 'asc' }, take: 5, select: { id: true, after: true }
        })
        const paper = next.find((x: any) => !String(x.after ?? '').includes('"path":"SELLER_CERTIFICATE'))
        if (paper) data.sellerPapers.set(paper.id, s.reasonCode)
      }
    }
    for (const { creditId, paymentId } of ids.redemptions) {
      const row = await db.storeCreditRedemption.findFirst({ where: { creditId, paymentId }, orderBy: { id: 'desc' }, select: { userId: true, at: true } })
      if (row) { data.redemptions.set(`${creditId}:${paymentId}`, { userId: row.userId ?? null, at: ms(row.at) }); if (row.userId) users.add(row.userId) }
    }
    for (const part of chunks([...handovers])) {
      const rows = await db.custodyHandover.findMany({
        where: { id: { in: part } },
        select: { id: true, fromShiftId: true, fromUserId: true, acceptedByUserId: true, finalCustodianUserId: true, expectedAtStart: true, countedAtStart: true, differenceCash: true }
      })
      for (const h of rows) {
        const receiver = h.acceptedByUserId ?? h.finalCustodianUserId ?? null
        data.handovers.set(h.id, { fromUserId: h.fromUserId ?? null, receiverUserId: receiver, expectedAtStart: h.expectedAtStart, countedAtStart: h.countedAtStart, differenceCash: h.differenceCash, fromShiftId: h.fromShiftId ?? null })
        if (h.fromUserId) users.add(h.fromUserId)
        if (receiver) users.add(receiver)
      }
    }
    // دفتر آزمون ۴-۲۷: پایان برنامهٔ ذخیره‌شدهٔ بخش‌های حضانت (خط «زمان تحویل» و «زمان بستن»)؛ ستون تازه‌ای نیست.
    const segmentShifts = new Set(shifts)
    for (const h of data.handovers.values()) if (h.fromShiftId) segmentShifts.add(h.fromShiftId)
    for (const part of chunks([...segmentShifts])) {
      const rows = await db.custodyShiftMeta.findMany({ where: { shiftId: { in: part } }, select: { shiftId: true, scheduledEndAt: true } })
      for (const m of rows) data.segments.set(m.shiftId, { scheduledEndAt: m.scheduledEndAt ? ms(m.scheduledEndAt) : null })
    }
    // بستن نهایی تجمیعی: شمرده، مرجع و مغایرت فقط در مرز ثبت‌شده‌اند (نه در `CASH_CLOSE`).
    for (const part of chunks([...boundaries])) {
      const rows = await db.custodyAggregateBoundary.findMany({
        where: { id: { in: part } },
        select: { id: true, observedOperationalTotal: true, operationalExpectedTotal: true, theoreticalExpectedTotal: true, newDifference: true, totalTheoreticalDifference: true, baselineSource: true }
      })
      for (const b of rows) {
        data.boundaries.set(b.id, {
          observedOperationalTotal: b.observedOperationalTotal, operationalExpectedTotal: b.operationalExpectedTotal, theoreticalExpectedTotal: b.theoreticalExpectedTotal,
          newDifference: b.newDifference, totalTheoreticalDifference: b.totalTheoreticalDifference, baselineSource: b.baselineSource ?? null
        })
      }
    }
    for (const part of chunks([...invoices])) {
      const rows = await db.saleInvoice.findMany({ where: { id: { in: part } }, select: { id: true, receiptNo: true, customerId: true } })
      for (const i of rows) data.invoices.set(i.id, { receiptNo: i.receiptNo, customerId: i.customerId ?? null })
    }
    for (const part of chunks([...ids.customers])) {
      const rows = await db.customer.findMany({ where: { id: { in: part } }, select: { id: true, name: true } })
      for (const c of rows) data.customers.set(c.id, String(c.name ?? '').slice(0, 80))
    }
    for (const part of chunks([...shifts])) {
      // دفتر آزمون ۴-۱۹: کاربر نشست همان مسئول صندوق است (نامش در پیام «صندوق بسته نشد»)
      const rows = await db.shift.findMany({ where: { id: { in: part } }, select: { id: true, name: true, number: true, userId: true } })
      for (const s of rows) {
        data.shifts.set(s.id, { name: String(s.name ?? '').slice(0, 60), number: s.number, userId: s.userId ?? null })
        if (s.userId) users.add(s.userId)
      }
    }
    for (const part of chunks([...users])) {
      const rows = await db.user.findMany({ where: { id: { in: part } }, select: { id: true, displayName: true, username: true } })
      for (const u of rows) data.users.set(u.id, String(u.displayName || u.username || '').slice(0, 60))
    }
    await fetchDocs(ids, data)
    return data
  }

  /**
   * دفتر آزمون ۴-۹ — قالب کامل فاکتور (فقط خواندن): بدنه و قلم‌های خود سند، با نامی که هنگام فروش در سند نوشته شد،
   * و پرداخت‌های همان لحظهٔ ثبت. فقط ستون‌های عددی، نام کالا و نام روش پرداخت؛ کد کالا، بارکد، کد برگشت، کد اعتبار،
   * تلفن و یادداشت هرگز انتخاب نمی‌شوند.
   */
  async function fetchDocs(ids: IdsNeeded, data: LookupData): Promise<void> {
    const saleAt = ids.saleDocs ?? new Map<number, number>()
    // دفتر آزمون ۴-۳۶: آستانهٔ «تخفیف غیرعادی»، فقط وقتی همین صفحه فروش دارد
    if (saleAt.size) data.abnormalDiscountPercent = parseAccountingPolicy(await settingValue(SETTING_KEYS.accountingPolicy)).abnormalDiscountPercent
    for (const part of chunks([...saleAt.keys()])) {
      const invoices = await db.saleInvoice.findMany({
        where: { id: { in: part } },
        select: { id: true, goodsTotal: true, discountTotal: true, taxTotal: true, serviceCharge: true, deliveryFee: true, grandTotal: true }
      })
      const lines = await docLines(db.saleInvoiceItem, 'invoiceId', part, true)
      const payments = await db.payment.findMany({
        where: { invoiceId: { in: part }, voidedAt: null }, orderBy: { id: 'asc' },
        select: { id: true, invoiceId: true, amount: true, seq: true, createdAt: true, methodId: true, destination: true, storeCreditId: true, kind: true, dueDateJalali: true }
      })
      const methodIds = [...new Set<number>(payments.map((p: any) => p.methodId))]
      const methods = methodIds.length ? await db.paymentMethod.findMany({ where: { id: { in: methodIds } }, select: { id: true, label: true } }) : []
      const methodLabel = new Map<number, string>(methods.map((m: any) => [m.id, String(m.label ?? '').slice(0, 30)]))
      for (const i of invoices) {
        const at = saleAt.get(i.id) ?? 0
        // «همان لحظه» = ردیف‌هایی که پیش از ردیف «ثبت فروش» ساخته شدند، و اعتبار خرید (که فقط هنگام فروش یا تعویض
        // مصرف می‌شود). پرداختِ بعدی پیام «💰 پرداخت» خودش را دارد.
        const own = payments
          .filter((p: any) => p.invoiceId === i.id && (p.storeCreditId != null || ms(p.createdAt) <= at))
          .sort((a: any, b: any) => (a.seq - b.seq) || (a.id - b.id))
        data.saleDocs.set(i.id, {
          goodsTotal: toNum(i.goodsTotal), discountTotal: toNum(i.discountTotal), taxTotal: toNum(i.taxTotal),
          serviceCharge: toNum(i.serviceCharge), deliveryFee: toNum(i.deliveryFee), grandTotal: toNum(i.grandTotal),
          lines: lines.get(i.id) ?? [],
          payments: own.map((p: any) => ({
            label: p.storeCreditId != null ? 'اعتبار خرید'
              : p.kind === 'CHEQUE' ? `چک${typeof p.dueDateJalali === 'string' && p.dueDateJalali ? ` (سررسید ${faDigits(p.dueDateJalali)})` : ''}`
                : p.destination === 'MANAGER' ? 'حساب مدیر' : methodLabel.get(p.methodId) || 'روش ثبت‌نشده',
            amount: toNum(p.amount)
          }))
        })
      }
    }
    for (const part of chunks([...(ids.returnDocs ?? [])])) {
      const returns = await db.saleReturn.findMany({ where: { id: { in: part } }, select: { id: true, kind: true, exchangeInvoiceId: true } })
      const lines = await docLines(db.saleReturnItem, 'returnId', part, false)
      const exchangeIds = returns.filter((r: any) => r.kind === 'EXCHANGE' && r.exchangeInvoiceId).map((r: any) => r.exchangeInvoiceId as number)
      const replacement = await docLines(db.saleInvoiceItem, 'invoiceId', exchangeIds, true)
      for (const r of returns) {
        const exchange = r.kind === 'EXCHANGE' && !!r.exchangeInvoiceId
        data.returnDocs.set(r.id, {
          lines: lines.get(r.id) ?? [],
          replacement: exchange ? replacement.get(r.exchangeInvoiceId) ?? [] : null,
          chain: exchange ? await exchangeChain(r.exchangeInvoiceId) : []
        })
      }
    }
  }
  /**
   * دفتر آزمون ۴-۹ — قلم‌های چند سند، به ترتیب ثبت (کلید = شناسهٔ سند). نام قلم همان نامی است که روز فروش در سند
   * نوشته شد؛ قلم برگشتی نام قلم فروش خودش را می‌گیرد؛ سند قدیمی بی نام ⇐ نام کنونی کالا (همان قاعدهٔ `saleLineTitle`).
   */
  async function docLines(model: any, key: 'invoiceId' | 'returnId', docIds: number[], isSale: boolean): Promise<Map<number, DocLineLite[]>> {
    const out = new Map<number, DocLineLite[]>()
    if (!docIds.length) return out
    const rows: any[] = []
    for (const part of chunks(docIds)) {
      rows.push(...await model.findMany({
        where: { [key]: { in: part } }, orderBy: { id: 'asc' },
        select: { [key]: true, variantId: true, variantName: true, qty: true, unitPrice: true, lineTotal: true, ...(isSale ? { discount: true } : { saleItemId: true }) }
      }))
    }
    const nameOf = (r: any): string => String(r.variantName ?? '').trim()
    const saleNames = new Map<number, string>()
    const saleItemIds = isSale ? [] : [...new Set<number>(rows.filter((r) => !nameOf(r) && r.saleItemId).map((r) => r.saleItemId))]
    for (const part of chunks(saleItemIds)) {
      for (const i of await db.saleInvoiceItem.findMany({ where: { id: { in: part } }, select: { id: true, variantName: true } })) saleNames.set(i.id, nameOf(i))
    }
    const liveNames = new Map<number, string>()
    const variantIds = [...new Set<number>(rows.filter((r) => !nameOf(r) && !saleNames.get(r.saleItemId)).map((r) => r.variantId))]
    for (const part of chunks(variantIds)) {
      const variants = await db.productVariant.findMany({ where: { id: { in: part } }, select: { id: true, size: true, color: true, product: { select: { name: true } } } })
      for (const v of variants) liveNames.set(v.id, `${v.product?.name ?? ''}${v.size ? ' سایز ' + v.size : ''}${v.color ? ' - ' + v.color : ''}`.trim())
    }
    for (const r of rows) {
      const list = out.get(r[key]) ?? []
      const name = nameOf(r) || saleNames.get(r.saleItemId) || liveNames.get(r.variantId) || ''
      list.push({ name: name.slice(0, 80), qty: toNum(r.qty), unitPrice: toNum(r.unitPrice), discount: isSale ? toNum(r.discount) : 0, lineTotal: toNum(r.lineTotal) })
      out.set(r[key], list)
    }
    return out
  }
  /** دفتر آزمون ۴-۹ — زنجیرهٔ تعویض با `sourceInvoiceId` سندهای تعویض: شماره‌ها از نخستین فاکتور تا همین سند. */
  async function exchangeChain(exchangeInvoiceId: number): Promise<number[]> {
    const out: number[] = []
    const seen = new Set<number>()
    let id: number | null = exchangeInvoiceId
    while (id && !seen.has(id) && seen.size < 50) {
      seen.add(id)
      const inv: any = await db.saleInvoice.findUnique({ where: { id }, select: { receiptNo: true, orderType: true, sourceInvoiceId: true } })
      if (!inv) break
      out.unshift(inv.receiptNo)
      id = inv.orderType === 'EXCHANGE' ? inv.sourceInvoiceId ?? null : null
    }
    return out
  }

  async function settingValue(key: string): Promise<string | null> {
    const row = await db.setting.findUnique({ where: { key } })
    return row?.value ?? null
  }
  async function officialOffsetHours(): Promise<number> {
    return parseOfficialTimeConfig(await settingValue(SETTING_KEYS.officialTime)).offsetHours
  }
  async function cashDifferenceThreshold(): Promise<number> {
    return parseAccountingPolicy(await settingValue(SETTING_KEYS.accountingPolicy)).cashDifferenceThreshold
  }

  // ---- خلاصهٔ ساعت ۲۴ (فقط خواندن) ----
  async function auditRowsInRange(actions: string[], from: Date, to: Date): Promise<Array<{ id: number; userId: number | null; action: string; after: string | null; entityId: number | null }>> {
    return db.auditLog.findMany({ where: { action: { in: actions }, at: { gte: from, lt: to } }, select: { id: true, userId: true, action: true, after: true, entityId: true } })
  }
  async function cashSessionsClosed(from: Date, to: Date): Promise<Array<{ id: number; shiftId: number | null; closedBy: number | null; counted: number | null; difference: number }>> {
    const rows = await db.cashSession.findMany({
      where: { closedAt: { gte: from, lt: to } }, orderBy: { id: 'asc' },
      select: { id: true, shiftId: true, closedBy: true, countedTotal: true, cashDifference: true }
    })
    return rows.map((r: any) => ({ id: r.id, shiftId: r.shiftId ?? null, closedBy: r.closedBy ?? null, counted: r.countedTotal === null || r.countedTotal === undefined ? null : toNum(r.countedTotal), difference: toNum(r.cashDifference) }))
  }
  async function openShiftsAt(at: Date): Promise<Array<{ id: number; name: string; userId: number | null }>> {
    const rows = await db.shift.findMany({ where: { closedAt: null, openedAt: { lt: at } }, orderBy: { id: 'asc' }, select: { id: true, name: true, userId: true } })
    return rows.map((r: any) => ({ id: r.id, name: String(r.name ?? ''), userId: r.userId ?? null }))
  }
  /** چک‌های پاس‌نشده با سررسید در بازه (طرح §۲۶-۲ افزودهٔ ۲۹؛ `Payment.dueDate` با شاخص خودش) */
  async function chequesDue(from: Date, to: Date): Promise<{ count: number; total: number }> {
    const rows = await db.payment.findMany({ where: { chequeStatus: 'PENDING', voidedAt: null, dueDate: { gte: from, lt: to } }, select: { amount: true } })
    return { count: rows.length, total: rows.reduce((s: number, r: any) => s + toNum(r.amount), 0) }
  }
  /**
   * دفتر آزمون ۴-۲۷ — پیگیری مدیر در خلاصهٔ ساعت ۲۴ (فقط خواندن): تحویل‌های دیرِ همان روز (تحویل‌دهنده و دقیقه،
   * نسبت به پایان برنامهٔ ذخیره‌شدهٔ بخش او) و صندوق‌هایی که بسته نشدند و برنامه خودکار بست یا مسئولشان بایگانی شد.
   * `active` = آن روز اصلاً رویداد حضانتی بود (فروشگاه بی حضانت این دو خط را ندارد).
   */
  async function custodyFollowUp(from: Date, to: Date): Promise<{ active: boolean; late: Array<{ userId: number | null; minutes: number }>; unclosed: Array<{ userId: number | null }> }> {
    const active = (await db.custodyEvent.count({ where: { at: { gte: from, lt: to } } })) > 0
    if (!active) return { active, late: [], unclosed: [] }
    const events = await db.custodyEvent.findMany({
      where: { at: { gte: from, lt: to }, type: { in: ['HANDOVER_ACCEPT', 'HANDOVER_ACCEPT_WITH_DIFFERENCE', 'ROLLOVER_UNRESOLVED', 'CUSTODIAN_ARCHIVED_UNRESOLVED'] } },
      orderBy: { id: 'asc' }, select: { id: true, type: true, shiftId: true, handoverId: true, payloadJson: true, at: true }
    })
    const late: Array<{ userId: number | null; minutes: number }> = []
    const unclosed: Array<{ userId: number | null }> = []
    for (const ev of events) {
      if (ev.type === 'ROLLOVER_UNRESOLVED') {
        const shift = ev.shiftId ? await db.shift.findUnique({ where: { id: ev.shiftId }, select: { userId: true } }) : null
        unclosed.push({ userId: shift?.userId ?? null })
      } else if (ev.type === 'CUSTODIAN_ARCHIVED_UNRESOLVED') {
        unclosed.push({ userId: custodyTargetUserId(ev) })
      } else if (ev.handoverId) {
        const h = await db.custodyHandover.findUnique({ where: { id: ev.handoverId }, select: { fromShiftId: true, fromUserId: true } })
        const meta = h?.fromShiftId ? await db.custodyShiftMeta.findUnique({ where: { shiftId: h.fromShiftId }, select: { scheduledEndAt: true } }) : null
        const minutes = minutesAfterShiftEnd(ms(ev.at), meta?.scheduledEndAt ? ms(meta.scheduledEndAt) : null)
        if (minutes >= 1) late.push({ userId: h?.fromUserId ?? null, minutes })
      }
    }
    return { active, late, unclosed }
  }

  // ---- دفتر آزمون ۴-۳۳: خواننده‌های فقط‌خواندنی گزارش ربات (ستون‌های ثابت، همان قاعده‌های محرمانگی) ----
  /** قلم‌های فاکتورهای فروش، به ترتیب ثبت (همان خوانندهٔ ۴-۹) */
  async function botSaleLines(invoiceIds: number[]): Promise<Map<number, DocLineLite[]>> {
    return docLines(db.saleInvoiceItem, 'invoiceId', [...new Set(invoiceIds.filter((id) => Number.isSafeInteger(id)))], true)
  }
  /** نام نسیه‌گیرنده‌ای که روز فروش روی خود فاکتور نوشته شد (همان `debtorSnapshotName`)؛ فقط نام، هرگز تلفن یا کد ملی */
  async function botDebtorNames(invoiceIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    for (const part of chunks([...new Set(invoiceIds.filter((id) => Number.isSafeInteger(id)))])) {
      for (const i of await db.saleInvoice.findMany({ where: { id: { in: part } }, select: { id: true, debtorFirstName: true, debtorLastName: true } })) {
        const name = [i.debtorFirstName, i.debtorLastName].map((x: unknown) => String(x ?? '').trim()).filter(Boolean).join(' ').slice(0, 80)
        if (name) out.set(i.id, name)
      }
    }
    return out
  }
  /** سندهای برگشت و تعویض: قلم‌های برگشتی، قلم‌ها و مبلغ فاکتور جایگزین، و زنجیرهٔ تعویض */
  async function botReturnDocs(returnIds: number[]): Promise<Map<number, BotReturnDoc>> {
    const out = new Map<number, BotReturnDoc>()
    const ids = [...new Set(returnIds.filter((id) => Number.isSafeInteger(id)))]
    for (const part of chunks(ids)) {
      const returns = await db.saleReturn.findMany({ where: { id: { in: part } }, select: { id: true, kind: true, exchangeInvoiceId: true } })
      const lines = await docLines(db.saleReturnItem, 'returnId', part, false)
      const exchangeIds = returns.filter((r: any) => r.kind === 'EXCHANGE' && r.exchangeInvoiceId).map((r: any) => r.exchangeInvoiceId as number)
      const replacement = await docLines(db.saleInvoiceItem, 'invoiceId', exchangeIds, true)
      const invoices = exchangeIds.length ? await db.saleInvoice.findMany({ where: { id: { in: exchangeIds } }, select: { id: true, receiptNo: true, grandTotal: true } }) : []
      const invoiceOf = new Map<number, any>(invoices.map((i: any) => [i.id, i]))
      for (const r of returns) {
        const exchange = r.kind === 'EXCHANGE' && !!r.exchangeInvoiceId
        const inv = exchange ? invoiceOf.get(r.exchangeInvoiceId) : null
        out.set(r.id, {
          lines: lines.get(r.id) ?? [],
          replacement: exchange ? replacement.get(r.exchangeInvoiceId) ?? [] : null,
          exchangeReceiptNo: inv ? toNum(inv.receiptNo) : null,
          exchangeGrandTotal: inv ? toNum(inv.grandTotal) : null,
          chain: exchange ? await exchangeChain(r.exchangeInvoiceId) : []
        })
      }
    }
    return out
  }
  /**
   * کارت‌به‌کارت مدیر در بازه، با همان شرط فهرست برنامه (`eventRangeWhere`: ثبت یا پرداخت در بازه)، قدیمی به تازه.
   * قلم‌ها فقط نام، تعداد و قیمت؛ شمارهٔ کارت مشتری با ۴-۳۴ (دستهٔ ۵) می‌آید.
   */
  async function botCardTransfers(fromDay: string, toDay: string, skip: number, take: number): Promise<BotCardTransferPage> {
    const range = { gte: jalaliStartOfDay(fromDay), lte: jalaliEndOfDay(toDay) }
    const where = { OR: [{ createdAt: range }, { paidAt: range }] }
    const total = await db.cardTransferRequest.count({ where })
    const rows = await db.cardTransferRequest.findMany({
      where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: Math.max(0, skip), take: Math.max(1, Math.min(50, take)),
      select: {
        id: true, kind: true, status: true, operationKind: true, returnId: true, sourceReceiptNo: true, exchangeReceiptNo: true, adjustsRequestId: true,
        amount: true, itemsJson: true, userName: true, createdAtJalali: true, createdAtTime: true,
        paidAmount: true, paidAt: true, paidAtJalali: true, paidAtTime: true, paidByUserName: true
      }
    })
    const pending = await db.cardTransferRequest.findMany({ where: { status: 'PENDING', kind: 'REQUEST', createdAt: { lt: range.gte } }, take: 1000, select: { amount: true } })
    const itemsOf = (json: unknown): BotCardTransferRow['items'] => {
      try {
        const list = JSON.parse(typeof json === 'string' && json ? json : '[]')
        return Array.isArray(list) ? list.slice(0, 50).map((i: any) => ({ name: String(i?.name ?? '').slice(0, 80), qty: toNum(i?.qty), unitPrice: toNum(i?.unitPrice) })) : []
      } catch { return [] }
    }
    const text = (v: unknown, max: number): string => String(v ?? '').slice(0, max)
    return {
      total: toNum(total),
      rows: rows.map((r: any) => ({
        id: r.id, kind: text(r.kind, 20), status: text(r.status, 20), operationKind: text(r.operationKind, 20), returnId: toNum(r.returnId),
        sourceReceiptNo: r.sourceReceiptNo == null ? null : toNum(r.sourceReceiptNo), exchangeReceiptNo: r.exchangeReceiptNo == null ? null : toNum(r.exchangeReceiptNo),
        adjustsRequestId: r.adjustsRequestId == null ? null : toNum(r.adjustsRequestId), amount: toNum(r.amount), userName: text(r.userName, 60),
        createdAtJalali: text(r.createdAtJalali, 16), createdAtTime: text(r.createdAtTime, 8), paid: r.paidAt != null,
        paidAmount: r.paidAmount == null ? null : toNum(r.paidAmount), paidAtJalali: text(r.paidAtJalali, 16), paidAtTime: text(r.paidAtTime, 8),
        paidByUserName: text(r.paidByUserName, 60), items: itemsOf(r.itemsJson)
      })),
      pendingBefore: { count: pending.length, total: pending.reduce((sum: number, r: any) => sum + toNum(r.amount), 0) }
    }
  }
  /** «وضعیت الان»: مسئول صندوق از وضعیت حضانت (شیفت فعال)، وگرنه شیفت‌های باز */
  async function botCustodyNow(at: number): Promise<BotCustodyNow> {
    const state = await db.custodyState.findUnique({ where: { key: 'MAIN' }, select: { state: true, activeShiftId: true } })
    let holder: { userId: number | null; since: number; shiftName: string; scheduledEndAt: number | null } | null = null
    if (state?.activeShiftId && state.state !== 'NO_SESSION') {
      const shift = await db.shift.findUnique({ where: { id: state.activeShiftId }, select: { name: true, openedAt: true, closedAt: true, userId: true } })
      const meta = await db.custodyShiftMeta.findUnique({ where: { shiftId: state.activeShiftId }, select: { custodianUserId: true, scheduledEndAt: true } })
      if (shift && !shift.closedAt) {
        holder = { userId: meta?.custodianUserId ?? shift.userId ?? null, since: ms(shift.openedAt), shiftName: String(shift.name ?? '').slice(0, 60), scheduledEndAt: meta?.scheduledEndAt ? ms(meta.scheduledEndAt) : null }
      }
    }
    const open = holder ? [] : await db.shift.findMany({ where: { closedAt: null, openedAt: { lt: new Date(at) } }, orderBy: { id: 'asc' }, take: 20, select: { name: true, userId: true, openedAt: true } })
    const names = await userNames([holder?.userId ?? 0, ...open.map((s: any) => s.userId ?? 0)])
    return {
      holder: holder ? { name: holder.userId ? names.get(holder.userId) ?? '' : '', since: holder.since, shiftName: holder.shiftName, scheduledEndAt: holder.scheduledEndAt } : null,
      handoverPending: state?.state === 'HANDOVER_PENDING',
      openShifts: open.map((s: any) => ({ name: String(s.name ?? '').slice(0, 60), userName: s.userId ? names.get(s.userId) ?? '' : '', since: ms(s.openedAt) }))
    }
  }

  /**
   * دفتر آزمون ۴-۲۶: بخش باز صندوق برای یادآوری پایان شیفت؛ فقط خواندن، بی هیچ مبلغ، کد یا تلفن.
   * پایان برنامه و حالت از عکس ثابت همان بخش (`scheduleSnapshotJson`، مثل `CustodyService.ts:706`)؛ عکس نسخهٔ ۱ بی حالت
   * چندشیفت است، و بخش قدیمیِ بی عکس حالت امروز را می‌گیرد (همان قاعدهٔ `effectiveCustodyMode`، `CustodyService.ts:293`).
   * برای «شیفت آخر»: قالب‌های فعال و دارای کارمند تنظیمات شیفت، یا برای بخش برنامهٔ قدیمی، برنامه‌های فعال قدیمی.
   */
  async function shiftReminderSegment(): Promise<ShiftReminderSegment | null> {
    const state = await db.custodyState.findUnique({ where: { key: 'MAIN' }, select: { state: true, activeShiftId: true } })
    if (!state || (state.state !== 'ACTIVE' && state.state !== 'HANDOVER_PENDING') || !Number.isSafeInteger(state.activeShiftId)) return null
    const shiftId: number = state.activeShiftId
    const meta = await db.custodyShiftMeta.findUnique({
      where: { shiftId }, select: { custodianUserId: true, templateId: true, planId: true, scheduledEndAt: true, scheduleSnapshotJson: true, dayCutoverSnapshot: true, endedAt: true }
    })
    if (!meta || meta.endedAt) return null
    let snapshot: { mode: 'SINGLE_SHIFT' | 'MULTI_SHIFT'; scheduledEndAt: number | null; templateId: string | null } | null = null
    if (meta.scheduleSnapshotJson) {
      try {
        const raw = JSON.parse(String(meta.scheduleSnapshotJson))
        if (raw && typeof raw === 'object') {
          const end = raw.scheduledEndAt == null ? null : new Date(String(raw.scheduledEndAt)).getTime()
          snapshot = { mode: raw.mode === 'SINGLE_SHIFT' ? 'SINGLE_SHIFT' : 'MULTI_SHIFT', scheduledEndAt: end !== null && Number.isFinite(end) ? end : null, templateId: raw.templateId == null ? null : String(raw.templateId) }
        }
      } catch { snapshot = null }
    }
    const scheduledEndAt = snapshot?.scheduledEndAt ?? (meta.scheduledEndAt ? ms(meta.scheduledEndAt) : null)
    if (scheduledEndAt === null || !Number.isFinite(scheduledEndAt)) return null
    const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { name: true, userId: true, closedAt: true } })
    if (!shift || shift.closedAt) return null
    const settings = await db.setting.findMany({ where: { key: { in: [SETTING_KEYS.shiftConfig, SETTING_KEYS.custodyConfig] } }, select: { key: true, value: true } })
    const valueOf = (key: string): unknown => settings.find((row: any) => row.key === key)?.value ?? null
    const scheduling = parseShiftConfig(valueOf(SETTING_KEYS.shiftConfig))
    const staffed = scheduling.templates.filter((t) => t.isActive && t.staffIds.length > 0)
    const mode = snapshot ? snapshot.mode
      : scheduling.custodyModeConfigured ? scheduling.custodyMode
        : scheduling.custodyMode === 'MULTI_SHIFT' && staffed.length > 0 ? 'MULTI_SHIFT'
          : parseCustodyConfig(valueOf(SETTING_KEYS.custodyConfig)).mode
    let plans: ShiftPlanLite[] = []
    if (snapshot?.templateId ?? meta.templateId) {
      plans = staffed.map((t) => {
        const start = minutesOfTime(t.startTime)
        return { startMinute: start, durationMinutes: ((minutesOfTime(t.endTime) - start + 1440) % 1440) || 1440, daysMask: t.daysMask }
      })
    } else if (meta.planId) {
      const legacy = await db.shiftPlan.findMany({ where: { isActive: true }, select: { startMinute: true, durationMinutes: true, daysMask: true } })
      plans = legacy.map((p: any) => ({ startMinute: Number(p.startMinute), durationMinutes: Number(p.durationMinutes), daysMask: Number(p.daysMask) }))
    }
    const custodianId = meta.custodianUserId ?? shift.userId ?? null
    const names = custodianId ? await userNames([custodianId]) : new Map<number, string>()
    return {
      shiftId, shiftName: String(shift.name ?? '').slice(0, 60), custodianName: custodianId ? names.get(custodianId) ?? '' : '',
      scheduledEndAt, dayCutoverMinutes: Number(meta.dayCutoverSnapshot ?? 300), mode, handoverPending: state.state === 'HANDOVER_PENDING', plans
    }
  }

  async function userNames(ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    for (const part of chunks([...new Set(ids.filter(Boolean))])) {
      const rows = await db.user.findMany({ where: { id: { in: part } }, select: { id: true, displayName: true, username: true } })
      for (const u of rows) out.set(u.id, String(u.displayName || u.username || '').slice(0, 60))
    }
    return out
  }

  return {
    maxAuditId, auditAnchor, auditPage, maxCustodyEventId, custodyEventPage, maxCustodyCountId, custodyCountPage,
    fetchLookups, officialOffsetHours, cashDifferenceThreshold,
    auditRowsInRange, cashSessionsClosed, openShiftsAt, chequesDue, custodyFollowUp, userNames,
    botSaleLines, botDebtorNames, botReturnDocs, botCardTransfers, botCustodyNow, shiftReminderSegment
  }
}
export type MessengerDb = ReturnType<typeof createMessengerDb>
