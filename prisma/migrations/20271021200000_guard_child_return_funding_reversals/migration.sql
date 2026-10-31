-- Permit exact reversal pairs for an exchange-child return's carry release.
-- The original trigger only knew invoice-void transfer pairs and payment
-- snapshot revisions; child-return releases are a distinct immutable event.
DROP TRIGGER IF EXISTS "exchange_funding_event_reversal_integrity_insert";

CREATE TRIGGER "exchange_funding_event_reversal_integrity_insert"
BEFORE INSERT ON "ExchangeFundingEvent"
WHEN
  (substr(NEW."kind", 1, 5) = 'VOID_' AND NEW."reversesEventId" IS NULL)
  OR
  (NEW."reversesEventId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ExchangeFundingEvent" source
    WHERE source."id" = NEW."reversesEventId"
      AND source."reversesEventId" IS NULL
      AND substr(source."kind", 1, 5) <> 'VOID_'
      AND NEW."kind" = 'VOID_' || source."kind"
      AND NEW."amount" = -source."amount"
      AND NEW."shareId" = source."shareId"
      AND NEW."rootShareId" = source."rootShareId"
      AND NEW."sourceInvoiceId" IS source."sourceInvoiceId"
      AND NEW."childInvoiceId" IS source."childInvoiceId"
      AND NEW."returnId" IS source."returnId"
      AND NEW."relatedReturnId" IS source."relatedReturnId"
      AND NEW."sourcePaymentId" IS source."sourcePaymentId"
      AND NEW."sourceRedemptionId" IS source."sourceRedemptionId"
      AND NEW."sourceCreditId" IS source."sourceCreditId"
      AND NEW."parentEventId" IS source."parentEventId"
      AND NEW."debtId" IS source."debtId"
      AND NEW."sourceMethodKind" IS source."sourceMethodKind"
      AND NEW."sourceDestination" IS source."sourceDestination"
      AND (
        (source."kind" = 'TRANSFER_OUT'
          AND NEW."evidenceKind" = 'SALE_INVOICE_VOID'
          AND NEW."eventKey" GLOB '*:out:void')
        OR
        (source."kind" = 'TRANSFER_IN'
          AND NEW."evidenceKind" = 'SALE_INVOICE_VOID'
          AND NEW."eventKey" GLOB '*:in:void')
        OR
        (source."kind" = 'RETURN_TRANSFER_OUT'
          AND NEW."evidenceKind" = 'SALE_RETURN_VOID'
          AND NEW."eventKey" = 'void:' || source."relatedReturnId" || ':return-transfer:' || source."id" || ':out')
        OR
        (source."kind" = 'RETURN_TRANSFER_IN'
          AND NEW."evidenceKind" = 'SALE_RETURN_VOID'
          AND NEW."eventKey" = 'void:' || source."relatedReturnId" || ':return-transfer:' || source."id" || ':in')
        OR
        (source."kind" NOT IN ('TRANSFER_OUT', 'TRANSFER_IN', 'RETURN_TRANSFER_OUT', 'RETURN_TRANSFER_IN')
          AND NEW."evidenceKind" = 'PAYMENT_SNAPSHOT_REVISION'
          AND substr(NEW."eventKey", 1, length(source."eventKey") + 7) = source."eventKey" || ':void:r'
          AND substr(NEW."eventKey", length(source."eventKey") + 8) <> ''
          AND substr(NEW."eventKey", length(source."eventKey") + 8) GLOB '[1-9]*'
          AND substr(NEW."eventKey", length(source."eventKey") + 8) NOT GLOB '*[^0-9]*')
      )
  ))
BEGIN
  SELECT RAISE(ABORT, 'exchange funding event reversal mismatch');
END;
