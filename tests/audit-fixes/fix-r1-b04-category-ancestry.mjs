import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mahak-r1-b04-'))
process.env.HARNESS_DIR = dir
process.env.HARNESS_DB = join(dir, 'isolated.db')

const [{ harnessClient }, { makeSeeder }, { productService }, { linesForInvoice }, { categoryAncestryPath, categoryParentMap }] = await Promise.all([
  import('../../test/harness/stubs/prismaClient.mjs'),
  import('../../test/harness/seed.mjs'),
  import('../../src/main/services/ProductService.ts'),
  import('../../src/main/services/StoreCreditService.ts'),
  import('../../src/shared/categoryAncestry.ts')
])

const db = harnessClient()
const seed = makeSeeder(db)
const sql = db.$harness.db

// The shared ancestry walk has no 20/100-level cap.
{
  const rows = Array.from({ length: 151 }, (_, index) => ({
    id: index + 1,
    parentId: index === 0 ? null : index
  }))
  const parents = categoryParentMap(rows)
  assert.equal(categoryAncestryPath(151, parents).length, 151)
  assert.throws(() => categoryParentMap([{ id: 1, parentId: 99 }]), /والد دسته/)
  assert.throws(() => categoryParentMap([{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }]), /چرخه/)
}

const rootId = seed.category('R1-B04 root')
let deepestId = rootId
for (let depth = 1; depth <= 150; depth++)
  deepestId = seed.category(`R1-B04 level ${depth}`, deepestId)

const productId = seed.product('R1-B04 deep product', deepestId)
const variantId = seed.variant(productId, 'R1-B04 deep variant')
sql.prepare('UPDATE "Product" SET isActive = 1 WHERE id = ?').run(productId)
sql.prepare('UPDATE "ProductVariant" SET isActive = 1, stock = 20, salePrice = 50000 WHERE id = ?').run(variantId)

// Tree rendering and parent-category product filtering both traverse all levels.
{
  const tree = await productService.categoryTree()
  const deepest = tree.find((row) => row.id === deepestId)
  assert.ok(deepest)
  assert.equal(deepest.depth, 150)

  const products = await productService.list({ categoryId: rootId })
  assert.ok(products.some((row) => row.id === variantId), 'root filter must include a product 150 levels below')

  const invoice = seed.invoiceWithLines([{ variantId, qty: 1, lineTotal: 50000 }])
  const lines = await linesForInvoice(db, invoice.id)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].categoryPath.length, 151)
  assert.equal(lines[0].categoryPath[0], deepestId)
  assert.equal(lines[0].categoryPath.at(-1), rootId)
}

// Editing a category under itself/one of its descendants or to a missing parent
// is rejected before it can corrupt the tree.
await assert.rejects(
  () => productService.categoryUpsert({ id: rootId, name: 'R1-B04 root', parentId: deepestId }),
  /چرخه/
)
await assert.rejects(
  () => productService.categoryUpsert({ id: rootId, name: 'R1-B04 root', parentId: 999999 }),
  /والد انتخاب‌شده پیدا نشد/
)

// If existing storage is corrupt, readers reject the graph rather than returning
// a truncated ancestor path or silently treating a broken node as a root.
sql.prepare('UPDATE "Category" SET parentId = ? WHERE id = ?').run(deepestId, rootId)
await assert.rejects(() => productService.categoryTree(), /چرخه/)
await assert.rejects(() => productService.categoryUpsert({ id: rootId, name: 'still corrupt', parentId: null }), /چرخه/)
const brokenInvoice = seed.invoiceWithLines([{ variantId, qty: 1, lineTotal: 50000 }])
await assert.rejects(() => linesForInvoice(db, brokenInvoice.id), /چرخه/)

console.log('✓ R1-B04 deep category ancestry, missing-parent/cycle rejection, and write-time validation passed')
await db.$disconnect?.()
