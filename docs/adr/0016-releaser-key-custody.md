# ADR 0016: Custody of the platform escrow releaser key

**Status:** Accepted
**Date:** 2026-11-22
**Phase:** 5.5 — Payments (issue #25)
**Related:** ADR 0002 (Stellar escrow for fulfillment payout, and escrow
ADR 0002 in `docforum-escrow`), ADR 0004 (custodial payments v1),
ADR 0005 (non-custodial patient payments), ADR 0015 (production target),
`docforum-escrow/docs/threat-model.md` §4 (T1, T2)

## Context

Every escrow `docforum-core` creates names a **releaser** — the only address
allowed to call `release` / `refund` on it. `create_escrow` stores that
address at creation (`docs/adr/0002` in `docforum-escrow`), and the contract
checks it with `require_auth`, so the releaser is the account whose
authorization the contract requires.

Today one environment variable holds that identity:

```text
PLATFORM_RELEASER_SECRET=<a single Stellar secret key>
```

`docforum-escrow`'s threat model rates the consequences High:

- **T1 — releaser compromised.** One leaked key can release or refund *every
  open escrow the platform has ever funded*. Blast radius is all money in
  flight, not one order.
- **T2 — releaser lost.** One lost key locks every open escrow until its
  refund deadline, after which the contract's timeout path returns funds to
  the payer — but until then nobody can settle anything, and any escrow the
  timeout path misses stays stuck.

Per-escrow releasers were designed for (escrow ADR 0002) but nothing in this
repo uses them: `services/index.ts` passes `platformReleaser.publicKey()` for
every intent, and the same current key is used at release/refund time.

This ADR decides how the releaser is held for v1 now that a production
target exists (ADR 0015 — Render, paid). It does not implement the change;
follow-ups are listed at the end.

## Decision

**A Stellar multisig account is the releaser for production escrows, with
2-of-4 signing authority split across three custodied keys plus a
break-glass master key. Per-escrow releaser public keys are recorded on the
`PaymentIntent` so a settled escrow remains releasable after any key
change. Key material never sits in the application's environment as a
single operational secret, and no production escrow is funded until the
signing path below exists.**

### The account

One releaser account per environment (staging, production — never shared).
For production:

- Three operational signer keys (A, B, C), each weight 1, each held by a
  different named custodian in the team password manager. "Different
  custodian" means a different person and a different storage location —
  not three entries in one vault.
- The account's own master key, weight 1, offline (printed/escrowed in the
  organisation safe, not on a laptop and not in CI). It exists so that
  losing one operational key does not lock the funds; it is not a day-to-day
  signer.
- Medium and high thresholds both **2**, master weight 1. A single key —
  operational or master — cannot authorize a release or refund; any two of
  the four can.

This directly answers the threat model:

- **T1:** a single compromised key is insufficient to move funds. An attacker
  needs two independent custodians, which is a different class of incident
  and is detectable (the second key must still be used to submit).
- **T2:** losing one key leaves 2-of-3 remaining operational signers, so
  settlement continues; the lost key is rotated out at leisure without
  touching open escrows.

### Why not KMS/HSM (option 2), and why not rotation (option 3)

- **KMS/HSM** is the right long-term home for signer keys, and ADR 0015's
  deadline is not a reason to rush it. A KMS alone would still be a single
  authority: it removes "key in an env var" but does not by itself require a
  second human to approve a release. Doing it properly means an approval
  workflow (two principals, audited) — a project, not a config change. It
  remains the plan once core moves to a cloud account with a real audit
  trail (ADR 0015's AWS alternative), and the account-level threshold design
  above carries over unchanged.
- **Per-period rotation** bounds T1 to one period's escrows, but does
  nothing for T2, and it adds a per-period key inventory that release/refund
  must consult. Rotation also has to answer "which key was this escrow
  funded with?" — the same question multisig answers with a single stored
  public key. Rotation is *not* adopted as the primary control. Rotation of
  an individual signer key (after a suspected leak) is still a supported
  operation, and is cheap precisely because the account is multisig.

### What must change in code (follow-ups)

1. **`docforum-escrow` SDK:** `release`/`refund` accept one `caller`
   `Keypair` and sign once. A multisig releaser needs the transaction signed
   by two of A/B/C. The SDK must accept a caller *account* plus a set of
   signer keypairs (or an externally collected signature set), and submit
   only when the threshold is met. This is the gating dependency: **no
   production escrow is funded with the multisig releaser until it ships.**
   Payments launch behind the existing feature flag, so this does not block
   the rest of the product going live.
2. **`docforum-core`:** persist the releaser public key on each
   `PaymentIntent` at funding time (alongside `fundedWalletAddress`, which
   already follows this append-only-in-spirit pattern) and use *that* at
   release/refund instead of the currently configured key. Without this, a
   signer rotation silently breaks settlement of escrows funded under the
   old account. This is a schema change and needs `ARCHITECTURE.md` §4.
3. **Signer collection:** release/refund becomes a two-step operation —
   build the transaction, collect the second signature, submit. The
   admin/manual release path (`POST /payments/intents/:id/release`) and the
   automatic settlement path (`releaseEscrowForFulfilledOrder`) both need a
   story for "waiting for the second signer". Recommended: automatic
   settlement enqueues the signed transaction and a short-lived approval
   task; the outbox already provides at-least-once delivery, so the approval
   must stay idempotent.
4. **Configuration:** `PLATFORM_RELEASER_SECRET` becomes
   `PLATFORM_RELEASER_PUBLIC_KEY` plus signer secrets supplied at settlement
   time (`PLATFORM_RELEASER_SIGNER_<ID>`), not at startup. Startup
   verification checks the account's thresholds are exactly the expected
   configuration and refuses to start otherwise — a releaser account whose
   thresholds were changed by hand is a security regression, not a config
   detail.

### Staging and the preview

Staging and the free preview keep a **single-signer releaser** with testnet
funds, from the environment group (ADR 0015). Requiring two custodians to
exercise a test suite would guarantee it is never exercised. The staging
account uses the same custom-account shape (so the flow is exercised) with
threshold 1 and only the automation key registered.

### What is explicitly not decided here

- The **platform payer** key (`PLATFORM_PAYER_SECRET`) — it funds escrows
  but cannot release them, so its compromise is a spending limit, not a
  custody break. Keep it a documented follow-up, not an implied part of this
  decision.
- Custody of `FIELD_ENCRYPTION_KEY_V1` and the JWT secrets — those are
  ADR 0015's environment-group decision.
- Fee/burner accounts, sponsor accounts, and any on-chain upgrade authority.

## Consequences

- Losing one signer key is recoverable; losing two is not. That is the
  intended trade, and it makes signer-key *availability* as important as
  secrecy — hence the offline master key and the password-manager copies.
- Settlement is no longer a single-service operation: it needs a second
  signature. This is the honest cost of removing the single point of
  compromise, and it is why the SDK change and the approval flow are
  prerequisites for production escrows rather than "nice to have".
- Any environment that funds escrows before the SDK change is single-key
  custody and must be labelled as such in its launch checklist — no
  production escrow is silently funded under the old model.
- Rotating a signer no longer requires touching existing escrows, because
  each intent records the releaser it was funded under.
- The threat model's T1/T2 move from "High, unmitigated" to "High,
  mitigated for new escrows after rollout"; existing testnet escrows are
  unaffected and can be settled with the current key.
