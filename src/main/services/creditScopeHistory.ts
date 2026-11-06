import { AuditAction } from '@shared/enums'
import { BusinessError } from '../errors'

/**
 * StoreCreditRedemption predates scope snapshots. Its current StoreCredit row is
 * therefore historical evidence only when no audited restriction edit happened
 * at or after redemption. On ambiguity, stop instead of reconstructing history
 * from today's mutable scope.
 */
export async function assertCreditScopeUnchangedSinceRedemption(
  tx: { auditLog: any },
  input: { creditId: number; redemptionAt: Date | string | number }
): Promise<void> {
  const at = input.redemptionAt instanceof Date
    ? input.redemptionAt
    : new Date(input.redemptionAt)
  if (!Number.isFinite(at.getTime())) {
    throw new BusinessError('زمان مصرف اعتبار برای اثبات محدودیت تاریخی معتبر نیست؛ تعویض بدون تغییر متوقف شد.')
  }
  const changes = await tx.auditLog.findMany({
    where: {
      entity: 'StoreCredit',
      entityId: input.creditId,
      action: AuditAction.CREDIT_RESTRICTION_CHANGE,
      // gte deliberately errs on the safe side for same-millisecond events.
      at: { gte: at }
    },
    select: { id: true },
    take: 1
  })
  if (changes.length) {
    throw new BusinessError(
      `محدودیت بارکد اعتبار #${input.creditId} بعد از مصرف تغییر کرده است و رکورد مصرف، محدودهٔ زمانِ مصرف را نگه نمی‌دارد. ` +
      'سیستم نمی‌تواند با اطمینان سهم تاریخی این اعتبار را برای کالای برگشتی تعیین کند؛ هیچ تغییری ثبت نشد. ' +
      'سابقهٔ تغییر محدودیت را بررسی کنید.'
    )
  }
}
