-- Durable idempotency for committed sale-return requests. Historical rows stay
-- NULL; new requests bind a unique key to a server-derived payload fingerprint
-- and a sanitized response snapshot for safe replay.
ALTER TABLE "SaleReturn" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "idempotencyFingerprint" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "idempotencyResponseJson" TEXT;

CREATE UNIQUE INDEX "SaleReturn_idempotencyKey_key"
  ON "SaleReturn"("idempotencyKey");

CREATE TRIGGER "sale_return_idempotency_immutable"
BEFORE UPDATE OF "idempotencyKey", "idempotencyFingerprint", "idempotencyResponseJson" ON "SaleReturn"
WHEN OLD."idempotencyKey" IS NOT NEW."idempotencyKey"
  OR OLD."idempotencyFingerprint" IS NOT NEW."idempotencyFingerprint"
  OR (OLD."idempotencyResponseJson" IS NOT NULL
      AND OLD."idempotencyResponseJson" IS NOT NEW."idempotencyResponseJson")
  OR (OLD."idempotencyResponseJson" IS NULL AND NEW."idempotencyResponseJson" IS NOT NULL
      AND (NEW."idempotencyKey" IS NULL OR NEW."idempotencyFingerprint" IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'sale return idempotency fields are immutable');
END;
