# AGENTS.md

Instructions for any coding agent (human-directed or autonomous) working in this repository.

## Read this first, in this order
1. `PRD.md` — what we're building and for whom.
2. `ARCHITECTURE_ESSENTIALS.md` — the fast-reference rules. Don't skip this even if `ARCHITECTURE.md` feels like the "real" doc — essentials exists so you don't have to load the whole architecture doc into context for every small task.
3. `ARCHITECTURE.md` — full reasoning, only when you need the "why," or when a task touches data models / module boundaries / tech stack.
4. `ROADMAP.md` — current phase, what's done, what's next, what's explicitly not started.

## Non-negotiable rules
- Follow the **Hard rules** section in `ARCHITECTURE_ESSENTIALS.md` exactly. These are not style preferences — violating them (e.g., mutating a `Prescription` after issuance, app-level slot booking checks instead of DB-level) reintroduces the exact bug classes the architecture was designed to prevent.
- **Never invent a data model field or table that isn't in `backend/prisma/schema.prisma`.** If a task needs a new field/table, propose the schema change explicitly in the PR description and update `ARCHITECTURE.md` §4 in the same PR.
- **Never cross a module boundary directly.** If module A needs data from module B, call B's exported service — do not import B's repository or query B's tables directly from A.
- Keep the module folder shape consistent: `routes/ controllers/ services/ repositories/`. If a module doesn't need one of these yet, leave the folder with a placeholder file rather than deleting it — folder structure is intentional scope-marking (see scaffold rationale in ROADMAP.md intro).

## Documentation is part of the contribution — not optional
Every PR/commit that does any of the following **must** update the relevant doc in the same change:
| Change | Update |
|---|---|
| Adds/changes a data model or table | `ARCHITECTURE.md` §4 + `ARCHITECTURE_ESSENTIALS.md` data model map if it affects the summary |
| Adds/removes a module or changes a module boundary | `ARCHITECTURE.md` §3 + `ARCHITECTURE_ESSENTIALS.md` |
| Changes tech stack / adds a dependency that's architecturally significant (new infra, new provider) | `ARCHITECTURE.md` §2, and add an ADR in `docs/adr/` if it reverses or overrides a prior stack decision |
| Completes, starts, or blocks a roadmap item | **`ROADMAP.md` — always.** Move the item, update its status, add a one-line note if you discovered new scope. This is required for every PR that touches roadmap-tracked work, no exceptions. |
| Resolves or discovers a "hard question" / edge case / overengineering flag in PRD.md §8 or ARCHITECTURE.md §6 | Update that section — mark resolved with a short note, or add the newly discovered item. Do not silently drop these. |

**If you're not sure whether a change is "significant enough" to need a doc update: update the doc.** A stale doc is worse than a slightly over-documented one in this repo, because other agents/contributors treat these files as ground truth before reading code.

## Working style
- Small, independent, reviewable units of work. This repo is explicitly structured (see ROADMAP.md issue breakdown) so contributors can pick up one piece without being blocked by another — respect that when scoping your own changes too.
- Prefer the "boring" solution described in `ARCHITECTURE.md` over a cleverer one, especially around concurrency (booking) and data mutability (orders). Cleverness there is a liability, not a feature.
- When you hit an unresolved design gap listed in `ARCHITECTURE_ESSENTIALS.md` ("Known unresolved design gaps"), don't silently invent a resolution — implement the smallest reasonable default, note the assumption in the PR description, and leave the gap noted (or mark it resolved if your PR actually closes it).
- Tests: booking, referral, and order-issuance flows are correctness-critical (see ARCHITECTURE.md §7) — these need integration tests, not just unit tests, before being considered done.

## For CLAUDE.md
`CLAUDE.md` in this repo defers to this file for substantive project rules and only adds Claude-specific operating notes (tool usage, file skills, etc.). Keep the two in sync — don't duplicate rules, reference them.
