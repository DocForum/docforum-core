// Issue #24 integration coverage: escrow funding is idempotent at the
// database, not in process memory.
//
// Real Postgres (embedded, port 5481) and the module's own services; the SDK
// and Horizon are substituted through the module's existing test seams, so no
// network is involved. What this proves:
//  - N concurrent fund calls on one intent produce exactly ONE on-chain
//    create_escrow call, one `escrowed` row, and 409s for the losers;
//  - a failed chain call returns the intent to `created` (audited), and a
//    retry funds it exactly once;
//  - a crash between the chain call and the status write leaves `funding`,
//    and the reconcile report + explicit adopt path resolves it;
//  - an operator can release a claim that never reached the chain.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { Keypair } from '@stellar/stellar-sdk';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5481; // unique per integration file
const runId = Date.now();

const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const CONTRACT_ID = 'CFUNDINGTESTCONTRACT';

// Before src/config is imported (dynamic imports in beforeAll).
process.env.PAYMENT_ASSETS = JSON.stringify([{ code: 'XLM', tokenContractId: NATIVE_SAC, decimals: 7 }]);
process.env.ESCROW_TOKEN_ID = NATIVE_SAC;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-funding-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_funding_test`;
const TEST_ACTOR = { userId: null, role: null, requestId: `funding-${runId}` };

async function captureError(thunk: () => unknown): Promise<{ status?: number; code?: string }> {
  try {
    await thunk();
  } catch (err) {
    return err as { status?: number; code?: string };
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

describe('escrow funding idempotency (issue #24)', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let paymentsService: typeof import('../../src/modules/payments/services/index.js');
  let facilityId: string;
  let patientProfileId: string;

  // The chain seam: every createEscrow call is recorded, and tests can make
  // the next N calls fail (a declined/failed submit, not a crash).
  const sdkCalls: Array<{ amount: bigint; conditionRef: string }> = [];
  let failNextCreateEscrow = 0;
  let nextEscrowId = 5000n;
  let intentSequence = 0;

  async function createIntent(amount = 10_000_000n) {
    intentSequence += 1;
    const order = await createOrderFixture(prisma, {
      patientProfileId,
      facilityProfileId: facilityId,
      kind: 'prescription',
      amountStroops: amount,
      tag: `funding-${runId}-${intentSequence}`,
    });
    return paymentsService.createPaymentIntent({
      orderType: 'prescription',
      orderId: order.id,
      patientProfileId,
      facilityId,
      assetCode: 'XLM',
      amount,
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_funding_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.PLATFORM_PAYER_SECRET = Keypair.random().secret();
    process.env.PLATFORM_RELEASER_SECRET = Keypair.random().secret();
    process.env.ESCROW_CONTRACT_ID = CONTRACT_ID;

    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    paymentsService = await import('../../src/modules/payments/services/index.js');

    paymentsService.setEscrowSdkForTests({
      Keypair,
      EscrowClient: class {
        async createEscrow(params: { amount: bigint; conditionRef: string }) {
          if (failNextCreateEscrow > 0) {
            failNextCreateEscrow -= 1;
            throw new Error('simulated submit failure');
          }
          sdkCalls.push({ amount: params.amount, conditionRef: params.conditionRef });
          nextEscrowId += 1n;
          return { escrowId: nextEscrowId, txHash: `funding-hash-${nextEscrowId}` };
        }
        async release() {}
        async refund() {}
      },
    } as never);
    paymentsService.setTrustlineCheckerForTests(async () => true);

    const facilityUser = await prisma.user.create({
      data: { email: `facility-funding-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    facilityId = (
      await prisma.facilityProfile.create({
        data: { userId: facilityUser.id, name: 'Funding Pharmacy', type: 'pharmacy' },
      })
    ).id;

    const patientUser = await prisma.user.create({
      data: { email: `patient-funding-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    patientProfileId = (
      await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Funding Patient' } })
    ).id;

    await paymentsService.linkWallet(facilityId, Keypair.random().publicKey());
  }, 180_000);

  afterAll(async () => {
    paymentsService?.resetEscrowSdkOverride();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('makes exactly one chain call for N concurrent fund requests', async () => {
    const intent = await createIntent();
    sdkCalls.length = 0;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id)),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const rejection of rejected) {
      expect((rejection as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }

    // The guard is the database's conditional UPDATE: only the winner's
    // request reached the SDK at all.
    expect(sdkCalls).toHaveLength(1);
    const row = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.status).toBe('escrowed');
    expect(row.escrowId).not.toBeNull();
    expect(row.fundingStartedAt).toBeNull();
    expect(row.version).toBe(2); // one bump on settle; the claim is internal bookkeeping
  }, 60_000);

  it('returns the claim to `created` when the chain call fails, and a retry funds once', async () => {
    const intent = await createIntent(20_000_000n);
    sdkCalls.length = 0;
    failNextCreateEscrow = 1;

    const error = await captureError(() => paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id));
    expect(String(error)).toContain('simulated submit failure');

    const afterFailure = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(afterFailure.status).toBe('created');
    expect(afterFailure.fundingStartedAt).toBeNull();
    expect(sdkCalls).toHaveLength(0);

    const failedAudit = await prisma.auditEvent.findFirst({
      where: { entityType: 'PaymentIntent', entityId: intent.id, action: 'payment_intent.funding_failed' },
    });
    expect(failedAudit).toMatchObject({ fromState: 'funding', toState: 'created' });

    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);
    expect(funded.status).toBe('escrowed');
    expect(sdkCalls).toHaveLength(1);
  }, 60_000);

  it('reports a stuck `funding` claim and its observed untracked escrow, then adopts it', async () => {
    const intent = await createIntent(30_000_000n);
    // Simulate the crash: the chain call happened (the intent was claimed
    // with its condition_ref) but the write back to `escrowed` never ran.
    const fundingStartedAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'funding', fundingStartedAt },
    });
    const orphanEscrowId = 777_001n;
    await prisma.escrowChainEvent.create({
      data: {
        eventId: `orphan-${runId}`,
        contractId: CONTRACT_ID,
        ledger: 1234,
        txHash: 'orphan-funding-hash',
        escrowId: orphanEscrowId,
        eventType: 'created',
        state: 'pending',
        payload: {},
      },
    });

    const report = await paymentsService.reportStuckFundingClaims();
    expect(report.stuckClaims.map((claim) => claim.id)).toContain(intent.id);
    expect(report.untrackedEscrows.map((escrow) => escrow.escrowId)).toContain(orphanEscrowId.toString());

    // Adopting an escrow the poller never observed fails closed.
    const unknownError = await captureError(() =>
      paymentsService.adoptObservedEscrow({
        paymentIntentId: intent.id,
        escrowId: '999999',
        contractId: CONTRACT_ID,
      }),
    );
    expect(unknownError.status).toBe(404);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('funding');

    const adopted = await paymentsService.adoptObservedEscrow({
      paymentIntentId: intent.id,
      escrowId: orphanEscrowId.toString(),
      contractId: CONTRACT_ID,
    });
    expect(adopted?.status).toBe('escrowed');
    expect(adopted?.escrowId).toBe(orphanEscrowId);
    expect(adopted?.fundingStartedAt).toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: 'PaymentIntent', entityId: intent.id, action: 'payment_intent.reconciled' },
    });
    expect(audit).toMatchObject({ fromState: 'funding', toState: 'escrowed' });
  }, 60_000);

  it('releases a stuck claim that never reached the chain', async () => {
    const intent = await createIntent(40_000_000n);
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'funding', fundingStartedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const released = await paymentsService.abandonStuckFundingClaim(intent.id);
    expect(released?.status).toBe('created');
    expect(released?.fundingStartedAt).toBeNull();

    // And it is fundable again exactly once.
    sdkCalls.length = 0;
    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);
    expect(funded.status).toBe('escrowed');
    expect(sdkCalls).toHaveLength(1);
  }, 60_000);
});
