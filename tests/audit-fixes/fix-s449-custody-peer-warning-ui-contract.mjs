/**
 * Desktop contract: a visibly directed, optional warning after the receiver's
 * count; a PIN-only readback after refresh, no public-status leak, and a
 * documented original-owner PIN cancel/new blind count without gating accept.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s449-custody-peer-warning-ui-contract.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')
const chip = read('src/renderer/src/components/CustodyChip.tsx')
const service = read('src/main/services/CustodyService.ts')
const ipc = read('src/main/ipc/index.ts')
const channels = read('src/shared/ipc.ts')
const preload = read('src/preload/index.ts')
let checks = 0
function yes(label, value) { assert.ok(value, label); checks++; console.log(`  ✓ ${label}`) }
const confirm = chip.slice(chip.indexOf("{view === 'confirmBlue' &&"), chip.indexOf("{view === 'emergency' ?"))
const cancel = chip.slice(chip.indexOf("{view === 'handover' ?"), chip.indexOf("{view === 'accept' ?"))
const readback = service.slice(service.indexOf('async handoverBlueReview('), service.indexOf('async handoverConfirmBlue('))
const acceptance = service.slice(service.indexOf('async handoverConfirmBlue('), service.indexOf('async handoverCancel('))
const publicStatus = service.slice(service.indexOf('async status('), service.indexOf('async openResolutions('))
yes('IPC channel is in shared allowlist and registered by Main', channels.includes("custodyHandoverBlueReview: 'custody:handover:blue-review'") && ipc.includes('handle(IPC.custodyHandoverBlueReview, (p) => custodyService.handoverBlueReview(p ?? {}))'))
yes('preload gets new channel only through the shared allowlist', preload.includes('new Set<string>(Object.values(IPC))'))
yes('receiver count immediately supplies warning and navigates to confirmBlue', chip.includes('setBlueCountPreview(result)') && chip.includes("setView('confirmBlue')"))
yes('readback uses a separate review PIN and does not reuse the confirm PIN', chip.includes('password: reviewPin') && confirm.includes('value={reviewPin}') && confirm.includes('password={password} setPassword={setPassword}'))
yes('readback action exists after reload but is optional', confirm.includes('!currentBluePreview ?') && confirm.includes('void reviewBluePreview()') && confirm.includes('custodyHandoverConfirmBlue'))
yes('preview is linked to current active, blue, counted handover ID', chip.includes('blueCountPreview?.handoverId === status.pendingHandover.id') && chip.includes('sameCountedHandover(prior.handoverId)'))
yes('all dismissal paths wipe PINs and private preview', chip.includes("setReviewPin('')") && chip.includes('setBlueCountPreview(null)') && chip.includes('dismiss()') && chip.includes('onClick={dismiss}'))
yes('nonzero difference is a distinct accessible warning', confirm.includes('peerWarning ? <div') && confirm.includes('role="alert"') && confirm.includes('{peerWarning}'))
yes('warning names uncertainty and leaves final approval below it', confirm.includes('کسری قطعی یا تقصیر هیچ‌کس را ثابت نمی‌کند') && confirm.indexOf('peerWarning ? <div') < confirm.indexOf('custodyHandoverConfirmBlue'))
yes('optional recount routes to old-owner cancel instead of editing saved snapshots', confirm.includes("reset('handover')") && cancel.includes('CH.custodyHandoverCancel') && cancel.includes('اگر بازشماری نمی‌خواهید') && cancel.includes("freshAttempt ? 'handover' : 'main'"))
yes('after cancel next attempt has blank PIN and amount, original giver must count himself', chip.includes("setPassword('')") && chip.includes("setCountedCash('')") && cancel.includes('خودش شمارش خروجی تازه را با PIN خودش ثبت می‌کند'))
yes('readback checks both snapshot links and the receiver PIN', readback.includes('this.verifyPin(pending.selectedRecipientUserId, input.password)') && readback.includes('incoming.priorSnapshotId !== out.id') && readback.includes('watermark.receiverSnapshotId !== incoming.id'))
yes('readback checks a sale/day race without changing financial state', readback.includes('financialRevision') && readback.includes('BLUE_RECOUNT_REQUIRED') && !readback.includes('markBlueHandoverStale') && !readback.includes('.update(') && !readback.includes('.create('))
yes('confirmation never requires warning acknowledgement, a manager or a reason', !acceptance.includes('peerComparison') && !acceptance.includes('custodyPeerWarningText') && !acceptance.includes('managerPassword') && !acceptance.includes('differenceReason'))
yes('public status remains free of peer comparison', !publicStatus.includes('peerComparison') && publicStatus.includes('countedAtStart: aggregatePending ? null : pendingRow.countedAtStart'))
console.log(`\n✓ ${checks} custody peer-warning UI/security contract checks passed`)
