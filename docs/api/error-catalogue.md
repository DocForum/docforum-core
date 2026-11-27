# Error catalogue

Every failed request answers with the same envelope:

```json
{ "code": "SLOT_TAKEN", "message": "This slot is no longer available." }
```

`code` is stable: branch on it. `message` is human-readable, may be
translated, and may change between releases, so never match on its text.
`details` is present only when the code carries structured, non-sensitive
context — validation failures put one entry per failing field in
`details.fields[]` (`path`, field-level `code`, `message`).

HTTP status is fixed by the code: `backend/src/error-catalogue.ts` is the
single source of truth, and `HttpError` derives the status from it.

This page is generated — edit the catalogue and run
`npm run errors:catalogue` in `backend/` instead of editing this file.

## Shared: envelope, auth middleware, request parsing

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `ACCESS_TOKEN_ACCOUNT_DEACTIVATED` | 401 | The account behind the access token was deactivated after the token was issued. | Contact an administrator; do not keep retrying with the token. |
| `ACCOUNT_DEACTIVATED` | 403 | An administrator deactivated the account. | Contact an administrator; signing in again will not help. |
| `AUTHENTICATION_REQUIRED` | 401 | The route needs an authenticated caller and none was supplied. | Sign in and send the access token as Authorization: Bearer &lt;token&gt;. |
| `CONFLICT` | 409 | The resource changed, or is not in the state the request needs. | Re-read the resource, then retry if the operation still makes sense. |
| `CSRF_TOKEN_MISSING` | 403 | The cookie-authenticated route needs the per-session CSRF token. | Send X-CSRF-Token with the csrfToken returned by signup/login/refresh. |
| `DUPLICATE_RECORD` | 409 | A database uniqueness constraint was violated. The response never names the column or constraint. | Use a different value; retrying unchanged cannot succeed. |
| `EMAIL_NOT_VERIFIED` | 403 | The route is gated on a verified email address (booking, referrals, payment mutations). | Verify the address through POST /auth/verify-email, then retry immediately — the guard reads the database. |
| `FORBIDDEN` | 403 | The caller is authenticated but lacks the role or ownership the route requires. | Use an account with the required role; retrying changes nothing. |
| `GONE` | 410 | The resource existed but has expired permanently. | Request a new one; retrying the same identifier will not work. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | The key is bound to a different method/path/body. | Use a fresh key for a different request. |
| `IF_MATCH_REQUIRED` | 428 | A mutable-resource write omitted the optimistic-concurrency precondition. | GET the resource and send its ETag as If-Match on the write. |
| `IN_PROGRESS` | 409 | The first request with this key has not finished yet. | Retry with the same key after a short backoff; do not change the key. |
| `INTERNAL` | 500 | An unexpected server error. No internal detail is ever returned. | Retry later; if it persists, report the request id from the X-Request-Id response header. |
| `INVALID_ACCESS_TOKEN` | 401 | The access token is malformed, expired or no longer valid. | Refresh the session, then retry. |
| `INVALID_BEARER_TOKEN` | 401 | A bearer token presented to a verifier was rejected. | Sign in again and retry with the new token. |
| `INVALID_CREDENTIALS` | 401 | The email/password pair is wrong. The response is identical for unknown accounts. | Check the credentials; use the password-reset flow if forgotten. |
| `INVALID_CURSOR` | 400 | The pagination cursor is malformed or was not issued by this endpoint. | Restart pagination without a cursor and use the returned nextCursor. |
| `INVALID_IDEMPOTENCY_KEY` | 400 | The key is empty, too long or not printable ASCII. | Send a 1–255 character printable ASCII key. |
| `INVALID_IF_MATCH` | 400 | The If-Match value is weak, a list, or not a version ETag. | Send exactly the strong ETag returned by the individual-resource read. |
| `INVALID_JSON` | 400 | The body could not be parsed as JSON. | Fix the JSON syntax and retry. |
| `INVALID_PATH_PARAMETER` | 400 | Express could not give the route a single string value for the parameter. | Send exactly one value for the parameter and retry. |
| `INVALID_REFERENCE` | 422 | A foreign-key constraint was violated. The response never names the table or constraint. | Check the referenced identifiers, then retry with valid ones. |
| `INVALID_REFRESH_TOKEN` | 401 | The refresh cookie is absent, expired, revoked or not a refresh token. | Sign in again and replace the stored tokens. |
| `INVALID_REQUEST` | 400 | The request is malformed or a required value is missing; the message says which. | Fix the request as described in message and retry. Do not retry unchanged. |
| `INVALID_REQUEST_BODY` | 400 | The body could not be decoded (for example a corrupt compressed payload). | Send an uncompressed or validly compressed body. |
| `MISSING_ACCESS_TOKEN` | 401 | The Authorization header is absent or not a Bearer token. | Send Authorization: Bearer &lt;accessToken&gt;. |
| `NO_REFRESH_TOKEN` | 401 | The refresh endpoint was called without the refresh cookie. | Send the request with credentials included. |
| `NOT_FOUND` | 404 | The requested resource does not exist, or is not visible to the caller. | Check the identifier; do not retry unchanged. |
| `OBJECT_STORAGE_NOT_CONFIGURED` | 503 | The object-storage driver has no credentials in this environment. | This is an operator problem; retrying will not help. |
| `ORIGIN_NOT_ALLOWED` | 403 | The request Origin is not on the environment allowlist. | Call the API from an allowlisted origin. |
| `PAYLOAD_TOO_LARGE` | 413 | The body exceeds the size limit for the route. | Send less data; use the module-specific upload limits where they apply. |
| `RATE_LIMITED` | 429 | A request, login or per-account throttle is exhausted. | Honour Retry-After and back off. Never treat this as a permanent account block. |
| `REQUEST_ABORTED` | 400 | The client disconnected or truncated the body. | Retry with the complete body. |
| `REQUEST_TIMEOUT` | 503 | The server-side deadline elapsed before the handler finished. | Retry once; a repeated timeout is worth reporting with the request id. |
| `ROUTE_NOT_FOUND` | 404 | No route matches this method and path. | Check the path and method against docs/api/README.md. |
| `SERVER_MISCONFIGURED` | 500 | A required setting is missing or invalid. The message names the setting, never a secret. | This is an operator problem: report it; retrying will not help. |
| `SERVICE_UNAVAILABLE` | 503 | A dependency or feature the request needs is unavailable. | Retry later; the message says what is unavailable. |
| `SESSION_REVOKED` | 401 | The session was revoked server-side (logout, password reset or token-version bump). | Sign in again. |
| `UNPROCESSABLE_ENTITY` | 422 | The payload is well formed but semantically unacceptable. | Fix the referenced values as described in message. |
| `UNSUPPORTED_CHARSET` | 415 | The Content-Type charset is not UTF-8 compatible. | Send UTF-8. |
| `UNSUPPORTED_ENCODING` | 415 | The Content-Encoding is not one the server accepts. | Use identity, gzip, deflate or br. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The body or file type is not one this route accepts. | Send a supported Content-Type / file type as listed in message. |
| `UPSTREAM_UNAVAILABLE` | 502 | A dependency answered with an error the API cannot recover from for this request. | Retry later; the request itself is valid. |
| `VALIDATION_FAILED` | 400 | One or more request fields failed schema validation. | Read details.fields — each entry names the field, a field-level code and the reason — fix them and retry. |
| `VERSION_CONFLICT` | 412 | The conditional write matched no row: someone else moved the record. | Re-read, reapply the change to the new version and retry with the new ETag. |

