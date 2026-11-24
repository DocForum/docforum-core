---
file: ARCHITECTURE.md
section: 4.2 Availability & Appointments
---
  # Partial unique index on (patient_profile_id, doctor_profile_id, specialty_id)
  # NULLS NOT DISTINCT where status in ('pending', 'on_hold') ensures active entries
  # are deduplicated at the DB level while allowing re-entry once accepted or expired.
