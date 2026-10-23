Phase 5: webhook security primitives for facility notifications
([issue #126](https://github.com/DocForum/docforum-core/issues/126), partial).
`src/utils/webhook-security.ts` adds HTTPS-only URL validation, blocks
private, loopback, link-local and metadata IP literals, signs payloads with
HMAC-SHA256 over `timestamp.body`, and computes capped exponential retry
delays. Registration, the outbox, the delivery log and the schema are not
included yet.