## Auth

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `EMAIL_ALREADY_VERIFIED` | 409 | A verification/resend was attempted on an already verified address. | Nothing to do; continue with the normal flow. |
| `EMAIL_TAKEN` | 409 | The email address is already in use (case-insensitive). | Sign in instead, or use another address. |
| `EMAIL_UNCHANGED` | 400 | An email-change request named the current address. | Send a different address. |
| `EMAIL_VERIFICATION_RATE_LIMITED` | 429 | A verification email went out within the resend interval. | Wait the interval stated in message before requesting another. |
| `INVALID_EMAIL` | 400 | The supplied address is not a valid email. | Send a valid, normalised email address. |
| `INVALID_MFA_TOKEN` | 401 | The short-lived mfaToken is missing, expired or not for this account. | Sign in again to obtain a fresh mfaToken. |
| `INVALID_PASSWORD_RESET_TOKEN` | 400 | The reset token is unknown, already used or expired. | Request a new password-reset email. |
| `INVALID_TOKEN` | 400 | A single-use token is unknown or malformed. | Request a new token through the flow that issued it. |
| `INVALID_TOTP_CODE` | 401 | The TOTP or recovery code presented at login was wrong or expired. | Retry with the current code from the authenticator app, or a recovery code. |
| `INVALID_TOTP_ENROLLMENT_CODE` | 400 | The code presented while confirming 2FA enrolment was wrong or expired. | Retry with a current code from the authenticator app. |
| `INVALID_VERIFICATION_TOKEN` | 400 | The verification token is unknown, malformed or already used. | Request a new verification email. |
| `LOGIN_THROTTLED` | 429 | The per-email or per-IP login throttle is backing off or locked. | Honour Retry-After. The response is identical for existing and unknown accounts, and for a lock and a backoff. |
| `MFA_NOT_ENABLED` | 401 | A second-factor verification was attempted for an account without 2FA. | Sign in with the password-only flow. |
| `PASSWORD_COMMONLY_BREACHED` | 400 | The password is on the common-password denylist. | Choose a longer, less predictable password. |
| `PASSWORD_CONFIRMATION_FAILED` | 403 | The current password supplied as confirmation was wrong. | Retry with the correct current password. |
| `PASSWORD_RESET_RATE_LIMITED` | 429 | The password-reset throttle is exhausted. | Wait before requesting another reset email. |
| `PASSWORD_TOO_LONG` | 400 | The password exceeds the maximum UTF-8 byte length. | Shorten the password to the byte limit stated in message. |
| `PASSWORD_TOO_SHORT` | 400 | The password is below the minimum length. | Use at least the minimum length stated in message. |
| `PASSWORD_UNCHANGED` | 400 | A password change reused the current password. | Choose a different password. |
| `SESSION_NOT_FOUND` | 404 | No live session matches the identifier, or it was already revoked. | Refresh the session list. |
| `SIGNUP_ROLE_NOT_ALLOWED` | 400 | Facility and admin accounts are created by an administrator. | Sign up as patient or doctor, or ask an administrator for an invited account. |
| `TOKEN_ALREADY_USED` | 400 | The single-use token was redeemed already. | Request a new token. |
| `TOKEN_EXPIRED` | 400 | The token passed its TTL. | Request a new token. |
| `TOTP_CODE_ALREADY_USED` | 400 | The TOTP time step was already consumed while confirming enrolment. | Wait for the next time step and retry. |
| `TOTP_CODE_REPLAYED` | 401 | The TOTP time step (or recovery code) was already consumed at login. | Wait for the next time step or use another recovery code. |
| `TWO_FACTOR_ALREADY_ENABLED` | 409 | An enrolment was attempted while 2FA is already on, or it was enabled concurrently. | Disable 2FA first if re-enrolling; otherwise nothing to do. |
| `TWO_FACTOR_NOT_ENABLED` | 409 | A 2FA-management action requires an enabled 2FA enrolment. | Enrol with POST /auth/2fa/setup first. |
| `TWO_FACTOR_SETUP_REQUIRED` | 400 | A 2FA confirmation arrived without a pending setup. | Call POST /auth/2fa/setup, then confirm with a code. |
| `VERIFICATION_TOKEN_EXPIRED` | 400 | The verification token passed its TTL. | Request a new verification email. |

