# Contributing to docforum-core

This is the backend of a 3-repo org (`docforum-core`, `docforum-web`,
`docforum-escrow`). This guide is for humans picking up a scoped issue —
if you're an AI coding agent, read `AGENTS.md` instead (it has the actual
architecture rules this file doesn't repeat).

## Supported Node Versions

`package.json` declares the supported Node engines: `node: ^20.19.0 || ^22.12.0 || >=24.0.0` (matching production deployment on Node 22). CI runs unit tests and typecheck across Node 20, 22, and 24 via a test matrix, while integration tests run on the production version (Node 22).

## 1. Set up locally

```bash
git clone https://github.com/DocForum/docforum-core.git
cd docforum-core/backend
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
npx prisma migrate deploy
npm run dev             # → http://localhost:4000, GET /health to check
```

You need a local Postgres for `npm run dev` (see `infra/docker/`) — but
**not** for the test suite: `npm run test` runs unit tests with no DB at
all, and `npm run test:integration` spins up its own throwaway Postgres
via the `embedded-postgres` devDependency (a prebuilt binary — no Docker,
no manual setup). `npm run test:all` runs both.

## 2. Find something to work on

Open issues are scoped, real, and tagged with a complexity/point value
(Trivial/100, Medium/150, High/200) in the issue body — see the
[issue list](https://github.com/DocForum/docforum-core/issues). Each
issue states why it matters, what to do, files likely involved, edge
cases, and how it'll be reviewed. Comment on an issue to claim it before
starting, and check it's still open.

`ROADMAP.md` shows the bigger picture: which phase an issue belongs to,
what depends on what, and what's deliberately not yet scoped (and why).

## 3. Before you open a PR

- Read `PRD.md` → `ARCHITECTURE_ESSENTIALS.md` → the relevant `ROADMAP.md`
  section for the issue you're working. `ARCHITECTURE_ESSENTIALS.md` has
  the hard rules (module boundaries, data-mutability rules like
  append-only prescriptions) — violating one of these is the most common
  way a PR gets sent back for changes.
- Tests are required in the same PR as the logic, not a follow-up —
  especially for anything touching booking, referrals, or order-issuance
  (see `AGENTS.md`'s testing rules). These are the correctness-critical
  paths in this codebase.
- If your change starts, completes, or blocks a roadmap-tracked item,
  tick or update that item's line in `ROADMAP.md` and add a changelog
  entry as a new file in `changelog.d/`, in the same PR. Don't append to
  the end of `ROADMAP.md`; that is what made every PR conflict. See
  `changelog.d/README.md`.
  A PR that finishes an issue but doesn't update the roadmap is
  incomplete.
- Don't add new lines to `ROADMAP.md`, `ARCHITECTURE.md`,
  `ARCHITECTURE_ESSENTIALS.md`, `PRD.md`, `README.md` or `docs/api/README.md`. Put new items, rows, paragraphs and
  sections in a fragment under `docs.d/` that names the doc and the heading
  (or line) they go under; a maintainer folds them in. Editing existing
  lines in place is fine. CI enforces this. See `docs.d/README.md`.
- Keep doc edits to your own lines: new lines go in `docs.d/`, and don't
  rewrite other people's paragraphs. See `AGENTS.md` → "Shared docs".
- Run `npm run typecheck && npm run test:all && npm run build` locally —
  this is exactly what CI checks.
- Run `npm run prisma:validate && npm run prisma:format:check` to verify
  the schema matches the migrations and is properly formatted. These checks
  are also run in CI (see `.github/workflows/ci.yml`).

- Run `node scripts/check-module-boundaries.mjs` to verify no new module
  boundary violations are introduced. This check is also run in CI.

If your change involves Prisma schema modifications, ensure the drift check
(`node scripts/check-migration-drift.mjs`) passes, and that a migration
exists for any new field or change.

## 3.1 Generating a new module skeleton

When an issue calls for a new backend module, start from the scaffold rather
than copying an existing module by hand:

```bash
cd backend
npm run new:module -- <name>   # lowercase kebab-case, e.g. lab-kits
```

This creates `backend/src/modules/<name>/` with `routes/`, `controllers/`,
`services/`, `repositories/`, `validation.ts` and `mount.ts`. The name must be
lowercase kebab-case; empty names, path separators, `..` and names that already
exist are refused without writing anything.

The generator deliberately does **not** edit shared files. It prints the exact
edges to add by hand: the `src/mounts.ts` export, the `PatientExportSection`
and retention-hold registry entries (only when the module holds patient data),
and a `docs.d/` fragment for the module's API rows. Generated placeholders
compile under `npm run typecheck`; replace them as the module's first real
routes and services land.

## 4. Opening the PR

- Branch off `main`.
- Reference the issue you're closing (`Closes #N`).
- State in the PR description what changed, why, and which `ROADMAP.md`
  item it maps to — not a vague "made improvements" summary. Reviewers
  are trusting the roadmap/docs to reflect real state.
- CI (typecheck, unit tests, the embedded-Postgres integration test,
  build) must pass before merge — it runs automatically on your PR.

## Found a bug instead?

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md), not
a comment on an unrelated issue — keeps scope and Wave points honest.
