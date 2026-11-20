Phase 2: consultation note sign-off with append-only addenda
([issue #64](https://github.com/DocForum/docforum-core/issues/64)).
Adds `Consultation.signedAt`; notes are editable only while unsigned, enforced
by a conditional UPDATE and a DB trigger, then corrections are append-only
`ConsultationAddendum` rows. Adds an RLS UPDATE policy for the note workflow
(the RLS migration previously only had SELECT/INSERT on `Consultation`) and an
hourly auto sign-off sweep.
