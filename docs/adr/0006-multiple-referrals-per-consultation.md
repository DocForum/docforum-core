# ADR 0006: One consultation may spawn several referrals — created atomically, living independently

Status: Accepted

## Context

PRD §8.2.4 asks whether a single `Consultation` can produce more than one
referral — "see both cardiology and endocrinology" is a normal real-world
outcome of one visit, and refusing it would push doctors into recording
fake consultations to route a patient twice.

Answering "yes" immediately raises three further questions that the
implementation (#66) had to settle, not merely obey:

1. **Bundle or independent rows?** If the two referrals share one
   lifecycle, the patient's decisions are coupled: declining cardiology
   would decline endocrinology too, which is clinically wrong — the two
   recommendations are independent judgements that merely share a birth
   event.
2. **Partial failure.** If the second target fails validation (say, an
   unverified doctor), does the first referral survive? A half-created
   bundle misrepresents what the referring doctor actually decided.
3. **Duplicate targets.** Nothing stops a doctor from accidentally
   listing the same specialty twice, or re-referring a target they
   already referred from that consultation a moment earlier.

The snapshot rule (ARCHITECTURE_ESSENTIALS.md hard rule 3) also has to
keep holding per referral: two referrals from one consultation are two
rows with two note copies, never two FKs into one shared blob.

## Decision

**Allowed, as independently-lived referrals born in an atomic batch.**

- `POST /referrals/from-consultation/:consultationId` (equivalently
  `POST /consultations/:consultationId/referrals`) takes
  `{ targets: [{ targetDoctorId, targetSpecialtyId?, snapshotNotes }] }`
  and creates every referral in **one transaction** — all or none.
- Each referral is a normal `Referral` row: its own `snapshotNotes`
  copy, its own status from `pending`, its own accept/decline, its own
  cascade, its own loop lineage and its own admin-queue presence. There
  is no bundle entity and no cross-referral state machine.
- The **patient-facing list** (`GET /referrals/mine`) groups the rows by
  `sourceConsultationId` (`groupedByConsultation`) purely as a
  presentation affordance, so the "one visit, several referrals" story
  is visible without inventing a lifecycle to attach it to.
- Guards at creation: a target doctor or specialty may appear **at most
  once** in a batch, and may not duplicate a referral that already exists
  for that consultation. Violations fail the whole batch.

## Why

- **Independent lifecycles match the clinical reality.** The patient
  deciding about cardiology has no bearing on their decision about
  endocrinology. Coupling them would create a state machine whose
  transitions nobody asked for.
- **Atomicity preserves the doctor's intent.** A batch is a single
  decision ("work this patient up for these two things"); a partially
  applied batch is a decision the doctor never made. All-or-none is also
  the only behaviour that composes with the loop guard's per-referral
  lineage walk — a surviving first referral would have lineage the
  doctor never intended to start.
- **The boring shape wins.** Reusing the existing `Referral` row and
  status machine means the cascade (#67), the loop guard (#65), the admin
  overrides (#68) and the expiry path (#8, when built) all apply to
  multi-referral patients for free, instead of needing a second
  implementation that handles "bundles".
- **Rejected: a `ReferralBundle` table.** It would add a join table and
  a second identifier to every downstream flow to express a grouping
  that only the patient list view actually needs — and that view can
  group by `sourceConsultationId` without any new schema.

## Consequences

- A referral's identity stays a single UUID everywhere: cascade hooks,
  audit events, admin actions and the eventual expiry job are all
  bundle-blind.
- "One consultation, N referrals" means `sourceConsultationId` is not
  unique — anything that assumed one-referral-per-consultation must not
  key on it (the duplicate-target check at creation is the enforcement
  point).
- Loop detection runs per referral against each one's own ancestor
  chain; two siblings in a batch are not each other's ancestors, so a
  batch can legitimately contain two referrals that would have been
  flagged had one led to the other.
- If a grouped lifecycle is ever genuinely needed (e.g. "recall the
  patient once all of a workup's referrals are completed"), that is new
  scope and needs its own decision — this ADR does not pre-commit to it.
