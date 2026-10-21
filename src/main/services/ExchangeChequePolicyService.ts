import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { audit } from './AuditService'
import { verifyManagerCorrectionApproval } from './AuthService'
import { AuditAction } from '@shared/enums'

export const EXCHANGE_CHEQUE_POLICY_SETTING_KEY = 'exchange.cheque.policy.v1'
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000

export interface ExchangeChequePolicyActive {
  version: number
  enabled: boolean
  minimumDelta: number
  changedAt: string | null
  proposerUserId: number | null
  proposerName: string | null
  approverUserId: number | null
  approverName: string | null
  reason: string | null
  evidenceRef: string | null
  approvalReason: string | null
  approvalEvidenceRef: string | null
}

export interface ExchangeChequePolicyProposal {
  id: string
  baseVersion: number
  enabled: boolean
  minimumDelta: number
  reason: string
  evidenceRef: string
  proposerUserId: number
  proposerName: string
  proposedAt: string
  expiresAt: string
}

export interface ExchangeChequePolicyState {
  schemaVersion: 1
  active: ExchangeChequePolicyActive
  pending: ExchangeChequePolicyProposal | null
}

const DEFAULT_POLICY: ExchangeChequePolicyState = {
  schemaVersion: 1,
  active: {
    version: 0, enabled: false, minimumDelta: 0, changedAt: null,
    proposerUserId: null, proposerName: null, approverUserId: null, approverName: null,
    reason: null, evidenceRef: null, approvalReason: null, approvalEvidenceRef: null
  },
  pending: null
}

type PolicyClient = Prisma.TransactionClient | typeof prisma

function text(raw: unknown, label: string, min: number, max = 1000): string {
  const value = String(raw ?? '').trim()
  if (value.length < min || value.length > max)
    throw new BusinessError(`${label} باید بین ${min} تا ${max} نویسه باشد.`)
  return value
}

function integerRial(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)
    throw new BusinessError(`${label} باید عدد صحیح نامنفی به ریال باشد.`)
  return raw
}

function validateTarget(enabledRaw: unknown, minimumDeltaRaw: unknown) {
  if (typeof enabledRaw !== 'boolean') throw new BusinessError('وضعیت روشن/خاموش سیاست چک معتبر نیست.')
  const minimumDelta = integerRial(minimumDeltaRaw, 'حداقل مابه‌التفاوت چک')
  if (enabledRaw && minimumDelta <= 0)
    throw new BusinessError('برای روشن‌کردن پذیرش چک، حداقل مابه‌التفاوتِ مثبت را تعیین کنید.')
  return { enabled: enabledRaw, minimumDelta }
}

function parsePolicy(raw: string | null): ExchangeChequePolicyState {
  if (raw == null) return structuredClone(DEFAULT_POLICY)
  try {
    const value = JSON.parse(raw) as ExchangeChequePolicyState
    const active = value?.active
    if (value?.schemaVersion !== 1 || !active || !Number.isSafeInteger(active.version) || active.version < 0 ||
        typeof active.enabled !== 'boolean' || !Number.isSafeInteger(active.minimumDelta) || active.minimumDelta < 0 ||
        (active.enabled && active.minimumDelta <= 0)) throw new Error('shape')
    let pending: ExchangeChequePolicyProposal | null = null
    if (value.pending != null) {
      const p = value.pending
      if (!p || typeof p.id !== 'string' || !p.id || !Number.isSafeInteger(p.baseVersion) ||
          typeof p.enabled !== 'boolean' || !Number.isSafeInteger(p.minimumDelta) || p.minimumDelta < 0 ||
          (p.enabled && p.minimumDelta <= 0) || !Number.isSafeInteger(p.proposerUserId) || p.proposerUserId <= 0 ||
          typeof p.reason !== 'string' || p.reason.length < 10 || typeof p.evidenceRef !== 'string' || p.evidenceRef.length < 8 ||
          typeof p.proposedAt !== 'string' || typeof p.expiresAt !== 'string') throw new Error('pending')
      pending = p
    }
    return { schemaVersion: 1, active: { ...DEFAULT_POLICY.active, ...active }, pending }
  } catch {
    throw new BusinessError('دفتر سیاست پذیرش چک خراب یا ناسازگار است؛ پذیرش چک متوقف شد تا تنظیمات بررسی شود.', 'S10_CHEQUE_POLICY_CORRUPT')
  }
}

async function readState(client: PolicyClient): Promise<ExchangeChequePolicyState> {
  const row = await client.setting.findUnique({ where: { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY } })
  return parsePolicy(row?.value ?? null)
}

async function writeState(client: PolicyClient, state: ExchangeChequePolicyState) {
  const value = JSON.stringify(state)
  await client.setting.upsert({
    where: { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY },
    update: { value }, create: { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY, value }
  })
}

/**
 * Establish a SQLite write lock on this setting row and keep it for the caller's
 * transaction. Exchange creation then uses exactly one policy version through
 * payment creation and ledger commit; a concurrent settings transaction waits.
 */
export async function lockExchangeChequePolicyForTransaction(tx: Prisma.TransactionClient): Promise<ExchangeChequePolicyState> {
  let row = await tx.setting.findUnique({ where: { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY } })
  if (!row) {
    await tx.setting.create({ data: { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY, value: JSON.stringify(DEFAULT_POLICY) } })
    row = { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY, value: JSON.stringify(DEFAULT_POLICY) } as any
  }
  const raw = String(row.value)
  // A no-op UPDATE acquires the SQLite writer lock even if the setting is not
  // changed. The surrounding transaction retains it until commit/rollback.
  await tx.setting.update({ where: { key: EXCHANGE_CHEQUE_POLICY_SETTING_KEY }, data: { value: raw } })
  return parsePolicy(raw)
}

