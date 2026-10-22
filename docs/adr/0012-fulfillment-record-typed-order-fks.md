# ADR 0012: `FulfillmentRecord` keeps one table and drops the polymorphic order reference for two typed FKs

Status: Accepted

## Context

ARCHITECTURE.md §6.1.3 has carried this since the Phase 0 sketch:

> Polymorphic `FulfillmentRecord.order_id` (§4.7) — polymorphic FKs are a
> known footgun for referential integrity in Postgres. Needs either two
> separate tables (`PrescriptionFulfillment`, `LabOrderFulfillment`) or a
> check-constraint + application-level guard. **Current schema sketch is a
> simplification that should be revisited before implementation**, not
> treated as final.

§6.3.1 flags the same model from the other direction — the polymorphic design
may itself be a premature abstraction, and "two small, boring, separate tables
might beat one clever polymorphic one at this stage". Issue #13 asks for the
decision before Phase 5's facility work (#14 facility matching, #15 fulfillment
UI, #16 lab-result attachment) builds on an undecided data shape.

What the model actually looked like when this ADR was written: a Phase 0
placeholder — `orderType String` + `orderId String`, no foreign keys of any
kind, `// TODO: facilityId`, and **no code path anywhere in `backend/src` that
ever writes or reads it**. So this is a design decision, not a migration of
live data.

Constraints that shaped it:

- **§5.3 step 5 is the invariant that matters.** An order's `status` reaches
  `fulfilled` *only* through a facility confirming its own fulfillment row.
  Neither patient nor doctor can self-mark it. The shape must make "which row
  may this facility touch, and what happens next" a single, locatable rule.
- **Hard rule 5** (ARCHITECTURE_ESSENTIALS.md): a facility writes only to its
  own `FulfillmentRecord`. That requires the row to name its facility —
  §4.7's `facility_id` and the schema's `TODO` are the same missing column.
- **Hard rule 1**: `Prescription`/`LabOrder` are immutable after issuance, so
  fulfillment state must live outside them. That part of §4.7's design note is
  not up for reconsideration here.
- **ADR 0010**: clinical rows must not be reachable by a cascade that deletes
  them. Whatever the shape, its FKs are `RESTRICT`, not `CASCADE`.
- **Postgres cannot express the polymorphic pair.** A `CHECK` can constrain a
  column's *value* (`orderType IN ('prescription','lab_order')`), but it
  cannot make `orderId` reference `Prescription` when `orderType` says so and
  `LabOrder` otherwise. The "check-constraint + application-level guard"
  option in §6.1.3 therefore still permits a row pointing at an order that
  does not exist — the exact failure the item was filed against.
- **This schema already resolved the identical problem once.** Issue #85
  replaced `PaymentIntent`'s `orderType`/`orderId` pair with nullable
  `prescriptionId`/`labOrderId` FKs, a `UNIQUE` on each, and a
  `PaymentIntent_exactly_one_order_check` requiring exactly one. One schema
  solving the same polymorphism two different ways is its own smell.

## Decision

**`FulfillmentRecord` stays a single table. It stops being polymorphic.**
`orderType` and `orderId` are dropped and replaced by two real foreign keys —
`prescriptionId` and `labOrderId`, each nullable, each `UNIQUE` — with a
PostgreSQL `CHECK` requiring exactly one of them. `facilityId` becomes a real
FK, resolving §4.7's `TODO`. The model keeps its name; §4.7's separation
rationale (a facility's operational status never writes the clinical order
row) is unchanged.

```prisma
model FulfillmentRecord {
  id             String            @id @default(uuid())
  prescriptionId String?           @unique
  labOrderId     String?           @unique
  facilityId     String
  status         FulfillmentStatus @default(pending)
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt

  prescription Prescription?   @relation(fields: [prescriptionId], references: [id], onDelete: Restrict)
  labOrder     LabOrder?       @relation(fields: [labOrderId], references: [id], onDelete: Restrict)
  facility     FacilityProfile @relation(fields: [facilityId], references: [id], onDelete: Restrict)

  @@index([facilityId, status])
}
```

At the database level, alongside the three `RESTRICT` FKs:

