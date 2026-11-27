-- Check for existing overlapping slots before creating constraint (issue #287)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AvailabilitySlot" a
    JOIN "AvailabilitySlot" b
      ON a."doctorProfileId" = b."doctorProfileId"
      AND a."id" <> b."id"
      AND tsrange(a."startTime", a."endTime") && tsrange(b."startTime", b."endTime")
  ) THEN
    RAISE EXCEPTION 'Cannot add exclusion constraint: overlapping AvailabilitySlot rows exist';
  END IF;
END $$;

-- Enable btree_gist extension required for mixing scalar and range columns in EXCLUDE constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Enforce doctor slots non-overlapping exclusion constraint
ALTER TABLE "AvailabilitySlot"
  ADD CONSTRAINT "AvailabilitySlot_doctor_no_overlap_excl"
  EXCLUDE USING gist (
    "doctorProfileId" WITH =,
    tsrange("startTime", "endTime") WITH &&
  );