## Users and admin invites

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `ADMIN_INVITE_ALREADY_USED` | 400 | The single-use invite was redeemed. | Sign in instead, or ask for a new invite. |
| `ADMIN_INVITE_EMAIL_MISMATCH` | 403 | The redeem attempt used an address other than the invited one. | Redeem with the invited address. |
| `ADMIN_INVITE_EXPIRED` | 400 | The invite passed its TTL. | Ask an administrator for a new invite. |
| `ADMIN_INVITE_NOT_FOUND` | 404 | No invite matches the identifier. | Check the invite id against GET /admin/invites. |
| `ADMIN_INVITE_REDEEMED` | 409 | The invite was consumed before the revocation. | Manage the account instead of the invite. |
| `ADMIN_INVITE_REVOKED` | 400 | An administrator revoked the invite. | Ask an administrator for a new invite. |
| `EMAIL_REQUIRED` | 400 | The request omitted the email address a new account or invite needs. | Send a valid email address. |
| `INVALID_ADMIN_INVITE` | 400 | The invite token is unknown or malformed. | Ask an administrator for a new invite. |
| `LAST_ADMIN_CANNOT_DEACTIVATE` | 409 | Deactivating this account would leave no active administrator. | Promote or reactivate another admin first. |
| `USER_NOT_FOUND` | 404 | No user matches the identifier, or it is not visible to the caller. | Check the identifier; do not retry unchanged. |

## Patients, guardianship and exports

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `DEPENDENT_NOT_A_MINOR` | 400 | A guardianship was requested for someone at or over the age of majority. | Have the adult create their own account. |
| `EXPORT_EXPIRED` | 410 | The export bundle passed its retention window and was deleted. | Request a new export. |
| `EXPORT_NOT_FOUND` | 404 | No export job matches the identifier for this patient. | Request a new export. |
| `EXPORT_NOT_READY` | 409 | The export job has not finished, or failed. | Poll the export until its status is ready; request a new one if it failed. |
| `GUARDIANSHIP_INACTIVE` | 403 | The guardianship was revoked or the dependent reached the age of majority. | Stop acting for this patient; an adult must use their own account. |
| `INVALID_DATE_OF_BIRTH` | 400 | The date of birth is invalid or in the future. | Send a real calendar date in the past. |
| `PATIENT_PROFILE_NOT_FOUND` | 404 | No patient profile matches the identifier, or it is not visible to the caller. | Check the identifier; do not retry unchanged. |
| `PATIENT_PROFILE_REQUIRED` | 403 | The caller has no patient profile, or is not acting for one they may. | Use a patient account; guardians must name a dependent they actively guard. |

## Doctors, specialties and symptoms

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `DOCTOR_NOT_AVAILABLE` | 409 | The doctor is deactivated, deleted or otherwise not accepting bookings. | Choose another doctor. |
| `DOCTOR_NOT_FOUND` | 404 | No doctor matches the identifier. | Check the doctor id; do not retry unchanged. |
| `DOCTOR_NOT_VERIFIED` | 403 | The acting doctor is not verified, so clinical issuance is refused. | Wait for admin verification before issuing orders. |
| `DOCTOR_PROFILE_NOT_FOUND` | 404 | No doctor profile matches the identifier. | Check the doctor profile id. |
| `INVALID_SPECIALTY` | 400 | The specialty name or slug is empty or malformed. | Send a non-empty name; slugs are lowercase words joined by hyphens. |
| `INVALID_SYMPTOM` | 400 | The symptom name or slug is empty or malformed. | Send a non-empty name; slugs are lowercase words joined by hyphens. |
| `NO_DOCTOR_PROFILE` | 404 | The caller has a doctor role but no doctor profile, or one was not found. | Use a doctor account with a completed profile. |
| `NOT_YOUR_DOCTOR_PROFILE` | 403 | The route only permits the profile owner. | Use the account that owns the profile. |
| `RETIRED_SPECIALTY` | 400 | The specialty is retired and cannot take new assignments. | Pick an active specialty. |
| `SPECIALTY_DUPLICATE` | 409 | The catalogue already has a specialty with that name or slug. | Use the existing specialty. |
| `SPECIALTY_LOOKUP_NOT_FOUND` | 404 | No specialty matches the identifier. | Check the specialty id or slug. |
| `SPECIALTY_MISMATCH` | 422 | A referral named a doctor and a specialty the doctor does not hold. | Name a doctor who holds the specialty, or route by specialty only. |
| `SPECIALTY_NOT_ASSIGNED` | 404 | The doctor profile does not hold the specialty being removed or queried. | Refresh the doctor’s specialties and retry. |
| `SPECIALTY_NOT_FOUND` | 422 | A referral or assignment named a specialty that is not in the catalogue. | Pick a specialty from GET /specialties. |
| `SYMPTOM_DUPLICATE` | 409 | The vocabulary already has a symptom with that name or slug. | Use the existing symptom. |
| `SYMPTOM_NOT_FOUND` | 404 | No symptom matches the identifier. | Check the symptom id or slug. |
| `TARGET_DOCTOR_NOT_VERIFIED` | 422 | A referral named a doctor who is not verified. | Choose a verified doctor or a specialty for routing. |
| `UNKNOWN_SPECIALTIES` | 400 | A specialty assignment named ids that do not exist. | Use ids from GET /specialties. |

## Availability

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `DATE_RANGE_TOO_LARGE` | 400 | The range exceeds the configured maximum span. | Narrow the range to the maximum stated in message. |
| `INVALID_DATE` | 400 | A date or date-time parameter could not be parsed. | Send ISO-8601 dates (YYYY-MM-DD) or timestamps. |
| `INVALID_DATE_RANGE` | 400 | The date range is inverted. | Swap the bounds so from ≤ to. |
| `INVALID_SLOT_GENERATION` | 400 | The generation window or slot length is invalid. | Send a whole-hour start, end after start, and a positive slot length that divides the window. |
| `INVALID_TIME_ZONE` | 400 | The time zone is not a canonical IANA identifier. | Send an IANA time zone such as Europe/Paris, or UTC. |
| `SLOT_DATE_BEYOND_HORIZON` | 400 | Slot generation named a date further ahead than the configured horizon. | Generate slots within the horizon stated in message. |
| `SLOT_DATE_IN_PAST` | 400 | Slot generation named a date before today. | Generate slots for today or a future date. |
| `SLOT_OVERLAP` | 409 | The generated slot would overlap one that already exists. | Discard the overlap or choose a different window; re-running generation skips overlaps. |

