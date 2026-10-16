# API docs

Phase 1 endpoints are real and tested (see `backend/tests/`). Everything
else is still unimplemented — see `ROADMAP.md` for phase order. Keep this
file in sync with `backend/src/modules/*/routes` (AGENTS.md doc-update
rule).

Base URL: `http://localhost:4000` locally (`PORT` in `.env`). No OpenAPI
spec yet — TBD, tracked informally, not blocking Phase 1.

## Auth (`/auth`) — `backend/src/modules/auth`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /auth/signup` | none | `{ role: 'patient'\|'doctor', email, password, fullName }` | **`role` is restricted to `patient`/`doctor` server-side, not just in docforum-web's UI** — facility accounts are admin-invited only (PRD OQ-2). Returns `{ user, accessToken }`; sets an httpOnly refresh cookie. |
| `POST /auth/login` | none | `{ email, password }` | Same response shape as signup. **Throttled** (Phase 8, issue #35) — see below. |
| `POST /auth/refresh` | refresh cookie + `X-CSRF-Token` | — | Reads the httpOnly cookie (not the body). Returns a fresh `{ user, accessToken, csrfToken }` and rotates the cookie **and** the CSRF token. `403` if the CSRF token is missing/wrong or the `Origin` isn't allowlisted. |
| `POST /auth/logout` | `X-CSRF-Token` | — | Clears the refresh cookie. `204 No Content`; `403` without the CSRF header or from a disallowed `Origin`. |
| `POST /auth/verify-email` | none | `{ token }` | Redeems the token from the verification email. `200 { emailVerifiedAt }`. Errors are `400` with `code: 'INVALID_VERIFICATION_TOKEN'` (unknown / already used) or `code: 'VERIFICATION_TOKEN_EXPIRED'`. Single-use and atomic — two concurrent redemptions can't both succeed. |
| `POST /auth/verify-email/resend` | access token | — | Re-sends to the caller's own address. `200 { resendAfterSeconds }`. `409 EMAIL_ALREADY_VERIFIED` if already verified; `429 EMAIL_VERIFICATION_RATE_LIMITED` if a mail went out less than `EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS` ago (default 60). Authenticated and account-scoped on purpose — no email in the body, so it can't be used to enumerate accounts. |

### Email verification (Phase 8, issue #34)

`POST /auth/signup` creates the account **unverified** (`user.emailVerifiedAt`
is `null` in the response and in `GET`-style payloads). Unverified accounts
can log in, refresh, and browse; they get
`403 { message, code: 'EMAIL_NOT_VERIFIED' }` from mutating routes that
depend on a trustworthy contact address:

- `POST /appointments` (booking)
- `POST /payments/wallet-link`, `POST /payments/intents`,
  `POST /payments/intents/:id/{fund,release,refund}`

That guard reads the database rather than trusting a claim in the access
token, so verifying in one tab unblocks the caller immediately instead of
after the 15-minute token TTL.

**No email provider is integrated yet** (Phase 6, issue #17) —
`backend/src/modules/auth/services/email-dispatcher.ts` is the
provider-agnostic seam and currently drops the message (logging only the
subject and recipient, never the body/token). On a hosted deployment, an
operator can mark an address verified out-of-band with
`node backend/scripts/mark-email-verified.mjs <email>`; see
`scripts/README.md`. This is a documented interim, not the end state.

Env knobs: `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES` (default 1440),
`EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS` (default 60),
`EMAIL_VERIFICATION_LANDING_URL` (where the emailed link points).

### CSRF (Phase 8, issue #37)

The refresh cookie is `SameSite=None; Secure` in production (docforum-web on
GitHub Pages and this API on Render are different sites), so **any** website
can cause a browser to send it to `/auth/refresh` / `/auth/logout`. Those two
routes are therefore protected by:

1. **A required `X-CSRF-Token` header** carrying the `csrfToken` from the
   login/signup/refresh response body. It's a claim inside the refresh JWT
   for that session, so it rotates together with the cookie and needs no
   server-side state. On `/auth/logout` there is no session token to match
   against, so the header's presence is required instead (the impact of a
   forged logout is a forced sign-out, not data loss).
2. **An `Origin` allowlist** — a request whose `Origin` is present and not on
   the CORS allowlist is rejected with `403 Origin not allowed.`
3. **An explicit per-environment CORS allowlist** — `CORS_ORIGINS`
   (comma-separated; `CORS_ORIGIN` still works as a single origin).
   Production defaults to `https://docforum.github.io`; local dev to
   `http://localhost:5173` and `http://127.0.0.1:5173`.

**Why not a double-submit cookie** (the usual default): a cookie set by this
API is a third-party cookie to `docforum.github.io`, so docforum-web's
JavaScript can never read it — the value therefore has to travel in the
response body instead. See `backend/src/middleware/csrf.ts`.

**Client requirements (docforum-web):**

- Store `csrfToken` from the signup/login/refresh response next to the access
  token (in memory), and replace it on every refresh response.
- Send it on the two cookie-authenticated calls:
  `fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken } })`.
- A `403` there means re-login, not retry.

**Requests with no `Origin` header** (curl, server-to-server): allowed past
the Origin check, but the CSRF header is still required — an attacker's page
can't win by suppressing `Origin`. Sessions issued before this change carry
no `csrf` claim in their refresh token, so they are rejected with `403` and
need one re-login.

### Login throttling (Phase 8, issue #35)

`POST /auth/login` is rate-limited **per normalised email and per client
IP**, with state in Postgres (so it survives restarts and doesn't assume a
single instance). Bucket size is capped by the first limit reached:

| Phase | Response |
|---|---|
| Below `LOGIN_THROTTLE_BACKOFF_AFTER` failures (default 3) in the window | normal `401 { message: 'Invalid email or password.' }` |
| At/after it | `429` with a `Retry-After: <seconds>` header, growing exponentially (`LOGIN_THROTTLE_BACKOFF_BASE_SECONDS` × 2ⁿ, capped at `LOGIN_THROTTLE_BACKOFF_MAX_SECONDS`) |
| At `LOGIN_THROTTLE_LOCK_AFTER` failures (default 10) | `429` locked for `LOGIN_THROTTLE_LOCK_SECONDS` (default 15 min). The lock is set once per window and is not extended by further attempts |
| Window (`LOGIN_THROTTLE_WINDOW_SECONDS`, default 15 min) | New window restarts the count at 1 and clears the lock |

A successful login clears the **per-account** counter. The per-IP bucket is
left alone, so one valid login can't reset a shared-IP budget.

Clients should honour `Retry-After` and must **not** treat a `429` as
"account locked permanently". The response is identical for a real and a
non-existent address, and for a locked and a backing-off bucket — it
deliberately reveals nothing about whether the account exists (an absent
account also pays bcrypt's comparison cost, so timing doesn't leak either).

`POST /auth/login-attempts/clear` (admin-only) clears a lock a legitimate
user is stuck behind: body `{ email?, ip? }` (at least one), returns
`{ cleared }`. Clear **both** when a lock was taken out via the account's IP,
or the IP bucket will keep refusing them. It's logged to the server console
— there is no `AuditEvent` table yet (known gap), so that's the interim
record.

Under the hood this uses Express's `trust proxy` setting via the
`TRUST_PROXY` env var: `1` behind Render's single proxy hop, `false` (the
default) locally. See `ARCHITECTURE.md` §7 — the wrong value is a security
bug in either direction. A cleanup interval in `src/server.ts` prunes
buckets whose last failure is older than
`LOGIN_THROTTLE_PRUNE_AFTER_SECONDS` (default 24 h).

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, no
revocation list yet (see `ARCHITECTURE_ESSENTIALS.md` known gaps —
JWT refresh rotation without a revocation list). Refresh tokens: httpOnly
cookie, 30-day TTL, `SameSite=None; Secure` in production and
`Lax`/insecure locally — the attributes live in `config.cookie`
(`backend/src/config/index.ts`) so the refresh and CSRF cookies can never
drift apart. See `docs/adr/0003` for why production needs `SameSite=None`.

