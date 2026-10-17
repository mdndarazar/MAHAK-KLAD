-- New financial cutover records ONLY. No legacy SaleReturn/Payment/StoreCredit is
-- deleted or guessed into a cash claim. Existing card-transfer rows stay legacy.
-- Scalar references deliberately have no cascading FK: purging an invoice or
-- return must never erase a settled obligation or its immutable evidence.
CREATE TABLE "ReturnEntitlement" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "returnId" INTEGER NOT NULL,
  "invoiceId" INTEGER NOT NULL,
  "requestId" INTEGER,
  "cashRight" BIGINT NOT NULL DEFAULT 0,
  "giftOpportunity" BIGINT NOT NULL DEFAULT 0,
  "debtReduced" BIGINT NOT NULL DEFAULT 0,
  "cashPaid" BIGINT NOT NULL DEFAULT 0,
  "cashReserved" BIGINT NOT NULL DEFAULT 0,
  "cashConverted" BIGINT NOT NULL DEFAULT 0,
  "state" TEXT NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnEntitlement_nonnegative" CHECK (
    "cashRight" >= 0 AND "giftOpportunity" >= 0 AND "debtReduced" >= 0 AND
    "cashPaid" >= 0 AND "cashReserved" >= 0 AND "cashConverted" >= 0 AND "version" >= 0
  )
);
CREATE UNIQUE INDEX "ReturnEntitlement_returnId_key" ON "ReturnEntitlement"("returnId");
CREATE UNIQUE INDEX "ReturnEntitlement_requestId_key" ON "ReturnEntitlement"("requestId");
CREATE INDEX "ReturnEntitlement_invoiceId_idx" ON "ReturnEntitlement"("invoiceId");
CREATE INDEX "ReturnEntitlement_state_idx" ON "ReturnEntitlement"("state");

CREATE TABLE "ReturnEntitlementEvent" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "entitlementId" INTEGER NOT NULL,
  "eventKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" BIGINT NOT NULL DEFAULT 0,
  "requestId" INTEGER,
  "creditId" INTEGER,
  "actorUserId" INTEGER,
  "evidenceKind" TEXT NOT NULL DEFAULT 'SYSTEM',
  "evidenceHash" TEXT,
  "reason" TEXT,
  "beforeVersion" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ReturnEntitlementEvent_eventKey_key" ON "ReturnEntitlementEvent"("eventKey");
CREATE INDEX "ReturnEntitlementEvent_entitlementId_id_idx" ON "ReturnEntitlementEvent"("entitlementId", "id");
CREATE INDEX "ReturnEntitlementEvent_requestId_idx" ON "ReturnEntitlementEvent"("requestId");
CREATE INDEX "ReturnEntitlementEvent_creditId_idx" ON "ReturnEntitlementEvent"("creditId");

-- A pending replacement/conversion can be PRINTED but cannot be spent until
-- separate witnessed delivery. Never infer delivery from a print counter.
CREATE TABLE "CreditDelivery" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "creditId" INTEGER NOT NULL,
  "originCreditId" INTEGER,
  "sourceKind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING_DELIVERY',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" DATETIME,
  "deliveredByUserId" INTEGER,
  "witnessKind" TEXT,
  "witnessRef" TEXT
);
CREATE UNIQUE INDEX "CreditDelivery_creditId_key" ON "CreditDelivery"("creditId");
CREATE INDEX "CreditDelivery_originCreditId_idx" ON "CreditDelivery"("originCreditId");
CREATE INDEX "CreditDelivery_status_idx" ON "CreditDelivery"("status");

-- A manager-reviewed *document* is distinct from the manager's typed
-- tracking number/PIN. The document is stored in the database so BackupService
-- also preserves the evidence; ordinary reports never receive its contents.
CREATE TABLE "BankStatementEvidence" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "requestId" INTEGER NOT NULL,
  "confirmedAmount" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "documentBase64" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "reviewedByUserId" INTEGER,
  "reviewNote" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankStatementEvidence_positive" CHECK ("confirmedAmount" > 0)
);
CREATE UNIQUE INDEX "BankStatementEvidence_requestId_key" ON "BankStatementEvidence"("requestId");
CREATE INDEX "BankStatementEvidence_sha256_idx" ON "BankStatementEvidence"("sha256");