## Appointments and waitlist

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `APPOINTMENT_NO_ACTIVE_SLOT` | 409 | The appointment’s slot was cancelled or released (for example by a referral cascade). | Reload the appointment; the slot is gone and cannot be rescheduled from here. |
| `APPOINTMENT_NOT_CANCELLABLE` | 409 | The appointment is not in a cancellable state. | Re-read the appointment; cancellation is only possible while scheduled. |
| `APPOINTMENT_NOT_FOUND` | 404 | No appointment matches the identifier, or it is not visible to the caller. | Check the appointment id. |
| `APPOINTMENT_NOT_RESCHEDULABLE` | 409 | The appointment is not in a reschedulable state. | Re-read the appointment; reschedule only while scheduled. |
| `APPOINTMENT_NOT_SCHEDULED` | 409 | The appointment already reached a terminal or in-progress state. | Re-read the appointment; no further transition is possible from here. |
| `APPOINTMENT_NOT_STARTED` | 409 | The slot has not started, or the appointment has no slot to time against. | Wait until the slot start time. |
| `APPOINTMENT_NOT_YOURS` | 403 | The caller is not the patient or treating doctor for this appointment. | Use the account that owns the appointment. |
| `NEW_SLOT_NOT_FOUND` | 404 | The reschedule target slot does not exist. | Check the new slot id and list availability again. |
| `NO_OPEN_SLOTS` | 404 | There is currently no open future slot to book. | Retry later or choose another doctor. |
| `ORDERS_WRONG_APPOINTMENT` | 403 | The acting doctor is not the appointment’s treating doctor. | Use the treating doctor’s account. |
| `RESCHEDULE_CUTOFF` | 409 | The reschedule cutoff window has passed. | Reschedule earlier, or contact the doctor. |
| `SLOT_ALREADY_PASSED` | 409 | The slot start time is in the past. | Pick a future slot. |
| `SLOT_DOCTOR_MISMATCH` | 400 | A reschedule named a slot owned by a different doctor. | Reschedule within the same doctor’s availability. |
| `SLOT_NOT_FOLLOW_UP_DOCTOR` | 409 | Booking a follow-up needs a slot from the original doctor. | Pick a slot from the follow-up’s doctor. |
| `SLOT_NOT_FOUND` | 404 | No slot matches the identifier. | Check the slot id and list availability again. |
| `SLOT_NOT_REFERRAL_TARGET` | 409 | Accepting a referral needs a slot from its target doctor. | Pick a slot from the referral’s target doctor. |
| `SLOT_TAKEN` | 409 | The slot was claimed by another request (or is no longer open). Exactly one concurrent claim wins. | Refresh availability and pick another slot. Do not retry the same slot. |
| `WAITLIST_ALREADY_ACCEPTED` | 409 | Leaving the waitlist is not allowed once an offer was accepted. | Cancel the booked appointment instead. |
| `WAITLIST_DUPLICATE` | 409 | An active waitlist entry already exists for the same target. | Reuse the existing entry rather than joining again. |
| `WAITLIST_NO_DOCTOR` | 404 | The entry has no doctor to book against. | Join a waitlist for a specific doctor or specialty. |
| `WAITLIST_NOT_ACTIVE` | 409 | The entry was already offered, booked, left or expired. | Re-read the entry; no further action is possible. |
| `WAITLIST_NOT_FOUND` | 404 | No waitlist entry matches the identifier for this patient. | Check the waitlist entry id. |
| `WAITLIST_NOT_YOURS` | 403 | The caller is not the patient who owns the waitlist entry. | Use the account that owns the entry. |

## Intake

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `INTAKE_NOT_FOUND` | 404 | No intake form matches the identifier for this patient. | Check the intake id. |
| `INVALID_INTAKE` | 400 | The structured symptoms are malformed. | Fix the fields described in message. |

## Consultations, messages, attachments and follow-ups

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `ATTACHMENT_CONTENT_MISMATCH` | 400 | Byte sniffing disagreed with the declared content type. | Send a file whose bytes match the declared type. |
| `ATTACHMENT_FILE_NOT_FOUND` | 404 | The attachment row exists but its stored object is gone. | Ask the sender to re-upload the file. |
| `ATTACHMENT_INVALID_BASE64` | 400 | The attachment payload is not valid base64. | Re-encode the file as base64. |
| `ATTACHMENT_LINK_INVALID` | 403 | The signed download URL is expired or its HMAC does not verify. | Request a fresh download URL. |
| `ATTACHMENT_NOT_FOUND` | 404 | No attachment matches the identifier for this thread. | Refresh the message list. |
| `ATTACHMENT_QUOTA_EXCEEDED` | 413 | The caller’s attachment quota is full. | Remove old attachments or continue without one. |
| `ATTACHMENT_TOO_LARGE` | 413 | The attachment exceeds the per-file size limit. | Compress or split the file. |
| `ATTACHMENT_TOO_MANY` | 400 | The per-message attachment limit was exceeded. | Send fewer attachments per message. |
| `ATTACHMENT_TYPE_NOT_ALLOWED` | 400 | The declared content type is not on the attachment allowlist. | Convert the file to JPEG, PNG or PDF. |
| `CONSULTATION_ALREADY_CLOSED` | 409 | Consultation.appointmentId is UNIQUE, so closing is a create-once operation. | Read the existing consultation instead of creating another. |
| `CONSULTATION_ALREADY_SIGNED` | 409 | Sign-off is a one-shot conditional write. | Read the consultation; it is already signed. |
| `CONSULTATION_APPOINTMENT_NOT_COMPLETED` | 409 | The appointment must be completed before its consultation can be recorded. | Complete the appointment first. |
| `CONSULTATION_FORBIDDEN` | 403 | The caller is neither the patient nor the treating doctor for this consultation. | Use a participating account. |
| `CONSULTATION_NOT_FOUND` | 404 | No consultation matches the identifier, or it is not visible to the caller. | Check the consultation id. |
| `CONSULTATION_NOTE_NOT_SIGNED` | 409 | Addenda are only allowed after sign-off. | Edit the note while unsigned, or sign it first. |
| `CONSULTATION_NOTE_SIGNED` | 409 | A signed note is immutable (hard rule 8). | Create an addendum instead of editing. |
| `CONSULTATION_THREAD_CLOSED` | 409 | The thread passed its configurable closing window. | No further messages can be sent on this thread. |
| `FOLLOW_UP_ALREADY_BOOKED` | 409 | The follow-up was booked once already. | Use the appointment that was created. |
| `FOLLOW_UP_EXPIRED` | 409 | The follow-up booking window closed. | Ask the doctor for a new follow-up. |
| `FOLLOW_UP_NOT_FOUND` | 404 | No follow-up request matches the identifier for this patient. | Check the follow-up id. |
| `FOLLOW_UP_NOT_YOURS` | 403 | The caller is not the patient who owns the follow-up request. | Use the account that owns the request. |
| `MESSAGE_EMPTY` | 400 | The message body and attachment list were both empty. | Send a body or attach a file. |
| `NOT_TREATING_DOCTOR` | 403 | The caller is not the consultation’s treating doctor. | Use the treating doctor’s account. |
| `ORDERS_REQUIRE_COMPLETED_CONSULTATION` | 409 | Order issuance requires a completed appointment behind the consultation. | Complete the appointment, then issue the order. |

