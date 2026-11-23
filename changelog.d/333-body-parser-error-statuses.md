Phase 9: malformed JSON and oversized request bodies no longer return 500
([issue #333](https://github.com/DocForum/docforum-core/issues/333)).
`errorHandler` maps body-parser failures to stable codes:
`400 INVALID_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_ENCODING`,
`415 UNSUPPORTED_CHARSET`, `400 REQUEST_ABORTED`, and `400 INVALID_REQUEST_BODY`
for a corrupt compressed body. These are logged at `warn` with only the
error type and status. The raw body, which body-parser attaches to parse
errors, is never logged. The lab-result raw-body route keeps
`LAB_RESULT_TOO_LARGE`. No schema or endpoint changes.
