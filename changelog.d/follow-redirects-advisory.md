Bumped `follow-redirects` 1.16.0 → 1.16.1 in `backend/package-lock.json`
(lockfile only; it comes in through `axios`, which allows `^1.15.x`). This
fixes GHSA-8r9p-f939-6h3c (high: credential headers can leak on redirect),
published 2026-10-20, which made the `audit:prod` CI gate fail on every PR.
No code changes.
