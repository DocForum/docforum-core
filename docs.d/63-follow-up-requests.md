---
file: ARCHITECTURE.md
section: 4.3 Consultation
---
**Phase 2, issue #63 — follow-up requests (implemented 2026-11-20).**
```
FollowUpRequest
  id, consultation_id (FK, UNIQUE — one per consultation)
  doctor_profile_id, patient_profile_id (FKs, RESTRICT)
  notes_snapshot [ENCRYPTED copy, never a live pointer]
  intake_form_id (nullable; latest intake at creation — Appointment has no
    intake FK yet, issue #2, so the request carries the link)
  window_start, window_end, status (open|booked|expired)
  booked_appointment_id (FK, UNIQUE)
```
Closing a consultation with `follow_up_needed` creates the request in the same
transaction, defaulting the window to now → now +
`CONSULTATION_FOLLOW_UP_WINDOW_DAYS` (14) unless the doctor supplies both
bounds. `GET /follow-ups/mine` lists the patient's own requests (expired ones
stay visible; snapshots decrypted) and `POST /follow-ups/:id/book` books one.
The booking uses `appointmentsService.bookForFollowUp`, which claims the slot
through the same conditional `UPDATE ... WHERE status = 'open'` as a direct
booking (hard rule 2) and creates an appointment with origin `follow_up`;
`FollowUpRequest` is claimed with its own conditional UPDATE first, so two
concurrent accepts produce exactly one appointment and one `409`. An
interval sweep (`src/jobs/follow-up-expiry.ts`) moves unbooked requests past
`window_end` to `expired` in one conditional UPDATE.
