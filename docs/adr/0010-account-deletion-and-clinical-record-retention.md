# ADR 0010: Patient account deletion anonymises identity and retains clinical, order and payment records

Status: Proposed (issue #41). Becomes Accepted when the implementing PR merges.

## Context

A patient must be able to delete their account (PRD §5: the architecture
must not preclude NDPR/GDPR, and erasure is the request after access, #40).
But the records that hang off a patient are not only the patient's:

- an `Appointment` is part of a doctor's calendar and clinical history;
- a `PaymentIntent` is a financial record whose on-chain escrow
  (`stellarTxHash`, `escrowId`) is immutable and must stay reconcilable;
- PRD §7 makes orders append-only "for legal and clinical safety", and
  requires every state transition on clinical records to stay attributable.

Before this ADR, the only deletion semantics in the schema were the foreign
keys' `ON DELETE` actions. Inventory, taken from the committed migrations
(not assumed):

| FK | ON DELETE (before) | Effect of deleting a patient's `User` row |
|---|---|---|
| `PatientProfile.userId → User` | **CASCADE** | Deletes the profile, the clinical identity anchor, whenever nothing RESTRICTs it, and fails with a raw FK error when something does |
| `EmailVerificationToken.userId → User` | CASCADE | Tokens go with the user (fine) |
| `Appointment.patientProfileId → PatientProfile` | RESTRICT (Prisma default) | Blocks the cascade above, so the delete errors out |
| `PaymentIntent.patientProfileId → PatientProfile` | RESTRICT (Prisma default) | Same |
| `DoctorProfile.userId → User`, `FacilityProfile.userId → User` | CASCADE | Not patient data. Their clinical/payment references (`Appointment.doctorProfileId`, `PaymentIntent.facilityId`) are already RESTRICT, so a cascade there can fail but can't destroy history |
| `AvailabilitySlot → DoctorProfile`, `DoctorSpecialty → *`, `FacilityCapability → FacilityProfile`, `WalletLink → FacilityProfile` | CASCADE | Operational rows of doctors/facilities. A booked slot is protected by `Appointment.availabilitySlotId` (RESTRICT) |
| `Appointment.availabilitySlotId → AvailabilitySlot`, `Appointment.doctorProfileId → DoctorProfile`, `PaymentIntent.facilityId → FacilityProfile` | RESTRICT | Already protective |

Models that reference `PatientProfile` and landed on `main` after this
inventory was first taken (re-checked when rebasing this PR):

| FK | ON DELETE | Treatment |
|---|---|---|
| `Referral.patientProfileId → PatientProfile` | RESTRICT (Prisma default) | Clinical record — retention hold `referrals` |
| `Prescription.patientProfileId`, `LabOrder.patientProfileId → PatientProfile` | RESTRICT (Prisma default) | Append-only orders — retention hold `orders` |
| `AccessLog.patientProfileId → PatientProfile` (issue #45) | CASCADE | Audit of who viewed the record — retention hold `access_logs` (below) |
| `PatientExport.patientProfileId → PatientProfile` (issue #40) | CASCADE | Derived copy — deleted at anonymisation |

`IntakeForm`, `Consultation`, `LabResult` and `FulfillmentRecord` reach the
patient through an appointment or an order rather than their own patient
foreign key, so the holds above already cover them. Anything that later
gains a direct patient FK is covered by the rule in the retention table.

No repository document establishes a **legal retention period** for
clinical, order or payment records after an account is deleted (PRD §5 puts
the full compliance programme out of scope). This ADR does not invent one.
That decision was confirmed with the maintainer before implementation (see
"Open decision" below).

## Decision

**Deleting a patient account anonymises the identity in place. It never
deletes the `User` or `PatientProfile` row while any clinical, order or
payment record references them.** Clinical, order and payment records are
kept intact and keep their foreign keys, so a doctor still sees "this
appointment happened", an auditor can still reconcile a payment against
its escrow, and nothing in them is rewritten. They just no longer lead to
a person.

### Retention table

| Model / data | At `DELETE /patients/me` | Retained for | Rationale |
|---|---|---|---|
| `User.email` | **Anonymised** to `deleted+<userId>@deleted.invalid` | until purged (below) | Frees the address: the unique index no longer blocks a future signup with it. `.invalid` is reserved (RFC 2606), so it can never deliver mail. Derived from the id, so it's unique and identical on every retry. |
| `User.phone` | **Deleted** (set null) | — | PII, no retention purpose. |
| `User.passwordHash` | **Replaced** with a bcrypt hash of 32 random bytes nobody knows | — | Login is impossible even if someone learned the tombstone address. Still a well-formed hash, so the login path's timing stays uniform. |
| `User.emailVerifiedAt` | **Cleared** | — | The address is gone. This also makes the existing `requireVerifiedEmail` guard refuse booking/payment mutations immediately, for an access token that's still inside its 15-minute TTL. |
| `User.deletedAt` (new) | **Set** | permanent | Irreversible marker. Refresh is refused once it's set, it makes repeat requests a no-op, and it's the purge clock. Kept distinct from admin deactivation (#39 / PR #141), which is reversible. |
| `User.role`, `User.id`, `createdAt` | Retained | while the row exists | Not identifying on their own. The id is what clinical rows ultimately join to. |
| `PatientProfile.fullName` | **Anonymised** to `Deleted patient` | — | What a doctor's appointment list shows from now on. |
| `PatientProfile.dateOfBirth` | **Deleted** (null) | — | PII. |
| `PatientProfile.guardianUserId` | — | — | Column dropped by issue #42 (ADR 0011), replaced by `Guardianship`. |
| `Guardianship` rows where the deleted user is the guardian (issue #42) | **Revoked** (`revokedAt` set), retained | while the tombstone exists | Access to a minor's profile ends with the account; the rows are the record of who had it. Retention hold `guardianships`. The dependents' own profiles and records are untouched. |
| `PatientProfile.anonymizedAt` (new) | **Set** | permanent | Owned by the patients module. Every patient route resolves the caller's profile through `getMyPatientProfile`, which refuses an anonymised profile, so booking, listing and repeat deletion stop working immediately. |
| `PatientProfile.id` | Retained | while any record references it | The link that keeps appointments/payments attached without any PII. |
| `EmailVerificationToken` (all of the user's) | **Deleted** | — | Bookkeeping tied to the old address. |
| `LoginAttempt` bucket keyed by the old normalised email | **Deleted** | — | It *is* the email address. IP-keyed buckets aren't tied to the account and keep their existing 24 h prune. |
| `Appointment` | **Retained unchanged** | **Indefinitely. Legal period is an open decision** | Clinical record, and part of the doctor's history. FK stays RESTRICT. |
| `PaymentIntent` | **Retained unchanged** | **Indefinitely. Legal period is an open decision** | Financial record; the escrow on-chain is immutable regardless. FK stays RESTRICT. |
| `Referral`, `Prescription`(+items), `LabOrder`(+`LabResult`) | **Retained unchanged** | **Indefinitely. Open decision** | Hard rules 1/3: orders and referral snapshots are immutable. Patient FK is RESTRICT; retention holds `referrals` and `orders`. |
| Future clinical/order rows (`IntakeForm`, `Consultation`, `FulfillmentRecord`, if they gain a direct patient FK) | **Retained unchanged** | **Indefinitely. Open decision** | **Rule for whoever builds them:** their patient FK must be `onDelete: Restrict`, and they must be added to the purge's retention holds (`src/retention-holds.ts`). |
| `AccessLog` rows about the patient (issue #45) | **Retained unchanged** | `ACCESS_LOG_RETENTION_DAYS`, then pruned by its own job | The audit trail of who read the record. Its FK cascades, so the purge holds (`access_logs`) until the access-log prune has removed them, instead of erasing them with the profile. |
| `PatientExport` (+chunks) (issue #40) | **Deleted at anonymisation**, in the same transaction | — | Derived copies, not records of care. An export mid-generation loses its row, so it can never publish. |
| Notifications / other copies of patient data (future) | **Deleted at anonymisation** | — | Derived copies, not records of care. |

### What it does to related records

Nothing is cascaded. Appointments and payment intents keep pointing at the
same `PatientProfile.id`. Doctors see `Deleted patient` in place of a name.
The escrow and its tx hash stay reconcilable. Free-text clinical content
written in the future (intake notes, consultation notes) is **not**
rewritten. It's a clinical record, and editing it would break the
append-only rules. If such text names the patient, that's residual personal
data in the clinical record, which retention law typically permits, and it's
listed under open decisions.

### Schema change

`PatientProfile.userId → User` becomes **`ON DELETE RESTRICT`**. Hard-deleting
a patient's `User` row is no longer a way anything can happen. Anonymisation
is the path, and an accidental `DELETE FROM "User"` fails loudly instead of
taking the clinical identity anchor with it.
`Appointment.patientProfileId` and `PaymentIntent.patientProfileId` are
already RESTRICT; they're now written as explicit `onDelete: Restrict` in
`schema.prisma` so the intent can't be lost to a default changing. Doctor
and facility cascades are deliberately not changed: no deletion flow exists
for those roles, their clinical/payment references are already RESTRICT,
and changing them is a separate decision for whoever designs those flows.

### Scheduled purge

An interval job (`src/jobs/account-purge.ts`; plain interval, per
ARCHITECTURE_ESSENTIALS) hard-deletes **tombstones only**: an anonymised
patient whose profile has no retained records (no appointment, payment
intent, prescription, lab order, referral or access-log row, checked through
each module's service via `src/retention-holds.ts`),
once `ACCOUNT_PURGE_GRACE_HOURS` (default 24) has passed since deletion.
The grace period is operational, not legal. It lets requests already in
flight under a still-valid access token finish before the row disappears.

- It never deletes clinical/order/payment rows. With the retention period
  open, nothing it could delete is a record of care.
- It is race-safe. Holds are checked first, and the delete itself is
  backstopped by the RESTRICT foreign keys, so a record that appeared
  between the check and the delete makes the delete fail. That account is
  skipped, never cascaded.
- It is idempotent. It works only on rows where `anonymizedAt`/`deletedAt`
  are already set, and re-running it finds nothing new.
- Logs carry counts and error types only, never ids paired with personal
  fields, and never error messages.

When a legal retention period is decided, the purge is where it goes: a
per-category age check before a record type stops counting as a hold. That
is a follow-up, not something this ADR pre-builds.

## Open decision (not resolved here)

- **How long clinical, order and payment records are kept after deletion**,
  per jurisdiction (e.g. NDPR in Nigeria; medical-record retention rules).
  Until it's decided they're kept indefinitely, which is the
  safe direction for clinical safety and the reversible one: a record kept
  too long can still be deleted later, a record deleted too early can't be
  recovered. Confirmed with the maintainer for #41.
- Residual personal data inside clinical free text (above).

## Consequences

- `DELETE /patients/me` requires the current password. A failed confirmation
  counts against the account's login-throttle bucket, so a stolen access
  token can't be used to brute-force the password through this route.
- Access tokens are stateless JWTs with a 15-minute TTL, and there's no
  revocation list (issue #18). After deletion the token still passes
  `authenticate` until it expires, but every patient route refuses it
  (anonymised profile), booking/payments refuse it (no verified email), and
  refresh refuses the session (`deletedAt`). Nothing personal is reachable
  through it.
- Anonymisation is irreversible. There's no undo and no "restore my
  account". The old address can sign up again as a brand-new, empty account.
