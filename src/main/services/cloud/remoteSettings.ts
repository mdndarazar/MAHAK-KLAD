/** User opt-in is separate from the non-overridable implementation readiness
 * gate. Missing, malformed, inaccessible or unexpected files mean disabled.
 * This setting never starts the experimental hub by itself. */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function remoteSettingEnabled(userData: string): boolean {
  if (typeof userData !== 'string' || !userData) return false
  try {
    const path=join(userData,'remote-settings.json'), stat=lstatSync(path)
    if (!stat.isFile() || stat.size > 1024) return false
    const value:unknown=JSON.parse(readFileSync(path,'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record=value as Record<string,unknown>
    return Object.keys(record).length===1 && Object.hasOwn(record,'enabled') && record.enabled===true
  } catch { return false }
}
