Shared docs now take new content as fragments: a PR adds a file under
`docs.d/` naming the doc and the heading (or line) its text goes under,
instead of adding lines to `ROADMAP.md`, `ARCHITECTURE.md`,
`ARCHITECTURE_ESSENTIALS.md`, `PRD.md`, `README.md` or `docs/api/README.md`. Maintainers fold them with
`node scripts/docs-fragments.mjs fold`. The new `Docs fragments` CI job fails
PRs that add lines to those docs directly or whose fragments don't fold.
