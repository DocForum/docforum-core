# Contributing to docforum-core

This is the backend of a 3-repo org (`docforum-core`, `docforum-web`,
`docforum-escrow`). This guide is for humans picking up a scoped issue —
if you're an AI coding agent, read `AGENTS.md` instead (it has the actual
architecture rules this file doesn't repeat).

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
  update `ROADMAP.md` in the same PR. A PR that finishes an issue but
  doesn't update the roadmap is incomplete.
- Run `npm run typecheck && npm run test:all && npm run build` locally —
  this is exactly what CI checks.

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
