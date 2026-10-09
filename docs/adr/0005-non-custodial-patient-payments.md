# ADR 0005: Non-custodial payments v2 — patients fund escrows from their own Stellar wallet

Status: Proposed
Date: 2026-10-08

Builds on ADR 0004 (custodial v1), which stays in place as a fallback.
Depends on `docforum-escrow` ADR 0004 (`refund_after` timeout refund,
SDK 0.3.0).

## Context

ADR 0004 made payments custodial: `docforum-core` funds every escrow
from its own `PLATFORM_PAYER_SECRET`, and the patient never touches
Stellar. That made the integration real and testable, but the escrow
protects nobody in particular. The platform is both payer and releaser,
so the escrow amounts to the platform holding money for itself.

ADR 0004 considered patient wallets and rejected them for one reason:
`docforum-web`'s hard rule 1 ("never calls `docforum-escrow` or Stellar
directly"). It assumed a patient-signed transaction meant the frontend
had to *construct* the transaction and send it to the network itself.

That assumption doesn't hold. The usual Soroban dApp pattern separates
three steps that live in different places:

1. **Build and simulate** the transaction. This needs an RPC connection,
   the contract client and the auth entries. It can happen entirely in
   `docforum-core`.
2. **Sign** it. This needs the patient's key, which lives in their
   wallet extension (Freighter, xBull, etc.). The browser hands an
   opaque XDR string to the wallet and gets a signed XDR string back.
   No network call is involved.
3. **Submit** it and track the result. This needs an RPC connection
   again, so it can also happen in `docforum-core`.

Only step 2 has to happen in the browser, and it isn't a Stellar network
call. So a non-custodial design is possible without `docforum-web` ever
talking to Stellar RPC, Horizon or the escrow contract.

Two other things changed since ADR 0004:

- `docforum-escrow` now has an optional `refund_after` deadline (its
  ADR 0004). With a patient as `payer`, that becomes a real patient
  protection: if an order is never fulfilled and nobody acts, the patient
  can get their money back without needing DocForum's cooperation.
- The escrow threat model (T1, T2) and `docforum-core` issue #25 already
  question holding a single platform releaser key in an env var. Taking
  the platform out of the *payer* role removes half of that key-custody
  risk.

## Decision

Add a **patient-wallet funding mode** alongside the custodial one. A
`PaymentIntent` is funded by exactly one of the two modes. Custodial
stays available for patients without a wallet.

### Roles on the escrow

