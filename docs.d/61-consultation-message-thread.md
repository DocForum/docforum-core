---
file: ARCHITECTURE.md
section: 4.3 Consultation
---
**Phase 2, issue #61 — async message thread (implemented 2026-11-20).**
```
ConsultationMessage
  id, consultation_id (FK -> Consultation, RESTRICT)
  sender_user_id (FK -> User, RESTRICT)
  sender_role (enum: patient|doctor)   # recorded at write time
  body [ENCRYPTED — same envelope as Consultation.notes]
  created_at
  @@index([consultation_id, created_at, id])   # keyset pagination
```
Append-only: a DB trigger rejects UPDATE/DELETE/TRUNCATE, so a mistaken
message is corrected by another message, never edited. Writers and readers are
exactly the underlying appointment's patient and treating doctor
(`consultationsService.resolveThreadContext`); a specialist who receives a new
referral gets that referral's thread and never the earlier one, because
membership is derived from each consultation's own appointment. Reads and
writes use the module's service, never the table.

`POST /consultations/:id/messages` appends (verified email required);
`GET /consultations/:id/messages?cursor=&limit=` pages oldest-first by
`(created_at, id)`. A thread stops accepting messages
`CONSULTATION_THREAD_CLOSE_AFTER_DAYS` (default 7) after `Consultation.createdAt`
— the close moment used as the completion anchor until `Appointment.completedAt`
exists; late writes get `409 CONSULTATION_THREAD_CLOSED`. Each append writes a
`consultation.message_sent` audit event and an outbox event
(`consultation.message.created`, payload carries the recipient user id, null for
a dependent profile) in the same transaction — that outbox row is the Phase 6
notification hook point.
