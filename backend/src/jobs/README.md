# jobs

Background jobs (reminders, order-expiry checks, notification delivery).

Per ARCHITECTURE_ESSENTIALS.md: keep this simple (cron/interval) until a
real job exists — do not introduce a queue (e.g. BullMQ/Redis) preemptively.
See ARCHITECTURE.md §6.3.2 for the overengineering flag on this exact point.

## Implemented

- `consultation-auto-sign-off.ts` (Phase 2 #64) — periodically signs off
  consultation notes that have been left editable past
  `CONSULTATION_AUTO_SIGNOFF_HOURS`. A plain `setInterval`, started from
  `src/server.ts` (not `app.ts`, so importing the app in a test never starts
  a timer). The window is measured from `Consultation.createdAt` because the
  appointment link isn't modelled yet — see the note in the service.

Still to come: reminders and order-expiry checks (Phases 4/6). Not scoped
into an issue yet.
