/**
 * A legacy setConfig call must not switch SINGLE/MULTI scheduling outside the
 * named-manager workflow, even before custodyModeConfigured is set. A real
 * cashier must still be able to open and sell after the approved workflow.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s432-custody-preworkflow-mode-gate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-preworkflow-mode-s432-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { makeSeeder } = await import('../../test/harness/seed.mjs')
const { custodyService } = await import('../../src/main/services/CustodyService.ts')
const { settingsService } = await import('../../src/main/services/SettingsService.ts')
const { parseShiftConfig } = await import('../../src/shared/receipt.ts')
const db = harnessClient()
const seed = makeSeeder(db)
const manager = seed.user('مدیر محدودیت حالت S432')
const cashier = seed.user('صندوق‌دار S432')
db.$harness.db.prepare('UPDATE "User" SET role=? WHERE id=?').run('CASHIER', cashier)
assert.equal(seed.one('SELECT role FROM "User" WHERE id=?', cashier)?.role, 'CASHIER')
await custodyService.setPin({ userId: manager, newPassword: 'Manager432!', currentPassword: '1111' })
await custodyService.setConfig({ config: { enabled: true }, managerUserId: manager, managerPassword: 'Manager432!' })
await custodyService.setPin({ userId: cashier, newPassword: 'Cashier432Temp!', managerUserId: manager,
  managerPassword: 'Manager432!', reason: 'آماده‌سازی صندوق‌دار برای تغییر روش' })
await custodyService.setPin({ userId: cashier, currentPassword: 'Cashier432Temp!', newPassword: 'Cashier432!' })
const legacyPlan = seed.insert('ShiftPlan', { title: 'برنامهٔ قدیمی ۴۳۲', startMinute: 540, durationMinutes: 480,
  crossesMidnight: 0, daysMask: 127, isActive: 1, sortOrder: 1 })
seed.insert('ShiftPlanStaff', { planId: legacyPlan, userId: cashier })
assert.equal((await settingsService.shiftConfig()).custodyModeConfigured, false)
const before = seed.one('SELECT value FROM "Setting" WHERE key=?', 'custody.config')?.value
const beforeAuditCount = seed.count('AuditLog')
await assert.rejects(
  () => custodyService.setConfig({ config: { enabled: true, mode: 'MULTI_SHIFT' },
    managerUserId: manager, managerPassword: 'Manager432!' }),
  (error) => error.code === 'CUSTODY_MODE_WORKFLOW_REQUIRED',
  'manager personal PIN alone must not bypass the reason + freeze workflow'
)
assert.equal(seed.one('SELECT value FROM "Setting" WHERE key=?', 'custody.config')?.value, before, 'a rejected mode switch writes nothing')
assert.equal(seed.count('AuditLog'), beforeAuditCount, 'a rejected mode switch invents no audit decision')
const initial = parseShiftConfig(await settingsService.shiftConfig())
const next = { ...initial, custodyMode: 'MULTI_SHIFT', custodyModeConfigured: true, singleShiftCustodianUserId: null,
  templates: initial.templates.map((template, i) => i === 0
    ? { ...template, startTime: '00:00', endTime: '00:00', daysMask: 127, staffIds: [cashier] }
    : { ...template, isActive: false, staffIds: [] }) }
const saved = await settingsService.saveCustodySchedulingWorkflow({ shift: next,
  reason: 'تغییر مستند از تک‌شیفت به چندشیفت با حفظ فروش', managerUserId: manager, managerPassword: 'Manager432!' })
assert.equal(saved.custodyMode, 'MULTI_SHIFT')
assert.equal((await custodyService.config()).mode, 'MULTI_SHIFT')
assert.equal(seed.one('SELECT userId FROM "AuditLog" WHERE entity=? ORDER BY id DESC LIMIT 1', 'CustodySchedulingWorkflow')?.userId, manager)
const opened = await custodyService.open({ userId: cashier, password: 'Cashier432!', operationalTotal: 0 })
assert.equal((await custodyService.actorForFinancialOperation()).expectedShiftId, opened.shiftId, 'approved workflow does not stop sales')
console.log('✓ legacy mode bypass rejected; documented manager workflow and financial attribution remain operational')
