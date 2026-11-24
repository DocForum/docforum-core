# Escrow event alerts runbook

Scope: what an operator does when the escrow event poller (issue #86) reports a
release or refund that core did not initiate, or when `catchupError` says the
RPC's event retention has moved past our cursor (issue #356). Written against
`backend/src/modules/payments/services/escrow-events.ts` as it is on `main`;
every step below is something the current code actually supports. On-chain
fund recovery — rotating the releaser key, migrating escrows between contract
deployments — is not covered here; that is the custody decision in issue #25.

## What the poller does

`startEscrowEventPoller` (`backend/src/jobs/escrow-events.ts`) runs
`pollEscrowContractEvents` on an interval, and does nothing at all while
`ESCROW_CONTRACTS` is empty. Each pass, per configured contract
(`src/config/payments.ts`):

1. Pages `getEvents` from the Soroban RPC (100 per page, at most 20 pages) and
   upserts each event under the unique pair `(contractId, eventId)`. Re-reading
   a ledger never duplicates a row and never resets a row's `state`, because the
   upsert's `update` clause is empty.
2. Matches pending rows against `PaymentIntent`: an event is `matched` when the
   intent with that `escrowId` and `sorobanContractId` already holds the status
   the event describes — `released` for a release, `refunded` for a refund,
   `escrowed` for anything else.
3. Marks a `released` or `refunded` event `unmatched` once it has stayed pending
   for 30 seconds (`graceMs`, hardcoded) and alerts for it exactly once. The
   write is a conditional `updateMany`, and only the process whose write changed
   the row sends the alert.

Each pass reconciles at most 500 pending rows, oldest first, so a backlog built
up by an RPC outage drains over several passes rather than in the first one
after recovery.

| Env var | Purpose |
|---|---|
| `ESCROW_CONTRACTS` | `CONTRACT_ID@START_LEDGER,...` — one entry per deployment. Empty means no polling and no unmatched detection. |
| `ESCROW_EVENT_START_LEDGER` | Start ledger when a deployment is configured through the older single `ESCROW_CONTRACT_ID`. |
| `ESCROW_EVENT_POLL_INTERVAL_SECONDS` | Pass interval. Default 15. |
| `ESCROW_EVENT_ALERT_WEBHOOK_URL` | Optional destination for the unmatched alert. Unset means log-only. |
| `SOROBAN_RPC_URL` | The RPC the poller reads (falls back to `ESCROW_RPC_URL`). |
| `FEATURE_FLAG_CACHE_TTL_SECONDS` | How long a non-serving process keeps a stale feature flag. Default 15. |

One process detail worth knowing when reading rates: `src/server.ts` starts the
poller twice (line 30 and line 154, the second handle discarded), so two
intervals poll the same contracts. The upsert dedupes, so the effect is extra
RPC requests rather than duplicate rows.

## What an alert is made of

The alert has two outputs, and only one of them is durable:

- Always: `[security:high] unmatched escrow terminal event` in the log of the
  process that won the write, with the event `id`, `contractId`, `eventType`,
  `escrowId`, `ledger` and `txHash`. No patient data and no secrets.
- Sometimes: an unsigned `POST` of the same fields to `ESCROW_EVENT_ALERT_WEBHOOK_URL`.
  A failure is logged and dropped — there is no retry, no queue and no record of
  which alerts were delivered.

Treat `GET /admin/payments/escrow-events` as the system of record and the
webhook as a notification. `unmatched` is terminal, so an alert you handled
last week is still readable today.

## Reading the admin endpoint

`GET /admin/payments/escrow-events` — admin role, read-only.

| Parameter | Values |
|---|---|
| `state` | `pending`, `matched`, `unmatched`. Omit for all. |
| `limit` | 1–200, default 50. |
| `cursor` | Opaque `nextCursor` from the previous page. |

The response is `{ items, cursors, nextCursor }`. `items` is newest-first by
`detectedAt`, and each row is returned whole: `id`, `eventId`, `contractId`,
`ledger`, `txHash`, `escrowId` (stringified, or `null`), `eventType`, `state`,
`paymentIntentId`, `detectedAt`, `alertedAt` and `payload`. Two things about those fields:

- `paymentIntentId` is only set when a row matched, so an `unmatched` row is
  found by `escrowId` and `contractId`, not by intent.
- `payload` is the base64 XDR of the raw topics and value
  (`services/escrow-event-decoder.ts`). It is evidence, not something to read in
  a console.

`cursors` reports every `EscrowEventCursor` row — `startLedger`, `cursor`,
`lastLedger`, `catchupError` — and is worth reading first on any escrow alert.
A thin `pending` backlog with a `lastLedger` stuck in the past means the poller
is not running (empty `ESCROW_CONTRACTS`) or is stalled, which from the outside
looks exactly like "nothing went wrong".

## Triage an unmatched release or refund

An `unmatched` release or refund means money moved on-chain that core has no
record of deciding to move. Most are a lag or a lost write; a few are a real
incident. Work the list oldest-first, and treat more than one unmatched event in
an hour as an incident rather than a queue.

1. Take `escrowId`, `contractId`, `txHash`, `ledger` from the row. If
   `escrowId` is `null` the decoder did not find an escrow id in the event's
   third topic, so the transaction itself is the only handle: open `txHash` on
   your RPC or explorer and read the call and the amounts there.
2. Find the intent that owns the escrow. No endpoint searches by escrow id, so
   this is a query against `PaymentIntent`:

   ```sql
   SELECT id, status, "sorobanContractId", amount, "assetCode"
   FROM "PaymentIntent" WHERE "escrowId" = <escrowId>;
   ```

   If it returns a row whose `sorobanContractId` differs from the event's
   `contractId`, the escrow was created on a deployment core is not watching;
   that is a configuration gap, not a theft.
3. No intent at all, but the escrow exists: run `npm run reconcile:escrows` from
   `backend/` (read-only). It lists stale `funding` claims and every observed
   escrow creation with no intent. Note the limit — its second section only
   covers creation events (`created`, `create_escrow`, `funded`, `deposit`), so
   it will not list the release you are triaging. It does tell you whether the
   escrow was ever linked, which is the question.
4. There is an intent and it is already `released` (or `refunded`): the event
   arrived after the grace window because the intent write or the RPC read was
   late. Reconcile the ledger and the intent's audit trail, then leave the row
   `unmatched` — there is nothing to acknowledge, and the count of these tells
   you how tight 30 seconds is.
5. There is an intent still `escrowed`: core did not authorise this settlement.
   Check `GET /admin/audit-events?entityType=PaymentIntent&entityId=<intentId>`.
   Automatic settlement is recorded as `payment_intent.released` under the system
   actor (`actorUserId: null`) with `metadata.settlementSource: 'automatic'`
   (`services/index.ts:863`). A manual override — `POST /payments/intents/:id/release`
   or `/refund`, admin plus `Idempotency-Key` — writes the same action name but
   names the admin as the actor and carries no `settlementSource`
   (`services/index.ts:788`, `:475`). So: a settlement with a named actor is a
   human decision you can go and ask about; a settlement with no audit row at all
   means nobody authorised it in core, which is the case where you stop and
   escalate.
6. Check `GET /admin/outbox/dead-letters` for the same window. Automatic
   settlement rides on `order.fulfilled` (release) and `order.rejected` /
   `order.expired` (refund), so that is what to look for. Five failed attempts
   dead-letter the event with `lastError: 'HANDLER_FAILED'`; an abandoned lease
   says `MAX_ATTEMPTS_EXCEEDED` and an unregistered type says `NO_HANDLER`. A
   dead-lettered `order.fulfilled` sitting next to an unmatched release usually
   explains each other. The endpoint returns `id`, `type`, `attempts`,
   `lastError` and the two timestamps — payloads are never exposed. Retries before
   the fifth attempt are quiet: 25 events per 5-second pass, backoff from 5
   seconds to an hour, so an event can be pending and healthy at the same time
   your alert fires.
7. Record the outcome where the money lives: the intent's status and the audit
   rows are the books. If the escrow was real and unlinked, `npm run
   reconcile:escrows -- --adopt=... --escrow-id=... --contract-id=... --confirm`
   links it. Only run `--adopt` when you have confirmed the escrow belongs to
   that intent — the conditional write means a guess is recoverable, but the
   on-chain escrow is not.

## When to pause funding

Pause when you cannot explain the outflow yet, and pause the funding side first:
it is the only side with a switch.

`payments.wallet_funding` gates every new patient funding transaction — a
disabled flag makes `preparePaymentIntent` answer
`403 FEATURE_DISABLED` (`backend/src/modules/payments/services/index.ts:667`).

1. `PATCH /admin/feature-flags/payments.wallet_funding` with `{"enabled": false}`
   (admin role). Use `enabled`, not `rolloutPercent: 0`: evaluation short-circuits
   on `enabled` before it looks at the allow-list, while a zero percentage still
   leaves every `allowUserIds` entry funded
   (`backend/src/modules/flags/evaluate.ts:35`). Check
   `GET /admin/feature-flags` first so you know what you are restoring later. The
   change is audited as `feature_flag.updated` on `entityType: 'FeatureFlag'`,
   which is the record that the pause happened:
   `GET /admin/audit-events?entityType=FeatureFlag&entityId=payments.wallet_funding`.
2. It takes effect immediately in the process that served the request and within
   `FEATURE_FLAG_CACHE_TTL_SECONDS` (default 15) elsewhere.
3. Confirm from a patient account: `GET /me/flags` shows the evaluated value, and
   `POST /payments/intents/:id/prepare` returns `403 FEATURE_DISABLED`.

Know what it does not do. It does not recall a transaction a patient already
prepared — those stay valid until the expiry sweep (`backend/src/jobs/payment-intents.ts`)
moves the intent back to `created`, and the patient can prepare again once the
flag is back on. It does not stop settlement of escrows that already exist,
because the release path is an outbox handler (`src/events/handlers.ts` →
`releaseEscrowForFulfilledOrder`) and the outbox worker has no switch: it starts
unconditionally from `src/server.ts`. Stopping releases today means redeploying
without the worker, which stops every other job too — a maintenance-window
action, not a triage action. If an unexplained release is still flowing, the
decision is on-chain (withhold the releaser key), and that is issue #25.

## Reconciling after a retention gap

`getEvents` only serves ledgers the RPC still retains. When the persisted cursor
falls out of that window, the poll throws, `isRetentionError` recognises it as a
message pattern (`retention`, `oldest ledger`, `start ledger … old/window`,
`ledger … prun`), and the contract's cursor row gets a `catchupError` naming the
configured start ledger.

Two consequences to accept before you start:

- The poller for that contract is now stalled. Recovery is deliberate: it only
  resumes when `ESCROW_CONTRACTS` gives that contract a start ledger strictly
  greater than the persisted one (`escrow-events.ts:88`). Redeploying with the
  same value does nothing, and an earlier value replays nothing.
- Events below the ledger you choose are gone from the RPC and were never copied
  into `EscrowChainEvent`. Any escrow that changed status inside the gap will
  show up as an unmatched release/refund, or as a `pending` row that never
  matched. Expect the gap to produce work in the section above.

To reconcile:

1. Read the gap: `catchupError` and `startLedger` on the cursor row from
   `GET /admin/payments/escrow-events` (in `cursors`), and find the oldest ledger
   the replacement RPC actually serves. The ledger quoted in `catchupError` is
   the one you configured, which may itself be unretained — do not try to
   recover to it.
2. Take escrow money out of scope for the gap window: pause funding as above, and
   note in the incident record that events between the old cursor and the new
   start ledger are missing.
3. Set the reviewed start ledger — higher than the persisted one, at or above
   the RPC's oldest available ledger, and after you have reasoned about which
   escrows were live in the skipped range. Redeploy; the next pass rewrites
   `startLedger`, clears `cursor` and `catchupError`, and resumes from there.
4. Alternatively reset the row directly:

   ```sql
   DELETE FROM "EscrowEventCursor" WHERE "contractId" = '<contractId>';
   ```

   The next pass re-creates it from the configured `ESCROW_CONTRACTS` start
   ledger. Already-stored events keep their state, so replaying does not re-alert
   for a release you already triaged.
5. Work the gap by hand for the escrows that were live: the contract is the
   source of truth for an escrow's terminal state, so each one is either
   reconciled onto its intent (`--adopt` for a creation, an audited admin status
   change for a settlement) or recorded as unexplained.
6. Watch for the flag clearing on its own: `catchupError` is set to null on every
   successful page (`escrow-events.ts:117`). A transient success wipes the
   warning while the gap remains, so record the gap outside the database too.

If the poll fails for a reason that is not retention-shaped — an RPC outage, a
bad URL, a rate limit — the pass logs
`[jobs] escrow event poll failed` with the error name only and sets no
`catchupError`. A `lastLedger` that stops advancing with a null `catchupError`
is that case: it is an availability problem, and it resolves when the RPC does.

## What does not exist

These come up in every post-incident review, so they are listed rather than
assumed:

- No acknowledgement or resolution workflow. `unmatched` is terminal and there is
  no way to mark an event handled, so the endpoint's unmatched count grows
  forever. Triage time has to be tracked outside it.
- No requeue. A dead-lettered event is not replayable through the API; there is
  no admin endpoint for it.
- No durable alert record. Nothing is written for the alert itself — `alertedAt`
  is the only evidence it was sent, and it does not say where.
- No funding switch for in-flight or already-escrowed payments. The feature flag
  gates preparation only.
- No backfill. There is no tool to re-fetch events the RPC dropped; a retention
  gap is closed by hand, escrow by escrow.
- No on-demand poll. You cannot force a pass from the API; the shortest wait is
  one `ESCROW_EVENT_POLL_INTERVAL_SECONDS` interval.
- Silent `unknown` events. A topic the decoder cannot read becomes
  `eventType: 'unknown'`, which is matched only against an intent that is already
  `escrowed` — otherwise it sits in `pending` forever, because only
  `released` and `refunded` can alert. A growing `pending` set of `unknown` rows
  after a contract upgrade means the event shape changed, and nothing will tell
  you so except looking.

## Staging record

None yet. Record each alert triaged here: the event `id`, which of the triage
outcomes it was, whether funding was paused and for how long, and the ledger
range for any retention gap.
