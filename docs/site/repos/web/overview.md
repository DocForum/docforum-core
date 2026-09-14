# docforum-web

**[github.com/DocForum/docforum-web](https://github.com/DocForum/docforum-web)** · Apache-2.0

The frontend. Owns presentation only — talks exclusively to `docforum-core`'s API, and never calls `docforum-escrow` or any Stellar SDK directly (a hard rule, since payment/escrow state is `docforum-core`'s to expose, not this repo's to reach for on its own).

Full product context (the flows this repo implements screens for) lives in `docforum-core`'s [PRD](/product/prd) — this repo's own docs cover frontend-specific rules only. See its full [README](/repos/web/readme) and [architecture essentials](/repos/web/architecture).

## Stack

React + TypeScript + Vite, React Query for server state, Zustand for client-only state. Fraunces + IBM Plex Sans, a solid pine-and-brass palette (no gradients), GSAP for two deliberate motion moments rather than applied broadly.

## Status

**Phase W1 (shell & auth): built and connected to a live backend.** Signup/login work end-to-end against `docforum-core`'s Render deployment. Phases W2–W5 (the actual patient/doctor/facility flow screens) aren't started yet — blocked on `docforum-core`'s Phase 2+.

Full breakdown: [roadmap](/repos/web/roadmap).

## Live preview

**[docforum.github.io/docforum-web](https://docforum.github.io/docforum-web/)** — deployed on every push to `main`. A real preview, not a mockup: signup/login genuinely work, backed by `docforum-core`'s live (free-tier, cold-starts after 15min idle) instance.
