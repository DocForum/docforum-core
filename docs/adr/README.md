# ADR index

| Number | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith over microservices for v1 | Accepted |
| [0002](0002-stellar-escrow-for-fulfillment-payout.md) | Stellar escrow as a consumed library, not a network service; org split into 3 repos | Accepted |
| [0003](0003-render-preview-deployment.md) | Render as a preview deployment (not the Phase 9 decision) | Accepted |
| [0004](0004-custodial-payments-v1.md) | Payments v1 is custodial — docforum-core holds the Stellar identities, patients never sign anything | Accepted |
| [0005](0005-non-custodial-patient-payments.md) | Non-custodial payments v2 — patients fund escrows from their own Stellar wallet | Accepted (2026-10-19; implementation started) |
| [0006](0006-prisma-7-driver-adapter.md) | Prisma 7 + the node-postgres driver adapter (clearing the `deepmerge-ts` advisory) | Accepted |
| [0007](0007-postgres-backups-and-restore-drill.md) | Postgres backups and a tested restore drill | Accepted |
| [0008](0008-referral-routing-without-target-doctor.md) | A specialty-only referral is routed at creation to the least-loaded eligible doctor | Accepted |
| [0009](0009-consultation-close-once.md) | Consultation is close-once, enforced by a unique appointment FK | Accepted |
| [0010](0010-account-deletion-and-clinical-record-retention.md) | Patient account deletion anonymises identity and retains clinical, order and payment records | Proposed (issue #41; becomes Accepted when the implementing PR merges) |
| [0011](0011-guardian-dependent-profiles.md) | Dependents are guardian-owned patient profiles, created (never linked) by the guardian; access ends at the age of majority | Proposed (issue #42; becomes Accepted when the implementing PR merges) |
| [0012](0012-fulfillment-record-typed-order-fks.md) | `FulfillmentRecord` keeps one table and drops the polymorphic order reference for two typed FKs | Accepted |
| [0013](0013-notification-provider.md) | Notification provider (email/SMS) | Accepted |
| [0014](0014-postgres-row-level-security.md) | PostgreSQL row-level security for patient-scoped reads | Accepted |
| [0015](0015-production-deployment-target.md) | Production deployment target — Render, paid, behind a Blueprint | Accepted |
| [0016](0016-releaser-key-custody.md) | Custody of the platform escrow releaser key | Accepted |
| [0017](0017-multiple-referrals-per-consultation.md) | One consultation may spawn several referrals — created atomically, living independently | Accepted |
| [0018](0018-lab-result-object-storage.md) | Lab result file storage (object storage provider) | Accepted |
| [0019](0019-retire-legacy-order-table.md) | Retire the legacy `Order` / `FulfillmentProof` / `OrderDispute` tables | Proposed (issue #315) |
