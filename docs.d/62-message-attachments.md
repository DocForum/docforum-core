---
file: ARCHITECTURE.md
section: 4.3 Consultation
---
**Phase 2, issue #62 — thread attachments (implemented 2026-11-20).**
```
ConsultationMessageAttachment
  id, message_id (FK -> ConsultationMessage, RESTRICT)
  object_key (UNIQUE, opaque, never returned to a client)
  file_name, content_type, size_bytes, created_at
```
Bytes live in the private object store (§2 / docs/adr/0014) through
`utils/object-storage.ts`; no business code imports the SDK and no public or
presigned storage URL is ever returned. Upload accepts JPEG, PNG and PDF only:
the declared content type must be on that allowlist **and** match the sniffed
bytes, so SVG (script injection), executables and mismatches are `400`.
Images are passed through `utils/image-metadata.ts` before storage — JPEG
APP1–APP15/COM segments (EXIF, GPS) and PNG `eXIf`/text chunks are dropped;
PDFs are stored unchanged. The per-message cap is
`CONSULTATION_ATTACHMENT_MAX_PER_MESSAGE` (5) and the per-user quota is
`CONSULTATION_ATTACHMENT_QUOTA_BYTES` (50 MB), measured over messages that
user sent (`413 ATTACHMENT_QUOTA_EXCEEDED`).

Downloads are authorised twice: `GET
/consultations/messages/attachments/:id/download-url` checks thread membership
on every call and mints an HMAC-signed URL `/consultations/messages/attachments/:id/file?expires=&signature=`
valid for `CONSULTATION_ATTACHMENT_URL_TTL_SECONDS` (default 5 minutes); that
endpoint has no auth middleware because the unexpired signature is the
authorisation. Messages and attachments are append-only, so a mistaken upload
is followed by a corrective message (or an operator action); it is not deleted
through the API.