## Doctors (`/doctors`) — `backend/src/modules/doctors`

| Method & path | Auth | Notes |
|---|---|---|
| `GET /doctors/me` | doctor | Returns the caller's own `DoctorProfile`. |
| `PATCH /doctors/:doctorProfileId/verification` | admin | Body `{ status: 'pending'\|'verified'\|'rejected' }`. Manual, admin-gated per PRD FR-3 — there is no automated verification pipeline. |

## Availability (`/availability`) — `backend/src/modules/availability`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `GET /availability/doctors/:doctorProfileId/slots` | none | — | Lists that doctor's open, future slots. Public on purpose — a patient needs to see availability before signing in. |
| `POST /availability/doctors/:doctorProfileId/slots/generate` | doctor (self only) | `{ date: 'YYYY-MM-DD', startHour, endHour, slotLengthMinutes }` | Fixed-length, single-day generation — no recurrence engine (ARCHITECTURE.md §6.3.6 guardrail). Idempotent: re-running with an overlapping range skips slots that already exist rather than erroring or duplicating. |

## Appointments (`/appointments`) — `backend/src/modules/appointments`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /appointments` | patient | `{ availabilitySlotId }` | **The concurrency-critical endpoint** — see `ARCHITECTURE.md` §5.1 and `backend/tests/integration/booking.test.mts`. `409` if the slot is no longer open. |
| `GET /appointments/mine` | patient | — | Caller's own appointments, most recent first. |

