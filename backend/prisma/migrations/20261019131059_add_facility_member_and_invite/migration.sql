-- Migration: add_facility_member_and_invite (issue #75)
-- Adds FacilityMember and FacilityInvite, and backfills every existing
-- FacilityProfile/User pair into a FacilityMember with role=owner so the
-- original facility logins keep their access and attribution.
--
-- Forward-only, like every other Prisma migration: the earlier draft appended
-- a "down migration" section to this same file, but Prisma applies the whole
-- file top to bottom, so the file used to drop the tables it had just created
-- and delete the backfilled rows. Reversals ship as a new migration instead.
-- The DROP ... IF EXISTS guards below are kept so the migration can safely be
-- re-applied (the integration suite re-runs it to prove the backfill).
--
-- FacilityProfile.userId stays unique: it remains the facility's original
-- owner link, so nothing that resolves a facility from its owner user changes.

-- ── FacilityRole ───────────────────────────────────────────────────────
DROP INDEX IF EXISTS "FacilityMember_facilityId_idx";
DROP INDEX IF EXISTS "FacilityMember_userId_key";
DROP TABLE IF EXISTS "FacilityMember";
DROP INDEX IF EXISTS "FacilityInvite_email_idx";
DROP INDEX IF EXISTS "FacilityInvite_facilityId_idx";
DROP INDEX IF EXISTS "FacilityInvite_tokenHash_key";
DROP TABLE IF EXISTS "FacilityInvite";
DROP TYPE IF EXISTS "FacilityRole";

CREATE TYPE "FacilityRole" AS ENUM ('owner', 'staff');

-- ── FacilityMember ─────────────────────────────────────────────────────
CREATE TABLE "FacilityMember" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "role"       "FacilityRole" NOT NULL DEFAULT 'staff',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityMember_pkey" PRIMARY KEY ("id")
);

-- A user belongs to at most one facility — DB-level, not app-level.
CREATE UNIQUE INDEX "FacilityMember_userId_key" ON "FacilityMember"("userId");
CREATE INDEX "FacilityMember_facilityId_idx" ON "FacilityMember"("facilityId");

ALTER TABLE "FacilityMember"
    ADD CONSTRAINT "FacilityMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FacilityMember"
    ADD CONSTRAINT "FacilityMember_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── FacilityInvite ─────────────────────────────────────────────────────
CREATE TABLE "FacilityInvite" (
    "id"         TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "role"       "FacilityRole" NOT NULL DEFAULT 'staff',
    "tokenHash"  TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityInvite_pkey" PRIMARY KEY ("id")
);

-- tokenHash is the only form of the invite token ever stored.
CREATE UNIQUE INDEX "FacilityInvite_tokenHash_key" ON "FacilityInvite"("tokenHash");
CREATE INDEX "FacilityInvite_facilityId_idx" ON "FacilityInvite"("facilityId");
CREATE INDEX "FacilityInvite_email_idx" ON "FacilityInvite"("email");

ALTER TABLE "FacilityInvite"
    ADD CONSTRAINT "FacilityInvite_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Backfill: existing 1:1 links become owners ─────────────────────────
-- Every pre-existing FacilityProfile row keeps its login as the facility's
-- owner. createdAt is copied from the profile so membership predates (or at
-- least matches) the facility itself in any audit trail.
INSERT INTO "FacilityMember" ("id", "userId", "facilityId", "role", "createdAt")
SELECT
    gen_random_uuid()::text,
    "FacilityProfile"."userId",
    "FacilityProfile"."id",
    'owner'::"FacilityRole",
    "FacilityProfile"."createdAt"
FROM "FacilityProfile";
