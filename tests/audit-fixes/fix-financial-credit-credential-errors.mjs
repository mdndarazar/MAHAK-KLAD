/** A spendable credit code is a credential, not an error/audit reference.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-financial-credit-credential-errors.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-credit-secret-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'test.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const { issueStoreCredit, guardCreditCode, findRedeemable } = await import('../../src/main/services/StoreCreditService.ts')
const db = harnessClient()
const sql = db.$harness.db
const knownCode = 'E7845632'
const unknownCode = 'E3456798'
const credit = await issueStoreCredit(db, { amount: 500, source: 'MANUAL', code: knownCode })
sql.prepare('UPDATE "StoreCredit" SET status = ?, usedAmount = ?, usedCount = ? WHERE id = ?')
  .run('USED', 500, 1, credit.id)

for (const [label, code] of [['known', knownCode], ['unknown', unknownCode]]) {
  await assert.rejects(() => guardCreditCode(code), error => {
    assert.ok(!error.message.includes(code), `${label}: returned error must not echo credential`)
    assert.match(error.message, /اعتبار|کد/)
    return true
  })
}
const attempts = await db.auditLog.findMany({ where: { action: 'CREDIT_REDEEM_BLOCKED' }, orderBy: { id: 'asc' } })
assert.equal(attempts.length, 2)
const [known, unknown] = attempts.map(a => ({ ...a, details: JSON.parse(a.after) }))
assert.equal(known.details.creditId, credit.id)
assert.equal(known.details.errorKind, 'NOT_REDEEMABLE')
assert.equal(unknown.details.creditId, null)
assert.equal(unknown.details.errorKind, 'UNKNOWN')
assert.equal(unknown.details.codeLength, unknownCode.length)
for (const attempt of attempts) {
  assert.equal(JSON.parse(attempt.after).credentialRedacted, true)
  const persisted = [attempt.before, attempt.after, attempt.note].filter(Boolean).join(' ')
  assert.ok(!persisted.includes(knownCode) && !persisted.includes(unknownCode))
}
console.log('✓ known failures reference creditId; unknown failures only length/kind; neither exposes a code')

await assert.rejects(() => findRedeemable({ storeCredit: { findMany: () => { throw Error('database failure') } } }, knownCode),
  /database failure/, 'a system/DB failure is not misclassified as bad user input')
console.log('✓ system/DB error is not misclassified as USER_INPUT')
