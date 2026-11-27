---
file: docs/api/README.md
after: "Base URL: `http://localhost:4000` locally (`PORT` in `.env`). No OpenAPI spec yet — TBD, tracked informally, not blocking Phase 1."
---
## Errors and error codes (issue #115)

Every failed request answers with the same envelope:

```json
{ "code": "SLOT_TAKEN", "message": "This slot is no longer available." }
```

- `code` — stable, machine-readable, and the field clients must branch on. It is
  always present.
- `message` — human-readable, may be translated and may change between
  releases. Kept for backwards compatibility; never match on its text.
- `details` — present only when the code carries structured, non-sensitive
  context. Validation failures put one entry per failing field in
  `details.fields[]`: `{ path, code, message }`.

HTTP status is derived from the code (a code always answers with the same
status). The full list — code, status, meaning and client guidance — is
generated from `backend/src/error-catalogue.ts` into
[`docs/api/error-catalogue.md`](error-catalogue.md); that file is the
reference, not a hand-maintained copy.

Two codes are worth calling out because they replace whole classes of
otherwise-uncoded failures:

- `400 VALIDATION_FAILED` — any schema-validation failure. The specific
  per-field validation code is inside `details.fields[].code`. A schema
  refinement that carries its own catalogue code (for example
  `PASSWORD_TOO_SHORT`) keeps answering with that code at the top level, as
  it did before the catalogue, so existing clients are unaffected.
- `500 INTERNAL` — any unexpected error. The response is always
  `{ "code": "INTERNAL", "message": "Internal server error." }`; no exception
  message, stack, table name, column or constraint is ever returned.

Codes that clients commonly branch on include `409 SLOT_TAKEN` (double-booking
loser), `403 EMAIL_NOT_VERIFIED`, `409 EMAIL_TAKEN`, `428 IF_MATCH_REQUIRED` /
`412 VERSION_CONFLICT` (optimistic concurrency), `409 WALLET_NOT_LINKED`,
`409 FACILITY_WALLET_NOT_LINKED`, `422 REFERRAL_NO_ELIGIBLE_TARGET`,
`422 PRICE_ON_REQUEST`, and the `SEP10_*` / `LAB_RESULT_*` families.
