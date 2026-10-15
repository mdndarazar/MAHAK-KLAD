import { money } from './jalali'
import type { CustodyPeerComparison } from './custodyPeerCount'

/** Plain-language warning about two physical witnesses, not the blue ledger. */
export function custodyPeerWarningText(comparison: CustodyPeerComparison): string | null {
  const { status, direction, absoluteDifferenceRial, selfCount } = comparison
  if (status !== 'DIFFERENT' || (direction !== 'MORE' && direction !== 'LESS') ||
      !absoluteDifferenceRial || !/^[1-9]\d*$/.test(absoluteDifferenceRial)) return null
  const second = selfCount ? 'شمارش دوم شما' : 'شمارش شما'
  const first = selfCount ? 'شمارش اول خودتان' : 'شمارش مسئول قبلی'
  return `${second} ${money(BigInt(absoluteDifferenceRial))} ریال ${direction === 'MORE' ? 'بیشتر' : 'کمتر'} از ${first} است.`
}
