Phase 4 / issue #11: `GET /orders/mine` — patient-facing view of active/past
prescriptions and lab orders. The supersedes-chain is resolved at the DB
query level (Prisma `correctedBy: null` filter), so the UI receives only
current/latest versions without having to traverse the chain. Lab order notes
are decrypted before return.

Phase 5 / issue #15: `GET /pharmacy-orders/facility/queue` — the facility's
own assigned fulfillment queue. Only records belonging to the calling facility
are returned (hard rule 5). `fulfilled` remains unreachable via
`PATCH /pharmacy-orders/fulfillments/:id` (validation schema allows only
`in_progress` | `rejected`); it is derived from dispensed items only
(§5.3 step 5). Integration test `backend/tests/integration/facility-queue.test.mts`
proves queue isolation, the `fulfilled` direct-set rejection (400), wrong-facility
ownership (403), patient dispense block (403), and the only valid path to
`fulfilled` via item-level writes.

Phase 8 / issue #20: PRD §8.2.6 (doctor moonlighting across facilities),
§8.2.8 (prescription drug interaction checking), and §8.2.9 (time zone
handling) each marked resolved in-place with explicit "Deferred — not planned
for v1" decisions and rationale. No code changes.
