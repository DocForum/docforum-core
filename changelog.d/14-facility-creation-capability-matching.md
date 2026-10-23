Phase 5: admin-only facility account creation + `FacilityCapability` matching
([issue #14](https://github.com/DocForum/docforum-core/issues/14)).

`POST /facilities` (admin-gated at the route, mirroring Phase 1's admin-gated
doctor verification) creates the `facility`-role `User`, its `FacilityProfile`
and its `FacilityCapability` rows in one transaction, plus a
`facility.created` `AuditEvent` (ids and counts only — never the email or the
credential). There is still no self-serve facility signup: `POST /auth/signup`
refuses the role, so this endpoint is the only creation path (PRD OQ-2 — a
curated partner list is what protects FR-13 / §8.1.6). Deliberate defaults,
flagged rather than hidden: the admin sets the initial password out of band
(same posture as the bootstrap admin CLI) and `emailVerifiedAt` is set at
creation because the email provider (#17) can't deliver a link, and an
unverified curated partner would otherwise never be able to publish prices
(`requireVerifiedEmail` gates `POST /facilities/me/prices`). Capabilities must
match the facility type (`lab` ↔ `lab_test`, `pharmacy` ↔
`medication_dispense`) and at least one is required, so an account created
through this path can never be un-qualifiable data. Capability management
after creation (edit/retire a capability) has no endpoint yet — that surface
is still pending.

Matching (PRD FR-13): `GET /facilities/eligible` now returns only facilities
of the requested type that *hold* the matching `FacilityCapability` row, and
the services export `listEligibleFacilitiesForOrderKind('lab_order' |
'prescription')` for callers that start from an order instead of a facility
type. **Fail closed** — a facility with no capability rows, or only rows of
the wrong capability type, shows for nothing; under-showing is an operator
fix, over-showing is the fraud/safety concern §8.1.6 names. Consequence for
existing data: Phase-1 facilities seeded without capabilities disappear from
`/eligible` until an admin creates/repairs their qualification data — the
integration tests that predate #14 needed capability rows added to their
fixtures for exactly this reason.

Not in this issue, stated plainly because ADR 0012 assigns it to #14: the
`FulfillmentRecord` row *at facility selection* is not created here — no
selection endpoint exists yet (orders name their facility at issuance,
`Prescription.facilityProfileId` / `LabOrder.facilityProfileId`), and issuance
currently does not capability-check it. That wiring, and the
`→ fulfilled` transition, land with #15 on top of this matching rule.

No schema or migration changes: `FacilityProfile`, `FacilityCapability` and
`FulfillmentRecord` were already modeled (Phase 1 / #13) and the relations
proved sufficient. Tests:
`backend/tests/integration/facility-creation-matching.test.mts` (admin gate
enforced server-side at 401/403, no self-serve path, one-transaction creation
+ audit, fail-closed matching across four facilities with different
capability data).
