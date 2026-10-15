# scripts

One-off/dev/operator scripts. The ones that need this repo's Prisma schema
or Stellar SDK live next to the backend that uses them
(`backend/scripts/`) — this file is where they're documented, so there's one
place to look.

## `backend/scripts/create-admin.mjs`

**The supported way to seed an admin account** (Phase 8, issue #39). Before
this, the only path was hand-editing the `User` row in the Render database —
see `docs/adr/0003-render-preview-deployment.md`, whose renewal runbook now
uses this script.

```
node backend/scripts/create-admin.mjs --email admin@example.com
printf 'admin@example.com\n<password>\n' | node backend/scripts/create-admin.mjs
node backend/scripts/create-admin.mjs --email admin@example.com --force
```

Needs `DATABASE_URL` (it reads `backend/.env` via `dotenv/config`, so run it
from `backend/`, or export the URL).

Rules it exists to enforce:

- **Credentials never come from argv.** `ps`, shell history and CI logs all
  record command lines, so the password is read from stdin — silently, when
  there's a TTY. Passing `--password`/`--password-hash` is refused rather
  than quietly ignored. The email *is* accepted as `--email`, because an
  address isn't a secret.
- **Secrets are never printed or logged.** No password, no hash, no echo.
- **It refuses to run when an active admin already exists**, unless `--force`
  is passed, so a stray run can't quietly add a second administrator.
- **It refuses to overwrite an existing account** for the same address —
  promote or reactivate that one instead.

Piped input is `email` then `password` (one line each, no confirmation
line); interactive input prompts for all three.

## `backend/scripts/mark-email-verified.mjs`

**Interim (Phase 8, issue #34).** Marks an existing account's email address
as verified, out-of-band:

```
node backend/scripts/mark-email-verified.mjs <email>
node backend/scripts/mark-email-verified.mjs      # prompts for the email
```

Why it exists: no email provider is integrated yet (Phase 6, issue #17), so
an account created through `POST /auth/signup` on a hosted deployment can't
complete the verification-link flow at all. This is the documented operator
path until a provider lands — it needs database credentials, which is the
same access a manual SQL `UPDATE` would require. Delete it when issue #17
lands.

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
