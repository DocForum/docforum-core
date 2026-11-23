Phase 5: four linked fixes — module-boundary enforcement, capability management,
price-list retirement, and patient fulfillment reads
([issue #318](https://github.com/DocForum/docforum-core/issues/318),
[issue #320](https://github.com/DocForum/docforum-core/issues/320),
[issue #321](https://github.com/DocForum/docforum-core/issues/321),
[issue #323](https://github.com/DocForum/docforum-core/issues/323)).

**#318 — Remove direct cross-module table access.** `lab-orders` and
`pharmacy-orders` services were calling `prisma.patientProfile` and
`prisma.facilityProfile` directly. Replaced with thin wrappers exposed from
`patients/services` (`findPatientProfileById`) and `facilities/services`
(`findFacilityProfileByUserId`), so all cross-module data access goes through
service interfaces as ARCHITECTURE_ESSENTIALS.md hard rule 4 requires.

**#320 — Admin capability management.** New endpoints
`POST /facilities/:id/capabilities` and
`DELETE /facilities/:id/capabilities/:capabilityId` (admin-only) let
operators add or remove a `FacilityCapability` row after account creation.
Both record an audit event in the same transaction; a duplicate-key violation
returns 409 with a stable error code. Removes the stale ROADMAP note that said
"capability management after creation … has no endpoint yet."

**#321 — Retire an item from a facility price list.** New endpoint
`POST /facilities/me/prices/retire` publishes a retirement version row
(`retired = true`, `amount = 0`) for one catalog item. `requireCurrentPrice`
now surfaces 422 `ITEM_RETIRED` (distinct from `PRICE_ON_REQUEST`) when the
in-force version is retired; `resolveCurrentPrice` returns `null` for retired
items. Migration: `20261122000000_retire_facility_price_item` adds
`retired BOOLEAN NOT NULL DEFAULT false` to `FacilityPrice`.

**#323 — Patient fulfillment reads.** `GET /pharmacy-orders/fulfillments/:id`
now accepts patients; it checks ownership through
`Prescription.patientProfileId` / `LabOrder.patientProfileId` (Phase 4 link)
and guardian access via `patientsService.isProfileAccessibleTo`.
New `GET /pharmacy-orders/orders/:orderId/fulfillments?orderType=…` lists all
records for one order, restricted to the owning patient (or guardian), the
owning facility, or admin. Removes the stale "blocked on Phase 4" comment.
