# API error catalogue

Errors use a stable `code` in addition to the HTTP status and human-readable
message. Clients should branch on `code`, not message text. The interactive
reference is generated from the OpenAPI document; endpoint responses should
link their documented error codes back to this catalogue.

| Code | Status | Meaning |
|---|---:|---|
| [`EMAIL_NOT_VERIFIED`](./reference#email-verification-phase-8-issue-34) | 403 | Verify the account email before using a protected write endpoint. |
| `INVALID_VERIFICATION_TOKEN` | 400 | The verification token is unknown, already used, or invalid. |
| `VERIFICATION_TOKEN_EXPIRED` | 400 | Request a fresh verification email. |
| `EMAIL_ALREADY_VERIFIED` | 409 | The account email is already verified. |
| `EMAIL_VERIFICATION_RATE_LIMITED` | 429 | Wait for the resend interval before requesting another email. |

This catalogue starts with the stable authentication and email-verification
codes currently documented by the API. Add a row in the same change whenever
a new public error code is introduced.
