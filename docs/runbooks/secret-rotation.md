# Secret rotation runbook

Scope: the JWT signing keys for access and refresh tokens (issue #106). The
other secret classes named in issue #106 (field-encryption keys, Stellar
releaser and sponsor keys) are not covered here yet. Stellar key rotation
must follow the custody decision in issue #25.

## How JWT key rotation works

Each token type has a keyring. The first entry signs new tokens and its
`kid` is written into the token header. Verification uses the key the
header names. A token whose `kid` is not in the keyring is rejected. A token
with no `kid` (minted before rotation support) is tried against each key.

| Env var | Purpose |
|---|---|
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Current key. Signs new tokens. |
| `JWT_ACCESS_KID` / `JWT_REFRESH_KID` | Optional `kid` for the current key. Defaults to `access-current` / `refresh-current`. |
| `JWT_ACCESS_SECRET_PREVIOUS` / `JWT_REFRESH_SECRET_PREVIOUS` | Previous key, kept during the overlap window. |
| `JWT_ACCESS_KID_PREVIOUS` / `JWT_REFRESH_KID_PREVIOUS` | Optional `kid` for the previous key. Defaults to `access-previous` / `refresh-previous`. |

Use a `kid` that changes at every rotation, for example `access-2026-10`.
Reusing a `kid` for a different secret would make verification pick the
wrong key.

## Rotating a JWT key without logging users out

Access tokens live 15 minutes and refresh tokens 30 days. The overlap window
must be at least the longer of the two, so the refresh token length (30 days)
bounds it.

1. Generate a new secret with at least 32 random bytes, for example
   `openssl rand -base64 48`. Don't reuse a previous value.
2. Set `JWT_<TYPE>_SECRET_PREVIOUS` to the current secret and
   `JWT_<TYPE>_KID_PREVIOUS` to the current `kid`. Set `JWT_<TYPE>_SECRET` to
   the new secret and `JWT_<TYPE>_KID` to a new `kid`. Redeploy.
3. Confirm that new logins work and that a token minted before the change
   still refreshes.
4. After the overlap window (30 days for refresh tokens) has passed, remove
   the `_PREVIOUS` variables and redeploy. Tokens still signed by the previous
   key are now rejected, which is the intended end of the overlap.

Rotating without an overlap window (removing `_PREVIOUS` immediately) logs out
every user whose token was signed by the old key. Use it only as an
emergency response to a leaked key.

## Who can read each secret

To be filled in with the secrets manager chosen under issue #22. Until then,
these values are set as deployment environment variables and must not be
committed to the repository or baked into an image.

## Staging rotation record

Not yet performed. Record the date, the `kid` values before and after, and
whether a test user's refresh still worked. Issue #106 asks for one staging
rotation to be carried out and recorded here.
