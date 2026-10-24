-- New OUT attempts persist the Main policy TTL atomically with the witness.
-- Old pending attempts keep NULL protocolVersion: the reader uses their
-- original startedAt + 10 minutes, never the mutable current policy.
ALTER TABLE "CustodyHandover" ADD COLUMN "protocolVersion" INTEGER;
ALTER TABLE "CustodyHandover" ADD COLUMN "deadlineAt" DATETIME;
ALTER TABLE "CustodyHandover" ADD COLUMN "deadlinePolicyMinutes" INTEGER;
CREATE INDEX "CustodyHandover_status_deadlineAt_idx" ON "CustodyHandover"("status", "deadlineAt");
