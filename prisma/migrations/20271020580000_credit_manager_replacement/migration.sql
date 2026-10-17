-- Manager replacement is a transfer of the *valid remaining* value, not a
-- second grant. Preserve the old instrument and its redemption history.
-- A single original can have only one direct successor; multiple successive
-- replacements form a traceable chain, never parallel spendable codes.
CREATE TABLE "CreditReplacement" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "originalCreditId" INTEGER NOT NULL,
  "successorCreditId" INTEGER NOT NULL,
  "transferredAmount" BIGINT NOT NULL,
  "receiptRef" TEXT NOT NULL,
  "witnessRef" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "approvingManagerId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditReplacement_positive" CHECK ("transferredAmount" > 0)
);
CREATE UNIQUE INDEX "CreditReplacement_originalCreditId_key" ON "CreditReplacement"("originalCreditId");
CREATE UNIQUE INDEX "CreditReplacement_successorCreditId_key" ON "CreditReplacement"("successorCreditId");
CREATE UNIQUE INDEX "CreditDelivery_originCreditId_key" ON "CreditDelivery"("originCreditId");
