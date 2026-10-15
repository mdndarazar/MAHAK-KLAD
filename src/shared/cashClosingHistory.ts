/** Read-only, Main-owned history of actual completed Cash Closing outcomes.
 * No renderer value is a financial source of truth: rows, counts and pagination
 * are materialized together in Main from committed evidence. */
export type CashClosingHistoryKind = 'HANDOVER' | 'EMERGENCY_COVER' | 'MASTER_OVERRIDE' | 'FINAL_CLOSE' | 'LEGACY_CLOSE'
export type CashClosingHistoryStream = 'CUSTODY' | 'LEGACY'
export type CashClosingReferenceState =
  | 'KNOWN_V2' | 'PENDING_V2' | 'KNOWN_V1' | 'PENDING_V1' | 'NOT_RECORDED' | 'INCONSISTENT'

export type CashClosingHistoryPerson = {
  userId: number | null
  /** Current display name, not an immutable historical name. */
  currentName: string | null
  shiftId: number | null
  scheduleTitleSnapshot: string | null
  presence: 'COUNTED' | 'ABSENT_UNCOUNTED' | 'UNKNOWN'
}

export type CashClosingHistoryRow = {
  source: 'CUSTODY_EVENT' | 'CASH_SESSION'
  sourceId: number
  /** Timestamp of successful completion, never the attempt's start time. */
  occurredAt: string
  occurredDayJalali: string
  kind: CashClosingHistoryKind
  era: 'BLUE_V2' | 'BLUE_V1' | 'PRE_BLUE'
  handoverId: number | null
  shiftId: number | null
  from: CashClosingHistoryPerson | null
  to: CashClosingHistoryPerson | null
  reference: {
    state: CashClosingReferenceState
    /** A number only when the *stored* snapshot status is AVAILABLE. */
    amount: number | null
    knownSubtotal: number | null
    fromDay: string | null
    toDay: string | null
    scopeKind: 'TODAY' | 'PRIOR_AND_TODAY' | null
    snapshotId: number | null
    calculationVersion: string | null
  }
  /** A later decision is never a replacement for the stored original amount. */
  laterDecision: { at: string; managerUserId: number; managerCurrentName: string | null; amount: number; kind: string } | null
  reason: string | null
  /** An inconsistent evidence row is visible, but must never claim a known amount. */
  evidenceWarning: string | null
  /** A second close of the same shift/range is a correction, not another final close. */
  legacyRepeat: boolean
}

export type CashClosingHistoryTotals = {
  handovers: number
  handoversByKind: { normal: number; emergency: number; override: number }
  /** All distinct actual final closes, including proven old-system closes. */
  finalClosings: number
  custodyFinalClosings: number
  /** Old-system CashSessions have their own stream, but genuine closes also contribute to finalClosings. */
  legacyCloses: number
  legacyCorrections: number
  amountKnownV2: number
  amountPendingV2: number
  amountKnownV1: number
  amountPendingV1: number
  amountNotRecorded: number
  amountInconsistent: number
}

export type CashClosingHistoryQuery = {
  fromJalali: string
  toJalali: string
  includeLegacyCustody?: boolean
  includeLegacyCashSessions?: boolean
  includeBlueV1?: boolean
  take?: number
  snapshotToken?: string
  cursor?: string
}

export type CashClosingHistoryResult = {
  range: { fromJalali: string; toJalali: string; fromIso: string; toExclusiveIso: string; dayBasis: 'LOCAL_CALENDAR_DAY' }
  snapshotToken: string
  snapshotAt: string
  expiresAt: string
  totals: CashClosingHistoryTotals
  rows: CashClosingHistoryRow[]
  page: { returned: number; nextCursor: string | null }
  legacy: { rows: CashClosingHistoryRow[]; page: { returned: number; nextCursor: string | null } }
  warnings: string[]
}
