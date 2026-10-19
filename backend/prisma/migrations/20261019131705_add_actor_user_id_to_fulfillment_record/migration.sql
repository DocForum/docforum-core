-- Migration: add_actor_user_id_to_fulfillment_record
-- Adds actorUserId field to FulfillmentRecord for attribution of
-- which staff user performed the action.
-- Existing rows get NULL; new rows must set actorUserId.

-- ── Add actorUserId column ─────────────────────────────────────────────
ALTER TABLE "FulfillmentRecord" ADD COLUMN "actorUserId" TEXT REFERENCES "User"(id) ON DELETE SET NULL;

-- Update existing rows to mark them as legacy (optional — left NULL per requirements)
-- The actorUserId is nullable, so existing rows remain valid without a value.

-- ── Reverse (down) migration ───────────────────────────────────────────
-- Drop the column and its constraint.
ALTER TABLE "FulfillmentRecord" DROP COLUMN IF EXISTS "actorUserId";