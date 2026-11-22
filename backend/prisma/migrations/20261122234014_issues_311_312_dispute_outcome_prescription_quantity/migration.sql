-- Issue #311: closed enum for dispute resolution outcomes.
CREATE TYPE "DisputeOutcome" AS ENUM ('upheld', 'rejected', 'refunded');

-- Alter the existing free-text column to the new enum type.
-- Any pre-existing rows whose outcome value is not a valid enum member will
-- cause this migration to fail — which is intentional: free-text outcomes
-- outside the vocabulary are a data-quality problem, not a migration concern.
ALTER TABLE "OrderDisputeResolution" ALTER COLUMN "outcome" TYPE "DisputeOutcome" USING "outcome"::"DisputeOutcome";

-- Issue #312: quantity and dispense unit per prescription item.
-- Nullable so existing rows migrate without backfill; the service now
-- requires both fields on newly issued prescriptions.
ALTER TABLE "PrescriptionItem" ADD COLUMN "quantity" INTEGER;
ALTER TABLE "PrescriptionItem" ADD COLUMN "unit" TEXT;
