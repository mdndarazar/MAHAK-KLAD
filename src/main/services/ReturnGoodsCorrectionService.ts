import type { Prisma } from '@prisma/client'
import { BusinessError } from '../errors'
import { inventoryService } from './InventoryService'
import { SecondaryStockAction } from '@shared/enums'
import { toClock, toJalaliDate } from '@shared/jalali'
import { DEFAULT_CENTRAL_WAREHOUSE_LABEL, StockSourceKind } from '@shared/stockSource'

/** Only the *actually received* units are reversed. Source rows are evidence,
 * not a request from the cashier. Historic receipts without that evidence may
 * use the old store path ONLY when the invoice has no allocation ledger at all;
 * a warehouse or a partial/missing source is never assigned to STORE by guess. */
type ReturnForCorrection = {
  id: number
  invoiceId: number
  goodsReceiptRequired: boolean
  items: { id: number; saleItemId: number; variantId: number; qty: number; restockedQty: number }[]
}

type ReceivedSource = {
  id: number | null
  receiptId: number | null
  returnItemId: number
  variantId: number
  allocationId: number | null
  sourceKind: string
  warehouseId: number | null
  warehouseName: string
  secondaryStockItemId: number | null
  stockItemName: string | null
  stockItemCode: string | null
  qty: number
}

type AllocationDebit = {
  id: number
  saleItemId: number
  variantId: number
  expectedRestoredQty: number
  qty: number
}

export type GoodsCorrectionPlan = {
  sources: ReceivedSource[]
  allocationDebits: AllocationDebit[]
}

const missingEvidence = (): BusinessError => new BusinessError(
  'مبدأ یا مقدار یکی از رسیدهای فیزیکی کامل و قابل‌تطبیق نیست؛ اصلاح جبرانی بدون حدس‌زدن انبار متوقف شد. رسیدگی شاهددار مدیر لازم است.'
)

