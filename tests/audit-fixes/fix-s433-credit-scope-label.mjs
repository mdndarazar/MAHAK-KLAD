// The full report aggregates historical CREDIT/null across every page; the
// inspector must not claim that same value is only the current invoice page.
// node tests/audit-fixes/fix-s433-credit-scope-label.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const sales = readFileSync('src/main/services/SalesService.ts', 'utf8')
const inspector = readFileSync('src/renderer/src/components/cash/FinancialInspector.tsx', 'utf8')
assert.match(sales, /totals\.creditTotal\s*=\s*a\.ambiguousLegacyCreditTotal\s*\?\?\s*0/, 'when accounting succeeds, creditTotal is the full-scope legacy payment sum')
assert.match(inspector, /statementsSnapshot\s*\?\s*'پرداخت اعتباری قدیمیِ بی‌مقصد/, 'scope must be explicit when statements were read')
assert.match(inspector, /صورت مالی کامل محاسبه نشد؛ این مبلغ فقط از ردیف‌های همین صفحه است/, 'failed accounting may leave only a page subtotal')
assert.doesNotMatch(inspector, /این مبلغ فقط بر پایهٔ فاکتورهای نمایش‌داده‌شده در صفحهٔ فعلی گزارش است؛ برای آن تیک هم‌خوانی کل‌بازه/, 'full-scope amount must not be called page-only')
console.log('✓ historical CREDIT/null is labelled by its actual scope and never confused with unpaid credit sales')
