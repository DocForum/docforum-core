// Escrow funding reconciliation CLI (issue #24).
//
// Funding claims a PaymentIntent `created -> funding` with one conditional
// UPDATE before calling `create_escrow`, and writes `escrowed` after it. A
// crash in between leaves `funding` and an escrow the database never linked.
// Re-calling create_escrow would create a SECOND escrow, so recovery is
// explicit and operator-driven:
//
//   npm run reconcile:escrows
//       Read-only report: claims stuck in `funding` past
//       ESCROW_FUNDING_STALE_AFTER_SECONDS, plus every on-chain escrow the
//       event poller observed with no PaymentIntent referencing it.
//
//   npm run reconcile:escrows -- \
//     --adopt=<paymentIntentId> --escrow-id=<id> --contract-id=<C...> [--confirm]
//       Attach an observed escrow to a stuck claim (funding -> escrowed).
//
//   npm run reconcile:escrows -- --abandon=<paymentIntentId> [--confirm]
//       Release a claim the operator has confirmed never reached the chain
//       (funding -> created, fundable again).
//
// Mutations do nothing without `--confirm`; the script prints what it WOULD
// do instead. No secret, key or patient identifier is printed — ids and
// amounts only (same rule as scripts/create-admin.mjs).
import { prisma } from '../src/db/prisma-client.js';
import {
  abandonStuckFundingClaim,
  adoptObservedEscrow,
  reportStuckFundingClaims,
} from '../src/modules/payments/services/index.js';

function argValue(argv: string[], name: string): string | undefined {
  const flagged = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (flagged) return flagged.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`reconcile-escrows: ${message}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes('--confirm');
  const adoptId = argValue(argv, 'adopt');
  const abandonId = argValue(argv, 'abandon');

  if (adoptId && abandonId) fail('use either --adopt or --abandon, not both.');

  if (adoptId) {
    const escrowId = argValue(argv, 'escrow-id');
    const contractId = argValue(argv, 'contract-id');
    if (!escrowId) fail('--adopt requires --escrow-id.');
    if (!contractId) fail('--adopt requires --contract-id (the id the escrow was observed under).');
    if (!confirmed) {
      console.log(
        `Would adopt escrow ${escrowId} on ${contractId} for PaymentIntent ${adoptId}. Re-run with --confirm.`,
      );
      return;
    }
    const intent = await adoptObservedEscrow({ paymentIntentId: adoptId, escrowId, contractId });
    console.log(
      intent
        ? `Adopted escrow ${escrowId} for PaymentIntent ${intent.id} (now ${intent.status}).`
        : 'PaymentIntent changed concurrently — nothing was written.',
    );
    return;
  }

  if (abandonId) {
    if (!confirmed) {
      console.log(`Would release the funding claim on PaymentIntent ${abandonId}. Re-run with --confirm.`);
      return;
    }
    const intent = await abandonStuckFundingClaim(abandonId);
    console.log(
      intent
        ? `Released the funding claim on PaymentIntent ${intent.id} (now ${intent.status}).`
        : 'PaymentIntent changed concurrently — nothing was written.',
    );
    return;
  }

  const report = await reportStuckFundingClaims();
  console.log(
    `Stale funding claims (older than ${report.staleAfterSeconds}s): ${report.stuckClaims.length}`,
  );
  for (const claim of report.stuckClaims) {
    console.log(
      `  intent ${claim.id}  amount=${claim.amount} ${claim.assetCode}  claimedAt=${claim.fundingStartedAt?.toISOString() ?? 'unknown'}`,
    );
  }
  console.log(`On-chain escrows with no PaymentIntent: ${report.untrackedEscrows.length}`);
  for (const escrow of report.untrackedEscrows) {
    console.log(
      `  escrow ${escrow.escrowId}  contract=${escrow.contractId}  ${escrow.eventType}  ledger=${escrow.ledger}  tx=${escrow.txHash ?? 'unknown'}`,
    );
  }
  if (report.stuckClaims.length > 0) {
    console.log(
      'Resolve each claim with --adopt (escrow exists on-chain) or --abandon (no escrow was created).',
    );
  }
}

main()
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  })
  .finally(() => prisma.$disconnect());
