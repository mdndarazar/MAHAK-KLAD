const TEHRAN = 'Asia/Tehran'
const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEHRAN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})
const dateTimeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TEHRAN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

function partMap(formatter: Intl.DateTimeFormat, value: Date): Record<string, number> {
  return Object.fromEntries(formatter.formatToParts(value)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]))
}

/** Tehran-calendar date key (YYYY-MM-DD), independent of the host OS timezone. */
export function tehranDateKey(value: Date | number | string): string | null {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = partMap(dateParts, date)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/**
 * End of the Tehran calendar day `daysAfter` days after the Tehran date of
 * `issuedAt`. For example, a one-day barcode issued at any time today remains
 * valid through 23:59:59.999 Tehran time tomorrow.
 */
export function tehranEndOfDayAfter(issuedAt: Date, daysAfter: number): Date {
  const issued = partMap(dateParts, issuedAt)
  const target = new Date(Date.UTC(issued.year, issued.month - 1, issued.day + Math.trunc(daysAfter)))
  const year = target.getUTCFullYear()
  const month = target.getUTCMonth() + 1
  const day = target.getUTCDate()

  // Find Tehran's UTC offset at the target local noon, then map local 23:59:59.999
  // to an absolute timestamp. This uses the IANA timezone database, not a hardcoded
  // +03:30 offset, so historical/future timezone rule changes stay correct.
  const localNoonAsUtc = Date.UTC(year, month - 1, day, 12, 0, 0)
  const shown = partMap(dateTimeParts, new Date(localNoonAsUtc))
  const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second)
  const offsetMs = shownAsUtc - localNoonAsUtc
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs)
}

/** Start of the Tehran calendar day containing the supplied instant. */
export function tehranStartOfDay(value: Date | number | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  return new Date(tehranEndOfDayAfter(date, -1).getTime() + 1)
}

/** A date-based expiry has passed only after its full Tehran calendar day. */
export function isPastTehranExpiryDate(expiresAt: Date | string | number, now: Date | string | number = Date.now()): boolean {
  const expiryKey = tehranDateKey(expiresAt)
  const nowKey = tehranDateKey(now)
  return expiryKey != null && nowKey != null && nowKey > expiryKey
}
