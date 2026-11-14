-- نشست ۲۲۳ · مورد ۷ — snapshot هویت بدهکار روی همان فاکتور نسیه.
-- فقط ستون‌های nullable اضافه می‌شوند؛ هیچ دادهٔ قدیمی بازنویسی یا backfill نمی‌شود.
ALTER TABLE "SaleInvoice" ADD COLUMN "debtorFirstName" TEXT;
ALTER TABLE "SaleInvoice" ADD COLUMN "debtorLastName" TEXT;
ALTER TABLE "SaleInvoice" ADD COLUMN "debtorPhone" TEXT;
ALTER TABLE "SaleInvoice" ADD COLUMN "debtorNationalId" TEXT;
