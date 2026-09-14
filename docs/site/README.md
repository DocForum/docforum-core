# docs/site

Documentation site for the whole `DocForum` org — `docforum-core`,
`docforum-web`, `docforum-escrow` — built with [VitePress](https://vitepress.dev).

**Live:** https://docforum.github.io/docforum-core/ (deploys on every push
to `main` that touches this folder or this repo's own root docs — see
`.github/workflows/deploy-docs.yml`).

## The one rule this is built around

**No content here is hand-maintained.** Every page under `product/`,
`architecture/`, `api/`, `roadmap/`, and `repos/*/readme.md` /
`architecture.md` / `roadmap.md` / `adr-*.md` is synced at build time by
`scripts/sync-docs.mjs` — this repo's own root docs are copied locally,
`docforum-web`'s and `docforum-escrow`'s are fetched from their `main`
branch on GitHub. **Never edit a synced file directly** — it's
regenerated (and gitignored) on every `dev`/`build`, so edits are silently
lost. Edit the source instead:

- This repo's docs → `../../PRD.md`, `../../ARCHITECTURE.md`,
  `../../ARCHITECTURE_ESSENTIALS.md`, `../../ROADMAP.md`,
  `../../docs/adr/*.md`, `../../docs/api/README.md`.
- `docforum-web`'s / `docforum-escrow`'s docs → their own repos.

Only `.vitepress/` (config, theme) and the hand-authored pages
(`index.md`, `repos/core.md`, `repos/web/overview.md`,
`repos/escrow/overview.md`) are real source, committed normally.

## Local development

```bash
cd docs/site
npm install
npm run dev      # syncs, then starts the dev server
```

`npm run build` does the same sync, then a production build to
`.vitepress/dist/` (gitignored). `npm run docs:sync` alone just refreshes
the synced content without starting/building anything.

## Known gap

Only triggers a rebuild on a push to *this* repo. A docs-relevant change
landing in `docforum-web` or `docforum-escrow` alone doesn't rebuild this
site automatically — see the note at the top of
`../../.github/workflows/deploy-docs.yml` for what closing that gap would
take (a sender workflow in each sibling repo + a cross-repo token). Not
built yet. In the meantime: `workflow_dispatch` triggers a manual rebuild.
