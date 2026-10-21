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

Changed by the Prisma 7 upgrade (Phase 8, issue #47): the shadow database is
now passed as the `SHADOW_DATABASE_URL` environment variable rather than a
`--shadow-database-url` CLI flag (removed in Prisma 7), and the diff target is
`--to-schema` (renamed from `--to-schema-datamodel`). Run it from `backend/`
as before.

## `backend/scripts/check-migration-drift.mjs`

Proves the committed migrations and `prisma/schema.prisma` still agree —
applies the migrations to a throwaway embedded Postgres with
`prisma migrate deploy` (the same command Render's start command runs), then
diffs that database against the schema with `--exit-code`. Exits non-zero if
anything has drifted. Added with the Prisma 7 upgrade, since a change to the
CLI or the schema without a matching migration is exactly what this catches.

```
node backend/scripts/check-migration-drift.mjs
```

Self-contained: no local dev DB, no Docker. Deliberately not wired into CI
(it spins its own Postgres cluster, and CI already runs the integration
suite's) — run it before merging a schema or Prisma change.

## `backend/scripts/audit-gate.mjs`

CI's production-dependency audit gate (Phase 8, issue #47), wired up as
`npm run audit:prod` and run on every PR. It runs
`npm audit --omit=dev --json` and fails on any **high or critical** advisory
that is not on its explicit, commented allowlist — so a newly added
vulnerable package fails the build.

The allowlist holds exactly one chain: `axios`, reached through
`@docforum/escrow-sdk`'s pinned `@stellar/stellar-sdk`. The fix lives in
`docforum-escrow` (the SDK must build on a patched `stellar-sdk`), not in this
repo, and no version bump here resolves it. Remove those entries once the
escrow SDK ships a patched release.

## `scripts/fold-changelog.mjs`

Maintainer script. Contributors add their `ROADMAP.md` changelog entry as a
new file in `changelog.d/` (see `changelog.d/README.md`) instead of appending
to the `## Changelog` section, so open PRs stop conflicting with each other.
This script appends every fragment to the end of that section, dated by the
day the fragment was merged (from git history), and deletes the fragment
files:

```
node scripts/fold-changelog.mjs --dry-run   # preview
node scripts/fold-changelog.mjs
```

Commit the result in its own PR. Run it from anywhere in the repo; it has no
dependencies.
