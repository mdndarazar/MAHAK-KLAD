import { prisma } from '../db/client'
import { BusinessError } from '../errors'
import { currentManagerSessionIdentity } from './panelSession'

const ROLES = new Set(['OUT', 'IN', 'OPENING', 'RECOVERY', 'FINAL_CLOSE'])
const MAX_REPORT_NOTES = 2_000
const snapshotIdOf = (raw: unknown) => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0)
    throw new BusinessError('شناسهٔ سند آبی نامعتبر است.', 'BLUE_NOTE_INVALID')
  return raw
}

/** Only manager-gated report services call this. Batch in SQLite-safe parts,
 * never N+1 by handover, and fail loudly instead of silently truncating notes. */
export async function readBlueNotesForSnapshots(client: any, rawIds: number[]) {
  const ids = [...new Set(rawIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
  const notes: any[] = []
  for (let i = 0; i < ids.length; i += 300) {
    notes.push(...await client.custodyBlueNote.findMany({
      where: { snapshotId: { in: ids.slice(i, i + 300) } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }], take: MAX_REPORT_NOTES + 1 - notes.length
    }))
    if (notes.length > MAX_REPORT_NOTES)
      throw new BusinessError('یادداشت‌های این صفحه بیش از سقف ایمن است؛ بازه یا صفحهٔ گزارش را کوچک‌تر کنید. هیچ سابقه‌ای حذف نشده است.', 'BLUE_NOTE_REPORT_TOO_LARGE')
  }
  return notes.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id)
}

export const custodyBlueNoteService = {
  /** Optional annotation; neither a resolution case nor a change to the blue
   * amount. The IPC's actual sender owns the manager session; the named manager
   * separately authenticates with THEIR personal custody PIN. */
  async append(input: { snapshotId: unknown; managerUserId: unknown; password: unknown; text: unknown; idempotencyKey: unknown }) {
    const identity = currentManagerSessionIdentity('ثبت یادداشت اختیاری روی سند آبی')
    const snapshotId = snapshotIdOf(input?.snapshotId)
    if (typeof input?.text !== 'string' || input.text.trim().length < 3 || input.text.trim().length > 1000)
      throw new BusinessError('یادداشت اختیاری مدیر باید بین ۳ تا ۱۰۰۰ نویسه باشد.', 'BLUE_NOTE_INVALID')
    const text = input.text.trim()
    const idempotencyKey = String(input?.idempotencyKey ?? '').trim()
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey))
      throw new BusinessError('کلید یکتای یادداشت نامعتبر است.', 'BLUE_NOTE_INVALID')
    // Lazy import prevents a circular dependency with the manager-only report.
    const { custodyService } = await import('./CustodyService')
    const manager = await custodyService.verifyPin(input.managerUserId, input.password, { requireManager: true })
    return prisma.$transaction(async (tx: any) => {
      if (currentManagerSessionIdentity('ثبت یادداشت روی سند آبی') !== identity)
        throw new BusinessError('نشست مدیر تغییر کرده است؛ یادداشت ثبت نشد.', 'REPORT_MANAGER_REQUIRED')
      const snapshot = await tx.custodyBlueSnapshot.findUnique({ where: { id: snapshotId }, select: { id: true, role: true } })
      if (!snapshot || !ROLES.has(snapshot.role)) throw new BusinessError('سند آبی برای یادداشت پیدا نشد.', 'BLUE_NOTE_SNAPSHOT_NOT_FOUND')
      const already = await tx.custodyBlueNote.findUnique({ where: { idempotencyKey } })
      if (already) {
        if (already.snapshotId !== snapshotId || already.managerUserId !== manager.userId || already.text !== text)
          throw new BusinessError('این کلید برای یادداشت دیگری ثبت شده است؛ سند قبلی بازنویسی نمی‌شود.', 'BLUE_NOTE_IDEMPOTENCY_CONFLICT')
        return { id: already.id, snapshotId, at: already.at, replayed: true }
      }
      const note = await tx.custodyBlueNote.create({ data: {
        snapshotId, managerUserId: manager.userId, authMethod: 'MANAGER_CUSTODY_PIN',
        text, idempotencyKey
      } })
      if (currentManagerSessionIdentity('ثبت یادداشت روی سند آبی') !== identity)
        throw new BusinessError('نشست مدیر حین ثبت تغییر کرد؛ یادداشت ثبت نشد.', 'REPORT_MANAGER_REQUIRED')
      return { id: note.id, snapshotId, at: note.at, replayed: false }
    })
  },

  async list(input: { snapshotId: unknown; skip?: unknown }) {
    currentManagerSessionIdentity('خواندن یادداشت‌های اسناد آبی')
    const snapshotId = snapshotIdOf(input?.snapshotId)
    const skip = input.skip ?? 0
    if (typeof skip !== 'number' || !Number.isSafeInteger(skip) || skip < 0 || skip > 100_000)
      throw new BusinessError('صفحهٔ یادداشت‌ها نامعتبر است.', 'BLUE_NOTE_INVALID')
    const rows = await prisma.custodyBlueNote.findMany({ where: { snapshotId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }], skip, take: 101 })
    return { rows: rows.slice(0, 100).map((row: any) => ({
      id: row.id, snapshotId: row.snapshotId, managerUserId: row.managerUserId,
      authMethod: row.authMethod, text: row.text, at: row.at
    })), hasMore: rows.length > 100 }
  }
}
