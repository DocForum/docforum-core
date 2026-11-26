// Issue #328: facility payout-wallet changes are audited (old + new
// address, same transaction) and only become the escrow payee after
// WALLET_LINK_COOLDOWN_HOURS. Real embedded Postgres + Express; FAKE escrow
// SDK (records payees and release calls) — zero network.
//
// The reviewer's check — "no path releases to a wallet linked inside the
// cool-down window" — is covered by: funding in the window pays the OLD
// address; a release whose recorded payee is a pending link is refused on
// both the admin override and the automatic (outbox) path.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { Keypair } from '@stellar/stellar-sdk';
import type { EscrowSdkForTests } from '../../src/modules/payments/services/index.js';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5484; // unique per integration file
const runId = Date.now();
const HOUR = 60 * 60 * 1000;
const TEST_ACTOR = { userId: null, role: null, requestId: `wallet-cooldown-${runId}` };

process.env.WALLET_LINK_COOLDOWN_HOURS = '24';
process.env.PLATFORM_PAYER_SECRET = Keypair.random().secret();
process.env.PLATFORM_RELEASER_SECRET = Keypair.random().secret();
process.env.ESCROW_CONTRACT_ID = 'TEST_CONTRACT_ID';
process.env.ESCROW_TOKEN_ID = 'TEST_TOKEN_ID';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-wallet-cooldown-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_wallet_cooldown_test`;

type Services = typeof import('../../src/modules/payments/services/index.js');

describe('facility payout-wallet audit + cool-down (issue #328)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let services: Services;
  let patientProfileId: string;
  let adminToken: string;
  let facilityToken: string;

  const createEscrowPayees: string[] = [];
  let releaseCalls = 0;

  const token = (sub: string, role: 'admin' | 'facility') => jwt.sign({ sub, role }, 'test-access-secret', { expiresIn: '15m' });

  async function makeFacility(label: string) {
    const user = await prisma.user.create({
      data: { email: `cooldown-${label}-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const facility = await prisma.facilityProfile.create({ data: { userId: user.id, name: `Cooldown ${label}`, type: 'lab' } });
    return { facilityId: facility.id, userId: user.id };
  }

  async function newIntent(facilityId: string) {
    const order = await createOrderFixture(prisma, {
      patientProfileId,
      facilityProfileId: facilityId,
      kind: 'lab_order',
      amountStroops: 1_000n,
      tag: `cooldown-${runId}-${Math.random().toString(36).slice(2)}`,
    });
    return services.createPaymentIntent({
      orderType: 'lab_order',
      orderId: order.id,
      patientProfileId,
      facilityId,
      assetCode: 'XLM',
      amount: 1_000n,
    });
  }

  /** An escrowed intent whose recorded payee is `payee` (as if funded). */
  async function escrowedIntentPayingTo(facilityId: string, payee: string) {
    const intent = await newIntent(facilityId);
    return prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'escrowed', escrowId: BigInt(Date.now()), sorobanContractId: 'TEST_CONTRACT_ID', stellarTxHash: 'f'.repeat(64), fundedWalletAddress: payee },
    });
  }

  const auditsFor = (linkId: string) =>
    prisma.auditEvent.findMany({ where: { entityType: 'WalletLink', entityId: linkId } });

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_wallet_cooldown_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    services = await import('../../src/modules/payments/services/index.js');
    app = (await import('../../src/app.js')).createApp();

    services.setEscrowSdkOverride({
      Keypair,
      EscrowClient: class {
        async createEscrow(args: { payee: string }) {
          createEscrowPayees.push(args.payee);
          return { escrowId: BigInt(createEscrowPayees.length), txHash: `fake-tx-${createEscrowPayees.length}` };
        }
        async release() {
          releaseCalls += 1;
          return { txHash: 'fake-release' };
        }
        async refund() {
          return { txHash: 'fake-refund' };
        }
      },
    } as unknown as EscrowSdkForTests);

    const patientUser = await prisma.user.create({
      data: { email: `cooldown-patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    patientProfileId = (await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Cooldown Patient' } })).id;
    const adminUser = await prisma.user.create({
      data: { email: `cooldown-admin-${runId}@example.com`, passwordHash: 'unused', role: 'admin' },
    });
    adminToken = token(adminUser.id, 'admin');
  }, 180_000);

  afterAll(async () => {
    services?.resetEscrowSdkOverride();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('inside the cool-down window', () => {
    let facilityId: string;
    const A = Keypair.random().publicKey();
    const B = Keypair.random().publicKey();
    const C = Keypair.random().publicKey();
    let linkA: { id: string };
    let linkB: { id: string; effectiveAt: Date; createdAt: Date };

    beforeAll(async () => {
      const facility = await makeFacility('window');
      facilityId = facility.facilityId;
      facilityToken = token(facility.userId, 'facility');
    });

    it('the first-ever link is effective immediately and audited as wallet_link.linked', async () => {
      linkA = await services.linkWallet(facilityId, A);
      const row = await prisma.walletLink.findUniqueOrThrow({ where: { id: linkA.id } });
      expect(row.effectiveAt.getTime()).toBeLessThanOrEqual(Date.now());

      const [audit] = await auditsFor(linkA.id);
      expect(audit).toMatchObject({ action: 'wallet_link.linked', fromState: null, toState: 'effective' });
      expect(audit!.metadata).toMatchObject({
        ownerType: 'facility',
        ownerId: facilityId,
        previousStellarAccount: null,
        newStellarAccount: A,
        firstLink: true,
        cooldownHours: 0,
      });
    });

    it('a re-link starts a 24h cool-down and audits old + new address', async () => {
      const before = Date.now();
      linkB = await services.linkWallet(facilityId, B);
      const delay = linkB.effectiveAt.getTime() - linkB.createdAt.getTime();
      expect(delay).toBeGreaterThan(24 * HOUR - 5_000);
      expect(delay).toBeLessThan(24 * HOUR + 5_000);
      expect(linkB.effectiveAt.getTime()).toBeGreaterThan(before + 23 * HOUR);

      const [audit] = await auditsFor(linkB.id);
      expect(audit).toMatchObject({ action: 'wallet_link.changed', fromState: 'effective', toState: 'pending' });
      expect(audit!.metadata).toMatchObject({
        previousLinkId: linkA.id,
        previousStellarAccount: A,
        newStellarAccount: B,
        cooldownHours: 24,
        firstLink: false,
        cancelledPendingLinkId: null,
        effectiveAt: linkB.effectiveAt.toISOString(),
      });
    });

    it('the facility sees its pending link (with effectiveAt) on GET /payments/wallet-link', async () => {
      const res = await request(app).get('/payments/wallet-link').set('Authorization', `Bearer ${facilityToken}`);
      expect(res.status).toBe(200);
      expect(res.body.stellarPublicKey).toBe(B);
      expect(res.body.effectiveAt).toBe(linkB.effectiveAt.toISOString());
    });

    it('funding inside the window pays the PREVIOUS address, never the new one', async () => {
      const intent = await newIntent(facilityId);
      const funded = await services.fundPaymentIntent(TEST_ACTOR, intent.id);
      expect(funded.status).toBe('escrowed');
      expect(funded.fundedWalletAddress).toBe(A);
      expect(createEscrowPayees.at(-1)).toBe(A);
      expect((await services.getWalletLink(facilityId))?.stellarPublicKey).toBe(A); // prepare's payee lookup
    });

    it('an escrow funded to the old address releases normally (it stays bound to it)', async () => {
      const intent = await escrowedIntentPayingTo(facilityId, A);
      const releasedBefore = releaseCalls;
      const released = await services.releasePaymentIntent(TEST_ACTOR, intent.id);
      expect(released.status).toBe('released');
      expect(releaseCalls).toBe(releasedBefore + 1);
    });

    it('a release whose payee is the pending link is refused on BOTH release paths, with no chain call', async () => {
      const releasedBefore = releaseCalls;
      const manual = await escrowedIntentPayingTo(facilityId, B);
      await expect(services.releasePaymentIntent(TEST_ACTOR, manual.id)).rejects.toMatchObject({
        status: 409,
        code: 'WALLET_LINK_COOLDOWN',
      });

      const automatic = await escrowedIntentPayingTo(facilityId, B);
      // Thrown, so the outbox keeps the event and retries with backoff (held).
      await expect(
        services.releaseEscrowForFulfilledOrder({ orderType: 'lab_order', orderId: automatic.labOrderId! }),
      ).rejects.toMatchObject({ code: 'WALLET_LINK_COOLDOWN' });

      expect(releaseCalls).toBe(releasedBefore);
      for (const id of [manual.id, automatic.id]) {
        expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id } })).status).toBe('escrowed');
      }
      // Refunds go back to the payer and are not held.
      const refund = await services.refundEscrowForUnfulfilledOrder({ orderType: 'lab_order', orderId: automatic.labOrderId! });
      expect(refund).toBe('settled');
    });

    it('admins see the pending change with the address it replaces; others get 403', async () => {
      const res = await request(app).get('/admin/payments/wallet-links/pending').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const mine = res.body.items.filter((item: { facilityId: string }) => item.facilityId === facilityId);
      expect(mine).toEqual([
        {
          id: linkB.id,
          facilityId,
          facilityName: 'Cooldown window',
          newStellarPublicKey: B,
          previousStellarPublicKey: A,
          linkedAt: linkB.createdAt.toISOString(),
          effectiveAt: linkB.effectiveAt.toISOString(),
        },
      ]);
      const denied = await request(app).get('/admin/payments/wallet-links/pending').set('Authorization', `Bearer ${facilityToken}`);
      expect(denied.status).toBe(403);
    });

    it('re-linking again inside the window cancels the pending link and restarts the window', async () => {
      const linkC = await services.linkWallet(facilityId, C);
      const cancelledB = await prisma.walletLink.findUniqueOrThrow({ where: { id: linkB.id } });
      expect(cancelledB.replacedAt!.getTime()).toBeLessThan(cancelledB.effectiveAt.getTime()); // never takes effect
      expect(services.selectEffectiveWalletLink([cancelledB], new Date(cancelledB.effectiveAt.getTime() + HOUR))).toBeNull();

      const [audit] = await auditsFor(linkC.id);
      expect(audit!.metadata).toMatchObject({
        previousStellarAccount: A, // still the effective payee
        newStellarAccount: C,
        cancelledPendingLinkId: linkB.id,
      });
      expect((await services.getWalletLink(facilityId))?.stellarPublicKey).toBe(A);

      const res = await request(app).get('/admin/payments/wallet-links/pending').set('Authorization', `Bearer ${adminToken}`);
      const mine = res.body.items.filter((item: { facilityId: string }) => item.facilityId === facilityId);
      expect(mine.map((item: { id: string }) => item.id)).toEqual([linkC.id]);
    });

    it('the audit row is in the same transaction: if it fails, no link change is written', async () => {
      const activeBefore = await prisma.walletLink.findFirstOrThrow({ where: { ownerId: facilityId, replacedAt: null } });
      // Make exactly this audit insert fail at the database.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "AuditEvent" ADD CONSTRAINT "test_block_wallet_change" CHECK (action <> 'wallet_link.changed') NOT VALID`,
      );
      try {
        await expect(services.linkWallet(facilityId, Keypair.random().publicKey())).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DROP CONSTRAINT "test_block_wallet_change"`);
      }
      const activeAfter = await prisma.walletLink.findFirstOrThrow({ where: { ownerId: facilityId, replacedAt: null } });
      expect(activeAfter.id).toBe(activeBefore.id);
      expect(activeAfter.replacedAt).toBeNull();
      expect(await prisma.walletLink.count({ where: { ownerId: facilityId } })).toBe(3); // A, B, C only
    });
  });

  describe('after the cool-down window', () => {
    it('the new link becomes the payee for funding and release once the window has passed', async () => {
      const { facilityId } = await makeFacility('after');
      const oldAddr = Keypair.random().publicKey();
      const newAddr = Keypair.random().publicKey();
      const now = Date.now();
      await services.linkWallet(facilityId, oldAddr, new Date(now - 72 * HOUR)); // first link
      const relinked = await services.linkWallet(facilityId, newAddr, new Date(now - 25 * HOUR)); // window ended 1h ago
      expect(relinked.effectiveAt.getTime()).toBeLessThan(now);

      const intent = await newIntent(facilityId);
      const funded = await services.fundPaymentIntent(TEST_ACTOR, intent.id);
      expect(funded.fundedWalletAddress).toBe(newAddr);
      expect(createEscrowPayees.at(-1)).toBe(newAddr);
      const released = await services.releasePaymentIntent(TEST_ACTOR, intent.id);
      expect(released.status).toBe('released');

      const res = await request(app).get('/admin/payments/wallet-links/pending').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.items.some((item: { facilityId: string }) => item.facilityId === facilityId)).toBe(false);
    });

    it('a facility whose only link is still cooling down cannot fund (WALLET_LINK_COOLDOWN)', async () => {
      const { facilityId } = await makeFacility('only-pending');
      // A pending link with no effective predecessor (e.g. the predecessor
      // was a cancelled pending link): funding is refused, not redirected.
      await prisma.walletLink.create({
        data: {
          ownerType: 'facility',
          ownerId: facilityId,
          stellarPublicKey: Keypair.random().publicKey(),
          verificationMethod: 'sep10',
          verifiedAt: new Date(),
          activeOwnerKey: `facility:${facilityId}`,
          effectiveAt: new Date(Date.now() + 24 * HOUR),
        },
      });
      const intent = await newIntent(facilityId);
      await expect(services.fundPaymentIntent(TEST_ACTOR, intent.id)).rejects.toMatchObject({
        status: 409,
        code: 'WALLET_LINK_COOLDOWN',
      });
    });
  });
});
