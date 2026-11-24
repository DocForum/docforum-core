---
file: docs/api/README.md
after: "Base URL: `http://localhost:4000` locally (`PORT` in `.env`). No OpenAPI spec yet"
---
**Which role reaches which route is generated, not hand-kept:**
`docs/api/access-matrix.md`, built from the routers by
`backend/scripts/gen-access-matrix.ts` (`npm run docs:access-matrix` in
`backend/`) and checked for staleness in CI (issue #357). The tables below stay
the place for request/response shapes and behaviour; the matrix is the access
view, and it covers endpoint guards only — the service-level ownership checks
that narrow a response further are listed as a limitation there.
