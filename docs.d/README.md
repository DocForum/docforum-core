# docs.d

New content for the shared docs goes here, one file per change, instead of
straight into the doc.

When every PR added its lines to `ROADMAP.md`, `ARCHITECTURE.md`
and the other shared docs, most PRs inserted text at the same few places, so
each merge put the other open PRs into conflict. A new file per PR never
collides with anyone else's. A maintainer folds the fragments into the docs
in batches.

The shared docs are listed in [`config.json`](config.json). For this repo:
`ROADMAP.md`, `ARCHITECTURE.md`, `ARCHITECTURE_ESSENTIALS.md`, `PRD.md`,
`README.md` and `docs/api/README.md`.

## The rule

In a shared doc, **change existing lines in place, but don't add new ones**.
CI fails a PR whose diff adds lines to a shared doc.

- Ticking your item's checkbox (`- [ ]` → `- [x]`) or correcting a line is
  fine: that's an in-place change.
- A new roadmap item, paragraph, table row, API listing line or section goes
  in a fragment.
- Changelog entries still go in [`changelog.d/`](../changelog.d/README.md).

## Writing a fragment

Create `docs.d/<issue-number>-<short-slug>.md` (add `-2`, `-3` for more than
one). Each fragment adds one block of text to one place in one doc. Start it
with a front matter block naming the doc and where the text goes, then write
the text exactly as it should appear.

**Under a heading** (`section:`), for example a new roadmap item:

```markdown
---
file: ROADMAP.md
section: Phase 4 — Orders: prescriptions & lab orders
---
- [x] Prescription renewal requests (issue #321): patients ask the issuing
  doctor to renew; the renewal is a new append-only prescription.
```

or a new endpoint row in the API docs:

```markdown
---
file: docs/api/README.md
section: Intake (/intake) — backend/src/modules/intake
---
| `DELETE /intake/:id` | patient | — | Withdraws the caller's own draft intake. |
```

- The text goes at the end of that heading's own text, before its first
  subheading. If your text starts with its own heading (`### …`), it goes at
  the end of the whole section instead, after the existing subsections.
- Headings are matched without the `#`s, ignoring case and backticks. If the
  same heading appears twice, name its parent too:
  `section: Parent heading > Repeated heading`.
- List items and table rows join the list or table they follow; anything else
  is separated by a blank line.

**After a specific line** (`after:`), when the text belongs in the middle of
a section, for example right after an existing table row:

```markdown
---
file: docs/api/README.md
after: "| `POST /intake` | patient |"
---
| `PATCH /intake/:id` | patient | `{ freeTextNotes }` | Edits the caller's own draft intake. |
```

- `after:` is any text that appears on exactly one line of the doc. Quote
  enough of the line to make it unique. CI tells you if it matches no line or
  more than one.
- Inside a fenced code block, your lines are inserted exactly as written.

Several fragments may target the same place; they go in filename order.

CI (`Docs fragments`) checks that every fragment folds cleanly against the
current docs, so a typo in a heading fails your PR instead of the fold. To
check locally:

```bash
node scripts/docs-fragments.mjs check origin/main
```

## Folding (maintainers)

```bash
node scripts/docs-fragments.mjs fold --dry-run   # preview
node scripts/docs-fragments.mjs fold             # apply and delete the fragments
```

Commit the result in its own PR, together with the `changelog.d/` fold if one
is due. Maintainer PRs skip the "no new lines" rule (CI passes `--maintainer`
for org members), but fragments are still validated.
