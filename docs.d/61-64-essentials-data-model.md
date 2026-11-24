---
file: ARCHITECTURE_ESSENTIALS.md
section: Data model map (see ARCHITECTURE.md §4 for full field lists)
---
`Consultation` (Phase 2, issues #61/#64) → `ConsultationMessage` (append-only,
encrypted body) → `ConsultationMessageAttachment` (object storage; access-checked
short-lived signed URLs), and → `ConsultationAddendum` (append-only, only after
`Consultation.signedAt` is set). `Consultation` → `FollowUpRequest` (issue #63;
one per consultation, immutable encrypted note snapshot, `open|booked|expired`,
`bookedAppointmentId`) → `Appointment` with origin `follow_up`.
