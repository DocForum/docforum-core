# ADR 0006: Prisma 7 + the node-postgres driver adapter (clearing the `deepmerge-ts` advisory)

Status: Accepted
Date: 2026-10-16

## Context

Phase 8 (issue #47). `npm audit --omit=dev` reported a **high**-severity advisory
against the production dependency tree: `prisma` → `@prisma/config` →
`deepmerge-ts < 8.0.0` ([GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
uncontrolled recursion / stack exhaustion when merging recursive object
graphs). `npm audit fix --force` offered exactly one remedy, and it was flagged
as a breaking change: `prisma@7.10.1`.

There is no 6.x escape hatch. Every published stable 6.x `@prisma/config` pins
`deepmerge-ts@7.1.5`; the fix was merged to Prisma's `v7` branch and first
shipped in a stable release as `@prisma/config@7.10.1` (verified against the
npm registry: the only stable versions declaring `deepmerge-ts@8.0.2` are
`7.10.1` and unreleased `8.1.0-dev.*` prereleases). So clearing the advisory
means taking the major upgrade.

Prisma 7 is a major release with real breaking changes (driver adapters are now
mandatory, the CLI's datasource configuration moved out of the schema, ESM
packaging, stricter Node/TypeScript minimums), which is why this needs an ADR
rather than a silent version bump.

## Decision

Upgrade `prisma` and `@prisma/client` to `^7.10.1` — the lowest stable release
that ships the patched `deepmerge-ts` — and adopt the v7 client shape:

- **Driver adapter.** Prisma 7 removed the Rust query engine, so
  `new PrismaClient()` with no arguments now throws ("A driver adapter is
  required to connect to your database"). Added `@prisma/adapter-pg` + `pg` and
  construct the client as `new PrismaClient({ adapter: new PrismaPg({ … }) })`
  in `src/db/prisma-client.ts`.
- **Keep the `prisma-client-js` generator.** It is still supported in 7.10.1 and
  still writes to `node_modules/@prisma/client`, so the 14 existing
  `@prisma/client` import sites are untouched and the backend stays
  **CommonJS** (which `ARCHITECTURE_ESSENTIALS.md` already documents as a
  constraint — `@docforum/escrow-sdk` is ESM-only and loaded via dynamic
  `import()`). Moving to the new `prisma-client` generator would force an
  import-path migration, an explicit `output` directory, and the ESM/`module`
  tsconfig changes, for no benefit to this fix. Recorded here so a future
  upgrade does not mistake it for an oversight.
- **`prisma.config.ts`** (new) is now the CLI's source of the datasource URL —
  v7 rejects `url` in the schema's `datasource` block and no longer loads `.env`
  implicitly, so the file imports `dotenv/config` itself. The URL is read with
  `process.env.DATABASE_URL` rather than Prisma's throwing `env()` helper so
  that `prisma generate` (which needs no database) works without one; commands
  that genuinely need a database still fail loudly.
- **`connectionTimeoutMillis: 5_000`** on the adapter, to preserve Prisma 6's
  five-second connection timeout — node-postgres defaults to no timeout (`0`),
  which would let a request against a wedged database hang indefinitely instead
  of failing fast.
- **No `ssl` option is passed.** Render decides whether a given `DATABASE_URL`
  uses TLS and expresses it in that URL; forcing an `ssl` object would break the
  internal (non-TLS) Render URL. See the consequences below.
- **`engines.node`** pinned to Prisma 7's supported range
  (`^20.19.0 || ^22.12.0 || >=24.0.0`), since Render derives its Node version
  from that field and v7 will not run on older Node.
- **CI gate** (`scripts/audit-gate.mjs`, `npm run audit:prod`) so this class of
  advisory cannot regress silently.

## Consequences

- **A new runtime dependency on node-postgres.** The connection pool is now
  `pg`'s, not Prisma's, so pool sizing/timeout behaviour is governed by `pg`
  defaults — see the connection-pool guide if limits ever need tuning.
- **SSL certificate validation is stricter than v6.** Prisma 6 (Rust engine)
  ignored invalid certificates; node-postgres verifies them by default. A
  deployment that previously worked can now fail with
  `P1010: User was denied access on the database`. This has **not** been
  verified against the live Render preview from here — it is the one item a
  post-deploy check should confirm. The documented remedy, if it appears, is
  `ssl: { rejectUnauthorized: false }` on the adapter (matching v6 behaviour),
  or configuring a trusted CA via `NODE_EXTRA_CA_CERTS`. Do not pass it
  pre-emptively: it disables certificate verification, and Render's internal
  URL does not use TLS at all.
- **`migrate dev` / `db push` no longer run `prisma generate`.** CI's build and
  Render's build command both already call `npx prisma generate` explicitly, so
  neither needed a change — but a developer running `migrate dev` locally must
  now run `generate` too (`--skip-generate` was removed).
- **`migrate diff` flags changed** (`--to-schema-datamodel` → `--to-schema`,
  `--shadow-database-url` gone in favour of `prisma.config.ts`).
  `scripts/gen-migration.mjs` was updated; `scripts/check-migration-drift.mjs`
  was added to make the "migrations still match the schema" check repeatable.
- **Automatic seeding on `migrate dev`/`migrate reset` was removed.** This repo
  has no seed script, so nothing to migrate.
- **The generated client still lands in `node_modules/@prisma/client`**, so
  imports and the CommonJS runtime are unchanged. Migration drift was verified
  as empty after the upgrade (`prisma migrate deploy` + `migrate diff
  --exit-code` → "No difference detected").
- **Client middleware (`$use`) was removed in v7.** This repo uses no client
  middleware.
- **The interactive-transaction client now exposes `$transaction`** — identical
  to the root client's — which v6's transaction client did not. The
  runtime guard in `audit.record()` used to refuse the root client by checking
  for `$transaction`, so the upgrade made it refuse *every legitimate*
  in-transaction call, aborting each audited change with it (surfaced as 16
  failing integration tests). The guard now recognises the root client by its
  lifecycle methods (`$connect`/`$disconnect` — present on the root client,
  absent on the transaction client in both v6 and v7), keeping the guarantee
  that an audit event exists iff its change committed.

## Alternatives considered

- **Pin `deepmerge-ts` via a `package.json` `overrides` entry.** Rejected: it
  forces a version underneath `@prisma/config`'s exact pin, leaves the real
  dependency graph unresolved, and does nothing about the other v7 changes
  (or the next advisory in this chain). The issue explicitly asks for the real
  upgrade.
- **Stay on 6.19.3 and accept the advisory.** Rejected: it is a high-severity
  finding in the production dependency tree, and the whole point of the issue
  was to stop carrying it.
- **Jump to `prisma@8.0.0-rc.23`** (the current `latest` dist-tag). Rejected: a
  release candidate is not an appropriate base for a security fix; 7.10.1 is the
  lowest *stable* release that clears the advisory.
- **Override `axios` to `^1.20.0` to also clear the remaining axios chain.**
  Rejected: that forces a version under `@stellar/stellar-sdk`'s exact pin
  inside a third-party SDK, and the payments path it feeds can only be exercised
  by the credential-gated testnet test — so the change could not be verified
  here. The remaining chain is documented and tolerated by the audit gate
  instead; its fix belongs in `docforum-escrow`.
