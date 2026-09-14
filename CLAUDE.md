# CLAUDE.md

This file is Claude-specific. All substantive project rules (module boundaries, hard architecture rules, doc-update requirements) live in **`AGENTS.md`** — read that first. This file only adds operating notes specific to Claude working in this repo.

## Read order (same as AGENTS.md)
`PRD.md` → `ARCHITECTURE_ESSENTIALS.md` → `ROADMAP.md` (current phase) → `ARCHITECTURE.md` only when a task needs the full "why."

Don't load `ARCHITECTURE.md` in full for a small, single-module task — `ARCHITECTURE_ESSENTIALS.md` exists specifically so you don't have to.

## Mandatory: update ROADMAP.md every contribution
Same rule as in AGENTS.md, stated again because it's the single most commonly skipped step: **any change that starts, completes, or blocks a roadmap-tracked item must update `ROADMAP.md` in the same turn/commit.** If you're generating a PR description, the roadmap update belongs in the same diff, not a follow-up.

## Skill usage in this repo
- Creating/editing `.docx`/`.pdf`/`.pptx`/`.xlsx` deliverables (e.g., a stakeholder-facing PRD export): use the relevant skill under `/mnt/skills/public/`. Default docs (`PRD.md`, `ARCHITECTURE.md`, etc.) stay Markdown in-repo — don't convert them to Word/PDF unless explicitly asked.
- When scaffolding or editing backend/frontend files, prefer `str_replace`/`view` on real files in the repo over regenerating whole files, once the repo has real content beyond scaffolding.

## Scope discipline
This repo was deliberately scaffolded (empty/near-empty files, full folder structure) before feature work began, specifically so scope is visible up front. When implementing:
- Do not add new top-level folders without updating `ARCHITECTURE.md` §3 (module boundaries) or §2 (stack) as applicable.
- Do not fill in a module beyond what the current `ROADMAP.md` phase calls for. Building ahead of the roadmap creates review burden and violates the "small independent units" working style in AGENTS.md.

## Hard questions discipline
`PRD.md` §8 and `ARCHITECTURE.md` §6 contain open "what would break / edge cases / overengineered" questions. When a task touches one of these areas:
1. Check whether the task resolves, worsens, or is orthogonal to a listed item.
2. If resolves: mark it resolved with a one-line note in place.
3. If worsens or reveals a new one: add it, don't skip past it silently.

## Communication style for this repo
When summarizing work in this repo (PR descriptions, chat responses), state directly what changed, what doc was updated, and what roadmap item it maps to. Avoid vague "made improvements" summaries — contributors are picking up independent issues and need to trust the roadmap/docs reflect real state.
