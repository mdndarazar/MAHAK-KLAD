/**
 * An already-applied auto-timeout migration added three nullable evidence
 * columns. Prisma's model must still describe those same columns; never edit
 * or replay an old migration against a real shop database.
 * node --import ./test/harness/register.mjs tests/audit-fixes/fix-s425-custody-resolution-old-columns-contract.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'mahak-resolution-schema-s425-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'shop.db')
const { harnessClient } = await import('../../test/harness/stubs/prismaClient.mjs')
const sql = harnessClient().$harness.db
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')
const model = schema.match(/model CustodyResolution \{([\s\S]*?)\n\}/)?.[1] ?? ''
const columns = sql.prepare('PRAGMA table_info("CustodyResolution")').all()
let checks = 0
function eq(label, got, want) { if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`); checks++; console.log(`  ✓ ${label}`) }
for (const [name, type] of [['expectedCard', 'BigInt?'], ['effectiveAt', 'DateTime?'], ['detectedAt', 'DateTime?']]) {
  eq(`${name} exists after the historical migration`, columns.some((column) => column.name === name), true)
  eq(`${name} is nullable in Prisma model`, new RegExp(`^\\s*${name}\\s+${type.replace('?', '\\?')}(?=\\s|$)`, 'm').test(model), true)
}
console.log(`\n✓ ${checks} checks passed`)
