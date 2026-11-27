-- Close issue #5 deviation-a: add an immutable intake snapshot to Referral
-- (ARCHITECTURE.md §4.4). The column is a nullable AES-256-GCM encrypted
-- TEXT field, written once at referral creation from the patient's most-recent
-- IntakeForm. It is never updated by reassign, cancel, or cascade operations —
-- only creation writes it. Null means the patient had no intake form at the
-- time of referral (issue #2 enforcement is still deferred).

ALTER TABLE "Referral" ADD COLUMN "snapshotIntake" TEXT;
