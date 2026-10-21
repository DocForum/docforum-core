# ADR 0009: Consultation is close-once, enforced by a unique appointment FK

Status: Accepted
Date: 2026-10-20

## Context

Phase 2, issue #4 — "`Consultation` record + outcome
(`resolved | referred | follow_up_needed`)". The `Consultation` table has
existed since the Phase 0 scaffold as `(id, outcome?, notes?, createdAt)` with
nothing relating it to an appointment, and nothing ever wrote to it.

The decisions that need recording are not really about columns:

1. **How is "a consultation can only be closed once" enforced?** The repo
   already has one precedent for this class of guarantee — booking (§5.1) is
   settled by a DB-level conditional `UPDATE`, not by a read-then-write check,
   because "check then write" is the exact bug class the architecture was
   built to avoid (ARCHITECTURE_ESSENTIALS.md hard rule).
2. **What does "closed" mean for the record?** A consultation is a clinical
   record of what happened. `Prescription`/`LabOrder` are explicitly
   never-mutated-after-issuance with corrections as new rows; consultation
   notes are the same category of data.
3. **Do amendments exist in v1?** PRD §8 leaves "can a consultation be
   corrected/amended" unresolved. The tempting move is to add
   `supersedes_consultation_id` "just in case". That would be inventing a
   resolution to an open question.

## Decision

- **`Consultation.appointmentId` is a `NOT NULL`, `UNIQUE` FK to
  `Appointment`** (`ON DELETE RESTRICT` — a clinical record must not
  disappear as a cascade side effect of an appointment row; the same rule
  `Prescription`/`LabOrder` already follow). The unique index *is* the
  close-once guarantee: two concurrent closes both reach the INSERT, exactly
  one commits, the loser gets Prisma `P2002` → `409`. There is deliberately
  no read-then-write pre-check in the service; the constraint is what makes
  it safe, so the code has nothing to get wrong.
- **`outcome` is nullable in the schema, required at the close routes**
  (`resolved | referred | follow_up_needed`, PRD FR-6). Phase 3's referral
  slice opened `POST /consultations` with `outcome` optional so a record can
  exist before sign-off; a **closed** record still always carries an outcome
  because `closeConsultationSchema` requires it. `notes` stays nullable,
  capped at 20k chars at the API boundary.
- **`notes` is encrypted on write** with the existing AES-256-GCM field
  encryption (issue #46) and decrypted only for the caller who just wrote it.
  ARCHITECTURE.md §2/§4.3 already list `Consultation.notes` as an encrypted
  clinical field; this is the first write path, so it sets the precedent
  rather than starting a plaintext one. Consequence: the column is
  unsearchable by design, and environments must set
  `FIELD_ENCRYPTION_KEY_V1`.
- **One writer, three addresses.** `consultationsService.createConsultation`
  is the only code that inserts this row; `POST /consultations`,
  `POST /appointments/:id/consultation` and the orders flow's consultation
  step all delegate to it, so none of them can bypass the uniqueness,
  encryption or audit rules. A consultation is recorded only against a
  `completed` appointment the caller owns.
- **No amendment path in v1.** Closing twice is a `409`, full stop. When the
  amendment question is actually answered (Phase 3 referral/consultation
  work), the answer should be a new, reviewed migration — for example an
  append-only history keyed by `supersedes_*` — not a quiet relaxation of the
  unique constraint.
- **Access is doctor-only, own-appointment-only.** The consultations module
  never queries `Appointment`; it asks
  `appointmentsService.getAppointmentForDoctor(userId, appointmentId)`, which
  returns `null` for someone else's appointment. The route answers `404` for
  both "doesn't exist" and "not yours", so it never confirms the existence of
  another doctor's appointment. This mirrors §5.1's rule and AGENTS.md hard
  rule 4 (no cross-module repository imports).
- **Every close writes a `consultation.closed` audit event in the same
  transaction** (issue #43), with `metadata: { appointmentId }` — never the
  notes, which are PHI.

## Consequences

- The guarantee survives races and process crashes; there is no window where
  two consultations exist for one appointment.
- Deleting an appointment that has a consultation is refused by the FK
  (`RESTRICT`), matching the rest of the Phase 1 model (nothing clinical is
  user-deletable yet). That is re-examined when the account-purge/retention
  work lands, since a clinical record with retention rules should not
  disappear as a cascade side effect.
- The encrypted `notes` column cannot back search, sorting or reporting. A
  future "search my consultations" feature must decrypt in the app layer or
  maintain a separate index — accepted, documented in §4.3.
- If `FIELD_ENCRYPTION_KEY_V1` is missing, closing a consultation fails loudly
  (`500`) with the util's own "key not configured" error instead of silently
  storing plaintext PHI. There is no fallback-to-plaintext path and there must
  not be one.
- The column, unique index and FK are created by
  `20261020000000_order_payment_intents` (issue #9, before this feature had a
  writer). That migration assumes the scaffold `Consultation` table is empty
  and fails loudly rather than backfilling an invented appointment.

## Alternatives considered

- **Check-then-write in the service only.** Rejected: the exact bug class
  (two requests pass the check, both insert) the architecture exists to
  prevent.
- **`status` enum on `Consultation` (`open | closed`) instead of create-on-
  close.** Rejected for v1: there is no "open consultation" state to model —
  the appointment is the thing that exists before the visit; a consultation is
  created when it is closed. Adding an `open` state now would be modelling a
  flow (intake → in-progress notes → close) that Phase 2 hasn't designed.
- **Nullable `appointmentId` + `supersedes_consultation_id` for amendments.**
  Rejected: it resolves an open PRD question by accident, and a nullable
  unique FK would allow orphan consultations.
