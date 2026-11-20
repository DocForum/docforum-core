---
file: docs/api/README.md
section: Consultations (`/consultations` + `/appointments`) — `backend/src/modules/consultations`
---
### Async thread, attachments, follow-ups and sign-off (Phase 2, issues #61–#64)

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `GET /consultations/:consultationId/messages` | patient (own visit) or treating doctor | — | Issue #61. Oldest-first keyset page: `?limit=1..100&cursor=<messageId>` returns `{ messages, nextCursor }`. Bodies decrypted, attachments metadata only (no object key). Non-participants get `403`; another patient's consultation is invisible (`404`) through RLS. |
| `POST /consultations/:consultationId/messages` | participants, verified email | `{ body?, attachments?: [{ fileName, contentType, dataBase64 }] }` | Appends. Text or ≥1 attachment required. `409 CONSULTATION_THREAD_CLOSED` after `CONSULTATION_THREAD_CLOSE_AFTER_DAYS`. Attachments: JPEG/PNG/PDF, sniffed, ≤ `CONSULTATION_ATTACHMENT_MAX_BYTES` each, ≤ 5 per message, per-user quota; EXIF stripped. |
| `GET /consultations/messages/attachments/:attachmentId/download-url` | participants | — | Mints `{ url, expiresAt }`, valid for `CONSULTATION_ATTACHMENT_URL_TTL_SECONDS` (default 300). Membership re-checked here on every call. |
| `GET /consultations/messages/attachments/:attachmentId/file?expires=&signature=` | signed URL (no auth header) | — | Serves the bytes while the HMAC signature and expiry are valid; `403 ATTACHMENT_LINK_INVALID` otherwise. `Cache-Control: private, no-store`. |
| `PATCH /consultations/:consultationId/notes` | authoring doctor, verified email | `{ notes }` | Issue #64. Conditional update while unsigned; `409 CONSULTATION_NOTE_SIGNED` after sign-off. |
| `POST /consultations/:consultationId/sign-off` | authoring doctor, verified email | — | Signs once. `409 CONSULTATION_ALREADY_SIGNED` on a second attempt. |
| `POST /consultations/:consultationId/addenda` | authoring doctor, verified email | `{ body }` | Post-sign-off correction, append-only. `409 CONSULTATION_NOTE_NOT_SIGNED` before sign-off. `GET /consultations/:id` returns `signedAt` and the addenda in order. |
| `GET /follow-ups/mine` | patient | `?status=open\|booked\|expired` | Issue #63. Own follow-up requests, newest first, decrypted note snapshot. |
| `POST /follow-ups/:followUpId/book` | patient (own request), verified email | `{ availabilitySlotId }` | Books through the standard conditional slot claim; appointment origin `follow_up`. `409 FOLLOW_UP_ALREADY_BOOKED` / `FOLLOW_UP_EXPIRED`. |

Documents the close route's `followUpWindowStart` / `followUpWindowEnd`
(optional, both together, ISO-8601) for the follow-up window.
