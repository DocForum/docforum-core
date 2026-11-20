---
file: ARCHITECTURE.md
section: 2. Tech stack
---
**Linting (Phase 9, issue #28).** `npm run lint` in `backend/` runs ESLint 9
with `typescript-eslint`'s type-aware config; CI runs it after `typecheck`.
The toolchain lives in `backend/tools/lint` rather than in `backend`'s own
devDependencies because `typescript-eslint` has no TypeScript 7 support yet
(TS 7 ships no compiler API). That package pins `typescript` to the official
TypeScript 6 compatibility package (`@typescript/typescript6`), so ESLint
parses with the 6.x API while the application keeps `typescript@7` for `tsc`.
A second `package-lock.json` (and a `npm ci --prefix tools/lint` CI step) is
the cost of that split; drop the folder once typescript-eslint supports the
TS 7.1 API. The baseline enables `no-floating-promises` as an error and
deliberately leaves `no-explicit-any`, `no-console` (structured-logger
migration, issue #341) and `no-unused-expressions` off — see the header of
`backend/tools/lint/eslint.config.mjs` for the reasoning.
