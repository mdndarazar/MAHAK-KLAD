-- The funding journal is append-only: corrections and reversals are new rows.
-- Scalar references deliberately survive business-document deletion, so UPDATE
-- or DELETE would silently rewrite both provenance and all downstream balances.
CREATE TRIGGER "exchange_funding_event_no_update"
BEFORE UPDATE ON "ExchangeFundingEvent"
BEGIN
  SELECT RAISE(ABORT, 'exchange funding events are append-only');
END;

CREATE TRIGGER "exchange_funding_event_no_delete"
BEFORE DELETE ON "ExchangeFundingEvent"
BEGIN
  SELECT RAISE(ABORT, 'exchange funding events are append-only');
END;
