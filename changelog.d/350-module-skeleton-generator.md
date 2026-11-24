Phase 9: added `npm run new:module -- <name>` (`backend/scripts/new-module.mjs`),
which scaffolds a backend module skeleton under `backend/src/modules/` with
the intentional `routes/controllers/services/repositories` folders,
`validation.ts` and `mount.ts`. Names are validated as lowercase kebab-case and
existing modules are never overwritten. Shared wiring (`src/mounts.ts`,
export/retention registries, API docs rows) is not edited automatically; the
generator prints the exact follow-ups instead. Documented in `CONTRIBUTING.md`.
No model or endpoint changes.
