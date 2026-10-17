import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { stockAllocationService } from './StockAllocationService'
import { inventoryService } from './InventoryService'
import { AuditAction } from '@shared/enums'
import { toJalaliDate } from '@shared/jalali'

const positive = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new BusinessError(`${label} باید عدد صحیح مثبت باشد.`)
  return value
}
const stale = () => new BusinessError('تعداد یا وضعیت کالای برگشتی تغییر کرده است؛ هیچ موجودی‌ای اضافه نشد. فهرست را تازه کنید.')

/** This operation says ONLY that the selected quantity was physically seen.
 * It says nothing about whether the customer was paid. The actor comes from
 * the active shift in IPC; a scanned barcode is not an ownership proof.
 */
export const returnGoodsService = {
  async receive(input: {
    returnId: number
    returnItemId: number
    qty: number
    eventKey: string
    witnessKind: 'SCAN' | 'SELECTED_CONFIRMED'
    witnessRef: string
    physicalConfirmed: boolean
    actorUserId?: number | null
  }) {
    const returnId = positive(input?.returnId, 'شناسه برگشت')
    const returnItemId = positive(input?.returnItemId, 'شناسه قلم')
    const qty = positive(input?.qty, 'تعداد کالای دیده‌شده')
    const key = String(input?.eventKey ?? '').trim()
    if (key.length < 12 || key.length > 128)
      throw new BusinessError('شناسهٔ یکتای رسید کالا معتبر نیست؛ با شناسهٔ تازه دوباره اقدام کنید.')
    const witnessKind = input?.witnessKind
    const witnessRef = String(input?.witnessRef ?? '').trim()
    if (input?.physicalConfirmed !== true || !['SCAN', 'SELECTED_CONFIRMED'].includes(witnessKind) ||
        witnessRef.length < 3 || witnessRef.length > 200)
      throw new BusinessError('اسکن یا انتخاب کالا و تأیید صریحِ تعدادِ واقعاً تحویل‌شده لازم است.')
    if (witnessKind === 'SELECTED_CONFIRMED' && witnessRef.length < 8)
      throw new BusinessError('برای انتخاب بدون اسکن، توضیح کوتاهِ مشاهدهٔ فیزیکی کالا را بنویسید.')

    return prisma.$transaction(async (tx) => {
      const previous = await tx.returnGoodsReceipt.findUnique({ where: { eventKey: key } })
      if (previous) {
        if (previous.returnId !== returnId || previous.returnItemId !== returnItemId || previous.qty !== qty ||
            previous.witnessKind !== witnessKind || previous.witnessRef !== witnessRef) throw stale()
        return { id: previous.id, returnId, returnItemId, releasedQty: qty, replayed: true }
      }
      // A correction leaves the original return unchanged for audit/history.
      // This must be checked in the same transaction as qty CAS + inventory:
      // otherwise a late receipt can undo the compensating stock movement.
      if (await tx.returnCorrection.findUnique({ where: { returnId }, select: { id: true } }))
        throw new BusinessError('این سند اصلاح جبرانی شده است؛ دریافتِ تازه روی سند اصلی مجاز نیست.')
      const ret = await tx.saleReturn.findUnique({
        where: { id: returnId },
        include: { items: true, invoice: { select: { id: true, receiptNo: true, deductInventory: true } } }
      })
      const claim = await tx.returnEntitlement.findUnique({ where: { returnId } })
      // Existing claim-backed card returns remain accepted, including those
      // predating the new marker. No claim is required for new non-bank goods,
      // but a historical pending paper without either guard is NOT promoted.
      if (!claim && !ret?.goodsReceiptRequired)
        throw new BusinessError('این برگشت پیش از دفتر دریافت شاهددار ثبت شده است؛ برای سابقهٔ قدیمی، مسیر مستقل رسیدگی مدیر لازم است.')
      if (claim && (claim.state === 'QUARANTINED' || claim.requestId == null || ret?.invoiceId !== claim.invoiceId))
        throw stale()
      if (!ret || ret.voidedAt != null || !ret.invoice?.deductInventory || !ret.restockPending)
        throw stale()
      const item = ret.items.find((row) => row.id === returnItemId)
      if (!item || item.qty - item.restockedQty < qty || item.qty <= 0) throw stale()
      if (witnessKind === 'SCAN') {
        const variant = await tx.productVariant.findUnique({ where: { id: item.variantId }, select: { code: true, barcode: true } })
        const scanned = witnessRef.toUpperCase()
        if (![variant?.code, variant?.barcode, item.variantCode].some((v) => v?.trim().toUpperCase() === scanned))
          throw new BusinessError('کد اسکن‌شده با قلم برگشتی انتخاب‌شده یکسان نیست؛ هیچ کالایی وارد انبار نشد.')
      }
      const changed = await tx.saleReturnItem.updateMany({
        where: { id: item.id, returnId, qty: item.qty, restockedQty: item.restockedQty },
        data: { restockedQty: { increment: qty } }
      })
      if (changed.count !== 1) throw stale()
      const split = await stockAllocationService.reverseForSaleItems(tx, {
        invoiceId: ret.invoiceId, receiptNo: ret.invoice.receiptNo,
        targets: [{ saleItemId: item.saleItemId, variantId: item.variantId, qty }],
        userId: input.actorUserId ?? null,
        reason: `دریافت مقداربه‌مقدار کالای برگشتی #${returnId} با شاهد ${witnessKind}`,
        captureSources: true
      })
      if (split.sources.reduce((sum, row) => sum + row.qty, 0) !== qty ||
          split.sources.filter((row) => row.sourceKind === 'WAREHOUSE').reduce((sum, row) => sum + row.qty, 0) !== split.warehouseQty ||
          split.sources.filter((row) => row.sourceKind === 'STORE').reduce((sum, row) => sum + row.qty, 0) !==
            split.storeLines.reduce((sum, row) => sum + row.qty, 0))
        throw new BusinessError('سهم مبدأهای رسید با تعداد واقعی کالا سازگار نیست؛ دریافت ثبت نشد.')
      const receipt = await tx.returnGoodsReceipt.create({ data: {
        eventKey: key, returnId, returnItemId, variantId: item.variantId, qty,
        actorUserId: input.actorUserId ?? null, witnessKind, witnessRef
      } })
      await tx.returnGoodsReceiptSource.createMany({ data: split.sources.map((row) => ({
        receiptId: receipt.id, returnItemId, variantId: row.variantId,
        allocationId: row.allocationId, sourceKind: row.sourceKind,
        warehouseId: row.warehouseId, warehouseName: row.warehouseName,
        secondaryStockItemId: row.secondaryStockItemId,
        stockItemName: row.stockItemName, stockItemCode: row.stockItemCode,
        qty: row.qty
      })) })
      if (split.storeLines.length) await inventoryService.increase(split.storeLines, {
        reason: 'SALE_RETURN', refType: 'ReturnGoodsReceipt', refId: receipt.id,
        userId: input.actorUserId ?? null,
        note: `دریافت فیزیکی ${qty} عدد از قلم #${returnItemId} · برگشت #${returnId} · رسید #${receipt.id}`
      }, tx)
      const allReceived = ret.items.every((row) => row.id === item.id
        ? row.restockedQty + qty >= row.qty : row.restockedQty >= row.qty)
      const now = new Date()
      if (allReceived) {
        const closed = await tx.saleReturn.updateMany({
          where: { id: returnId, voidedAt: null, restockPending: true },
          data: { restockPending: false, restockReleasedAt: now, restockReleasedAtJalali: toJalaliDate(now) }
        })
        if (closed.count !== 1) throw stale()
      }
      // «اعلام پرداخت مدیر» شاهد دریافت کالا نیست؛ متن درخواست هم باید فقط
      // وضعیتِ واقعاً شمارش‌شده را نشان بدهد، حتی اگر دریافت مرحله‌ای باشد یا
      // درخواست پیش‌تر لغو شده باشد. شمارش/یادداشت با رسید در همین تراکنش است.
      const receivedQty = ret.items.reduce((sum, row) => sum + row.restockedQty + (row.id === item.id ? qty : 0), 0)
      const remainingQty = ret.items.reduce((sum, row) =>
        sum + Math.max(0, row.qty - row.restockedQty - (row.id === item.id ? qty : 0)), 0)
      const exchangePrefix = ret.kind === 'EXCHANGE' ? 'کالای جایگزین طبق سند تعویض از موجودی کسر شد؛ ' : ''
      const stockNote = exchangePrefix + (remainingQty === 0
        ? `${receivedQty} عدد کالای برگشتی با رسید فیزیکیِ شاهددار دریافت شد؛ نتیجهٔ بانک مستقل است.`
        : `${receivedQty} عدد کالای برگشتی با رسید فیزیکیِ شاهددار دریافت شد؛ ${remainingQty} عدد هنوز بدون شاهد است و در موجودی قابل‌فروش نیست. نتیجهٔ بانک مستقل است.`)
      if (claim) {
        const requestId = claim.requestId
        if (requestId == null) throw stale()
        const noted = await tx.cardTransferRequest.updateMany({
          where: { id: requestId, returnId, kind: 'REQUEST' },
          data: { stockNote, stockReleasedQty: receivedQty, stockReleasedAt: now }
        })
        if (noted.count !== 1) throw stale()
      }
      await tx.auditLog.create({ data: {
        action: claim ? AuditAction.CARD_TRANSFER_RESTOCK : AuditAction.RETURN_GOODS_RECEIVE,
        entity: 'ReturnGoodsReceipt', entityId: receipt.id,
        userId: input.actorUserId ?? null,
        after: JSON.stringify({ returnId, returnItemId, qty, variantId: item.variantId,
          witnessKind, warehouseQty: split.warehouseQty, allReceived }),
        note: `کالای برگشتی فیزیکی دریافت شد: ${qty} عدد · ${claim ? 'مستقل از نتیجهٔ بانک' : 'مستقل از تسویهٔ پول/اعتبار'} · رسید #${receipt.id}`
      } })
      return { id: receipt.id, returnId, returnItemId, releasedQty: qty,
        restoredToWarehouses: split.warehouseQty, allReceived, replayed: false }
    })
  },

  async items(returnIdRaw: number) {
    const returnId = positive(returnIdRaw, 'شناسه برگشت')
    const ret = await prisma.saleReturn.findUnique({ where: { id: returnId },
      select: { voidedAt: true, restockPending: true, goodsReceiptRequired: true, items: { select: {
        id: true, qty: true, restockedQty: true, variantCode: true, variantName: true, variantId: true
      } } } })
    const claim = await prisma.returnEntitlement.findUnique({ where: { returnId }, select: { id: true, state: true } })
    const corrected = !!(await prisma.returnCorrection.findUnique({ where: { returnId }, select: { id: true } }))
    const managed = !!claim || !!ret?.goodsReceiptRequired
    return { managed, state: claim?.state ?? (ret?.goodsReceiptRequired ? 'GOODS_ONLY' : null),
      corrected, voided: !!ret?.voidedAt, restockPending: !!ret?.restockPending,
      // An old return has no new witness protocol, regardless of its data.
      items: managed ? (ret?.items ?? []).map((r) => ({ id: r.id, variantId: r.variantId,
        variantCode: r.variantCode, variantName: r.variantName, qty: r.qty,
        received: r.restockedQty, pending: Math.max(0, r.qty - r.restockedQty) })) : [] }
  }
}
