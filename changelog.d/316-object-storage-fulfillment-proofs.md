Phase 5: fulfillment proof files go to private object storage behind an
access check ([issue #316](https://github.com/DocForum/docforum-core/issues/316)).
`POST /pharmacy-orders/:id/fulfill` and `POST /lab-orders/:id/fulfill` no
longer take an attachment (a client URL or inline data is a `400`). The
recording facility uploads the file afterwards as the raw request body of
`PUT /fulfillment-proofs/:proofId/attachment`, the same pattern as lab results
(ADR 0018): PDF/PNG/JPEG only, matching magic bytes, a size cap
(`FULFILLMENT_PROOF_MAX_BYTES`, default 10 MiB), the malware scanner, a
server-generated object key and an audit event; one file per proof.
`GET /fulfillment-proofs/:proofId/attachment` serves it to the order's patient
(or an active guardian), that facility and admins, `404` for anyone else, and
writes an access-log row. The migration renames the old client-supplied
`FulfillmentProof.attachmentUrl` to `legacyAttachmentUrl` (kept, untrusted,
never served) and adds `attachmentObjectKey`/`attachmentContentType`/
`attachmentByteSize`; order responses never include the object key. A
fulfilling facility must also be the one an order was routed to, if any.
`utils/storage.ts` (the URL-echoing stub) is removed.
