Migrate fulfillment-proof attachments to object storage
([issue #316](https://github.com/DocForum/docforum-core/issues/316)).
Both `fulfillPharmacyOrder` and `fulfillLabOrder` now upload attachment data
through `getObjectStorage().putObject(...)` (S3-compatible, server-side
encrypted) instead of the legacy `storageService` stub that invented
`storage://…` placeholder URLs. The storage key is stored in
`FulfillmentProof.attachmentUrl`; `utils/storage.ts` is marked `@deprecated`.
`FulfillOrderInput.attachment` is now `{data: string; contentType?: string}`
(base64-encoded content) in both services.
