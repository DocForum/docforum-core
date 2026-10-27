# docs/site

Documentation site for the whole `DocForum` org — `docforum-core`,
`docforum-web`, `docforum-escrow` — built with [VitePress](https://vitepress.dev).

**Live:** https://docforum.github.io/docforum-core/ (deploys on every push
to `main` that touches docs in this repo, manual `workflow_dispatch`, or
`repository_dispatch` from sibling repos — see
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

## Rebuilding on upstream changes (cross-repo docs sync)

The site deploys automatically when documentation changes land in `docforum-core`.
When documentation changes land on `main` in sibling repositories (`docforum-web`
or `docforum-escrow`), the site is rebuilt via GitHub's `repository_dispatch` event
([issue #29](https://github.com/DocForum/docforum-core/issues/29)).

`.github/workflows/deploy-docs.yml` listens for `repository_dispatch` with event
types `upstream-docs-updated` and `docs-sync`.

### Token setup (minimum required scope)

Triggering a `repository_dispatch` event in `docforum-core` from an external repository
requires an authenticated token with permission to trigger dispatches on `docforum-core`.
Store this token as a secret (e.g. `DOCS_SYNC_DISPATCH_TOKEN`) in `docforum-web`
and `docforum-escrow`.

#### Option A: Fine-grained Personal Access Token (PAT) — Recommended for users
A fine-grained PAT limits access strictly to `docforum-core`:
1. Navigate to **GitHub Settings → Developer Settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** `DocForum`
3. **Repository access:** *Only select repositories* → choose **`docforum-core`** only.
4. **Permissions:**
   - **Repository permissions → Contents: Read and write** (the GitHub REST API `POST /repos/{owner}/{repo}/dispatches` requires write access to repository contents).
5. Add the generated token as a secret named `DOCS_SYNC_DISPATCH_TOKEN` in the repository settings of `docforum-web` and `docforum-escrow`.

*(Note: If using a classic PAT instead, only `repo` or `public_repo` scope is required, though fine-grained PATs or GitHub Apps are preferred for least-privilege isolation).*

#### Option B: GitHub App installation token — Recommended for organizations
For automated organization-level workflows without user-bound credentials:
1. Create a GitHub App in the `DocForum` organization with **Repository permissions → Contents: Read & write**.
2. Install the App with access limited exclusively to **`docforum-core`**.
3. In the sibling workflow, use `actions/create-github-app-token` (providing App ID and private key stored as secrets) to generate a short-lived token scoped only to `docforum-core`.

### Sibling repository sender workflow

In each sibling repo (`docforum-web`, `docforum-escrow`), add a workflow (e.g. `.github/workflows/dispatch-docs-sync.yml`):

```yaml
name: Dispatch docs sync

on:
  push:
    branches: [main]
    paths:
      - 'README.md'
      - 'ARCHITECTURE_ESSENTIALS.md'
      - 'ROADMAP.md'
      - 'docs/**'

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger docs site rebuild in docforum-core
        run: |
          gh api repos/DocForum/docforum-core/dispatches \
            --input - <<< '{
              "event_type": "upstream-docs-updated",
              "client_payload": {
                "repository": "${{ github.repository }}",
                "ref": "${{ github.ref }}",
                "sha": "${{ github.sha }}"
              }
            }'
        env:
          GH_TOKEN: ${{ secrets.DOCS_SYNC_DISPATCH_TOKEN }}
```