## Referrals

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `INVALID_OLDER_THAN` | 400 | The admin queue age filter is malformed. | Send a positive integer followed by h or d. |
| `REFERRAL_ADMIN_TARGET_DUPLICATE` | 409 | A reassignment named the current target. | Choose a different doctor. |
| `REFERRAL_CHANGED` | 409 | A conditional write matched no row: someone else moved the referral. | Reload the referral and reapply the action if it still applies. |
| `REFERRAL_DUPLICATE_IN_BATCH` | 422 | An atomic batch named the same target twice. | Send each target once; the whole batch fails otherwise. |
| `REFERRAL_DUPLICATE_TARGET` | 409 | The consultation already has a referral to the same target. | Use the existing referral. |
| `REFERRAL_INVALID_TARGET` | 422 | The target doctor failed validation (verification or specialty). | Fix the target as described in message and retry. |
| `REFERRAL_NO_APPOINTMENT` | 422 | The source consultation has no appointment, so the referral hierarchy cannot be recorded. | Create the consultation from a completed appointment. |
| `REFERRAL_NO_ELIGIBLE_TARGET` | 422 | Specialty routing found no eligible, verified, active doctor; no referral row was written. | Name a specific doctor instead, or retry when one is available. |
| `REFERRAL_NOT_ACCEPTABLE` | 409 | Accept is a one-shot conditional transition from pending. | Re-read the referral; exactly one concurrent accept wins. |
| `REFERRAL_NOT_CANCELLABLE` | 409 | The referral is already terminal. | Re-read the referral. |
| `REFERRAL_NOT_DECLINABLE` | 409 | Decline is only possible while pending. | Re-read the referral. |
| `REFERRAL_NOT_FOUND` | 404 | No referral matches the identifier, or it is not visible to the caller. | Check the referral id. |
| `REFERRAL_NOT_PENDING` | 409 | The referral was accepted, declined, cancelled, expired or completed. | Re-read the referral; the action is no longer possible. |
| `REFERRAL_NOT_REASSIGNABLE` | 409 | Admin reassignment is only possible while pending. | Re-read the referral. |
| `REFERRAL_NOT_WITHDRAWABLE` | 409 | Withdraw is a conditional pending → cancelled transition. | Re-read the referral; the withdrawal is no longer possible. |
| `REFERRAL_NOT_YOURS` | 403 | The caller is not the referred patient. | Use the patient account the referral targets. |
| `REFERRAL_ONLY_OWN_CONSULTATION` | 403 | The acting doctor is not the consultation’s treating doctor. | Use the treating doctor’s account. |
| `REFERRAL_REQUIRES_COMPLETED_APPOINTMENT` | 409 | The source consultation’s appointment is not completed. | Complete the appointment before referring. |
| `REFERRAL_SELF` | 422 | The referring doctor and the target doctor are the same person. | Choose a different doctor or a specialty. |
| `REFERRAL_TARGET_REQUIRED` | 422 | The request named neither target. | Send targetDoctorId or targetSpecialtyId. |
| `REFERRAL_TARGETS_REQUIRED` | 422 | An atomic batch was sent with an empty target list. | Send at least one target. |

## Orders

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `DISPUTE_ALREADY_RESOLVED` | 409 | A resolution was already recorded for this dispute. | Refresh the queue; disputes resolve once. |
| `DISPUTE_NOT_FOUND` | 404 | No dispute matches the identifier. | Refresh the admin dispute queue. |
| `DISPUTE_REASON_REQUIRED` | 400 | A dispute was opened without a reason. | Send a non-empty reason. |
| `INVALID_ORDER_TOKEN` | 400 | The signed order link is missing, tampered with, or not for this server. | Open the latest order link; do not edit it. |
| `LAB_ORDER_CORRECTION_INVALID` | 409 | A correction named an unusable original lab order. | Check the original id and whether a correction already exists. |
| `ORDER_ALREADY_CONFIRMED` | 409 | Confirm and dispute are mutually exclusive. | Re-read the order; it is already confirmed. |
| `ORDER_ALREADY_DISPUTED` | 409 | Receipt cannot be confirmed while a dispute is open. | Wait for the dispute to be resolved. |
| `ORDER_AMOUNT_NOT_POSITIVE` | 400 | The manual amount is zero or negative. | Send a positive integer string of smallest units. |
| `ORDER_AMOUNT_REQUIRED` | 400 | Order pricing needs exactly one of a manual amount or a catalog code. | Send exactly one of the two fields. |
| `ORDER_CONFIRM_FAILED` | 409 | The conditional write matched no row (state changed concurrently). | Re-read the order, then retry if the state allows it. |
| `ORDER_CONFIRM_FORBIDDEN` | 403 | Only the patient who owns the order can confirm receipt. | Use the owning patient account. |
| `ORDER_CORRECTION_CONFLICT` | 409 | Append-only corrections are one per order; the original still owns its intent. | Use the existing correction. |
| `ORDER_DISPUTE_FAILED` | 409 | The conditional write matched no row (state changed concurrently). | Re-read the order, then retry if the state allows it. |
| `ORDER_DISPUTE_FORBIDDEN` | 403 | Only the patient who owns the order can dispute it. | Use the owning patient account. |
| `ORDER_DISPUTE_WINDOW_ELAPSED` | 409 | The post-fulfillment window to confirm or dispute the order passed. | No further action is possible on this order. |
| `ORDER_FETCH_FAILED` | 500 | The write succeeded but re-reading the order failed. | Re-read the order on the next poll; do not repeat the write blindly. |
| `ORDER_ID_REQUIRED` | 400 | The request omitted the order identifier. | Send the order id. |
| `ORDER_NOT_FOUND` | 404 | No order matches the identifier, or it is not visible to the caller. | Check the order id. |
| `ORDER_NOT_FULFILLED` | 400 | The patient action (confirm receipt / dispute) requires a fulfilled order. | Wait for the facility to mark the order fulfilled. |
| `PRESCRIPTION_CORRECTION_INVALID` | 409 | A correction named an unusable original prescription. | Check the original id and whether a correction already exists. |

