Phase 9: the docs site is built on pull requests
([issue #347](https://github.com/DocForum/docforum-core/issues/347)).
`.github/workflows/build-docs.yml` runs `GITHUB_PAGES=true npm run build` in
`docs/site/` on PRs that touch the site or a document it syncs in, and stops
there — no Pages artifact, no deploy, and the job's token is `contents: read`
only, so a fork PR gets no deploy permissions. VitePress dead-link checking is
pinned on explicitly (`ignoreDeadLinks: false` in
`docs/site/.vitepress/config.ts`), which is what makes a broken internal link,
a bad front-matter block or markdown that isn't a valid Vue template fail the
PR instead of the next `main` deploy. Verified locally: the current tree
builds clean, and adding one dead link to `repos/core.md` fails the build with
`[vitepress] 1 dead link(s) found`. No schema or endpoint changes.
