-- CENTRAL POLICY CHANGE POINT: CreditReturnService.RETURN_CREDIT_POLICY_VERSION.
-- Any policy change ships as a new migration; do not edit already-applied migrations.
ALTER TABLE "SaleReturn" ADD COLUMN "realMoneyRefundAmount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "SaleReturn" ADD COLUMN "creditReturnPolicyVersion" INTEGER;

CREATE TRIGGER "CreditReturnAllocation_real_money_ceiling_insert"
BEFORE INSERT ON "CreditReturnAllocation"
WHEN EXISTS (
  SELECT 1 FROM "SaleReturn" r
  WHERE r."id" = NEW."returnId"
    AND r."creditReturnPolicyVersion" = 1
    AND r."realMoneyRefundAmount" > max(0,
      r."total" - r."exchangeTotal" - r."debtReduction" -
      COALESCE((SELECT SUM(a."amount") FROM "CreditReturnAllocation" a WHERE a."returnId" = r."id"), 0) - NEW."amount")
)
BEGIN
  SELECT RAISE(ABORT, 'Credit return allocation would leave a cashable credit share');
END;

CREATE TRIGGER "SaleReturn_real_money_entitlement_insert"
BEFORE INSERT ON "SaleReturn"
WHEN NEW."creditReturnPolicyVersion" = 1
BEGIN
  SELECT CASE WHEN NEW."realMoneyRefundAmount" < 0 OR NEW."realMoneyRefundAmount" > max(0,
    NEW."total" - NEW."exchangeTotal" - NEW."debtReduction")
    THEN RAISE(ABORT, 'Real-money refund entitlement exceeds return value') END;
END;
CREATE TRIGGER "SaleReturn_real_money_entitlement_update"
BEFORE UPDATE OF "realMoneyRefundAmount", "creditReturnPolicyVersion", "exchangeTotal", "debtReduction" ON "SaleReturn"
WHEN NEW."creditReturnPolicyVersion" = 1
BEGIN
  SELECT CASE WHEN NEW."realMoneyRefundAmount" < 0 OR NEW."realMoneyRefundAmount" > max(0,
    NEW."total" - NEW."exchangeTotal" - NEW."debtReduction" -
    COALESCE((SELECT SUM(a."amount") FROM "CreditReturnAllocation" a WHERE a."returnId" = NEW."id"), 0))
    THEN RAISE(ABORT, 'Real-money refund entitlement includes non-cashable source credit or exceeds return value') END;
END;

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
      AND NEW."amount" <= r."realMoneyRefundAmount"
  ) THEN RAISE(ABORT, 'Return cash refund exceeds the authorized real-money entitlement') END;
END;
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
      AND NEW."amount" <= r."realMoneyRefundAmount"
  ) THEN RAISE(ABORT, 'Return cash refund exceeds the authorized real-money entitlement') END;
END;

CREATE TRIGGER "CardTransferRequest_return_policy_insert"
BEFORE INSERT ON "CardTransferRequest"
WHEN NEW."kind" = 'REQUEST'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" >= 0
      AND NEW."amount" <= r."realMoneyRefundAmount"
  ) THEN RAISE(ABORT, 'Manager transfer exceeds the authorized real-money return entitlement') END;
END;
CREATE TRIGGER "CardTransferRequest_return_policy_update"
BEFORE UPDATE OF "amount", "returnId", "kind" ON "CardTransferRequest"
WHEN NEW."kind" = 'REQUEST'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" >= 0
      AND NEW."amount" <= r."realMoneyRefundAmount"
  ) THEN RAISE(ABORT, 'Manager transfer exceeds the authorized real-money return entitlement') END;
END;

CREATE TRIGGER "Payment_store_credit_non_cash_insert"
BEFORE INSERT ON "Payment"
WHEN NEW."storeCreditId" IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW."destination" IS NOT NULL
    THEN RAISE(ABORT, 'Barcode credit is non-cashable and cannot have a money destination') END;
  SELECT CASE WHEN upper(COALESCE((SELECT m."kind" FROM "PaymentMethod" m WHERE m."id" = NEW."methodId"), '')) <> 'STORE_CREDIT'
    THEN RAISE(ABORT, 'Barcode-backed payment must use the STORE_CREDIT method') END;
END;
CREATE TRIGGER "Payment_store_credit_non_cash_update"
BEFORE UPDATE OF "storeCreditId", "destination", "methodId" ON "Payment"
WHEN NEW."storeCreditId" IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW."destination" IS NOT NULL
    THEN RAISE(ABORT, 'Barcode credit is non-cashable and cannot have a money destination') END;
  SELECT CASE WHEN upper(COALESCE((SELECT m."kind" FROM "PaymentMethod" m WHERE m."id" = NEW."methodId"), '')) <> 'STORE_CREDIT'
    THEN RAISE(ABORT, 'Barcode-backed payment must use the STORE_CREDIT method') END;
END;

CREATE TRIGGER "CreditReturnAllocation_no_update"
BEFORE UPDATE ON "CreditReturnAllocation"
BEGIN
  SELECT RAISE(ABORT, 'CreditReturnAllocation is append-only');
END;
CREATE TRIGGER "CreditReturnAllocation_no_delete"
BEFORE DELETE ON "CreditReturnAllocation"
BEGIN
  SELECT RAISE(ABORT, 'CreditReturnAllocation is append-only');
END;

-- A positive manager-transfer correction is another payout, not a new return
-- request. Keep the original request plus all corrections within the same cap.
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
        <= r."realMoneyRefundAmount"
  ) THEN RAISE(ABORT, 'Manager transfer adjustment exceeds the authorized real-money return entitlement') END;
END;
CREATE TRIGGER "CardTransferRequest_paid_amount_policy_update"
BEFORE UPDATE OF "paidAmount" ON "CardTransferRequest"
WHEN NEW."kind" = 'REQUEST' AND NEW."paidAmount" IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW."paidAmount" < 0 OR NEW."paidAmount" > NEW."amount" OR NOT EXISTS (
    SELECT 1 FROM "SaleReturn" r
    WHERE r."id" = NEW."returnId"
      AND r."creditReturnPolicyVersion" = 1
      AND NEW."amount" <= r."realMoneyRefundAmount"
  ) THEN RAISE(ABORT, 'Manager payment exceeds the authorized real-money return entitlement') END;
END;