async function verifyManager(managerUserId: unknown, managerPin: unknown, action: string) {
  return verifyManagerCorrectionApproval({
    managerUserId: typeof managerUserId === 'number' ? managerUserId : null,
    password: typeof managerPin === 'string' ? managerPin : null,
    action
  })
}

export const exchangeChequePolicyService = {
  async get(): Promise<ExchangeChequePolicyState> {
    return readState(prisma)
  },

  async propose(input: {
    enabled?: unknown
    minimumDelta?: unknown
    reason?: unknown
    evidenceRef?: unknown
    proposerUserId?: unknown
    proposerPin?: unknown
  }) {
    const target = validateTarget(input.enabled, input.minimumDelta)
    const reason = text(input.reason, 'دلیل تغییر سیاست چک', 10)
    const evidenceRef = text(input.evidenceRef, 'شاهد مستند تغییر سیاست چک', 8, 500)
    const proposer = await verifyManager(input.proposerUserId, input.proposerPin, 'پیشنهاد تغییر سیاست پذیرش چک در تعویض')
    return prisma.$transaction(async (tx) => {
      const current = await lockExchangeChequePolicyForTransaction(tx)
      const now = new Date()
      if (current.pending && Date.parse(current.pending.expiresAt) > now.getTime())
        throw new BusinessError('یک پیشنهاد فعال برای سیاست چک در انتظار تأیید مدیر دوم است؛ ابتدا همان را تأیید یا تا انقضایش صبر کنید.')
      if (current.active.enabled === target.enabled && current.active.minimumDelta === target.minimumDelta)
        throw new BusinessError('سیاست پیشنهادی با نسخهٔ فعال تفاوتی ندارد؛ تغییری برای ثبت نیست.')
      const pending: ExchangeChequePolicyProposal = {
        id: randomUUID(), baseVersion: current.active.version, ...target,
        reason, evidenceRef, proposerUserId: proposer.userId, proposerName: proposer.displayName,
        proposedAt: now.toISOString(), expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString()
      }
      const next = { ...current, pending }
      await writeState(tx, next)
      await audit(tx, {
        action: AuditAction.SETTINGS_UPDATE, entity: 'Setting', entityId: 0, userId: proposer.userId,
        before: JSON.stringify(current), after: JSON.stringify(next),
        note: `پیشنهاد سیاست پذیرش چک در تعویض توسط ${proposer.displayName}؛ version پایه ${current.active.version}؛ نیازمند تأیید مدیر دوم · دلیل: ${reason} · شاهد: ${evidenceRef}`
      })
      return next
    })
  },

  async approve(input: {
    proposalId?: unknown
    approvingManagerUserId?: unknown
    approvingManagerPin?: unknown
    approvalReason?: unknown
    approvalEvidenceRef?: unknown
  }) {
    const proposalId = text(input.proposalId, 'شناسهٔ پیشنهاد سیاست چک', 20, 80)
    const approvalReason = text(input.approvalReason, 'دلیل تأیید مستقل سیاست چک', 10)
    const approvalEvidenceRef = text(input.approvalEvidenceRef, 'شاهد تأیید مستقل سیاست چک', 8, 500)
    const approver = await verifyManager(input.approvingManagerUserId, input.approvingManagerPin, 'تأیید مستقل تغییر سیاست پذیرش چک در تعویض')
    return prisma.$transaction(async (tx) => {
      const current = await lockExchangeChequePolicyForTransaction(tx)
      const proposal = current.pending
      if (!proposal || proposal.id !== proposalId)
        throw new BusinessError('پیشنهاد سیاست چک وجود ندارد یا دیگر فعال نیست؛ تازه‌سازی کنید.')
      if (proposal.proposerUserId === approver.userId)
        throw new BusinessError('پیشنهاد و تأیید سیاست باید توسط دو مدیرِ متفاوت انجام شوند.')
      if (Date.parse(proposal.expiresAt) <= Date.now())
        throw new BusinessError('مهلت پیشنهاد سیاست چک گذشته است؛ پیشنهاد تازه با نسخهٔ فعال ثبت کنید.')
      if (proposal.baseVersion !== current.active.version)
        throw new BusinessError('نسخهٔ پایهٔ پیشنهاد با سیاست فعال برابر نیست؛ این پیشنهاد کهنه است و باید دوباره ثبت شود.')
      const now = new Date().toISOString()
      const active: ExchangeChequePolicyActive = {
        version: current.active.version + 1,
        enabled: proposal.enabled,
        minimumDelta: proposal.minimumDelta,
        changedAt: now,
        proposerUserId: proposal.proposerUserId,
        proposerName: proposal.proposerName,
        approverUserId: approver.userId,
        approverName: approver.displayName,
        reason: proposal.reason,
        evidenceRef: proposal.evidenceRef,
        approvalReason,
        approvalEvidenceRef
      }
      const next: ExchangeChequePolicyState = { schemaVersion: 1, active, pending: null }
      await writeState(tx, next)
      await audit(tx, {
        action: AuditAction.SETTINGS_UPDATE, entity: 'Setting', entityId: 0, userId: approver.userId,
        before: JSON.stringify(current), after: JSON.stringify(next),
        note: `نسخهٔ ${active.version} سیاست پذیرش چک در تعویض با تأیید دوم ${approver.displayName} فعال شد؛ ${active.enabled ? 'روشن' : 'خاموش'} · حداقل ${active.minimumDelta} ریال · دلیل پیشنهاد: ${proposal.reason} · شاهد پیشنهاد: ${proposal.evidenceRef} · دلیل تأیید: ${approvalReason} · شاهد تأیید: ${approvalEvidenceRef}`
      })
      return next
    })
  }
}
