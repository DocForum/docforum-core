# changelog.d

One new file per PR for the `ROADMAP.md` changelog.

When every PR appended its entry to the end of `ROADMAP.md`, any two open PRs
edited the same lines, so each merge put most of the other PRs into conflict.
A new file per PR never collides with anyone else's.

## Adding your entry

1. Create `changelog.d/<issue-number>-<short-slug>.md`, for example
   `changelog.d/107-backup-restore-drill.md`.
2. Write the entry as plain Markdown: what changed, which issue or roadmap
   item it closes, and anything the next contributor should know. A short
   paragraph is usually enough. Don't add a date or a leading `- `: both are
   added when the entry is folded in.
3. Commit it in the same PR as your change.

For example:

```markdown
Phase 9: automated Postgres backups with a tested restore drill
([issue #107](https://github.com/DocForum/docforum-core/issues/107)).
`scripts/backup-postgres.sh` takes a gpg-encrypted `pg_dump`;
`scripts/restore-drill.sh` restores it into a `_drill` database and runs
integrity checks. No schema or endpoint changes.
```

## What not to edit in `ROADMAP.md`

- The `## Changelog` section. Put your entry here instead.
- The status summary at the top of the file and each phase's `**Status:**`
  line. Maintainers update those when they fold entries in.

Do tick your own item's checkbox (`- [ ]` → `- [x]`) and edit your own item's
line. That line is yours, so it doesn't conflict with other PRs.

## Folding entries in (maintainers)

```bash
node scripts/fold-changelog.mjs --dry-run   # preview
node scripts/fold-changelog.mjs             # append to ROADMAP.md and delete the fragments
```

Each entry is dated by the day its fragment was merged (from git history) and
appended to the end of the `## Changelog` section. Commit the result in its
own PR.