const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/** Read-only validation, inside the same transaction as the correction. */
export async function prepareGoodsCorrection(
  tx: Prisma.TransactionClient,
  ret: ReturnForCorrection
): Promise<GoodsCorrectionPlan> {
  const receipts = await tx.returnGoodsReceipt.findMany({ where: { returnId: ret.id }, orderBy: { id: 'asc' } })
  const stored = receipts.length ? await tx.returnGoodsReceiptSource.findMany({
    where: { receiptId: { in: receipts.map((r) => r.id) } }, orderBy: { id: 'asc' }
  }) : []
  const allocations = await tx.saleItemStockAllocation.findMany({ where: { invoiceId: ret.invoiceId } })
  const byItem = new Map(ret.items.map((i) => [i.id, i]))
  const byAllocation = new Map(allocations.map((a) => [a.id, a]))
  const byReceipt = new Map<number, typeof stored>()
  for (const s of stored) {
    const list = byReceipt.get(s.receiptId) ?? []
    list.push(s)
    byReceipt.set(s.receiptId, list)
  }
  const received = new Map<number, number>()
  const sources: ReceivedSource[] = []
  const allocationQty = new Map<number, number>()

  const add = async (source: ReceivedSource, item: ReturnForCorrection['items'][number]) => {
    if (!positive(source.qty) || source.returnItemId !== item.id || source.variantId !== item.variantId)
      throw missingEvidence()
    if (source.sourceKind !== StockSourceKind.STORE && source.sourceKind !== StockSourceKind.WAREHOUSE)
      throw missingEvidence()
    const a = source.allocationId == null ? null : byAllocation.get(source.allocationId)
    if (a) {
      if (a.saleItemId !== item.saleItemId || a.variantId !== item.variantId || a.sourceKind !== source.sourceKind ||
          !positive(a.qty) || !Number.isSafeInteger(a.restoredQty) || a.restoredQty < 0 || a.restoredQty > a.qty ||
          (source.sourceKind === StockSourceKind.WAREHOUSE &&
            source.warehouseName !== (a.warehouseName || DEFAULT_CENTRAL_WAREHOUSE_LABEL)))
        throw missingEvidence()
      if (source.sourceKind === StockSourceKind.WAREHOUSE &&
          (a.warehouseId ?? null) !== (source.warehouseId ?? null)) {
        // Logical central warehouse = null, but its physical row may belong
        // to the real isDefault warehouse. Keep that distinction explicit.
        if (a.warehouseId != null || source.warehouseId == null ||
            !(await tx.secondaryWarehouse.findUnique({
              where: { id: source.warehouseId }, select: { isDefault: true }
            }))?.isDefault) throw missingEvidence()
      }
      allocationQty.set(a.id, (allocationQty.get(a.id) ?? 0) + source.qty)
    } else if (source.allocationId != null || allocations.length) {
      // No ledger at all is an explicit legacy store sale; one missing row
      // inside an allocated sale is NOT evidence of a store source.
      throw missingEvidence()
    }
    if (source.sourceKind === StockSourceKind.STORE) {
      if (source.warehouseId != null || source.secondaryStockItemId != null ||
          source.stockItemName != null || source.stockItemCode != null)
        throw missingEvidence()
    } else {
      if (!a || !positive(source.secondaryStockItemId ?? 0) || source.stockItemName == null)
        throw missingEvidence()
      const row = await tx.secondaryStockItem.findUnique({ where: { id: source.secondaryStockItemId! } })
      // Missing, relocated or repurposed rows require a manager's manual
      // reconciliation. Neither a matching name nor another branch suffices.
      if (!row || (row.warehouseId ?? null) !== (source.warehouseId ?? null) ||
          row.name !== source.stockItemName || (row.code ?? null) !== (source.stockItemCode ?? null))
        throw missingEvidence()
    }
    sources.push(source)
  }

  for (const receipt of receipts) {
    const item = byItem.get(receipt.returnItemId)
    if (!item || !positive(receipt.qty) || receipt.variantId !== item.variantId)
      throw missingEvidence()
    received.set(item.id, (received.get(item.id) ?? 0) + receipt.qty)
    const parts = byReceipt.get(receipt.id) ?? []
    if (parts.length) {
      if (parts.reduce((n, p) => n + p.qty, 0) !== receipt.qty) throw missingEvidence()
      for (const part of parts) await add(part, item)
    } else {
      // Pre-migration receipt: only an invoice with NO source ledger proves
      // its received units entered the store. Do not invent ledger rows.
      if (allocations.length) throw missingEvidence()
      await add({ id: null, receiptId: receipt.id, returnItemId: item.id, variantId: item.variantId,
        allocationId: null, sourceKind: StockSourceKind.STORE, warehouseId: null, warehouseName: '',
        secondaryStockItemId: null, stockItemName: null, stockItemCode: null, qty: receipt.qty }, item)
    }
  }
  for (const item of ret.items) {
    if (!Number.isSafeInteger(item.restockedQty) || item.restockedQty < 0 || item.restockedQty > item.qty)
      throw missingEvidence()
    const witnessed = received.get(item.id) ?? 0
    if (witnessed === item.restockedQty) continue
    // Old non-managed returns could restock immediately without a physical
    // receipt. Never treat such a gap as store stock on a managed return or
    // any invoice that has an allocation ledger.
    if (witnessed || ret.goodsReceiptRequired || allocations.length || item.restockedQty <= 0)
      throw missingEvidence()
    await add({ id: null, receiptId: null, returnItemId: item.id, variantId: item.variantId,
      allocationId: null, sourceKind: StockSourceKind.STORE, warehouseId: null, warehouseName: '',
      secondaryStockItemId: null, stockItemName: null, stockItemCode: null, qty: item.restockedQty }, item)
  }

  const allocationDebits: AllocationDebit[] = []
  for (const [id, qty] of allocationQty) {
    const a = byAllocation.get(id)!
    if (qty > a.restoredQty) throw missingEvidence()
    allocationDebits.push({ id, saleItemId: a.saleItemId, variantId: a.variantId,
      expectedRestoredQty: a.restoredQty, qty })
  }
  return { sources, allocationDebits }
}

