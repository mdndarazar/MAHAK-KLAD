/**
 * A cashier without either prior PIN must be able to see and submit a fresh
 * physical count from the everyday drawer dialog while a historical handover
 * is frozen. The obsolete count/reason may never be prefilled into new cover.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s439-frozen-handover-renderer-contract.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const chip = readFileSync(new URL('../../src/renderer/src/components/CustodyChip.tsx', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../src/main/ipc/index.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../src/main/services/CustodyService.ts', import.meta.url), 'utf8')
assert.match(chip, /const frozenHandover = status\.state === 'HANDOVER_RECOUNT'/, 'renderer recognizes an interrupted legacy acceptance')
assert.match(chip, /\{frozenHandover && !status\.evidenceQuarantined \? <div[\s\S]{0,1500}onClick=\{\(\) => reset\('emergency'\)\}/,
  'the visible frozen-state panel offers a replacement without old PINs only while evidence is healthy')
assert.match(chip, /status\.evidenceQuarantined \? <div[\s\S]{0,900}قرنطینه/, 'a corrupt witness has its own manager route, not emergency cover')
assert.match(chip, /شمارش تازه و ورود جایگزین/, 'next worker is explicitly asked for a new independent count')
assert.doesNotMatch(chip, /setCountedCash\(pending\.countedAtStart/, 'old emergency amount is never auto-filled')
assert.doesNotMatch(chip, /setNote\(pending\.resolutionReason/, 'old exceptional reason is never borrowed')
assert.match(ipc, /handle\(IPC\.custodyEmergencyCover,[\s\S]{0,130}countedCash: _old/, 'public IPC rejects forged legacy cash-only cover evidence')
assert.match(service, /\['ACTIVE', 'HANDOVER_PENDING', 'HANDOVER_RECOUNT'\]\.includes\(state\.state\)/,
  'service can retire the expired frozen state as SYSTEM evidence')
console.log('✓ frozen history has a fresh-PIN/count/reason desktop path and no reused old amount')
