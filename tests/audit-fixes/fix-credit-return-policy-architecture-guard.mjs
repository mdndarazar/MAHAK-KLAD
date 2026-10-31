import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const serviceRoot = join(root, 'src/main/services')
const centralPath = 'src/main/services/CreditReturnService.ts'
const salesPath = 'src/main/services/SalesService.ts'
const policy = readFileSync(join(root, centralPath), 'utf8')
const migration = readFileSync(join(root, 'prisma/migrations/20271021440000_enforce_non_cashable_barcode_returns/migration.sql'), 'utf8')
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')

assert.match(policy, /export const RETURN_CREDIT_POLICY_VERSION\s*=\s*1/)
assert.match(policy, /export const RETURN_CREDIT_POLICY_KEY\s*=\s*'BARCODE_CREDIT_NEVER_CASHABLE'/)
assert.match(policy, /authorizeReturnRealMoneyRefund/)
assert.match(policy, /appendCreditReturnAllocation/)
assert.match(schema, /realMoneyRefundAmount\s+BigInt\s+@default\(0\)/)
assert.match(schema, /creditReturnPolicyVersion\s+Int\?/)
for (const trigger of [
  'CreditReturnAllocation_real_money_ceiling_insert',
  'SaleReturn_real_money_entitlement_update',
  'CashMovement_sale_return_policy_insert',
  'CardTransferRequest_return_policy_insert',
  'Payment_store_credit_non_cash_insert',
  'CreditReturnAllocation_no_update',
  'CreditReturnAllocation_no_delete'
]) assert.ok(migration.includes(trigger), `database enforcement is missing ${trigger}`)

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}
const sources = new Map(sourceFiles(serviceRoot).map((path) =>
  [relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')]))

// One allocation write gateway; only the two existing policy subflows may call it.
for (const [path, text] of sources) {
  if (path !== centralPath)
    assert.doesNotMatch(text, /creditReturnAllocation\s*\.\s*create\s*\(/,
      `${path} writes the credit-return allocation ledger outside its central gateway`)
  if (path !== centralPath && path !== 'src/main/services/ExchangeResidualRightsService.ts')
    assert.doesNotMatch(text, /appendCreditReturnAllocation\s*\(/,
      `${path} adds an unreviewed allocation path`)
}
assert.match(policy, /tx\.creditReturnAllocation\.create/)
assert.match(sources.get('src/main/services/ExchangeResidualRightsService.ts'), /appendCreditReturnAllocation/)

// The shared cash ceiling is written only in the central service, then invoked
// from the known simple-return and exchange settlement flows.
for (const [path, text] of sources) {
  if (path !== centralPath)
    assert.doesNotMatch(text, /(?:realMoneyRefundAmount|creditReturnPolicyVersion)\s*:/,
      `${path} writes policy authorization columns outside the central service`)
  if (path !== salesPath && path !== centralPath)
    assert.doesNotMatch(text, /authorizeReturnRealMoneyRefund\s*\(/,
      `${path} introduces a new payout authorization route`)
}
assert.match(policy, /data:\s*\{\s*realMoneyRefundAmount:\s*input\.amount,\s*creditReturnPolicyVersion:\s*policyVersion/)
assert.match(sources.get(salesPath), /authorizeReturnRealMoneyRefund/)

// Drawer refunds and manager requests are reviewed settlement routes. Other
// services may classify/report these events, but may not create them.
for (const [path, text] of sources) {
  if (path !== salesPath && /type\s*:\s*CashMovementType\.(?:RETURN_REFUND|EXCHANGE_REFUND)/.test(text))
    assert.fail(`${path} adds a return cash-refund writer`)
}
const sales = sources.get(salesPath)
const returnRefundWrites = sales.match(/type:\s*CashMovementType\.RETURN_REFUND/g) ?? []
const exchangeRefundWrites = sales.match(/type:\s*CashMovementType\.EXCHANGE_REFUND/g) ?? []
assert.equal(returnRefundWrites.length, 1, 'new simple-return drawer payout routes require an explicit policy review')
assert.equal(exchangeRefundWrites.length, 4, 'new exchange-refund routes require an explicit policy review')
assert.equal((sales.match(/createCardTransferRequest\(tx,/g) ?? []).length, 2,
  'new manager-transfer request routes require an explicit policy review')
assert.equal((sales.match(/authorizeReturnRealMoneyRefund\(tx,/g) ?? []).length, 3,
  'every cash or manager payout route must be authorized by the central policy')
const cardTransfer = sources.get('src/main/services/CardTransferService.ts')
assert.doesNotMatch(cardTransfer, /recordCashMovement\s*\(/,
  'paying from the manager account must not create store cash/POS movements')

console.log('✓ architecture guard: centralized entitlement and allocation writers, approved settlement callers, and DB backstops')
