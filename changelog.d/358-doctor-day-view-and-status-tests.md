Phase 2: integration tests for the doctor's day view and status transitions
([issue #358](https://github.com/DocForum/docforum-core/issues/358)).
`backend/tests/integration/doctor-day-view-and-status-transitions.test.mts`
(real Postgres) pins `GET /appointments/doctor/today` — own
appointments only, ordering by slot start, the calendar day taken from the
doctor's `timeZone`, scheduled-only, doctor-only — and every legal and illegal
`PATCH /appointments/:id/status` transition, including a three-way concurrent
race where exactly one request wins. The suite fakes the clock
(`vi.useFakeTimers({ toFake: ['Date'] })`) so it cannot flake near midnight UTC.
`docs/api/README.md` still described `/doctor/today` as the server-local day
after issue #290 changed it; that row is corrected in place. No behaviour
changed.
