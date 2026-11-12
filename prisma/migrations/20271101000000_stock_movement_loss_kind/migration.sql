-- مورد ۱۱ — طبقه‌بندی علت کاهش دستی موجودی (DAMAGE = زیان · CORRECTION = بدون زیان · NULL = نامشخص)
ALTER TABLE "StockMovement" ADD COLUMN "lossKind" TEXT;
CREATE INDEX IF NOT EXISTS "StockMovement_lossKind_idx" ON "StockMovement"("lossKind");
