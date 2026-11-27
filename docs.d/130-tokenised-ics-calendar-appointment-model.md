---
file: ARCHITECTURE.md
section: 4.2 Availability & Appointments
---
#### Issue #130 — Tokenised doctor calendar feeds

`Appointment.calendarStartTime` and `calendarEndTime` snapshot the latest
booked slot times, are updated atomically when rescheduled, and survive slot
release on cancellation so the ICS feed can emit `STATUS:CANCELLED`. The
token-authenticated `GET /calendar/:token.ics` selects only the appointment
ID, status, times and update timestamp; it never reads patient identity,
intake or clinical notes.
