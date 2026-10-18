// Rollover boundary probe (temp copy only). Fake clock shim, no source change.
// usage: TZ=... node --import register boundary.mjs <legacy|legacy-0459|scheduled>
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode = process.argv[2] ?? 'legacy'
const RealDate = Date
let offset = 0
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a) } static now() { return RealDate.now() + offset } }
globalThis.Date = FakeDate
const setLocal = (y, mo, d, h, mi, s = 0) => { offset = new RealDate(y, mo - 1, d, h, mi, s, 0).getTime() - RealDate.now() }
const dir = mkdtempSync(join(tmpdir(), `bnd-${mode}-`)); process.env.HARNESS_DIR = dir; process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { SETTING_KEYS } = await import('@shared/receipt')
const db = harnessClient(); const seed = makeSeeder(db)
const manager = seed.user('m'), worker = seed.user('w')
const hm = t => `${String(Math.floor(((t%1440)+1440)%1440/60)).padStart(2,'0')}:${String(((t%1440)+1440)%1440%60).padStart(2,'0')}`
if (mode === 'scheduled') {
  setLocal(2026, 10, 18, 14, 0)
  seed.setting(SETTING_KEYS.shiftConfig, { byTime: true, custodyMode: 'SINGLE_SHIFT', overtimeMaxMinutes: 30, templates: [{ id: 'tpl', name: 'T', startTime: hm(13*60+55), endTime: hm(14*60+5), isActive: true, daysMask: 127, staffIds: [worker], reminderRepeatMin: 15, allowMidDayHandover: true }] })
} else {
  seed.setting(SETTING_KEYS.shiftConfig, { byTime: false, custodyMode: 'SINGLE_SHIFT', templates: [] })
  if (mode === 'legacy-0459') setLocal(2026, 10, 19, 4, 59, 30); else setLocal(2026, 10, 18, 14, 0)
}
await custodyService.setPin({ userId: manager, newPassword: 'Manager9!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager9!' })
await custodyService.setPin({ userId: worker, newPassword: 'WorkTmp9!', managerUserId: manager, managerPassword: 'Manager9!', reason: 'setup' })
await custodyService.setPin({ userId: worker, currentPassword: 'WorkTmp9!', newPassword: 'WorkFin9!' })
const openedAt = new Date()
const opened = await custodyService.open({ userId: worker, password: 'WorkFin9!', countedCash: 0 })
const meta = seed.one('SELECT templateId, scheduledEndAt, rolloverAt, dayCutoverSnapshot FROM "CustodyShiftMeta" WHERE shiftId=?', opened.shiftId)
const R = new RealDate(Number(meta.rolloverAt))
const fmt = d => ({ iso: d.toISOString(), local: d.toLocaleString('en-GB', { hour12: false }) })
const res = { mode, TZ: process.env.TZ ?? '(unset)', tzOffsetMin: -R.getTimezoneOffset(), openedAt: fmt(openedAt), meta: { templateId: meta.templateId, scheduledEndAt: meta.scheduledEndAt ? fmt(new RealDate(Number(meta.scheduledEndAt))) : null, dayCutoverSnapshot: meta.dayCutoverSnapshot, rolloverAt: fmt(R) } }
res.rolloverLocalHHMMSS = `${R.getHours()}:${R.getMinutes()}:${R.getSeconds()}.${R.getMilliseconds()}`
res.minutesOpenToRollover = (R.getTime() - openedAt.getTime()) / 60000
const before = await custodyService.ensureRolledOver(new Date(R.getTime() - 1))
res.atMinus1ms = { result: before, state: (await custodyService.status()).state }
const at = await custodyService.ensureRolledOver(new Date(R.getTime()))
const sh = seed.one('SELECT closedAt FROM "Shift" WHERE id=?', opened.shiftId)
res.atExact = { result: at ? Object.keys(at) : null, state: (await custodyService.status()).state, shiftClosedAtMinusRollover: sh.closedAt == null ? null : Number(sh.closedAt) - R.getTime() }
// financial actor after boundary (real clock path uses ensureRolledOver(new Date()))
offset = R.getTime() + 1000 - RealDate.now()
try { const f = await custodyService.actorForFinancialOperation(); res.fenceAfter = { fence: f } } catch (e) { res.fenceAfter = { error: String(e?.message ?? e).split('\n')[0], code: e?.code ?? null } }
console.log(JSON.stringify(res))