## Prescriptions

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `PRESCRIPTION_EMPTY` | 400 | Fulfillment was requested for a prescription with no items. | Issue the prescription with at least one item. |
| `PRESCRIPTION_NOT_FOUND` | 404 | No prescription matches the identifier. | Check the prescription id. |

## Lab orders and results

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `ACKNOWLEDGEMENT_NOT_REQUIRED` | 404 | The result is normal, so no acknowledgement task was opened. | Nothing to acknowledge. |
| `LAB_ORDER_ALREADY_FULFILLED` | 409 | Fulfillment is a one-shot transition. | Re-read the order. |
| `LAB_ORDER_FULFILLMENT_FAILED` | 409 | The conditional status update matched no row (state changed concurrently). | Re-read the order and retry only if it is still open. |
| `LAB_ORDER_NOT_FOUND` | 404 | No lab order matches the identifier, or it is not visible to the caller. | Check the lab order id. |
| `LAB_ORDER_NOT_FULFILLABLE` | 400 | The status transition is not allowed from here. | Re-read the order; only an open order can be fulfilled. |
| `LAB_ORDER_SUPERSEDED` | 409 | Corrections are new append-only rows; the superseded row no longer takes a result. | Attach the result to the correction the message points at. |
| `LAB_RESULT_ALREADY_ACKNOWLEDGED` | 409 | Acknowledgement is a one-shot conditional write. | Re-read the result; it is already acknowledged. |
| `LAB_RESULT_ALREADY_ATTACHED` | 409 | A lab order carries exactly one result; attaching is a once-only write. | Read the existing result instead of attaching another. |
| `LAB_RESULT_CONTENT_MISMATCH` | 415 | Byte sniffing disagreed with the declared content type. | Send a file whose bytes match its declared type. |
| `LAB_RESULT_EMPTY` | 400 | The upload carried no bytes. | Send the file as the raw request body. |
| `LAB_RESULT_INFECTED` | 422 | The file scan flagged the upload. | Do not retry the same file; investigate and upload a clean copy. |
| `LAB_RESULT_NOT_FOUND` | 404 | The lab order has no result file yet. | Wait for the fulfilling facility to attach the result. |
| `LAB_RESULT_SCAN_UNAVAILABLE` | 503 | The malware scanner is unreachable and scanning is mandatory here. | Retry later. |
| `LAB_RESULT_TOO_LARGE` | 413 | The upload exceeds the lab-result size limit. | Upload a smaller file. |
| `LAB_RESULT_UNREADABLE` | 400 | The upload could not be decoded as a file. | Send the file as raw bytes with its content type. |
| `LAB_RESULT_UNSUPPORTED_TYPE` | 415 | The uploaded file type is not accepted for lab results. | Upload a file of one of the types listed in message. |

## Pharmacy orders and fulfillment

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `DUPLICATE_ITEMS` | 400 | The same item id appears more than once. | Send each item once, with its total dispensed quantity. |
| `FACILITY_ONLY` | 403 | The route is facility-only. | Use a facility account. |
| `FULFILLMENT_FORBIDDEN` | 403 | The caller is not the facility, patient or doctor the record is visible to. | Use a participating account. |
| `FULFILLMENT_ITEM_ALREADY_UPDATED` | 409 | The item’s dispensed state changed concurrently. | Re-read the record and retry only if the change still applies. |
| `FULFILLMENT_ITEM_DISPENSED_ELSEWHERE` | 409 | A unique (order, item) constraint prevents double dispensing. | Do not dispense this item; it is already covered. |
| `FULFILLMENT_ITEM_NOT_ROUTED` | 404 | The item does not belong to the named fulfillment record. | Refresh the record’s item list. |
| `FULFILLMENT_NOT_FOUND` | 404 | No fulfillment record matches the identifier for this caller. | Refresh the facility queue. |
| `FULFILLMENT_NOT_YOURS` | 403 | Facilities see and write only their own fulfillment records (hard rule 5). | Use the facility the order was routed to. |
| `FULFILLMENT_ORDER_REFERENCE_MISSING` | 500 | The record violates the typed-order-FK invariant. | Report this with the request id; it is a server-side data problem. |
| `FULFILLMENT_PARTIAL_ONLY` | 409 | A record with dispensed items cannot be marked fully fulfilled directly. | Let the derived item state drive fulfillment. |
| `FULFILLMENT_REJECTED` | 409 | Rejection is terminal for the record. | Re-read the record. |
| `FULFILLMENT_TERMINAL` | 409 | No further updates are possible on a terminal record. | Re-read the record. |
| `ITEM_ALREADY_DISPENSED` | 409 | Dispensed items cannot be re-routed to another facility. | Route only the remaining items. |
| `ITEMS_NOT_IN_ORDER` | 400 | The request named item ids outside the order being fulfilled. | Use item ids from the order. |
| `PATIENT_PROFILE_ID_REQUIRED` | 400 | The request omitted the patient profile the order belongs to. | Send patientProfileId. |
| `PHARMACY_ORDER_ALREADY_FULFILLED` | 409 | Fulfillment is a one-shot transition. | Re-read the order. |
| `PHARMACY_ORDER_FULFILLMENT_FAILED` | 409 | The conditional status update matched no row (state changed concurrently). | Re-read the order and retry only if it is still open. |
| `PHARMACY_ORDER_NOT_FOUND` | 404 | No pharmacy order matches the identifier, or it is not visible to the caller. | Check the order id. |
| `PHARMACY_ORDER_NOT_FULFILLABLE` | 400 | The status transition is not allowed from here. | Re-read the order; only an open order can be fulfilled. |
| `PROOF_ALREADY_ATTACHED` | 409 | A fulfillment proof carries exactly one file; attaching is a once-only write. | Read the existing proof instead of attaching another file. |
| `PROOF_CONTENT_MISMATCH` | 415 | Byte sniffing disagreed with the declared content type. | Send a file whose bytes match its declared type. |
| `PROOF_EMPTY` | 400 | The upload carried no bytes. | Send the file as the raw request body. |
| `PROOF_FILE_NOT_FOUND` | 404 | The fulfillment proof has no attachment yet, or it was removed. | Ask the facility that recorded the proof to attach the file. |
| `PROOF_INFECTED` | 422 | The file scan flagged the upload. | Do not retry the same file; investigate and upload a clean copy. |
| `PROOF_SCAN_UNAVAILABLE` | 503 | The malware scanner is unreachable and scanning is mandatory here. | Retry later. |
| `PROOF_TOO_LARGE` | 413 | The upload exceeds the fulfillment-proof size limit. | Upload a smaller file. |
| `PROOF_UNSUPPORTED_TYPE` | 415 | The uploaded file type is not accepted for fulfillment proofs. | Upload a JPEG, PNG or PDF file. |
| `QUANTITY_EXCEEDS_ORDERED` | 400 | Dispensing cannot exceed the prescribed quantity. | Send a dispensed quantity at or below the ordered quantity. |
| `REFERENCE_NUMBER_REQUIRED` | 400 | Fulfillment proof needs the facility’s reference number. | Send the reference number the facility records. |

