Phase 5: lab result attachment on object storage
([issue #16](https://github.com/DocForum/docforum-core/issues/16)).

Provider decision, recorded in `docs/adr/0014-lab-result-object-storage.md`:
**Amazon S3**, one private, SSE-S3-encrypted bucket per environment, reached
through the official `@aws-sdk/client-s3` (new dependency). The SDK is wrapped
by `backend/src/utils/object-storage.ts` and nothing else imports it. Any
S3-compatible endpoint (MinIO locally) works through
`OBJECT_STORAGE_ENDPOINT`. Files are never addressed by URL. The `LabResult`
row stores an opaque, server-generated key (`lab-results/<uuid>`) that is
never returned to a client, and the API serves the bytes after an access
check on every read. Presigned URLs were rejected because they are bearer
credentials, they can't be revoked, and reads through them skip the access log.

Endpoints, both in the `orders` module (which owns `LabOrder`):
`POST /orders/lab-orders/:labOrderId/result` takes a raw PDF/PNG/JPEG body
(the bytes must match the declared type; size limit `LAB_RESULT_MAX_BYTES`,
default 10 MiB). Only the facility the order was issued to can attach. Other
facilities get `404`. The attach is create-once (`409`), refused on a
superseded order (`409`), and audited as `lab_result.attached`.
`GET /orders/lab-orders/:labOrderId/result` serves the file (`no-store`,
`nosniff`, attachment) to the patient, the ordering doctor and the
fulfilling facility only (PRD §7). Everyone else, including admins, gets the
same `404` as a missing order, and every read is written to the PHI access
log. The `LabOrder` row and its status are not touched (hard rule 1), and
neither is `FulfillmentRecord` (hard rule 5; the `fulfilled` transition is
still #15).

Schema: `LabResult` gains `resultObjectKey` (unique), `resultContentType` and
`resultByteSize` (migration `20261024090000_lab_result_object_storage`).
`resultFileUrl` stays in place but is not written.
Config: `OBJECT_STORAGE_DRIVER` (`s3`/`memory`/`none`; `memory` is refused in
production), `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, and the
optional endpoint/path-style settings. With no bucket configured the server
still starts and these endpoints return `503 OBJECT_STORAGE_NOT_CONFIGURED`.

Known gaps, added to ARCHITECTURE.md §6.2: the right-of-access export lists
the result row but not the file bytes, and read access mirrors consultation
notes, so guardians of dependents and later doctors in a referral thread
can't read a result. The existing `utils/storage.ts` stub used by the #76
fulfillment-proof `attachmentUrl` is unchanged and still stores nothing.
Tests: `backend/tests/integration/lab-result-attachment.test.mts`
and `backend/tests/unit/object-storage.test.ts`.
