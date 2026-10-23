-- A return may settle one real-money entitlement through two explicit legs:
-- the selected immediate/manager payout (`refundAmount`) and a newly issued
-- store-credit barcode (`refundStoreCreditAmount`). Historical rows default 0.
ALTER TABLE "SaleReturn" ADD COLUMN "refundStoreCreditAmount" BIGINT NOT NULL DEFAULT 0;

CREATE TRIGGER "SaleReturn_refund_split_policy_insert"
BEFORE INSERT ON "SaleReturn"
WHEN NEW."creditReturnPolicyVersion" = 1
BEGIN
  SELECT CASE WHEN NEW."refundStoreCreditAmount" > 0 AND upper(COALESCE(NEW."refundMethod", '')) <> 'CASH'
    THEN RAISE(ABORT, 'Split store-credit refunds require the CASH primary settlement') END;
  SELECT CASE WHEN NEW."refundStoreCreditAmount" < 0 OR
    COALESCE(NEW."refundAmount", 0) + NEW."refundStoreCreditAmount" > NEW."realMoneyRefundAmount"
    THEN RAISE(ABORT, 'Return settlement legs exceed the authorized real-money entitlement') END;
END;
CREATE TRIGGER "SaleReturn_refund_split_policy_update"
BEFORE UPDATE OF "refundAmount", "refundStoreCreditAmount", "realMoneyRefundAmount", "creditReturnPolicyVersion", "refundMethod" ON "SaleReturn"
WHEN NEW."creditReturnPolicyVersion" = 1
BEGIN
  SELECT CASE WHEN NEW."refundStoreCreditAmount" > 0 AND upper(COALESCE(NEW."refundMethod", '')) <> 'CASH'
    THEN RAISE(ABORT, 'Split store-credit refunds require the CASH primary settlement') END;
  SELECT CASE WHEN NEW."refundStoreCreditAmount" < 0 OR
    COALESCE(NEW."refundAmount", 0) + NEW."refundStoreCreditAmount" > NEW."realMoneyRefundAmount"
    THEN RAISE(ABORT, 'Return settlement legs exceed the authorized real-money entitlement') END;
END;

-- Reserve only the non-barcode remainder for immediate cash and manager-transfer
-- legs. The previous per-leg checks accepted a request larger than the actual
-- remaining right whenever part of the same right had become store credit.
DROP TRIGGER IF EXISTS "CashMovement_sale_return_policy_insert";
CREATE TRIGGER "CashMovement_sale_return_policy_insert"
BEFORE INSERT ON "CashMovement"
WHEN NEW."refType" = 'SaleReturn'
BEGIN
  SELECT CASE WHEN NEW."type" NOT IN ('RETURN_REFUND', 'EXCHANGE_REFUND')
    THEN RAISE(ABORT, 'SaleReturn cash movements must use a policy-controlled refund type') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."refId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" > 0
      AND NEW."amount" + COALESCE((SELECT SUM(m."amount") FROM "CashMovement" m
        WHERE m."refType" = 'SaleReturn' AND m."refId" = r."id"
          AND m."type" IN ('RETURN_REFUND', 'EXCHANGE_REFUND')), 0)
        <= max(0, r."realMoneyRefundAmount" - r."refundStoreCreditAmount")
  ) THEN RAISE(ABORT, 'Return cash refund exceeds the authorized real-money entitlement') END;
END;

DROP TRIGGER IF EXISTS "CashMovement_sale_return_policy_update";
CREATE TRIGGER "CashMovement_sale_return_policy_update"
BEFORE UPDATE OF "amount", "type", "refType", "refId" ON "CashMovement"
WHEN NEW."refType" = 'SaleReturn' OR OLD."refType" = 'SaleReturn'
BEGIN
  SELECT CASE WHEN NEW."refType" <> 'SaleReturn' OR NEW."type" NOT IN ('RETURN_REFUND', 'EXCHANGE_REFUND')
    THEN RAISE(ABORT, 'SaleReturn cash movements must use a policy-controlled refund type') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."refId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" > 0
      AND NEW."amount" + COALESCE((SELECT SUM(m."amount") FROM "CashMovement" m
        WHERE m."refType" = 'SaleReturn' AND m."refId" = r."id"
          AND m."type" IN ('RETURN_REFUND', 'EXCHANGE_REFUND') AND m."id" <> OLD."id"), 0)
        <= max(0, r."realMoneyRefundAmount" - r."refundStoreCreditAmount")
  ) THEN RAISE(ABORT, 'Return cash refund exceeds the authorized real-money entitlement') END;
END;

DROP TRIGGER IF EXISTS "CardTransferRequest_return_policy_insert";
CREATE TRIGGER "CardTransferRequest_return_policy_insert"
BEFORE INSERT ON "CardTransferRequest"
WHEN NEW."kind" = 'REQUEST'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" >= 0
      AND NEW."amount" <= max(0, r."realMoneyRefundAmount" - r."refundStoreCreditAmount")
  ) THEN RAISE(ABORT, 'Manager transfer exceeds the authorized real-money return entitlement') END;
END;

DROP TRIGGER IF EXISTS "CardTransferRequest_return_policy_update";
CREATE TRIGGER "CardTransferRequest_return_policy_update"
BEFORE UPDATE OF "amount", "returnId", "kind" ON "CardTransferRequest"
WHEN NEW."kind" = 'REQUEST'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" >= 0
      AND NEW."amount" <= max(0, r."realMoneyRefundAmount" - r."refundStoreCreditAmount")
  ) THEN RAISE(ABORT, 'Manager transfer exceeds the authorized real-money return entitlement') END;
END;

DROP TRIGGER IF EXISTS "CardTransferRequest_adjustment_policy_insert";
CREATE TRIGGER "CardTransferRequest_adjustment_policy_insert"
BEFORE INSERT ON "CardTransferRequest"
WHEN NEW."kind" = 'ADJUSTMENT' AND NEW."amount" > 0
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    JOIN "CardTransferRequest" base ON base."id" = NEW."adjustsRequestId"
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND base."kind" = 'REQUEST'
      AND base."returnId" = NEW."returnId"
      AND COALESCE(base."paidAmount", base."amount") +
        COALESCE((SELECT SUM(COALESCE(a."paidAmount", a."amount")) FROM "CardTransferRequest" a
          WHERE a."adjustsRequestId" = base."id" AND a."kind" = 'ADJUSTMENT'), 0) + NEW."amount"
        <= max(0, r."realMoneyRefundAmount" - r."refundStoreCreditAmount")
  ) THEN RAISE(ABORT, 'Manager transfer adjustment exceeds the authorized real-money return entitlement') END;
END;

DROP TRIGGER IF EXISTS "CardTransferRequest_paid_amount_policy_update";
CREATE TRIGGER "CardTransferRequest_paid_amount_policy_update"
BEFORE UPDATE OF "paidAmount" ON "CardTransferRequest"
WHEN NEW."kind" = 'REQUEST' AND NEW."paidAmount" IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW."paidAmount" < 0 OR NEW."paidAmount" > NEW."amount" OR NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" <= max(0, r."realMoneyRefundAmount" - r."refundStoreCreditAmount")
  ) THEN RAISE(ABORT, 'Manager payment exceeds the authorized real-money return entitlement') END;
END;