## Facilities and pricing

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `CAPABILITY_ALREADY_HELD` | 409 | Capabilities are unique per facility. | Nothing to add; the capability is already present. |
| `CAPABILITY_NOT_FOUND` | 404 | The facility does not hold the capability being removed. | Refresh the facility’s capabilities. |
| `CAPABILITY_TYPE_MISMATCH` | 400 | Lab facilities hold lab_test; pharmacies hold medication_dispense. | Match the capability to the facility type. |
| `FACILITY_CAPABILITIES_REQUIRED` | 400 | Unqualified facilities are never eligible, so none may be created. | Send at least one capability matching the facility type. |
| `FACILITY_DEACTIVATED` | 400 | A deactivated facility cannot be selected for an order. | Choose another facility. |
| `FACILITY_NAME_REQUIRED` | 400 | Facility creation omitted the name. | Send a non-empty name. |
| `FACILITY_NOT_FOUND` | 404 | No facility matches the identifier, or it is not visible to the caller. | Check the facility id. |
| `FACILITY_PROFILE_REQUIRED` | 403 | The caller has no facility profile to act through. | Use a facility account. |
| `FACILITY_TYPE_MISMATCH` | 400 | A prescription needs a pharmacy; a lab order needs a lab. | Choose a facility of the expected type. |
| `INVALID_CAPABILITY` | 400 | A capability entry is malformed or its detail is too long. | Fix the capability object as described in message. |
| `INVALID_CATALOG_ITEM` | 400 | A price entry has a missing, empty or over-long catalog code or asset. | Send a non-empty catalogItemCode and asset within the limits. |
| `INVALID_EFFECTIVE_FROM` | 400 | The price’s effective date could not be parsed. | Send an ISO-8601 timestamp. |
| `INVALID_FACILITY_TYPE` | 400 | The facility type or order kind is not recognised. | Send lab or pharmacy. |
| `INVALID_ORDER_KIND` | 400 | The order kind is not one of the known types. | Use prescription or lab_order. |
| `INVALID_TIMESTAMP` | 400 | A timestamp query parameter could not be parsed. | Send an ISO-8601 timestamp. |
| `ITEM_RETIRED` | 422 | The catalog item was retired from the facility’s price list. | Choose another item or facility; existing intents keep their snapshot amount. |
| `NOT_FACILITY_OWNER` | 403 | The caller is not the owner of the facility whose prices are being changed. | Use the owning facility account. |
| `PRICE_EFFECTIVE_FROM_CONFLICT` | 409 | Price versions are unique per item, asset and effective date. | Use a different effectiveFrom. |
| `PRICE_ON_REQUEST` | 422 | The facility has not published a price for the catalog item. | Send a manual amount, or choose a facility that published a price. |
| `VERIFY_RATE_LIMITED` | 429 | The facility verification throttle is exhausted. | Wait before retrying. |

