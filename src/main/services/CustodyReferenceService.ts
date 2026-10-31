import { salesService } from './SalesService'
import { SaleChannel } from '@shared/enums'
import { isValidJalaliDate } from '@shared/jalali'
import { pendingCustodyReference, type CustodyReference } from '@shared/custodyReference'

/**
 * Main-only source for the same blue number returned to SalesReports. The UI
 * cannot supply an amount, skip/take or an arbitrary subset of shifts/users.
 * Morning's first real observation can explicitly include the previous day;
 * later observations use only the current day. Neither manager cash movements
 * nor previous discrepancies are ever subtracted from this report figure.
 * New opening/handover/absence routes use this reader with revision fencing
 * and immutable blue snapshots. A failed read remains PENDING_RECONCILIATION.
 */
export async function officialReferenceForDays(input: {
  operationalDay: string
  previousDayForFirstMorning?: string | null
}): Promise<CustodyReference> {
  const fromJalali = input.previousDayForFirstMorning ?? input.operationalDay
  const toJalali = input.operationalDay
  if (!isValidJalaliDate(fromJalali) || !isValidJalaliDate(toJalali) || fromJalali > toJalali)
    throw new RangeError('محدودهٔ روز برای مرجع حضانت نامعتبر است.')
  try {
    const report = await salesService.reportRows({
      fromJalali,
      toJalali,
      channels: [SaleChannel.RETAIL, SaleChannel.WHOLESALE],
      take: 1
    })
    return report.custodyReference ?? pendingCustodyReference('صورت مالی کامل برای این بازه برنگشت؛ مرجع نامعلوم است.')
  } catch {
    // A read failure is not a zero balance. An authenticated receiver may
    // still record an independent real count with a pending reconciliation.
    return pendingCustodyReference('محاسبهٔ مرجع گزارش ممکن نشد؛ تطبیق در انتظار بررسی است.')
  }
}
