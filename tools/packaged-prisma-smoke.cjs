'use strict'
/**
 * Packaged-app smoke check (CI: .github/workflows/windows-installer.yml).
 * Run it with the packaged executable in Node mode, for example:
 *   set ELECTRON_RUN_AS_NODE=1
 *   dist\win-unpacked\MahakPOS.exe tools\packaged-prisma-smoke.cjs dist\win-unpacked\resources\app.asar %TEMP%
 *
 * It loads Prisma Client from the packaged app the same way out/main does and
 * runs one query on a fresh, empty SQLite file in a new temporary folder. A
 * missing generated client (node_modules/.prisma) or query engine then fails
 * the build instead of the owner's first launch ("Cannot find module
 * '.prisma/client/default'", 2026-11-20). It never opens the shop database or
 * any user data, and it writes nothing outside its own temporary folder.
 */
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')

const [appRoot, tempRoot] = process.argv.slice(2)
if (!appRoot || !tempRoot) {
  console.error('usage: packaged-prisma-smoke.cjs <app.asar or unpacked app folder> <temp folder>')
  process.exit(2)
}
if (/\.asar$/i.test(appRoot) && !process.versions.electron) {
  console.error('An .asar path needs the packaged Electron executable with ELECTRON_RUN_AS_NODE=1')
  process.exit(2)
}
const dir = mkdtempSync(join(tempRoot, 'mahak-packaged-prisma-'))
function done(code) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {}
  process.exit(code)
}

let prisma
try {
  const { PrismaClient } = require(join(appRoot, 'node_modules', '@prisma', 'client'))
  const db = join(dir, 'smoke.db')
  writeFileSync(db, '')
  prisma = new PrismaClient({ datasourceUrl: `file:${db}` })
} catch (error) {
  console.error('PRISMA_LOAD_FAILED', (error && error.stack) || error)
  done(1)
}

prisma.$queryRawUnsafe('SELECT 1 AS ok').then(async rows => {
  const value = Array.isArray(rows) && rows.length === 1 && rows[0] ? rows[0].ok : undefined
  if (Number(value) !== 1) throw new Error(`unexpected result: ${String(value)}`)
  await prisma.$disconnect()
  console.log(`PRISMA_PACKAGED_OK electron=${process.versions.electron || 'none'}`)
  done(0)
}).catch(async error => {
  console.error('PRISMA_QUERY_FAILED', (error && error.stack) || error)
  try { await prisma.$disconnect() } catch {}
  done(1)
})
