CI: fork PRs' workflow runs are now approved automatically once they pass
security review (`PR CI auto-approval`, the same workflow docforum-web uses
since #350). The workflow runs after `PR malware scan` succeeds. It re-runs
the scanner, then checks the diff and every commit in the PR's history for
workflow, editor-config, font, payload-loader, npm-script, lockfile
(npm/crates.io) and Go `replace` changes, and requires every commit to come
from the PR author, a known AI coding tool account or a GitHub update merge. A
PR that fails any check is labelled `ci-needs-manual-approval` and waits for a
maintainer, as before.
