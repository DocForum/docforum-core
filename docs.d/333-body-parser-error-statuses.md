---
file: docs/api/README.md
section: Health
---
Request-body errors (issue #333), on every route that parses JSON:
`400 INVALID_JSON` (malformed JSON), `413 PAYLOAD_TOO_LARGE` (over
`express.json()`'s limit), `415 UNSUPPORTED_ENCODING` (unknown
`Content-Encoding`), `415 UNSUPPORTED_CHARSET`, `400 REQUEST_ABORTED`, and
`400 INVALID_REQUEST_BODY` (e.g. a corrupt gzip body), all in the
`{ message, code }` envelope. The lab-result upload keeps its own
`413 LAB_RESULT_TOO_LARGE`.
