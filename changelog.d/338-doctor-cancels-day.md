Phase 2: a doctor can cancel the rest of a day in one call
([issue #338](https://github.com/DocForum/docforum-core/issues/338)).
`POST /appointments/doctor/cancel-day` with `{ date, reason? }` (the date in
the doctor's time zone; `reason` is a code: illness, emergency, personal, other) cancels every scheduled appointment of that day that
has not started yet through `applyScheduledTransition` (one transaction each,
so slots are released and referral cascades fire), then closes the day's
remaining future open slots so nothing new can be booked. A booking racing the
call is cancelled by a second pass. Returns
`{ date, cancelled, slotsClosed, failures, appointmentIds }`. Integration tests
in `appointment-cancel-day-and-audit.test.mts` (port 5491) cover the day
cancel, past appointments left alone, another doctor untouched, a racing
booking, date validation and role checks.
