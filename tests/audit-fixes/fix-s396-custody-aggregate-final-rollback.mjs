/**
 * A failed blue snapshot in final close must roll back atomically to ACTIVE,
 * leaving the outgoing Shift usable rather than silently closing it.
 *
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s396-custody-aggregate-final-rollback.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-custody-aggregate-s396-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const db = harnessClient()
const seed = makeSeeder(db)
let ok = 0, bad = 0
const eq = (label, got, want) => { if (got === want) { ok++; console.log(`  ✓ ${label}`) } else { bad++; console.log(`  ✗ ${label} — دریافت ${JSON.stringify(got)}، انتظار ${JSON.stringify(want)}`) } }

const manager = seed.user('مدیر S396')
const custodian = seed.user('مسئول S396')
await custodyService.setPin({ userId: manager, newPassword: 'Manager396!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager396!' })
await custodyService.setPin({ userId: custodian, newPassword: 'Temp396!', managerUserId: manager, managerPassword: 'Manager396!', reason: 'راه‌اندازی آزمون rollback' })
await custodyService.setPin({ userId: custodian, currentPassword: 'Temp396!', newPassword: 'Custodian396!' })
const opening = await custodyService.open({ userId: custodian, password: 'Custodian396!', operationalTotal: 10_000_000 })

let rejectedWithoutCount = false
try { await custodyService.finalClose({ password: 'Custodian396!' }) } catch { rejectedWithoutCount = true }
eq('بستن نهایی بدون مجموع کور پذیرفته نیست', rejectedWithoutCount, true)

db.$harness.breakNext('CustodyBlueSnapshot', 'create')
let fault = ''
try { await custodyService.finalClose({ password: 'Custodian396!', operationalTotal: 10_000_000 }) } catch (error) { fault = error?.message ?? '' }
eq('خطای ثبت سند آبی به فراخواننده برمی‌گردد', fault.includes('HARNESS-FAULT'), true)
const restored = await custodyService.status()
eq('پس از خطای close، وضعیت حضانت به ACTIVE برمی‌گردد', restored.state, 'ACTIVE')
eq('پس از خطای close، همان Shift همچنان فعال است', restored.activeShiftId, opening.shiftId)
eq('rollback، Shift را نیمه‌بسته باقی نمی‌گذارد', seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opening.shiftId)?.closedAt, null)
eq('rollback سند نهایی نیمه‌کاره ثبت نمی‌کند', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'FINAL_CLOSE', opening.shiftId)?.n ?? 0), 0)

const retried = await custodyService.finalClose({ password: 'Custodian396!', operationalTotal: 10_000_000 })
eq('پس از rollback، تلاش دوباره با همان مسئول قابل انجام است', retried.state, 'NO_SESSION')
eq('تلاش دوباره دقیقاً یک سند آبیِ نهایی ثبت می‌کند', Number(seed.one('SELECT COUNT(*) AS n FROM "CustodyBlueSnapshot" WHERE role=? AND shiftId=?', 'FINAL_CLOSE', opening.shiftId)?.n ?? 0), 1)
eq('هیچ کیس aggregate-v2 قدیمی از بستن آبی تولید نمی‌شود', seed.count('CustodyAggregateBoundary'), 0)

console.log(`\n${bad === 0 ? '✓' : '✗'} ${ok} بررسی موفق · ${bad} ناموفق`)
process.exitCode = bad ? 1 : 0