/** All writes use the caller's correction transaction. Effects returned here
 * are posted with the other financial effects, never in a separate commit. */
export async function applyGoodsCorrection(
  tx: Prisma.TransactionClient,
  ret: Pick<ReturnForCorrection, 'id' | 'invoiceId'>,
  plan: GoodsCorrectionPlan,
  ctx: { correctionId: number; receiptNo: number | null; userId: number; reason: string; at: Date }
): Promise<{ type: string; qty: number; variantId: number; referenceType: string; referenceId: number; detailsJson: string }[]> {
  const store = new Map<number, number>()
  for (const s of plan.sources) if (s.sourceKind === StockSourceKind.STORE)
    store.set(s.variantId, (store.get(s.variantId) ?? 0) + s.qty)
  if (store.size) await inventoryService.decrease(
    [...store.entries()].map(([variantId, qty]) => ({ variantId, qty })),
    { reason: 'RETURN_CORRECTION', refType: 'ReturnCorrection', refId: ctx.correctionId, userId: ctx.userId,
      note: `اصلاح جبرانی برگشت ${ret.id} · فاکتور ${ctx.receiptNo ?? 0} · ${ctx.reason}` }, tx
  )

  const effects = [] as { type: string; qty: number; variantId: number; referenceType: string; referenceId: number; detailsJson: string }[]
  for (const s of plan.sources) {
    if (s.sourceKind === StockSourceKind.WAREHOUSE) {
      const row = await tx.secondaryStockItem.findUnique({ where: { id: s.secondaryStockItemId! } })
      if (!row || (row.warehouseId ?? null) !== (s.warehouseId ?? null) ||
          row.name !== s.stockItemName || (row.code ?? null) !== (s.stockItemCode ?? null))
        throw missingEvidence()
      const changed = await tx.secondaryStockItem.updateMany({
        where: { id: row.id, warehouseId: s.warehouseId, name: s.stockItemName!, code: s.stockItemCode, qty: row.qty },
        data: { qty: { decrement: s.qty } }
      })
      if (changed.count !== 1) throw missingEvidence()
      // Unlike the general sale-restoration log, this correction log is
      // mandatory: losing the stock history must roll back the money too.
      await tx.secondaryStockLog.create({ data: {
        itemId: row.id, warehouseId: s.warehouseId, warehouseName: s.warehouseName,
        action: SecondaryStockAction.SALE_RETURN_CORRECTION,
        name: row.name, code: row.code ?? null, qtyBefore: row.qty, qtyAfter: row.qty - s.qty, delta: -s.qty,
        note: `اصلاح جبرانی برگشت ${ret.id} · رسید ${s.receiptId} · ردیف مبدأ ${row.id} · ${ctx.reason}`,
        userId: ctx.userId, at: ctx.at, atJalali: toJalaliDate(ctx.at), atTime: toClock(ctx.at)
      } })
    }
    effects.push({
      type: s.sourceKind === StockSourceKind.WAREHOUSE ? 'WAREHOUSE_INVENTORY_OUT' : 'INVENTORY_OUT',
      qty: s.qty, variantId: s.variantId,
      referenceType: s.id == null ? 'SaleReturnItem' : 'ReturnGoodsReceiptSource',
      referenceId: s.id ?? s.returnItemId,
      detailsJson: JSON.stringify({ returnId: ret.id, receiptId: s.receiptId, receiptSourceId: s.id,
        allocationId: s.allocationId, sourceKind: s.sourceKind, warehouseId: s.warehouseId,
        secondaryStockItemId: s.secondaryStockItemId })
    })
  }
  for (const a of plan.allocationDebits) {
    const changed = await tx.saleItemStockAllocation.updateMany({
      where: { id: a.id, invoiceId: ret.invoiceId, saleItemId: a.saleItemId,
        variantId: a.variantId, restoredQty: a.expectedRestoredQty },
      data: { restoredQty: { decrement: a.qty } }
    })
    if (changed.count !== 1) throw missingEvidence()
  }
  return effects
}
