---
file: ROADMAP.md
section: Phase 2 — Intake, appointments, consultations
---
- [x] Async consultation message thread between the patient and treating
  doctor ([issue #61](https://github.com/DocForum/docforum-core/issues/61)).
  Append-only `ConsultationMessage` with an encrypted body, cursor pagination,
  participant-only access, a configurable closing window and a notification
  outbox hook.
- [x] Message attachments with access-checked, short-lived download URLs
  ([issue #62](https://github.com/DocForum/docforum-core/issues/62)). JPEG/PNG/PDF
  only with byte sniffing, EXIF/GPS stripping, per-user quota, signed URLs.
- [x] Follow-up outcome creates a pre-filled follow-up booking request
  ([issue #63](https://github.com/DocForum/docforum-core/issues/63)).
  `FollowUpRequest` + immutable note snapshot, booking through the standard
  conditional slot claim with origin `follow_up`, expiry sweep.
- [x] Consultation note sign-off with append-only addenda
  ([issue #64](https://github.com/DocForum/docforum-core/issues/64)).
  `signedAt`, DB-level immutability after sign-off, `ConsultationAddendum`,
  auto sign-off sweep.
