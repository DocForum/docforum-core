# ADR 0008: A specialty-only referral is routed at creation to the least-loaded eligible doctor

Status: Accepted

## Context

ARCHITECTURE.md §6.1.2 flagged the gap directly: a doctor referring a
patient to "a cardiologist" rather than to a named doctor needs a real
rule for which cardiologist's queue the referral lands in, or referrals
will pile up with nobody responsible for them. PRD §8.2.2 asks the same
question from the patient's side ("zero verified doctors in the
specialty — what happens?"), and PRD §8.2.1 asks what happens when a
referred patient can find no specialist who will actually see them.

The first Phase 3 slice (#5) answered this by requiring a concrete,
verified `target_doctor_id`. That was a scope cut, not a decision: it
made the unassigned state impossible to construct instead of deciding who
receives an unassigned referral, and it left PRD §8.2.2's "waiting for a
specialist" state unreachable. This ADR takes the decision.

Constraints that shaped it:

- **It must be implementable now.** There is still no doctor-discovery
  surface (issue #23 owns the public catalog and the specialty
  management CRUD), no availability-based matching, and no notification
  layer (Phase 6). A rule that needs any of those is not a v1 rule.
- **No new schema, and no nullable target.** Issue #5's shape —
  `Referral.targetDoctorId` NOT NULL — is the thing that makes "nobody
  owns this referral" impossible. Prefer a rule that keeps it.
- **It must terminate.** Every referral must end up with exactly one
  accountable doctor at the moment it exists, or not be created.
- **It must handle zero candidates.** The rule cannot assume a specialist
  exists; "zero verified doctors in this specialty" is a normal early
  network state, not an exceptional one.

## Decision

**A referral may name a target doctor *or* a target specialty. A
specialty-only referral is resolved to a concrete doctor at creation,
inside the same transaction, by a deterministic least-loaded rule. The
column stays NOT NULL; nothing is ever created unassigned.**

### 1. Request shape

```jsonc
// still supported, unchanged:
{ "sourceConsultationId": "…", "targetDoctorId": "d1", "targetSpecialtyId": "cardiology", "snapshotNotes": "…" }
// new — routing decides the doctor:
{ "sourceConsultationId": "…", "targetSpecialtyId": "cardiology", "snapshotNotes": "…" }
```

At least one of `targetDoctorId` / `targetSpecialtyId` is required; both
absent is a `400` at validation. When `targetDoctorId` is present, the
request behaves exactly as before — the rule never overrides an explicit
choice.

### 2. Eligibility predicate (one predicate, both paths)

A doctor is eligible to receive a referral when all of these hold:

- `DoctorProfile.verificationStatus = 'verified'` (PRD FR-3: manual,
  admin-gated verification);
- the doctor holds `targetSpecialtyId` (`DoctorSpecialty` link);
- the doctor is not the referring doctor (self-referral is a `422` on the
  manual path; excluded outright on the routed path);
- the doctor's owning account is not deactivated (`User.deactivatedAt is
  null`) — a deactivated doctor cannot log in, so routing to them would
  create the very dead end this ADR exists to prevent;
- the doctor was not explicitly named by another target in the same
  referral batch (§5).

The routed path applies the same verification and specialty gates the
manual path applies (`assertDoctorVerified` /
`assertDoctorVerifiedInSpecialty`), so there is no second definition of
"qualified" to drift.

### 3. Selection rule

Among eligible candidates, choose the doctor with the **fewest active
referrals currently targeted at them**, where active = status
`pending` or `accepted`:

```sql
SELECT target_doctor_id, count(*)
  FROM "Referral"
 WHERE target_doctor_id IN (…eligible ids…)
   AND status IN ('pending', 'accepted')
 GROUP BY target_doctor_id;
```

A doctor absent from that result has a load of `0`. Ties are broken by
`DoctorProfile.id` ascending, so the same set of candidates with the same
loads always produces the same choice — an unmeasurable "fairness" is not
part of the rule, determinism is.

Terminal referrals (`completed`, `declined`, `expired`, `cancelled`) do
not count: load means outstanding work, and a referral that has finished
should stop steering future routing.

### 4. Zero eligible candidates

Creation fails with `422` (machine-readable
`code: "REFERRAL_NO_ELIGIBLE_TARGET"`, so the referring doctor's UI can
say "no specialist available" rather than render a generic failure) and a
message naming the reason; the whole batch rolls back and **no `Referral`
row is written**. There is no "unassigned" record, no retry queue and no
placeholder doctor in v1.

Consequence, stated plainly rather than papered over: PRD §8.2.2's
"waiting for a specialist" state is still not built. The patient never
holds a referral with no owner — the referring doctor is told at the
moment of the referral that nobody is available, which is the actionable
place to learn it. Building the waiting state would require assignment
*after* creation, which is the thing §2 forbids.

### 5. Batches (issue #66)

Targets are resolved in order, and each routed target excludes: the
referring doctor, every doctor explicitly named anywhere in the batch,
and every doctor already resolved for an earlier target in the batch.
This makes a batch order-independent for explicit targets and prevents a
"cardiology (any) + Dr A" batch from failing the duplicate-target check
just because routing happened to pick Dr A for the specialty. A routed
target that finds no remaining candidate after exclusions fails the whole
batch with the same `422` — all-or-none, as #66 established.

### 6. Everything downstream is unchanged

The resolved `targetDoctorId` is an ordinary `Referral.targetDoctorId`
from that point on: the loop walk (#65) still runs against it and still
*flags* a repeated doctor/specialty for the admin queue rather than
blocking, accept (#7) still books the target doctor's slot, the cascade
(#67) is untouched, and the admin queue/reassign (#68) remains the human
override. `targetSpecialtyId` stays the denormalised label the loop guard
and admin views read.

## Why least-loaded

- **Fair on the dimension that matters.** The failure this rule exists to
  prevent is a specialist drowning in a queue nobody assigned them. Open
  slot count is a better proxy for capacity but is unavailable to
  routing today (no availability-aware matching, and a doctor with no
  published slots would be excluded from routing entirely — a worse dead
  end than an uneven queue).
- **No new state to keep correct.** Round-robin needs a per-specialty
  cursor: a new table, a transaction to advance it, and a decision about
  what a rolled-back creation does to the cursor. Least-loaded is one
  aggregate query over rows that already exist, so it cannot drift out of
  sync with reality. This is the boring option, deliberately.
- **Deterministic and explainable.** "Why did this land on Dr B?" has a
  one-sentence answer the admin queue can show, and the tie-break makes
  test assertions exact instead of probabilistic.

Rejected alternatives:

- **Round-robin per specialty** — perfectly even, but needs persisted
  cursor state and still ignores actual load (even distribution ≠ fair
  distribution when doctors work at different rates).
- **Patient chooses the specialist from a list** — requires a doctor
  discovery surface (issue #23) and a referral state where the target is
  unset, i.e. exactly the nullable column §2 rules out. It also moves a
  clinical hand-off decision onto the patient. Revisit only together with
  the "waiting for a specialist" state.
- **Keep requiring an explicit target doctor (status quo)** — leaves
  §6.1.2 open and forces a referring doctor to guess a UUID with no way
  to enumerate eligible specialists. Not a decision.

## Consequences

- **Where it lives:** the pure rule is
  `backend/src/modules/referrals/routing.ts`; resolution (eligibility +
  load + choice) is `resolveTargetDoctor` in
  `backend/src/modules/referrals/services/index.ts`; eligibility is
  `doctors/services.listEligibleReferralTargets` (never a direct
  `DoctorSpecialty` read from the referrals module). Tests:
  `tests/unit/referral-routing.test.ts` (the rule) and
  `tests/integration/referral-routing.test.mts` (least-loaded choice,
  zero candidates, self/deactivated exclusions, batch exclusions).
- A referring doctor who names only a specialty gets a doctor back in the
  creation response (`targetDoctorId`); the API returns the referral row
  with the resolved target, so no extra round trip is needed to learn who
  received it.
- **Load-balancing is approximate under concurrency.** Two creations
  resolving the same specialty at the same instant can both read the same
  loads and pick the same doctor, and both succeed. There is no unique
  constraint or advisory lock: the referral count is a soft signal, the
  drift is one referral, and serialising referral creation on a specialty
  is not worth the contention. If this ever becomes measurably unfair,
  the place to fix it is this rule, not the schema.
- Routing reads `DoctorProfile` through the doctors module's service and
  `Referral` through this module's repository — no cross-module table
  access (ARCHITECTURE_ESSENTIALS.md hard rule 4).
- There is no "why this doctor" audit row: referral *creation* is still
  unaudited (ARCHITECTURE.md §6.2.4 lists that gap). When creation
  auditing lands, the routing inputs (candidate set size, chosen load)
  belong in its metadata — that is the natural place to record it, not a
  second log.
- Deferred, with a trigger for revisiting: availability-aware routing
  (only doctors with open slots) once doctor-side discovery/availability
  exists; a per-doctor "accepting referrals" switch, which is the honest
  long-term replacement for the account-deactivation exclusion; and the
  "waiting for a specialist" queue if a real clinical workflow needs a
  referral to exist before an owner does.
- PRD §8.2.1's dead end narrows but is not closed: a routed referral can
  still sit pending because the chosen doctor never publishes a slot.
  That is issue #8's time-based expiry (and the admin queue, #68), not a
  routing problem — this ADR deliberately does not try to solve it by
  routing only to doctors with slots.
