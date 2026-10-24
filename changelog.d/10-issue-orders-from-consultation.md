Phase 4: a doctor issues a prescription or lab order from a consultation
([issue #10](https://github.com/DocForum/docforum-core/issues/10)).
`POST /orders/consultations/:consultationId/{prescriptions,lab-orders}` now
also refuse consultations whose appointment isn't `completed` (409, via the
new `consultationsService.assertConsultationAcceptsOrders`, checked after the
treating-doctor check) and check the facility up front
(`facilitiesService.requireFacilityForOrderKind`: unknown or wrong-type
facility → 400 instead of a foreign-key 500). Both still write through the
append-only issuance path from #9. New HTTP integration suite
`backend/tests/integration/orders-issuance.test.mts` (embedded Postgres, port
5467) covers both order types, corrections, treating-doctor-only access and
invalid consultation states. No schema or migration changes.
