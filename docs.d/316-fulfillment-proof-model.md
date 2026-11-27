---
file: ARCHITECTURE.md
section: 4.7 Fulfillment (facility-side)
---
Legacy `FulfillmentProof` (issue #316, ADR 0019): `reference_number`, `notes`,
`attachment_object_key` / `attachment_content_type` / `attachment_byte_size`
(the proof file in private object storage, server-generated key, never
returned to clients), and `legacy_attachment_url` (nullable; the
client-supplied value the pre-#316 endpoints stored — kept for history,
untrusted, never written again or served as a link).