```sql
CREATE UNIQUE INDEX "FulfillmentRecord_prescriptionId_key" ON "FulfillmentRecord"("prescriptionId");
CREATE UNIQUE INDEX "FulfillmentRecord_labOrderId_key"     ON "FulfillmentRecord"("labOrderId");
ALTER TABLE "FulfillmentRecord" ADD CONSTRAINT "FulfillmentRecord_exactly_one_order_check"
  CHECK (("prescriptionId" IS NOT NULL) <> ("labOrderId" IS NOT NULL));
```

`FulfillmentStatus` (`pending | in_progress | fulfilled | rejected`) is
unchanged — the enum was never the problem; the untyped reference was.

In `PaymentIntent`'s image, deliberately: same discriminator mechanism, same
constraint names, same `RESTRICT` posture. What §6.1.3 called "a
check-constraint + application-level guard" is *not* what this is — the CHECK
here picks between two columns that are each a real foreign key, so
referential integrity holds whichever way the discriminator falls.

## Why one table rather than two

- **The invariant lives in exactly one place.** §5.3 step 5 becomes one
  transition, not two parallel implementations that can drift apart: a
  conditional update scoped to the caller's own facility
  (`UPDATE ... SET status = 'fulfilled' WHERE id = ? AND facilityId = ? AND
  status <> 'fulfilled'`), followed inside the same transaction by the order's
  `status` write through the orders module's service. Split in two, every
  future rule added to that transition — the audit row owed by §6.2.4, the
  escrow-release trigger Phase 5.5 still waits for, the notification trigger
  Phase 6 will add — has to be written, reviewed and tested twice. AGENTS.md's
  rule is to prefer the boring option around data mutability; here boring and
  single-implementation happen to be the same thing.