## Payments (`/payments`) — `backend/src/modules/payments`

Custodial v1 escrow actions (`GET/POST /payments/intents/...`) are
admin/facility-gated — see `docs/adr/0004-custodial-payments-v1.md` for
why. Wallet linking and SEP-10 (below) are the non-custodial building
blocks from `docs/adr/0005` (issues #77/#78).

### Wallet links (issue #78)

Wallet links are **owner-scoped and verified**: a patient links the
wallet they will pay FROM, a facility the wallet they are paid TO. The
endpoint never accepts an address — only a signed SEP-10 challenge —
and the address is derived server-side from the account that challenge
was verified for.

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /payments/wallet-link` | access token, role `patient` or `facility`, + verified email | `{ transaction }` (signed SEP-10 challenge XDR) | Creates (or replaces) the caller's OWN active link: `200 { id, ownerType, ownerId, stellarPublicKey, verificationMethod: 'sep10', verifiedAt, replacedAt: null, createdAt, updatedAt }`. Patient responses additionally carry `privacyNotice` (see below). Link creation and the SEP-10 nonce consumption commit in one transaction — a failed verification creates no link and burns no nonce. |
| `GET /payments/wallet-link` | access token, role `patient` or `facility` | — | The caller's active link, or `404 { message: 'No wallet linked yet.' }`. Replaced links are history and are not returned. |

**Rules:**

- **One active link per owner**, enforced by a DB unique constraint —
  concurrent creates race it (`409 WALLET_LINK_CONFLICT` for the loser)
  rather than ever producing two. Re-linking deactivates the previous
  link (`replacedAt` set) instead of mutating or deleting it, so history
  survives; already-funded escrows keep referencing their own address
  (snapshot in `PaymentIntent.fundedWalletAddress`).
- **Patient privacy notice:** every patient link response includes
  `privacyNotice` — ADR 0005's on-chain privacy risk text **verbatim**
  (word-for-word; a unit test checks it against the ADR file), so a
  client cannot render the success screen without carrying it:
  > **Privacy risk: health information can leak on-chain.** A payment
  > from a patient's wallet to a facility's wallet is public forever. …
  (full text in the response body / `services/wallet-link.ts`).
  The ADR mandates the *display* but is silent on an acknowledgement
  field — none is required (open design decision in the PR).

**Errors:**

| Status | `code` | Meaning |
|---|---|---|
| 400 | — | Malformed body, or **any raw-address field** (`stellarPublicKey`, `account`, …) — the schema is strict on purpose. |
| 401 | `SEP10_*` | Challenge invalid/untrusted/replayed/expired — same codes as `POST /payments/sep10/verify`; no link is created and the nonce is not consumed. |
| 403 | `SEP10_CHALLENGE_NOT_FOR_CALLER` | Challenge was issued to a different user/account. |
| 403 | — | Role cannot own a link (doctor/admin), no profile, or email not verified (`EMAIL_NOT_VERIFIED`). |
| 409 | `WALLET_LINK_CONFLICT` | A concurrent request created the owner's link first. |
| 404 | — | `GET` with no active link. |

**Legacy links & the funding cutoff:** existing facility links
(typed-in before this change) migrated to `verificationMethod:
'unverified_legacy'`, `verifiedAt: null`. Escrow funding keeps accepting
them **before** `WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF` (ISO date,
validated at startup, default `2027-01-01T00:00:00Z`, see
`.env.example`); **after** it, funding a facility whose link is not
`sep10` fails with `409 { code: 'WALLET_LINK_UNVERIFIED' }` (enforced in
the funding service — re-link with a SEP-10-verified wallet to resume).
Verified links fund normally before and after the cutoff.

### SEP-10 Stellar Web Authentication (issue #77)

Proves the caller controls a Stellar address before it can ever be
trusted as a payer or payee. **Both endpoints require a verified-email
account** (same guard as every payments mutation — issue #34), and
neither issues a DocForum session: your normal access token
authenticates the *user*; SEP-10 proves control of the *wallet*.

| Method & path | Auth | Body/query | Notes |
|---|---|---|---|
| `GET /payments/sep10/challenge` | access token (+ verified email) | `?account=G…` | Returns `200 { transaction, expires_in, network_passphrase }` — the base64 XDR of a server-signed SEP-10 challenge (5-minute time bounds by default, `SEP10_CHALLENGE_TIMEOUT_SECONDS`). Hand `transaction` to the user's wallet for signing (build/sign/submit all stay server-side per `docforum-web`'s hard rule — the browser only relays XDR). `400` if `account` is missing, malformed, or fails the Stellar strkey checksum (`code: 'SEP10_INVALID_ACCOUNT'`). |
| `POST /payments/sep10/verify` | access token (+ verified email) | `{ transaction }` (signed challenge XDR) | Runs the full SEP-10 server verification list plus this server's own single-use/binding rules. Returns `200 { account, signers, userId }` on success, and the nonce is consumed — a challenge is single-use, even concurrently. |

**What verify checks, in order** (SEP-10's server verification list):

1. XDR deserializes as a transaction; sequence number is 0; source is
   the server's SEP-10 signing account; time bounds are present, bounded
   and unexpired.
2. The first operation is Manage Data, sourced by `account`, keyed
   `<home domain> auth`, with a spec-sized (48-random-bytes base64)
   nonce; later operations are server-sourced Manage Data including
   `web_auth_domain` equal to this server's configured domain.
3. The server's signature on the challenge is valid.
4. The nonce exists in this server's issuance ledger (`Sep10Challenge`),
   is still unconsumed and unexpired, and is bound to **the calling user
   and the exact account in the challenge** — a signed challenge is
   never redeemable by another user or for another account.
5. Client signatures: for a **funded** account, signer weights loaded
   from Horizon must meet the account's **medium threshold**;
   for an **unfunded account** (not yet created on the network — no
   signers/thresholds exist to weigh), the challenge must be signed by
   the account's **master key**, per the SEP-10 spec. A Horizon outage is
   a `502`, never silently treated as "unfunded".
6. The nonce is consumed with a single conditional UPDATE — of several
   concurrent submissions of the same signed challenge, exactly one
   succeeds.

**Errors from `POST /payments/sep10/verify`** (all also carry a `message`):

| Status | `code` | Meaning |
|---|---|---|
| 400 | `SEP10_INVALID_CHALLENGE` | Not a valid/well-formed SEP-10 challenge: bad XDR, wrong source, non-zero sequence, expired time bounds, wrong home domain or `web_auth_domain`, extra operations, or a missing/wrong server signature. |
| 401 | `SEP10_INVALID_SIGNATURE` | Well-formed challenge, but the client signature is missing, from a non-signer, or below the account's medium threshold (incl. the unfunded-account master-key rule). A failed verification does NOT burn the nonce. |
| 401 | `SEP10_CHALLENGE_UNKNOWN` | The challenge's nonce was never issued by this server (or its record was pruned). |
| 401 | `SEP10_CHALLENGE_EXPIRED` | The issued nonce record is past its expiry (stricter than the transaction time bounds). |
| 401 | `SEP10_CHALLENGE_ALREADY_USED` | Replay — the nonce is already consumed. |
| 403 | `SEP10_CHALLENGE_NOT_FOR_CALLER` | The challenge was issued to a different user or for a different account. |
| 401 / 403 | — | Standard auth failures: no/invalid access token (`401`), unverified email (`403 EMAIL_NOT_VERIFIED`). |

**Configuration** (see `.env.example`; the first three are required at
server startup — the server refuses to boot without them, and secrets
are never logged): `SEP10_SIGNING_SECRET` (a dedicated key, separate
from `PLATFORM_PAYER_SECRET`/`PLATFORM_RELEASER_SECRET` — it only signs
web-auth challenges, so it can be rotated without touching money-moving
keys), `SEP10_HOME_DOMAIN`, `SEP10_WEB_AUTH_DOMAIN`, plus optional
`SEP10_NETWORK_PASSPHRASE`, `SEP10_HORIZON_URL` (both default to
testnet) and `SEP10_CHALLENGE_TIMEOUT_SECONDS` (default 300).

## Not yet implemented

Everything else in `ARCHITECTURE.md` §3's module list (`patients`,
`facilities`, `consultations`, `referrals`, `prescriptions`, `lab-orders`,
`pharmacy-orders`, `notifications`) has no routes yet — Phase
2 onward, see `ROADMAP.md`. (`payments` has routes — see the Payments
section above.)
