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

## Known gap

`PaymentIntent.orderType`/`orderId` are opaque, unvalidated fields (see
`schema.prisma` comment) — `Prescription`/`LabOrder`/`FulfillmentRecord`
are still Phase 0 placeholders (Phase 4/5 aren't built). This phase is
deliberately buildable independently of those; once they're real, add
proper validation (does `orderId` actually exist, is it actually
assigned to `facilityId`) as a follow-up, not assumed done by this ADR.

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
