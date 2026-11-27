---
file: docs/api/README.md
section: Pharmacy orders (`/pharmacy-orders`) — `backend/src/modules/pharmacy-orders`
---
Legacy order fulfillment proofs (issue #316). `POST /pharmacy-orders/:id/fulfill`
and `POST /lab-orders/:id/fulfill` take `{ referenceNumber, notes? }` only
(strict: an `attachment` field is a `400`); the proof file is uploaded
separately. The module also mounts `/fulfillment-proofs`:

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `PUT /fulfillment-proofs/:proofId/attachment` | the facility that recorded the proof (verified email) | raw file, `Content-Type: application/pdf`, `image/png` or `image/jpeg` | `201 { proofId, orderId, contentType, byteSize }`. `415` for another type or bytes that don't match it, `413` above `FULFILLMENT_PROOF_MAX_BYTES`, `422` if the scanner flags it, `409 PROOF_ALREADY_ATTACHED` on a second upload, `404` for any other facility. Stored under a server-generated key; never a client URL. |
| `GET /fulfillment-proofs/:proofId/attachment` | the order's patient (`?patientProfileId=` for an active guardian), the recording facility, admin | — | The file, `Cache-Control: no-store`, `nosniff`, as an attachment. `404` for anyone else, and `404 PROOF_FILE_NOT_FOUND` when no file was uploaded (including pre-#316 rows, whose untrusted `legacyAttachmentUrl` is never served). Writes an access-log row. |
