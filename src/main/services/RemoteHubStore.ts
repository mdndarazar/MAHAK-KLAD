/**
 * RemoteHubStore — ذخیره هاب محلی hub.db (better-sqlite3) — stub فاز 1
 * فعلا JSON فایل تا better-sqlite3 نصب شود
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

function hubDir() {
  const d = join(app.getPath('userData'), 'remote-hub')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function filePath(name: string) {
  return join(hubDir(), name)
}

export function readJson(name: string, fallback: any = null) {
  const p = filePath(name)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(name: string, data: any) {
  const p = filePath(name)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(data), 'utf-8')
  // atomic rename
  try {
    const { renameSync } = require('node:fs')
    renameSync(tmp, p)
  } catch {
    writeFileSync(p, JSON.stringify(data), 'utf-8')
  }
}
