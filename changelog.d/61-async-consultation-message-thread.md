Phase 2: async consultation message thread
([issue #61](https://github.com/DocForum/docforum-core/issues/61)).
Adds an append-only `ConsultationMessage` (encrypted body) with cursor
pagination, participant-only read/write derived from the consultation's
appointment, a configurable closing window, and a `consultation.message.created`
outbox event as the Phase 6 notification hook. Messages and addenda are
append-only at the DB level.
