-- Keep UNKNOWN-destination receipts as separate, immutable blue evidence.
-- An existing blue V1 snapshot is frozen: NULL means this component was NOT
-- measured in V1. A new V2 snapshot always writes its explicit amount (even
-- zero). No old payment, count, handover or snapshot is changed here.
ALTER TABLE "CustodyBlueSnapshot" ADD COLUMN "destinationUnknownReceived" BIGINT;
-- A single final decision can document BOTH independent uncertainties, without
-- changing old CREDIT-only decisions or issuing a partial RESOLVED verdict.
ALTER TABLE "CustodyBlueResolution" ADD COLUMN "destinationDecisionKind" TEXT;
ALTER TABLE "CustodyBlueResolution" ADD COLUMN "destinationAmbiguousAmount" BIGINT;
ALTER TABLE "CustodyBlueResolution" ADD COLUMN "destinationEvidenceDay" TEXT;
ALTER TABLE "CustodyBlueResolution" ADD COLUMN "destinationEvidenceReference" TEXT;
