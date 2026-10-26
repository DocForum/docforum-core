# ADR 0004: Payments v1 is custodial — docforum-core holds the Stellar identities, patients never sign anything

Status: Accepted

## Context

Phase 5.5 needs to actually call `@docforum/escrow-sdk`'s `createEscrow`/
`release`/`refund`. Each of those requires a real Ed25519 `Keypair` to
sign — Soroban's `require_auth()` is enforced on-chain, not something a
backend can fake.

Two fundamentally different architectures were possible:

1. **Non-custodial**: the patient's own wallet (a browser extension like
   Freighter) signs the `create_escrow` call directly, since the patient
   is the contract's `payer`. `docforum-core` never touches the patient's
   private key.
2. **Custodial**: `docforum-core` holds its own Stellar identity and acts
   as the on-chain `payer` itself. The patient never has a wallet or
   signs anything; funding a payment is a backend-only action.

Option 1 is the more "real crypto" design, but it directly conflicts with
`docforum-web`'s `ARCHITECTURE_ESSENTIALS.md` hard rule 1: **no direct
Stellar calls from the frontend, ever — everything goes through
`docforum-core`'s API.** A patient's wallet signing a transaction in the
browser is, unavoidably, a direct Stellar call from the frontend (the
signed transaction has to reach the network from somewhere, and
`docforum-core`'s API relaying an already-signed transaction on the
patient's behalf doesn't remove the frontend's need to construct and sign
it in the first place).

## Decision

**Custodial v1** (option 2). `docforum-core` holds two of its own Stellar
identities, configured via environment secrets, never logged, never
returned by any endpoint:

- `PLATFORM_PAYER_SECRET` — the identity that funds escrows (`payer` in
  `create_escrow`).
- `PLATFORM_RELEASER_SECRET` — the identity set as every escrow's
  `releaser` (per `docforum-escrow`'s ADR 0002), used to call
  `release`/`refund`.

`WalletLink` (see `schema.prisma`) is scoped to the **facility**, not the
patient — it's where a facility receives payout (the contract's `payee`),
not an identity that signs anything. A patient's actual payment
collection (fiat, or however DocForum funds its platform payer identity)
is explicitly out of scope here — same category as `docforum-escrow`'s
own README noting fiat on/off-ramp and KYC are `docforum-core`'s concern,
not modeled or assumed by this ADR either.

## Why

- **The only design consistent with the existing frontend hard rule.**
  `docforum-web`'s "no direct Stellar calls" rule already existed before
  this ADR — a non-custodial design would have required either violating
  that rule or writing around it with awkward transaction-relay
  machinery that still amounts to the same thing. Custodial sidesteps
  the conflict entirely: every Stellar call genuinely originates from
  `docforum-core`.
- **Matches `docforum-escrow`'s own releaser design.** ADR 0002 there
  already assumes the releaser is "the calling application's own service
  identity" — this ADR is the other half of that: the payer is too.
- **Honest about what's not solved.** This does not solve fiat
  collection, custody risk, or regulatory questions a real custodial
  payment flow would need — it's a v1 that makes the Stellar integration
  itself real and demonstrable without pretending those harder questions
  are answered. If DocForum ever needs genuine non-custodial patient
  wallets, that's a v2 architectural change, not an extension of this one.

## Order linkage (resolved by issue #85)

`PaymentIntent` has nullable `prescriptionId` and `labOrderId` foreign keys;
a PostgreSQL check constraint requires exactly one. Each order snapshots its
patient, issuing doctor, selected pharmacy/lab, and total amount. V1 has no
facility catalog or price service, so the issuing clinician supplies the total
in native XLM stroops at issuance. This is an explicit manual pricing source,
not a currency conversion or estimate.

Issuing a correction creates a new order row. An unpaid (`created`) intent is
moved to the new row in the same transaction. An escrowed intent remains with
the original row and uses the existing admin-triggered refund action; this
preserves the current custodial v1 refund policy. The migration removes only
orphaned preview intents in `created` state and aborts if any funded or
terminal intent has no matching order.
## Consequences

