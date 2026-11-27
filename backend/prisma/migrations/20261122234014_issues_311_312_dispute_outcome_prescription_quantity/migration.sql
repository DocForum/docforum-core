-- Issue #311: closed enum for dispute resolution outcomes.
--
-- `unspecified` exists only for legacy rows: the old admin endpoint stored
-- `outcome || status || 'resolved'`, so existing rows can hold `resolved`
-- or other free text that names no outcome. The API never accepts it for a
-- new resolution (resolveDisputeSchema allows upheld/rejected/refunded).
CREATE TYPE "DisputeOutcome" AS ENUM ('upheld', 'rejected', 'refunded', 'unspecified');

-- Unmapped legacy values keep their original text: it is appended to the
-- resolution notes before the column is converted, so nothing is lost.
UPDATE "OrderDisputeResolution"
SET "resolutionNotes" = "resolutionNotes" || E'\n\n[Legacy outcome before issue #311: ' || "outcome" || ']'
WHERE lower(trim("outcome")) NOT IN (
  'upheld', 'uphold', 'accepted', 'approved',
  'rejected', 'reject', 'denied', 'dismissed',
  'refunded', 'refund'
);

-- Explicit mapping of existing free-text values; anything else becomes
-- `unspecified` (documented above), so the conversion cannot fail.
ALTER TABLE "OrderDisputeResolution" ALTER COLUMN "outcome" TYPE "DisputeOutcome" USING (
  CASE lower(trim("outcome"))
    WHEN 'upheld' THEN 'upheld'
    WHEN 'uphold' THEN 'upheld'
    WHEN 'accepted' THEN 'upheld'
    WHEN 'approved' THEN 'upheld'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'reject' THEN 'rejected'
    WHEN 'denied' THEN 'rejected'
    WHEN 'dismissed' THEN 'rejected'
    WHEN 'refunded' THEN 'refunded'
    WHEN 'refund' THEN 'refunded'
    ELSE 'unspecified'
  END
)::"DisputeOutcome";

-- Issue #312: quantity and dispense unit per prescription item.
-- Nullable so existing rows migrate without backfill (prescriptions are
-- append-only); the service requires both fields on newly issued items.
ALTER TABLE "PrescriptionItem" ADD COLUMN "quantity" INTEGER;
ALTER TABLE "PrescriptionItem" ADD COLUMN "unit" TEXT;
