# scripts

One-off/dev/operator scripts. The ones that need this repo's Prisma schema
or Stellar SDK live next to the backend that uses them
(`backend/scripts/`) — this file is where they're documented, so there's one
place to look.

## `backend/scripts/mark-email-verified.mjs`

**Interim (Phase 8, issue #34).** Marks an existing account's email address
as verified, out-of-band:

```
node backend/scripts/mark-email-verified.mjs <email>
node backend/scripts/mark-email-verified.mjs      # prompts for the email
```

Needs `DATABASE_URL` (it reads `backend/.env` via `dotenv/config`, so run it
from `backend/`, or export the URL). Why it exists: no email provider is
integrated yet (Phase 6, issue #17), so `POST /auth/signup` accounts on the
hosted preview can't complete the verification link flow at all. This is the
documented operator path until a provider lands — it needs database
credentials, which is the same access a manual SQL `UPDATE` would require.
Delete it when issue #17 lands.

## `backend/scripts/gen-platform-identities.mjs`

Generates a fresh testnet Stellar payer + releaser keypair and funds them via
Friendbot, writing the secrets straight to `backend/.env` (never printed).
See `docs/adr/0004-custodial-payments-v1.md`.

## `backend/scripts/gen-migration.mjs`

Generates a `prisma/migrations/<timestamp>_<name>/migration.sql` from a real
Postgres diff without needing a local dev DB (spins up a throwaway embedded
Postgres as Prisma's shadow database). Usage:
`node scripts/gen-migration.mjs <migration_name>` — review the generated SQL
before committing, and add any data backfill it can't express as a schema
diff.
