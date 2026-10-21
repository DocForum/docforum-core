// Issue #79 integration coverage: PaymentIntent is denominated in an
// allowlisted asset (USDC + native XLM), amounts are stored in that asset's
// smallest unit, an unknown asset is rejected, and funding checks the
// payee's trustline before any on-chain call.
//
// Real Postgres (embedded, port 5439) and the module's own services; the
// SDK and Horizon are substituted through the module's existing test seams,
// so no network is involved.
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
const PORT = 5439;
const runId = Date.now();

const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Must be set before src/config is imported (dynamic import in beforeAll).
process.env.PAYMENT_ASSETS = JSON.stringify([
  { code: 'XLM', tokenContractId: NATIVE_SAC, decimals: 7 },
  { code: 'USDC', tokenContractId: USDC_SAC, decimals: 7, issuer: USDC_ISSUER },
]);
process.env.ESCROW_TOKEN_ID = NATIVE_SAC;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-assets-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_assets_test`;
const TEST_ACTOR = { userId: null, role: null, requestId: `assets-${runId}` };

/** Vitest's rejects matchers don't reliably see custom Error fields, so grab
 * the rejection and assert the fields directly. */
async function captureError(thunk: () => unknown): Promise<{ status?: number; code?: string }> {
  try {
    await thunk();
  } catch (err) {
    return err as { status?: number; code?: string };
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

describe('payment assets (issue #79)', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let paymentsService: typeof import('../../src/modules/payments/services/index.js');
  let facilityId: string;
  let patientProfileId: string;
  let payoutWallet: string;

  const sdkCalls: Array<{ token: string; amount: bigint }> = [];
  const trustlineCalls: Array<{ account: string; code: string }> = [];
  let trustlineResult = true;

  async function createIntent(input: {
    kind: 'prescription' | 'lab_order';
    assetCode: string;
    amount: bigint;
    facilityId?: string;
  }) {
    const order = await createOrderFixture(prisma, {
      patientProfileId,
      facilityProfileId: input.facilityId ?? facilityId,
      kind: input.kind,
      amountStroops: input.amount,
      tag: `assets-${runId}-${Math.random().toString(36).slice(2)}`,
    });
    return paymentsService.createPaymentIntent({
      orderType: input.kind,
      orderId: order.id,
      patientProfileId,
      facilityId: input.facilityId ?? facilityId,
      assetCode: input.assetCode,
      amount: input.amount,
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_assets_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.PLATFORM_PAYER_SECRET = Keypair.random().secret();
    process.env.PLATFORM_RELEASER_SECRET = Keypair.random().secret();
    process.env.ESCROW_CONTRACT_ID = 'CTESTCONTRACT';
    process.env.ESCROW_TOKEN_ID = NATIVE_SAC;

    const dbModule = await import('../../src/db/prisma-client.js');
    prisma = dbModule.prisma;
    paymentsService = await import('../../src/modules/payments/services/index.js');

    paymentsService.setEscrowSdkForTests({
      Keypair,
      EscrowClient: class {
        async createEscrow(params: { token: string; amount: bigint }) {
          sdkCalls.push({ token: params.token, amount: params.amount });
          return { escrowId: 7n, txHash: 'funded-hash' };
        }
      },
    } as never);
    paymentsService.setTrustlineCheckerForTests(async (account, asset) => {
      trustlineCalls.push({ account, code: asset.code });
      return trustlineResult;
    });

    const facilityUser = await prisma.user.create({
      data: { email: `facility-assets-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    facilityId = (
      await prisma.facilityProfile.create({
        data: { userId: facilityUser.id, name: 'Asset Facility', type: 'pharmacy' },
      })
    ).id;

    const patientUser = await prisma.user.create({
      data: { email: `patient-assets-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    patientProfileId = (
      await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Asset Patient' } })
    ).id;

    payoutWallet = Keypair.random().publicKey();
    await paymentsService.linkWallet(facilityId, payoutWallet);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores the asset and its token contract on the intent', async () => {
    const intent = await createIntent({ kind: 'prescription', assetCode: 'USDC', amount: 25_000_000n });

    expect(intent.assetCode).toBe('USDC');
    expect(intent.tokenContractId).toBe(USDC_SAC);
    expect(intent.amount).toBe(25_000_000n);
  });

  it('rejects an asset that is not on the environment allowlist', async () => {
    const error = await captureError(() =>
      paymentsService.createPaymentIntent({
        orderType: 'prescription',
        orderId: `eur-${runId}`,
        patientProfileId,
        facilityId,
        assetCode: 'EUR',
        amount: 100n,
      }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('UNSUPPORTED_PAYMENT_ASSET');
  });

  it('checks the payee trustline and funds in USDC', async () => {
    trustlineResult = true;
    trustlineCalls.length = 0;
    sdkCalls.length = 0;

    const intent = await createIntent({ kind: 'lab_order', assetCode: 'USDC', amount: 12_500_000n });
    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);

    expect(funded.status).toBe('escrowed');
    expect(trustlineCalls).toEqual([{ account: payoutWallet, code: 'USDC' }]);
    expect(sdkCalls).toEqual([{ token: USDC_SAC, amount: 12_500_000n }]);
  });

  it('refuses to fund when the payee has no trustline, before calling the SDK', async () => {
    trustlineResult = false;
    sdkCalls.length = 0;

    const intent = await createIntent({ kind: 'lab_order', assetCode: 'USDC', amount: 100n });

    const error = await captureError(() => paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id));
    expect(error.status).toBe(409);
    expect(error.code).toBe('PAYEE_TRUSTLINE_MISSING');
    expect(sdkCalls).toHaveLength(0);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('created');
  });

  it('skips the trustline check for native XLM', async () => {
    trustlineCalls.length = 0;
    sdkCalls.length = 0;

    const intent = await createIntent({ kind: 'prescription', assetCode: 'XLM', amount: 500_000n });
    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);

    expect(funded.status).toBe('escrowed');
    expect(trustlineCalls).toHaveLength(0);
    expect(sdkCalls).toEqual([{ token: NATIVE_SAC, amount: 500_000n }]);
  });

  it('resolves the legacy null token contract to ESCROW_TOKEN_ID', async () => {
    sdkCalls.length = 0;
    // A row created before issue #79: no tokenContractId, native XLM only.
    const created = await createIntent({ kind: 'prescription', assetCode: 'XLM', amount: 1_000_000n });
    const legacy = await prisma.paymentIntent.update({
      where: { id: created.id },
      data: { tokenContractId: null },
    });

    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, legacy.id);

    expect(funded.status).toBe('escrowed');
    expect(funded.tokenContractId).toBe(NATIVE_SAC);
    expect(sdkCalls).toEqual([{ token: NATIVE_SAC, amount: 1_000_000n }]);
  });
});
