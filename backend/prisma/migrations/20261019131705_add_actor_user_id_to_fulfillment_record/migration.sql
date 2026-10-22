-- Migration: add_actor_user_id_to_fulfillment_record (issue #75)
-- Adds FulfillmentRecord.actorUserId — the staff user who performed the
-- fulfillment action, so attribution is per person, not just per facility
-- (PRD §7 auditability). Nullable: rows that predate #75 have no actor.
--
-- Forward-only, like every other Prisma migration: an earlier draft appended
-- the reversal (`DROP COLUMN`) to this same file, but Prisma applies the
-- whole file top to bottom, so the column was dropped the moment it was
-- added. Reversals ship as a new migration instead.

ALTER TABLE "FulfillmentRecord"
    ADD COLUMN "actorUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL;
