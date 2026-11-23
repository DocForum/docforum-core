-- AlterTable
ALTER TABLE "WalletLink" ADD COLUMN     "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;


-- Issue #328: existing links took effect when they were created. Without
-- this backfill every pre-existing row would read as effective "now" and
-- the most recent historical row would not be the deterministic winner.
UPDATE "WalletLink" SET "effectiveAt" = "createdAt";
