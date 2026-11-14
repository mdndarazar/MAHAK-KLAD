/**
 * CloudSyncService — آینه فقط-خواندنی + هاب محلی
 * فاز 1: هر 30ث دسته‌ای 500 + yield 100ms + heartbeat ≤4KB
 * بدون دست زدن به منطق فروش/صندوق/حضانت
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { prisma } from '../db/client'
import { registerRemoteAuthHandlers } from '../ipc/remoteAuth'
import { initRemoteGrantRegistry } from './RemoteGrantRegistry'

let timer: NodeJS.Timeout | null = null
let lastEpoch = ''
let lastCursor = 0
let lastHash = ''
let failStreak = 0
let hubState: any = null

function cloudStatePath() {
  return join(app.getPath('userData'), 'cloud-state.json')
}

function ensureState() {
  const p = cloudStatePath()
  if (existsSync(p)) {
    try {
      hubState = JSON.parse(readFileSync(p, 'utf-8'))
      lastEpoch = hubState.epoch ?? ''
      lastCursor = hubState.cursor ?? 0
      lastHash = hubState.chainHash ?? ''
    } catch {}
  }
  if (!lastEpoch) {
    lastEpoch = randomUUID()
    hubState = { epoch: lastEpoch, cursor: 0, chainHash: '', mode: 'HUB_LOCAL', endpoints: [] }
    try {
      writeFileSync(p, JSON.stringify(hubState), 'utf-8')
    } catch {}
  }
}

function saveState() {
  if (!hubState) return
  hubState.epoch = lastEpoch
  hubState.cursor = lastCursor
  hubState.chainHash = lastHash
  try {
    writeFileSync(cloudStatePath(), JSON.stringify(hubState), 'utf-8')
  } catch {}
}

async function roQuery<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<T | null> {
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ])
    return r as T
  } catch (e: any) {
    if (String(e?.message ?? e).includes('BUSY')) failStreak++
    return null
  }
}

async function tick() {
  // تشخیص ری‌استور: MAX(id) < cursor یا فایل last-restore.txt تغییر کرده
  const maxRow: any = await roQuery(() => (prisma as any).auditLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))
  const maxId = maxRow?.id ?? 0
  if (maxId && maxId < lastCursor) {
    // ریستور — epoch جدید
    lastEpoch = randomUUID()
    lastCursor = maxId
    lastHash = ''
    saveState()
  } else {
    // خواندن دسته‌ای 500
    const rows: any[] = (await roQuery(() =>
      (prisma as any).auditLog.findMany({
        where: { id: { gt: lastCursor } },
        orderBy: { id: 'asc' },
        take: 500,
      })
    )) ?? []
    if (rows.length > 0) {
      // heartbeat hash
      let h = lastHash
      for (const r of rows) {
        h = createHash('sha256').update(`${h}|${r.id}|${r.at}|${r.action}|${r.entity}`).digest('hex')
      }
      lastHash = h
      lastCursor = rows[rows.length - 1].id
      saveState()
      // yield 100ms
      await new Promise((res) => setTimeout(res, 100))
      failStreak = 0
    }
  }

  // heartbeat ≤4KB
  const hb = {
    v: 1,
    epoch: lastEpoch,
    cursor: lastCursor,
    chainHash: lastHash,
    at: new Date().toISOString(),
    outboxPending: 0,
  }
  // در HUB_LOCAL همین‌جا به hub.db می‌رود — فعلا فقط در حافظه
  void hb
}

export function startCloudSync() {
  try {
    ensureState()
    // Registry را به panelSession وصل کن
    import('./panelSession').then((ps: any) => {
      initRemoteGrantRegistry({
        notePanelUnlocked: ps.notePanelUnlocked,
        clearPanelScope: ps.clearPanelScope,
        clearPanelSessions: ps.clearPanelSessions ?? (() => {}),
      })
    }).catch(() => {})

    registerRemoteAuthHandlers()

    // هاب محلی با utilityProcess اگر فعال باشد — فعلا stub
    // if (hubState?.mode === 'HUB_LOCAL') startHub()

    timer = setInterval(() => {
      tick().catch(() => {
        failStreak++
        if (failStreak >= 3) {
          if (timer) clearInterval(timer)
          timer = setTimeout(() => {
            failStreak = 0
            timer = setInterval(() => tick().catch(() => {}), 30000)
          }, 5 * 60 * 1000) as any
        }
      })
    }, 30000)
    // اولین tick با تاخیر 20ثانیه تا استارت‌آپ کند نشود
    setTimeout(() => tick().catch(() => {}), 20000)
  } catch {}
}

export function stopCloudSync() {
  if (timer) clearInterval(timer)
  timer = null
}