## Payments

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `ESCROW_CONTRACT_MISSING` | 409 | The intent predates contract pinning and cannot settle safely. | This needs operator reconciliation; do not retry. |
| `ESCROW_CONTRACT_UNREGISTERED` | 409 | The recorded contract is not in ESCROW_CONTRACTS for this environment. | This needs operator configuration; do not retry. |
| `ESCROW_NOT_OBSERVED` | 404 | Adoption needs an escrow the event poller actually saw. | Wait for the poller or investigate the chain; do not adopt blindly. |
| `ESCROW_SDK_PREPARE_UNSUPPORTED` | 503 | The installed SDK version predates the prepare call (needs 0.3.0). | Custodial funding remains available until the SDK is upgraded. |
| `ESCROW_SDK_SUBMIT_UNSUPPORTED` | 503 | The installed SDK version predates the submit call (needs 0.3.0). | Custodial funding remains available until the SDK is upgraded. |
| `FACILITY_WALLET_NOT_LINKED` | 409 | The payee facility has no effective payout address. | Ask the facility to link a wallet, or wait for its cool-down to end. |
| `FEATURE_DISABLED` | 403 | A feature flag is off for the caller. | Use the enabled path, or ask an operator to enable the flag. |
| `FEE_SPONSOR_GLOBAL_LIMIT` | 429 | The platform’s sponsored-fee budget is exhausted. | Retry later or pay the fee from the patient wallet. |
| `FEE_SPONSOR_PATIENT_LIMIT` | 429 | The patient’s sponsored-fee budget is exhausted. | Wait for the budget window to reset. |
| `HORIZON_UNAVAILABLE` | 502 | Horizon was unreachable or answered with an error. | Retry later. |
| `INVALID_AMOUNT` | 400 | The amount is missing, not an integer string, negative or out of range. | Send a positive integer string of smallest units. |
| `INVALID_CONTRACT_ID` | 400 | The contract id is not configured for this environment. | Use a contract from the environment allowlist. |
| `INVALID_ESCROW_ID` | 400 | The escrow id is not a number. | Send the numeric escrow id. |
| `INVALID_SIGNATURE` | 400 | The signature does not match the payer recorded on the intent. | Sign with the linked patient wallet. |
| `INVALID_XDR` | 400 | The submitted XDR could not be parsed. | Submit the XDR returned by prepare. |
| `PAYEE_TRUSTLINE_MISSING` | 409 | The payee cannot hold the asset being escrowed. | Ask the facility to link a wallet with a trustline for the asset. |
| `PAYMENT_ASSET_NOT_CONFIGURED` | 409 | The intent cannot settle because its asset is no longer configured. | This needs operator configuration; do not retry. |
| `PAYMENT_INTENT_NOT_FOUND` | 404 | No payment intent matches the identifier, or it is not visible to the caller. | Check the intent id. |
| `PAYMENT_STATE_CONFLICT` | 409 | The transition or concurrent update is not allowed from the intent’s current status. | Re-read the intent; retry only if its status still allows the operation. |
| `PAYMENTS_MISCONFIGURED` | 500 | A payments setting is missing or invalid (named, never its value). | This is an operator problem; report it. |
| `PAYMENTS_NOT_CONFIGURED` | 500 | Required payments environment variables are missing. | This is an operator problem; report it. |
| `POOLED_PAYOUT_DISABLED` | 503 | The feature is intentionally off outside testnet. | Use the direct-payout mode. |
| `POOLED_PAYOUT_MISCONFIGURED` | 503 | PAYOUT_PRIVACY_POOL_ADDRESS is missing or invalid. | This is an operator problem; report it. |
| `PREPARE_ALREADY_PENDING` | 409 | A prepared transaction is already live for this intent. | Submit the prepared transaction, or wait for it to expire. |
| `PREPARE_REQUIRED` | 409 | Submitting requires a prior prepare. | Call prepare first. |
| `PREPARED_EXPIRED` | 409 | The prepared transaction passed its expiry ledger. | Prepare a new transaction. |
| `SEP10_CHALLENGE_ALREADY_USED` | 401 | Challenges are single-use. | Fetch a new challenge. |
| `SEP10_CHALLENGE_BUILD_FAILED` | 500 | The server could not construct the challenge transaction. | Report this with the request id. |
| `SEP10_CHALLENGE_EXPIRED` | 401 | The challenge passed its time bounds. | Fetch a new challenge. |
| `SEP10_CHALLENGE_MALFORMED` | 500 | Challenge construction produced an unexpected transaction shape. | Report this with the request id. |
| `SEP10_CHALLENGE_NOT_FOR_CALLER` | 403 | The challenge is bound to another user or account. | Fetch a challenge for the authenticated account. |
| `SEP10_CHALLENGE_UNKNOWN` | 401 | The challenge’s signing key is not this server’s. | Fetch a challenge from this server and sign that. |
| `SEP10_HORIZON_UNAVAILABLE` | 502 | The SEP-10 signer check needs Horizon and it was unavailable. | Retry later. |
| `SEP10_INVALID_ACCOUNT` | 400 | The account id is not a valid Stellar public key with a good checksum. | Send a valid G… address. |
| `SEP10_INVALID_CHALLENGE` | 400 | The challenge XDR could not be parsed or does not match the expected shape. | Use the challenge returned by the server unchanged. |
| `SEP10_INVALID_SIGNATURE` | 401 | The challenge was not correctly signed by the account’s signers. | Sign the challenge with a valid signer and retry. |
| `SEP10_NOT_CONFIGURED` | 500 | Required SEP-10 environment variables are missing or invalid. | This is an operator problem; report it. |
| `TX_HASH_MISMATCH` | 400 | The signed XDR differs from what prepare built. | Sign exactly the prepared transaction. |
| `UNSUPPORTED_PAYMENT_ASSET` | 400 | The asset is not on the environment allowlist. | Use an asset listed in message. |
| `WALLET_LINK_ACCOUNT_TYPE` | 403 | Doctor and admin accounts have no payer/payee role. | Use a patient or facility account. |
| `WALLET_LINK_CONFLICT` | 409 | Links are conditional; a concurrent request won. | Refresh the wallet link and reuse it. |
| `WALLET_LINK_COOLDOWN` | 409 | A re-linked payee only becomes effective after the cool-down. | Wait until effectiveAt, or keep using the previous payee until then. |
| `WALLET_LINK_NOT_FOUND` | 404 | The account has no wallet link to return. | Link a wallet first. |
| `WALLET_LINK_UNVERIFIED` | 409 | Unverified legacy payee links can no longer receive funded payments. | Re-link a SEP-10-verified wallet. |
| `WALLET_NOT_LINKED` | 409 | Paying from a patient wallet needs a SEP-10-verified PatientWalletLink. | Link and verify a wallet before preparing the payment. |

## Notifications

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `INVALID_NOTIFICATION_PAYLOAD` | 400 | A notification payload does not match its template. | Fix the payload fields described in message. |
| `NOTIFICATION_NOT_FOUND` | 404 | No notification matches the identifier for this caller. | Refresh the inbox. |
| `STREAM_LIMIT` | 429 | The per-user concurrent stream limit was reached. | Close an existing stream before opening another. |

## Medications

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `MEDICATION_QUERY_TOO_SHORT` | 400 | The medication autocomplete query is too short to be useful. | Send at least two characters. |
| `UNKNOWN_MEDICATION` | 400 | A prescription item named medication ids not in the catalogue. | Pick ids from GET /medications, or use the unlisted-medication path. |

## Audit

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `INVALID_AUDIT_RANGE` | 400 | The audit query range is inverted. | Swap the bounds so from ≤ to. |

## Feature flags

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `FLAG_NOT_FOUND` | 404 | No feature flag matches the identifier. | Check the flag key. |

## Metrics

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `METRICS_UNAVAILABLE` | 503 | Metrics collection is disabled or not configured. | This is an operator concern; nothing for the client to retry. |

## Lab tests

| Code | HTTP | Meaning | Client guidance |
|---|---|---|---|
| `LAB_TEST_NOT_FOUND` | 404 | No lab test matches the catalog code. | Pick a code from the lab test catalogue. |
