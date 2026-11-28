/**
 * دفتر آزمون ۴-۳۲ — راهنمای «معمولی، حساس، یک‌باره» زیر هر تنظیم (معماری §۶ خط ۵۶۶):
 *  - `lockKindLists`: هر قسمت و هر کار دقیقاً در یکی از سه فهرست است، همان‌که برنامه با آن رفتار می‌کند (نوع `lockKindOf`،
 *    مرز کد `codeSectionOfPanel`، کلید مدت راه دور، و رفتار پل برای مدت هر قسمت)؛ کارها به تفکیک بخش کاتالوگ؛
 *  - صفحهٔ «کنترل از راه دور»: جملهٔ کوتاه بالای فهرست‌ها، فهرست زیر هر دو مدت و فهرست کارها زیر دفعات با نشان «قابل
 *    تکرار» یا «برگشت‌ناپذیر؛ همیشه یک بار»؛ صفحهٔ کدها همان سازنده و همان فهرست؛ فهرست بلند با «نمایش همه».
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-32-kind-help.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'mahak-tl-4-32-'))
process.env.HARNESS_DIR = DIR
process.env.HARNESS_DB = join(DIR, 'shop.db')

const durations = await import('../../src/main/services/locks/durations.ts')
const { createBotRemoteBridge } = await import('../../src/main/services/cloud/botRemoteBridge.ts')
const { REMOTE_PANELS } = await import('../../src/shared/enums.ts')
const { GATE_ACTION_IDS, GATE_CATALOG, GATE_IRREVERSIBLE_ACTIONS } = await import('../../src/shared/gateCatalog.ts')
const { LOCKED_PANELS, LOCK_KIND_HELP, codeSectionOfPanel, lockKindLists, lockKindOf } = await import('../../src/shared/panels.ts')

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
durations.writeLockDurations({ sensitiveCodeMinutes: 10, otherCodeMinutes: 10, remoteGrantMinutes: 35, remoteSensitiveGrantMinutes: 20 })
const lists = lockKindLists()
const ids = (items) => items.map((i) => i.id)
const actionIds = lists.actions.flatMap((g) => ids(g.items))

test('every part and every action is in exactly one of the three lists, the one the program uses', () => {
  const all = [...ids(lists.normal), ...ids(lists.sensitive), ...actionIds]
  assert.equal(new Set(all).size, all.length, 'no key in two lists')
  const parts = LOCKED_PANELS.filter((p) => p.kind === 'part')
  assert.deepEqual([...ids(lists.normal), ...ids(lists.sensitive)].sort(), parts.map((p) => p.key).sort(), 'all parts, and only parts (no «act-*» lock keys)')
  assert.deepEqual([...actionIds].sort(), [...GATE_ACTION_IDS].sort(), 'all 53 actions')
  assert.deepEqual([lists.normal.length, lists.sensitive.length, actionIds.length], [25, 19, 53])
  for (const key of REMOTE_PANELS) {
    const where = ids(lists.normal).includes(key) ? 'normal' : ids(lists.sensitive).includes(key) ? 'sensitive' : actionIds.includes(key) ? 'action' : null
    assert.equal(where, lockKindOf(key), `${key}: listed where the program classifies it`)
  }
  const remote = createBotRemoteBridge({ available: async () => true, closeAll: () => {}, note: () => {} })
  for (const p of lists.normal) {
    assert.equal(codeSectionOfPanel(p.id), 'other', `${p.id}: the «other modules» code`)
    assert.equal(durations.remoteDurationKey(codeSectionOfPanel(p.id)), 'remoteGrantMinutes')
    assert.equal(remote.minutesFor(p.id), 35, `${p.id}: the first duration`)
  }
  for (const p of lists.sensitive) {
    assert.equal(codeSectionOfPanel(p.id), 'sensitive', `${p.id}: the «sensitive» code`)
    assert.equal(remote.minutesFor(p.id), 20, `${p.id}: the second duration`)
  }
  for (const id of actionIds) assert.equal(remote.minutesFor(id), null, `${id}: an action has no time`)
  for (const p of [...lists.normal, ...lists.sensitive]) assert.equal(p.title, LOCKED_PANELS.find((x) => x.key === p.id).title)
})

test('actions by catalog section, in catalog order; the irreversible nine are marked «always one time»', () => {
  for (const g of lists.actions) for (const item of g.items) {
    assert.equal(GATE_CATALOG[item.id].group, g.group, item.id)
    assert.equal(GATE_CATALOG[item.id].titleFa, item.title)
  }
  assert.equal(new Set(lists.actions.map((g) => g.group)).size, lists.actions.length, 'one block per section')
  assert.deepEqual(actionIds.filter((id) => GATE_IRREVERSIBLE_ACTIONS.includes(id)).sort(), [...GATE_IRREVERSIBLE_ACTIONS].sort())
  assert.equal(LOCK_KIND_HELP, 'ماژول یعنی یک بخش کامل که برای مدتی باز می‌ماند؛ کار یک‌باره یعنی یک کار حساس داخل یک بخش که هر مجوزش فقط برای همان کار است.')
})

test('screens: the remote-control page and the codes page build their lists from the same function, with the short sentence and «نمایش همه»', () => {
  const ui = read('src/renderer/src/components/RemoteGrantControls.tsx')
  assert.match(ui, /const KIND_LISTS = lockKindLists\(\)/)
  assert.match(ui, /<div className="kbd leading-6">\{LOCK_KIND_HELP\}<\/div>/)
  assert.match(ui, /<KindHelpList label="مدت اول، ماژول‌های معمولی" items=\{KIND_LISTS\.normal\} \/>/)
  assert.match(ui, /<KindHelpList label="مدت دوم، ماژول‌های پولی و حساس" items=\{KIND_LISTS\.sensitive\} \/>/)
  assert.match(ui, /KIND_LISTS\.actions\.map/, 'the 4-31 action list comes from the same lists')
  assert.match(ui, /\{item\.never \? 'برگشت‌ناپذیر؛ همیشه یک بار' : 'قابل تکرار'\}/)
  assert.match(ui, /`نمایش همه \(\$\{faDigits\(items\.length\)\}\)`/)
  assert.equal((ui.match(/type="password"/g) ?? []).length, 1)
  const codes = read('src/renderer/src/components/OneTimeCodesSettings.tsx')
  assert.match(codes, /const lists = useMemo\(\(\) => lockKindLists\(\), \[\]\)/)
  assert.match(codes, /\{LOCK_KIND_HELP\}/)
  assert.match(codes, /<KindHelpList label="ماژول‌های پولی و حساس" items=\{lists\.sensitive\} \/>/)
  assert.match(codes, /<KindHelpList label="ماژول‌های معمولی" items=\{lists\.normal\} \/>/)
  assert.doesNotMatch(codes, /LOCKED_PANELS\.filter/, 'no second list builder')
})
