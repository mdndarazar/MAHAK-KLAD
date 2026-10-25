-- Cash movements change the expected drawer total just like payments and returns.
-- Advance the same monotonic revision used by blind counts/final-close fences so
-- a deposit or withdrawal between the observed count and commit makes that
-- observation stale instead of accepting a count against an old cash total.
CREATE TRIGGER "custody_blue_cash_movement_insert_rev"
AFTER INSERT ON "CashMovement"
BEGIN
  UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN';
END;

CREATE TRIGGER "custody_blue_cash_movement_update_rev"
AFTER UPDATE ON "CashMovement"
BEGIN
  UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN';
END;

CREATE TRIGGER "custody_blue_cash_movement_delete_rev"
AFTER DELETE ON "CashMovement"
BEGIN
  UPDATE "CustodyState" SET "financialRevision" = "financialRevision" + 1 WHERE "key" = 'MAIN';
END;
