# prisma/schema

The data model, one `.prisma` file per backend module. Prisma reads every
file in this folder as one schema (`schema: 'prisma/schema'` in
`backend/prisma.config.ts`), so a model can reference models in other files.

Until 2026-11 this was a single `schema.prisma`. Nearly every feature PR added
a model or a field to it, so each merge put the other open PRs into conflict.
With one file per module, PRs for different modules no longer touch the same
file.

| File | Holds |
|---|---|
| `base.prisma` | `generator` and `datasource` only |
| `identity.prisma` | `User`, roles, email verification, password reset, admin invites, login throttle, refresh sessions |
| `patients.prisma` | `PatientProfile`, data exports, guardianship |
| `doctors.prisma` | `DoctorProfile`, verification status, specialties |
| `facilities.prisma` | `FacilityProfile`, capabilities, prices |
| `scheduling.prisma` | availability slots, appointments, waitlist |
| `intake.prisma` | `IntakeForm` |
| `consultations.prisma` | `Consultation` |
| `referrals.prisma` | `Referral` and its statuses |
| `orders.prisma` | `Order`, fulfillment proofs, disputes and resolutions |
| `prescriptions-labs.prisma` | append-only prescriptions and lab orders/results |
| `fulfillment.prisma` | `FulfillmentRecord` / `FulfillmentItem` |
| `notifications.prisma` | notifications and the transactional outbox |
| `payments.prisma` | payment intents, wallet links, SEP-10 challenges, escrow chain events |
| `audit.prisma` | `AccessLog`, `AuditEvent` |
| `platform.prisma` | feature flags, idempotency keys, rate limits |

## Adding to the schema

- Put a new model or enum in the file for the module that owns it. A new
  module gets a new file; don't add to `base.prisma`.
- An enum lives next to the model that uses it.
- Every schema change still needs a migration:
  `node scripts/gen-migration.mjs <name>` (from `backend/`). CI's
  "Migrations reproduce the schema" step fails when the schema and the
  migrations disagree.
