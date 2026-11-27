Phase 8: Zod validation for the legacy order controllers
([issue #317](https://github.com/DocForum/docforum-core/issues/317)).
Pharmacy-order and lab-order create/fulfill (new `lab-orders/validation.ts`)
and the admin dispute list/resolve parse their input with Zod schemas, and
the duplicated `typeof`/empty-string checks are gone from the services. A
missing or malformed body is now a `400` before any lookup (the
access-control matrix rows say so). Unit tests in
`tests/unit/legacy-order-schemas.test.ts`.
