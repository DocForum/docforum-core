-- Migration: add_facility_member_and_invite
-- Adds FacilityMember and FacilityInvite models,
-- migrates existing 1:1 FacilityProfile/User links to FacilityMember with role=owner.
-- Reversible: drops new tables and restores FacilityProfile.userId @unique.

-- ── Create FacilityRole enum type ───────────────────────────────────────
CREATE TYPE "FacilityRole" AS ENUM ('owner', 'staff');

-- ── Create FacilityMember ──────────────────────────────────────────────
CREATE TABLE "FacilityMember" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "userId"      TEXT NOT NULL UNIQUE,
    "facilityId"  TEXT NOT NULL,
    "role"        "FacilityRole" NOT NULL DEFAULT 'staff',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT NOW(),

    "user"        TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "facility"    TEXT NOT NULL REFERENCES "FacilityProfile"(id) ON DELETE CASCADE
);

-- Create index for the unique constraint (explicit, though @@unique in Prisma
-- creates one; kept here for clarity and reversible migration).
CREATE UNIQUE INDEX "FacilityMember_userId_key" ON "FacilityMember"("userId");

-- Add foreign key constraint explicitly if not already handled by Prisma.
-- (Prisma's `@relation` with `onDelete: Cascade` will be enforced by the DB trigger.)

-- ── Create FacilityInvite ──────────────────────────────────────────────
CREATE TABLE "FacilityInvite" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "facilityId"  TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "role"        "FacilityRole" NOT NULL DEFAULT 'staff',
    "tokenHash"   TEXT NOT NULL UNIQUE,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "consumedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT NOW(),

    "facility"    TEXT NOT NULL REFERENCES "FacilityProfile"(id) ON DELETE CASCADE
);

-- Create indexes for lookup by facility and email/token.
CREATE INDEX "FacilityInvite_facilityId_idx" ON "FacilityInvite"("facilityId");
CREATE INDEX "FacilityInvite_email_idx" ON "FacilityInvite"("email");

-- ── Migrate existing 1:1 FacilityProfile/User links to FacilityMember ─
-- Every existing FacilityProfile row becomes a FacilityMember with role=owner,
-- preserving the original facility login attribution.
INSERT INTO "FacilityMember" ("id", "userId", "facilityId", "role", "createdAt")
SELECT
    gen_random_uuid(),
    "FacilityProfile"."userId",
    "FacilityProfile"."id",
    'owner'::"FacilityRole",
    "FacilityProfile"."createdAt"
FROM "FacilityProfile";

-- ── Reverse (down) migration ─────────────────────────────────────────
-- Drop tables and restore FacilityProfile.userId @unique.

DELETE FROM "FacilityMember";
DELETE FROM "FacilityInvite";

-- Restore the original unique constraint on FacilityProfile.userId.
-- Note: this re-creates the constraint; if data violates it the migration will fail.
CREATE UNIQUE INDEX "FacilityProfile_userId_key" ON "FacilityProfile"("userId");

DROP TABLE "FacilityInvite";
DROP TABLE "FacilityMember";