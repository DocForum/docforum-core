-- Issue #321: add retirement flag to FacilityPrice. A new version row with
-- retired = true acts as a tombstone — resolveCurrentPrice skips it and
-- requireCurrentPrice surfaces ITEM_RETIRED (422) to callers.
-- Append-only history is unaffected: existing rows keep retired = false.
ALTER TABLE "FacilityPrice" ADD COLUMN "retired" BOOLEAN NOT NULL DEFAULT false;