- The platform payer identity needs real funding to do anything (testnet
  XLM via Friendbot for now — see `docs/testnet-deployments.md` in
  `docforum-escrow` for the pattern). Running out of testnet funds is an
  operational concern, not a code bug; no auto-funding is built here.
- `release`/`refund` are callable by anyone who can call this module's
  service functions with the platform releaser identity — there's no
  actual `FulfillmentRecord.status == fulfilled` trigger yet (that model
  doesn't exist), so v1 exposes `release`/`refund` as directly-callable
  actions (see the "Known gap" above), restricted at the HTTP layer to
  `admin` role rather than any automatic trigger. Do not read this as the
  final design for how release gets triggered in production — it's what
  the roadmap already flagged: "don't let it drift into a manual/admin-
  triggered release" is the target once Phase 4/5 exist; v1's admin-only
  gate is the honest interim, not the destination.

## Update — 2026-10-19 (issues #79 and #80)

`PaymentIntent` is no longer native-XLM-only: issue #79 added an
allowlisted `assetCode` + `tokenContractId` per intent and renamed
`amountStroops` to the token-agnostic `amount` (a plain column rename, so
existing values are preserved). The custodial funding path described here
is unchanged — the platform payer still funds the escrow — but the token it
pulls from is now the intent's asset, defaulting to the legacy
`ESCROW_TOKEN_ID` for pre-#79 rows. ADR 0005's non-custodial path is being
added alongside this one (issue #80 added prepare; submit is still pending),
and release/refund remain admin-triggered exactly as described above.


## Event monitoring and releaser-key alerts (issue #86)

The backend polls Soroban RPC getEvents independently for each configured contract deployment, persisting each page and its cursor together. Events are deduplicated by contract and RPC event id, then matched against the local PaymentIntent state. Unmatched release/refund events raise high-severity structured logs, can be forwarded to ESCROW_EVENT_ALERT_WEBHOOK_URL, and are visible through the admin endpoint. If the RPC retention window has advanced beyond a saved cursor, the poller records an explicit catch-up error and does not silently skip the gap. This detects unexpected terminal contract events; it does not itself protect the releaser key.
## Signing provider seam (issue #87)

Payment operations use the `PlatformSigner` interface (`publicKey`, async transaction signing, and optional Soroban auth-entry signing) rather than constructing keypairs in the payments service. The env adapter preserves the current `PLATFORM_PAYER_SECRET` / `PLATFORM_RELEASER_SECRET` behavior. A reference HTTP adapter supports a signer service with role-scoped `GET /signers/{role}/public-key`, `POST /signers/{role}/sign-transaction`, and `POST /signers/{role}/sign-auth-entry` endpoints. Requests carry the network passphrase; the remote public key must match the configured expected address. Errors are sanitized before leaving the adapter.

The HTTP adapter is a seam, not a managed KMS deployment. It requires HTTPS, a bearer token, and operator-provided signer service; production deployment choice and custody policy remain with issue #25. The issue #25 custody ADR should choose an adapter configuration here without changing the payment services interface. The implementation follows the signer surface proposed by `docforum-escrow` issue #60. The current published SDK remains compatible through its signer-shaped Keypair boundary; when SDK #60 is released, the local bridge can be removed without changing payment services. Signing is completed before the database transition transaction begins.

## Network and contract safeguards (issue #88)

Payments network settings are parsed at process startup from ESCROW_NETWORK_PASSPHRASE and ESCROW_RPC_URL. Mainnet is refused unless ALLOW_MAINNET=true is explicitly set after the security review. When an active ESCROW_CONTRACT_ID is configured outside tests, ESCROW_HEALTHCHECK_ID is required and the backend calls getStatus before opening its HTTP listener; a failed check prevents startup. Tests skip this network call.

ESCROW_LEGACY_CONTRACT_IDS is a comma-separated registry retained for existing intents. Funding records the active contract id on the intent; release and refund use only that recorded id and reject intents with an absent or unregistered id. ESCROW_ASSET_ALLOWLIST is a comma-separated token registry; when set, funding rejects a configured escrow token outside the list. ESCROW_TOKEN_ID remains the active funding token.
