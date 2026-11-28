---
file: ARCHITECTURE.md
section: 4.2 Availability & Appointments
---
ClosurePeriod (Phase 2, issue #131 — admin-managed closure calendar)
  id, version (int, default 1 — If-Match guarded, §5.4),
  scope (enum: platform|facility),
  facility_profile_id (nullable FK -> FacilityProfile, ON DELETE CASCADE),
  start_date, end_date (inclusive DATE range), time_zone (IANA, default UTC),
  reason (short operational text; never patient data), created_at, updated_at
  # DB CHECKs: (scope='platform' <=> facility_profile_id IS NULL) and
  # start_date <= end_date, so a row cannot contradict itself.
  # A closure is an ALL-DAY span: the inclusive range is read in `time_zone` and
  # converted once into a half-open UTC instant window (23h/25h across a DST
  # transition), never "midnight UTC on whatever day the server is in".
  # Applying it on create/update is one conditional DELETE of slots with
  # status='open' AND no appointment inside the window; booked appointments are
  # REPORTED (appointment id, doctor id, start time) and never cancelled —
  # cancellation stays in the appointments flows, where the referral cascade and
  # the audit trail live. A second sweep catches a booking that commits between
  # the DELETE and the report (same shape as the doctor cancel-day sweep, #338).
  # Slot generation skips the window (`skippedClosed` in the response) and
  # GET /availability/doctors/:id/slots filters it out, so a slot released after
  # the closure existed is not listed either. Booking by slot id is unchanged:
  # the hot path stays one conditional UPDATE (hard rule 2).
  # v1 scope limit: a platform closure blocks every doctor's calendar; a facility
  # closure is stored, audited and listed but blocks none, because
  # AvailabilitySlot carries no facility (one calendar per doctor, §8 deferral).
  # That is the single predicate to change when multi-facility doctors land.
