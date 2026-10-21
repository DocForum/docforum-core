Contributing: changelog entries now go in `changelog.d/` (one new file per
PR) instead of being appended to this section, which used to put most open
PRs into merge conflict on every merge. Maintainers fold them in with
`node scripts/fold-changelog.mjs`. Also dropped the "Last updated" line,
made the `docs/api/README.md` intro phase-agnostic, and documented the
"edit only your own lines" rule in `AGENTS.md`, `CLAUDE.md` and
`CONTRIBUTING.md`. The conflict notifier now points authors at
`changelog.d/`.
