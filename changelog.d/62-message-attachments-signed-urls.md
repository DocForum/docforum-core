Phase 2: message attachments with access-checked short-lived URLs
([issue #62](https://github.com/DocForum/docforum-core/issues/62)).
JPEG/PNG/PDF only, byte-sniffed, EXIF/GPS and PNG text metadata stripped on
upload, per-message cap and per-user quota. Downloads require thread membership
to mint an HMAC-signed URL that expires after `CONSULTATION_ATTACHMENT_URL_TTL_SECONDS`;
object keys are never returned.
