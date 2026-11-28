/**
 * دفتر آزمون، دستهٔ ۳ گام ۱ — پنج ورودی تازهٔ کاتالوگ قفل، یک‌جا (معماری §۳-۲؛ TL-D9):
 *  - ۴-۲۵ «باز کردن صندوق بیرون از شیفت»، ۴-۴۸ «برگشت و تعویض پس از مهلت»، ۴-۷۳ «چاپ بار سوم گواهی اعتبار به دست
 *    فروشنده»، ۴-۷۹ «ابطال چک در جریان یا برگشتی» (STRICT، مادر «نسیه») و ۴-۸۰ «تسویهٔ چک» (همان کلید و رمز «جایگزینی چک»)؛
 *  - هر کلید تازه یک ردیف «قفل کار» حساس، پیش‌فرض روشن، با کد «حساس»؛ «جایگزینی چک» نام و ردیف خودش را نگه می‌دارد؛
 *  - مجوز گوشی و پل ربات هر پنج شناسه را خودبه‌خود می‌شناسند (`REMOTE_PANELS`)؛
 *  - هیچ‌کدام تا دستهٔ خودش جایی صدا زده نمی‌شود (۵، ۶ و ۸)، پس امروز هیچ رفتاری عوض نمی‌شود.
 *
 *   node --import ./test/harness/register.mjs tests/test-log/tl-4-25-48-73-79-80-catalog.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const catalog = await import('../../src/shared/gateCatalog.ts')
const panels = await import('../../src/shared/panels.ts')
const { REMOTE_PANELS } = await import('../../src/shared/enums.ts')
const { GATE_CATALOG, GATE_ACTION_IDS, GATE_ACTION_LOCK_KEYS, GATE_GROUPS: G, gateEntry } = catalog
const { LOCKED_PANELS, PANEL_KEYS, allLockedConfig, parsePanelLocks, codeSectionOfPanel, panelTitle } = panels

/** [شناسه، کلید، منشأ، ماژول مادر، گروه، عنوان، بند، دسته‌ای که مصرفش می‌کند] */
const NEW = [
  ['custody.open-outside-shift', 'act-custody-open-outside-shift', 'MANAGER_PASSWORD', undefined, G.cashClose, 'باز کردن صندوق بیرون از شیفت', '4-25', 6],
  ['return.after-deadline', 'act-return-after-deadline', 'MANAGER_PASSWORD', undefined, G.returns, 'برگشت و تعویض پس از مهلت', '4-48', 5],
  ['credit.third-print-seller', 'act-credit-third-print', 'MANAGER_PASSWORD', undefined, G.credit, 'چاپ بار سوم گواهی اعتبار به دست فروشنده', '4-73', 8],
  ['cheque.void-pending', 'act-cheque-void-pending', 'STRICT', 'sales-credit', G.salesCredit, 'ابطال چک در جریان یا برگشتی', '4-79', 5],
  ['cheque.settle', 'act-cheque-replace', 'STRICT', 'sales-credit', G.salesCredit, 'تسویهٔ چک', '4-80', 5]
]
const NEW_KEYS = ['act-custody-open-outside-shift', 'act-return-after-deadline', 'act-credit-third-print', 'act-cheque-void-pending']

test('the five entries: id, lock key, action category, origin, parent module, group and title as the items say', () => {
  for (const [id, lockKey, origin, parentPanel, group, titleFa, item] of NEW) {
    const e = gateEntry(id)
    assert.ok(e, `${item}: ${id} is in the catalog`)
    assert.deepEqual({ ...e }, { id, lockKey, category: 3, origin, ...(parentPanel ? { parentPanel } : {}), lockKind: 'panel', group, titleFa }, item)
    assert.ok(GATE_ACTION_IDS.includes(id), `${item}: an action id`)
    assert.equal(Object.isFrozen(e), true)
  }
  assert.equal(GATE_ACTION_IDS.length, 53)
  assert.equal(GATE_ACTION_LOCK_KEYS.length, 40)
  assert.equal(new Set(GATE_ACTION_IDS).size, GATE_ACTION_IDS.length, 'ids stay unique')
})

test('each new key is one sensitive action row, on by default, with the «sensitive» code; the cheque key keeps its name', () => {
  for (const key of NEW_KEYS) {
    const rows = LOCKED_PANELS.filter((p) => p.key === key)
    assert.equal(rows.length, 1, key)
    assert.equal(rows[0].kind, 'action')
    assert.equal(rows[0].tier, 'sensitive')
    assert.ok(Object.values(PANEL_KEYS).includes(key), `${key} is a PANEL_KEYS value`)
    assert.equal(panels.normalizePanelKey(key), key)
    assert.equal(allLockedConfig()[key], true, 'a fresh install has it on')
    assert.equal(parsePanelLocks({})[key], true, 'an older config without it reads as on')
    assert.equal(parsePanelLocks({ [key]: false })[key], false, 'the manager can turn it off')
    assert.equal(codeSectionOfPanel(key), 'sensitive')
  }
  assert.equal(LOCKED_PANELS.length, 84)
  // «تسویهٔ چک» کار جدای خودش است ولی همان کلید روشن و خاموش و همان رمز «جایگزینی چک» را دارد (۴-۸۰ بند ۶)
  assert.equal(LOCKED_PANELS.filter((p) => p.key === 'act-cheque-replace').length, 1)
  assert.equal(panelTitle('act-cheque-replace'), 'جایگزینی چک')
  assert.equal(GATE_CATALOG['cheque.replace'].lockKey, GATE_CATALOG['cheque.settle'].lockKey)
  // ردیف‌ها کنار کارهای هم‌خانواده در «تنظیمات رمز» می‌آیند
  const order = LOCKED_PANELS.map((p) => p.key)
  assert.equal(order.indexOf('act-cheque-void-pending'), order.indexOf('act-cheque-void-cleared') + 1)
  assert.equal(order.indexOf('act-credit-third-print'), order.indexOf('act-credit-reprint') + 1)
  assert.equal(order.indexOf('act-return-after-deadline'), order.indexOf('act-refund-card-exchange') + 1)
  assert.equal(order.indexOf('act-custody-open-outside-shift'), order.indexOf('act-master-override') + 1)
})

test('the phone grant and the bot bridge know all five without any other change (REMOTE_PANELS)', () => {
  for (const [id] of NEW) assert.ok(REMOTE_PANELS.includes(id), id)
  assert.equal(REMOTE_PANELS.length, 97)
  assert.ok(REMOTE_PANELS.length <= 128, 'under the hub policy cap')
  for (const key of NEW_KEYS) assert.equal(REMOTE_PANELS.includes(key), false, 'an action key itself is never a phone panel')
})

test('nothing calls them before their own batch: the ids appear only in the catalog, so no behaviour changes today', () => {
  const walk = (d, out = []) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f, out); else if (/\.(ts|tsx)$/.test(n)) out.push(f) } return out }
  const files = walk('src').filter((f) => !f.endsWith(join('shared', 'gateCatalog.ts')))
  for (const [id, , , , , , item, batch] of NEW) {
    const users = files.filter((f) => readFileSync(f, 'utf8').includes(`'${id}'`) || readFileSync(f, 'utf8').includes(`"${id}"`))
    assert.deepEqual(users, [], `${item} is used only from batch ${batch}`)
  }
  for (const key of NEW_KEYS) {
    const users = files.filter((f) => !f.endsWith(join('shared', 'panels.ts')) && readFileSync(f, 'utf8').includes(`'${key}'`))
    assert.deepEqual(users, [], `${key} has no caller yet`)
  }
})