| Contract role | Custodial (ADR 0004) | Patient wallet (this ADR) |
|---|---|---|
| `payer` | platform payer identity | **patient's own wallet** |
| `payee` | facility's linked wallet | facility's linked wallet (unchanged) |
| `releaser` | platform releaser identity | platform releaser identity (unchanged; custody decided in #25) |
| `refund_after` | not set | **set**: order expiry plus a grace period |

The releaser must stay the platform, never the patient. If the payer
were also the releaser, they could refund themselves after receiving
the service (escrow threat model T8).

### Flow

1. **Link a wallet (once).** The patient proves they control a Stellar
   address by signing a challenge, using the SEP-10 Stellar Web
   Authentication standard, with `docforum-core` as the server. The
   verified address is stored in a patient-scoped wallet link.
   Facilities link payout wallets the same way. That replaces today's
   type-the-address form, so a facility can no longer register an
   address it doesn't control or mistype one (see #26).
2. **Prepare.** `POST /payments/intents/:id/prepare` (patient-only, own
   intent). `docforum-core` builds the `create_escrow` call with the
   patient as `payer`, simulates it, assembles the auth entries, and
   returns the unsigned transaction XDR. It stores the transaction's
   hash and moves the intent to `awaiting_signature`.
3. **Sign.** `docforum-web` passes the XDR to the patient's wallet
   through a wallet-connection library (Stellar Wallets Kit, which
   covers Freighter, xBull, Albedo, Lobstr and others) and gets the
   signed XDR back.
4. **Submit.** `POST /payments/intents/:id/submit` with the signed XDR.
   `docforum-core` checks that it is exactly the transaction it prepared
   (same hash, signed by the linked patient address, not expired). It
   then wraps it in a **fee-bump transaction paid by the platform**, so
   the patient only needs the payment asset, not XLM for fees. It
   submits, waits for the result, and records `escrowId` and
   `stellarTxHash` as `escrowed`.
5. **Release / refund.** Unchanged from ADR 0004: the platform releaser
   acts, admin-triggered until Phase 5's `FulfillmentRecord` exists. In
   addition, once `refund_after` passes, the patient can get their funds
   back even if the platform doesn't act.

### Payment asset

v2 pays in **USDC** through its Stellar Asset Contract, so prices stay
stable for medical bills. Native XLM stays supported for testnet
development. `PaymentIntent` gains a token contract id and stores the
amount in that token's smallest unit. The current `amountStroops` field
is renamed, with a migration.

### Rule change in `docforum-web`

Hard rule 1 is amended, not dropped:

> This repo never calls Stellar RPC, Horizon, `docforum-escrow` or any
> contract directly. **The one exception is asking the user's wallet to
> sign a transaction XDR that `docforum-core` prepared, and returning
> the signed XDR to `docforum-core`.** The frontend never builds,
> simulates or submits transactions, and never holds a private key.

Done this way, every network-facing Stellar call still originates in
`docforum-core`, which was the point of the original rule.

## Why

- **The escrow starts protecting someone.** With the patient as payer,
  the funds are the patient's until the facility fulfils the order, and
  `refund_after` gives them a way out that doesn't depend on DocForum.
  That's the "trust layer between patient and facility" ADR 0002
  intended, which custodial v1 couldn't deliver.
- **Less key custody for the platform.** The platform no longer holds
  a payer key that funds everything. It keeps the releaser key (#25)
  and a fee-sponsor account that can only pay network fees, which is a
  much smaller target.
- **It removes ADR 0004's actual objection.** Splitting build/sign/submit
  keeps all Stellar network access in the backend.
- **It builds on existing work instead of replacing it.** It uses the
  same escrow contract and SDK and the same releaser model, and it keeps
  the custodial path.

### Alternatives considered

- **Keep custodial only.** Simplest, but the escrow stays the platform
  paying itself. Rejected as the long-term design. Kept as a fallback.
- **Frontend builds and submits transactions itself** (the usual
  stand-alone dApp design). Rejected: it breaks hard rule 1 for no
  benefit, and spreads contract ids, RPC configuration and error
  handling across two repos.
- **Patient pays fiat, and an anchor (SEP-24) funds the escrow on their
  behalf.** It removes the need for a wallet, which is the right
  long-term user experience for most patients. Deferred: it needs a
  partner anchor, KYC, and regional licensing decisions. It can be added
  later as a third funding mode without changing this one.

## Consequences

- **Product risk: wallets are a barrier.** Most patients don't have a
  Stellar wallet or USDC. That's why custodial stays, and why wallet
  payment should launch as an option, not the default. Usage numbers,
  not this ADR, should decide whether it becomes the default.
- **Privacy risk: health information can leak on-chain.** A payment from
  a patient's wallet to a facility's wallet is public forever. If the
  patient's address is ever linked to their identity, the facility it
  paid (for example a specialised clinic) can reveal health information.
  `condition_ref` stays an opaque id (escrow threat model T9), but that
  doesn't hide who paid whom. The wallet-linking screen must say this
  plainly. Before launch, decide whether facilities should get payouts
  through a less identifying arrangement (for example a payout address
  per facility category or per period). That's recorded here as an open
  question, not solved.
- **New statuses.** `PaymentIntent` gains `awaiting_signature` and
  `submitting`, plus a path back to `created` if the prepared
  transaction expires unsigned. This overlaps with #24 (idempotent
  funding). Do #24 first and build this on it. A Stellar transaction's
  sequence number already means only one signed version can ever land.
- **Prepared transactions expire.** Soroban transactions have a short
  validity window and a ledger-bounded auth expiry. If the patient takes
  too long to sign, they prepare again. The UI must handle that as a
  normal case, not an error.
- **SDK changes.** `@docforum/escrow-sdk` currently only signs with a
  local `Keypair`. It needs a "prepare unsigned `create_escrow`" call
  that returns XDR, and a "submit signed XDR" call. That's work in
  `docforum-escrow`, and it's generic, so any consumer can use it.
- **Prerequisite.** `docforum-core` still depends on SDK 0.2.0, against
  the older testnet contract. Upgrading to 0.3.0 (which has
  `refund_after`) comes first.
- **Fee sponsorship needs limits.** The platform's fee-sponsor account
  only fee-bumps transactions `docforum-core` prepared itself (the hash
  check in step 4). Add a per-patient rate limit, so the sponsor can't
  be drained by repeated prepare-and-submit calls.
- **Release triggering doesn't change.** Admin-triggered release remains
  the interim, as in ADR 0004, until Phase 5 exists.

## Implementation outline (to become issues once Accepted)

In order:

1. `docforum-core`: upgrade to `@docforum/escrow-sdk` 0.3.0 and the
   current testnet contract.
2. `docforum-core`: #24 (idempotent funding).
3. `docforum-escrow`: SDK prepare-unsigned and submit-signed calls.
4. `docforum-core`: SEP-10 challenge/verify endpoints, and wallet links
   for patients and facilities.
5. `docforum-core`: payment asset field and migration (USDC + XLM).
6. `docforum-core`: prepare/submit endpoints, new statuses, fee-bump
   sponsorship and rate limit, `refund_after` set from order expiry.
7. `docforum-web`: amend hard rule 1 (this ADR), add Stellar Wallets Kit
   and a wallet connect + SEP-10 link screen with the privacy notice.
8. `docforum-web`: patient "pay with wallet" flow, including the
   expired-transaction case.
9. Both: end-to-end test on testnet (extends `docforum-web` #12).
