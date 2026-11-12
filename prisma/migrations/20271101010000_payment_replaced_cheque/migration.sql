-- مورد ۶ — زنجیرهٔ جایگزینی چک (چک جایگزین به چک قبلی اشاره می‌کند؛ چک اصلی NULL می‌ماند)
ALTER TABLE "Payment" ADD COLUMN "replacedChequeId" INTEGER;
CREATE INDEX IF NOT EXISTS "Payment_replacedChequeId_idx" ON "Payment"("replacedChequeId");
