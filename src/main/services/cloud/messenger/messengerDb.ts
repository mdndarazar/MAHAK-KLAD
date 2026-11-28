/**
 * طرح ۱۴۰۵ · موردهای ۱۳ و ۱۵ — خواندن سبک از پایگاه داده برای پیام‌رسان (فقط خواندن).
 *
 * AuditLog از نشانگر به بعد، صفحهٔ حداکثر ۲۰۰ ردیف (WAL خاموش است؛ طرح §۲۶-۲ افزودهٔ ۲۵).
 * رویدادهای حضانت از جدول خودشان. هیچ نوشتنی در پایگاه داده انجام نمی‌شود.
 */
import { createHash } from 'node:crypto'
import { prisma as defaultPrisma } from '../../../db/client'
import { SETTING_KEYS, parseAccountingPolicy, parseOfficialTimeConfig } from '@shared/receipt'
import { custodyBoundaryId, custodyTargetUserId, type AuditRowLite, type CustodyCountLite, type CustodyEventLite, type IdsNeeded, type LookupData } from './messengerEvents'
import { emptyLookups } from './messengerEvents'

type Client = typeof defaultPrisma
const CHUNK = 400
const chunks = <T>(list: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(String(v)).getTime())
const toNum = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v) || 0)

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
        select: { id: true, fromUserId: true, acceptedByUserId: true, finalCustodianUserId: true, expectedAtStart: true, countedAtStart: true, differenceCash: true }
      })
      for (const h of rows) {
        const receiver = h.acceptedByUserId ?? h.finalCustodianUserId ?? null
        data.handovers.set(h.id, { fromUserId: h.fromUserId ?? null, receiverUserId: receiver, expectedAtStart: h.expectedAtStart, countedAtStart: h.countedAtStart, differenceCash: h.differenceCash })
        if (h.fromUserId) users.add(h.fromUserId)
        if (receiver) users.add(receiver)
      }
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
    return data
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
    auditRowsInRange, cashSessionsClosed, openShiftsAt, chequesDue, userNames
  }
}
export type MessengerDb = ReturnType<typeof createMessengerDb>
