# ADR 0011: Dependents are guardian-owned patient profiles, created (never linked) by the guardian; access ends at the age of majority

Status: Proposed (issue #42). Becomes Accepted when the implementing PR merges.

## Context

PRD §8.2.5 lists "minor/dependent patients — booking on behalf of a child or
dependent; consent and account ownership model undefined" as an open edge
case. The Phase 1 schema has a placeholder for it,
`PatientProfile.guardianUserId`: a nullable string with no foreign key and a
comment saying not to build on it. Repository check: no code reads or writes
it, so there's no existing data model to preserve.

Today a `PatientProfile` is 1:1 with a login (`userId` required and unique),
and booking always books for the caller's own profile
(`appointments/services` `bookSlot`).

Paediatric visits are a large share of hospital care, so the product needs a
real ownership model before launch. Two shapes were considered:

1. **Guardian-owned dependent profiles.** A dependent is a `PatientProfile`
   with no login of its own, owned by the guardian through an explicit
   guardianship relation.
2. **Separate accounts, linked later.** The dependent has their own `User`,
   and a guardian link needs consent from both sides.

Option 2 is a poor fit for young children, who don't have an email address
or a password. Worse, a "link to an existing patient" operation is exactly
the kind of request that lets one user reach another person's records. It
needs identity proofing this platform doesn't have.

The model choice and the age-of-majority behaviour were confirmed with the
maintainer before implementation.

## Decision

### Ownership and representation

- A **dependent** is a `PatientProfile` whose `userId` is **null**. It has no
  login and can't authenticate.
- Guardianship is a row in a new **`Guardianship`** table:
  `guardianUserId → User` and `dependentProfileId → PatientProfile`, both
  real foreign keys (`ON DELETE RESTRICT`), plus `createdAt` and
  `revokedAt`. It's unique on `(guardianUserId, dependentProfileId)`, so
  there can't be duplicate or ambiguous rows for one pair. The model allows
  more than one guardian per dependent (two parents) for later. v1's API
  only ever creates one, for the guardian who created the profile.
- The bare `PatientProfile.guardianUserId` string is **dropped**. The
  migration refuses to run if any row has a value (none should; no code ever
  wrote one), so an operator decides rather than the migration silently
  discarding or reinterpreting data.
- A database `CHECK` keeps a login-less profile from existing without a
  date of birth (`"userId" IS NOT NULL OR "dateOfBirth" IS NOT NULL`). The
  majority rule below depends on it.

### How guardianship is created and verified

- **Create-only.** `POST /patients/me/dependents` creates a *new* dependent
  profile and the guardianship together, in one transaction. There is **no
  operation that links an existing profile or account** to a guardian. The
  request schema is strict and rejects unknown fields such as `userId` or
  `patientProfileId`. So the feature can't be used to get access to anyone
  else's records. A guardian can only ever see data they created on the
  dependent's behalf, plus the care that follows from bookings they made.
- **Only patients can be guardians** (`requireRole('patient')`), with a
  verified email (`requireVerifiedEmail`, the same bar as booking).
- **Guardianship is self-asserted in v1.** There's no document or identity
  check. That's acceptable here only because of create-only: asserting
  guardianship of a child gives access to nothing that already exists. Real
  verification (e.g. at a facility desk) is future work and is listed under
  open decisions.
- The dependent must be **under the age of majority at creation**, and the
  DOB can't be in the future. An adult creates their own account.

### What a guardian can access

While the guardianship is **active** (see below), the guardian can:

- list the dependent (`GET /patients/me/dependents`: id, name, DOB, created
  date and nothing else);
- book an appointment for them (`POST /appointments` with
  `patientProfileId`);
- list the dependent's appointments (`GET /appointments/mine?patientProfileId=`).

Those are the only dependent-scoped surfaces that exist today. When later
phases add intake, consultation notes, orders or exports, each must
authorise through the same check, `patientsService.resolveActingProfile`,
and decide in its own ADR or PR whether guardians see it. PRD §7's privacy
rule applies: intake and consultation notes go to "the patient, the
treating doctor(s), the fulfilling facility". For a minor, that patient is
represented by their guardian.

A guardian never gains access to another guardian's dependent. Any
`patientProfileId` that isn't the caller's own profile or an active
dependent of theirs is refused **before** anything else happens. The answer
is `404` when the caller has no relationship to the profile at all (no
enumeration), and `403 GUARDIANSHIP_INACTIVE` when they did and it has
ended.

### Age of majority

- `AGE_OF_MAJORITY_YEARS` is configurable, **default 18**. It's evaluated in
  UTC on the calendar date: a person reaches majority at 00:00 UTC on their
  Nth birthday. Someone born on 29 February reaches it on 1 March in a
  non-leap year.
- Guardian access **ends automatically** on that date. It's checked at
  request time from the DOB, so no job has to run and there's no window
  where a stale flag still grants access. The dependent drops out of the
  guardian's list, and booking for them is refused with
  `GUARDIANSHIP_INACTIVE`.
- The profile and all its clinical history are **kept unchanged**. Nothing
  is deleted or moved at majority.
- The now-adult **claiming** that profile as their own account (attaching a
  login to `userId`, with appropriate verification) is **not built here**.
  It's a follow-up issue. Until then, the profile is reachable by nobody but
  the treating doctors who already see its appointments.

### Revocation

A guardianship is inactive if **either** `revokedAt` is set **or** the
dependent has reached majority. `revokedAt` exists in the model and every
check honours it. v1 doesn't expose a revoke endpoint: guardian
relinquishment and admin revocation (e.g. a court order) are follow-ups
that only need to set it. Revocation is always a soft end (`revokedAt`),
never a delete, so who had access and when stays on record.

### Privacy and clinical history

- Dependents' records are ordinary patient records. Appointments reference
  the dependent's own `PatientProfile`, never the guardian's, so a child's
  history stays the child's even when guardianship ends or changes.
- `Guardianship` rows are never deleted. The FKs are RESTRICT, so neither the
  guardian's user nor the dependent's profile can be hard-deleted out from
  under the relation.
- A guardian deleting their own account (issue #41, ADR 0010) revokes all
  their guardianships in the same transaction as the anonymisation. The
  dependents' profiles and records are untouched (they're the dependents'),
  and the revoked rows stay as the record of who had access. A deleted
  account also acts for no one through `resolveActingProfile`, even while
  its access token is still valid, and the account purge holds the
  guardian's tombstone while those rows exist (retention hold
  `guardianships`).

## Open decisions (not resolved here)

- How guardianship is verified beyond self-assertion. That's needed before
  any feature lets a guardian see data they didn't create.
- The majority claim flow, and whether some care (e.g. adolescent sexual
  health) should be hidden from a guardian *before* majority. That's a
  jurisdiction-specific consent rule this ADR doesn't invent.
- Adding a second guardian, and the revoke endpoints.

## Consequences

- `PatientProfile.userId` becomes nullable. Everything that resolves "my
  profile" still goes through `getMyPatientProfile(userId)`, which can never
  return a dependent, since a dependent has no `userId`.
- `bookSlot` gains one authorisation step *before* its transaction:
  resolving which profile the caller may act for. The transaction itself,
  `claimOpenSlot`'s conditional `UPDATE` followed by the `Appointment`
  insert, is unchanged, so the double-booking guarantee (ARCHITECTURE §5.1)
  is unchanged. That's re-proven with a concurrent test that mixes a
  guardian-for-dependent booking with self-bookings on one slot.