- **The facility's assigned-orders queue is one query.** `WHERE "facilityId" =
  ? AND "status" IN (...) ORDER BY "createdAt"` over one table, with the
  `(facilityId, status)` index. Two tables force either a `UNION ALL` of two
  shaped-alike subqueries or two paginated fetches merged in application code
  — and pagination is the sharp edge: correct cross-table paging means a
  keyset cursor over `(createdAt, id)` rebuilt by hand, because `OFFSET` over a
  merged list is wrong. That is *more* machinery than the polymorphism it
  removes, and it is precisely the "duplicating logic" the issue warns about.
- **The two forms do not diverge in their data.** What a fulfillment *is* — a
  facility, a status, timestamps, one order — is identical for a prescription
  and a lab order. The lab-specific payload lives in `LabResult` already
  (§4.6), which keeps its own `labOrderId`/`fulfillingFacilityId` pair; #16
  attaches results there and needs no new column on the fulfillment row. A
  split would be justified by divergent fields or divergent lifecycles, and
  neither exists today.
- **Consistency with `PaymentIntent`.** Two solutions to one problem means
  every future reader has to learn both and remember which table uses which.
- **Reversibility, stated honestly.** The table has no rows and no readers
  yet, so this is a cheap decision to make now and would have been an expensive
  one after #15 and #16 shipped. It is *not* cheap after that; the second
  table would have to be introduced with its own migration and a
  one-fulfillment-per-order constraint spanning both.

Rejected alternatives:

- **Split into `PrescriptionFulfillment` / `LabOrderFulfillment`.** Real FKs
  and NOT NULL on the order reference (the one genuine gain: the discriminator
  becomes a column-level guarantee instead of a table-level CHECK), at the
  price of two copies of every transition rule, a hand-rolled union for the
  facility queue, and a second answer to a question this schema already
  answered. Not worth it for two forms that share every field.
- **Keep `orderType` + `orderId`, add a CHECK and an application guard** —
  the literal option §6.1.3 offered. Rejected because the CHECK only validates
  the *label*; `orderId` stays a bare `TEXT` with no FK, so a fulfillment can
  still point at a nonexistent or wrong-typed order, and the only thing
  standing between that and corrupt clinical history is application code. A
  dangling `orderId` on a row whose order was deleted (or never existed) is
  exactly the bug class §6.1.3 names; hard rule 4 (module-boundary purity)
  means the guard cannot even be a join the database checks for you.
- **A `VIEW` over two split tables**, to keep one facility query — adds a
  schema object Prisma cannot map as a model (v7 has no view support), so it
  gets read with `$queryRaw` anyway: the union survives, plus a hand-maintained
  projection that silently breaks whenever a column is added.
- **Table-per-kind with a shared `Fulfillment` parent (JOI/CTI inheritance).**
  Postgres has no native table inheritance worth using here; a join to read a
  status is the ceremony §6.3 exists to prevent.

## Consequences

- **Where the columns live:** `backend/prisma/schema.prisma` §4.7 model, with
  back-relations on `Prescription` (`fulfillment`), `LabOrder` (`fulfillment`)
  and `FacilityProfile` (`fulfillments`). Migration:
  `backend/prisma/migrations/*_fulfillment_record_typed_order_fks/migration.sql`.
  It drops the two placeholder columns and aborts if the old table has any
  rows: a `(orderType, orderId)` pair that was never validated cannot be
  reinterpreted as a typed reference without a human, so the migration refuses
  rather than guesses (same posture as #9's placeholder guard).
- **Reading the order type.** Code branches on which FK is non-null
  (`row.prescriptionId ? 'prescription' : 'lab_order'`) instead of reading a
  stored label. No `OrderType` enum returns — there was an `OrderTypeForPayment`
  enum in the payments sketch, dropped in #85, and nothing here needs it back.
- **One fulfillment per order, permanently, in v1.** The `UNIQUE` on each
  column is the guarantee. Consequence, not papered over: a facility that
  `reject`s an order cannot be swapped for another facility by creating a
  second row — re-routing after rejection needs a partial unique index
  (`WHERE status NOT IN ('fulfilled','rejected')`), which Prisma cannot declare
  and which nobody has asked for yet. A `rejected` order follows the path
  already built: its payment intent is refunded (Phase 5.5, `POST
  /payments/intents/:id/refund`), and a corrected order is a *new*
  `Prescription`/`LabOrder` row via `supersedes_*_id` — which, being a new row,
  gets its own new fulfillment. Deferred until a real workflow needs it;
  revisit triggers are #15's reject path and #12's order-expiry work.
- **`facilityId` is denormalised, and deliberately so.** The order already
  names its facility at issuance (`Prescription.facilityProfileId` /
  `LabOrder.facilityProfileId`), so the fulfillment row copies it rather than
  deriving it: the facility queue must filter on the fulfillment table to be
  indexable, and hard rule 5 needs ownership on the row the facility writes.
  The invariant "`record.facilityId` equals its order's `facilityProfileId`" is
  enforced by the creating service (#14), which copies it in the issuance
  transaction, and by the confirming service (#15), which never re-points it. A
  DB trigger could enforce it across tables; rejected as too clever for an
  invariant with exactly one writer — the same reasoning AGENTS.md's "prefer
  the boring solution … around data mutability" rule applies to. If it ever
  breaks, the correct fix is the transition function, not a second enforcement
  point.
- **Retention: nothing here is deletable by cascade.** All three FKs are
  `RESTRICT`, so deleting an order or a facility account cannot silently erase
  the fulfillment trail, and `FacilityProfile`'s `Cascade` from `User` (Phase 1)
  stops at the fulfillment row instead of propagating into it. The model has no
  direct patient FK — ADR 0010's rule applies to clinical rows that *gain* one;
  a fulfillment inherits its patient through the order, whose
  `patientProfileId` is already `RESTRICT` and already covered by the orders
  module's retention hold (`src/retention-holds.ts`). No new hold is required,
  and this ADR does not add one.
- **What Phase 5's remaining issues get from this:** #14 creates the row
  (`pending`) when a qualified facility is selected, and owns the
  capability→facility check; #15 implements the transition function above and
  is the only code path that may set `fulfilled` — the endpoint that marks the
  order fulfilled, and the audit event that records it (§6.2.4 still owes the
  Phase 4/5 transitions); #16 attaches `LabResult` through its existing table.
  Phase 5.5's escrow release then triggers off `status == 'fulfilled'` on this
  table, which is the seam ADR 0004 says the admin-triggered release is an
  interim for.
- **No API surface or service code changes here.** The model has no readers
  yet, so this decision ships as schema + documentation; the first behavior
  lands with #14.
- **Docs updated in this change:** ARCHITECTURE.md §4.7 (the sketch becomes
  what was built), §6.1.3 and §6.3.1 marked resolved, ARCHITECTURE_ESSENTIALS.md's
  data-model map and "Known unresolved design gaps", ROADMAP.md Phase 5's
  prerequisite item.
