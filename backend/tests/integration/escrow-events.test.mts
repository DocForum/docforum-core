// GET /admin/payments/escrow-events (issue #86) — integration coverage for
// issue #327. Rows are seeded straight into EscrowChainEvent /
// EscrowEventCursor; the only poller code exercised is the RPC-free
// reconcile pass (no contracts configured), so the suite never touches the
// network. `fetch` is spied on to prove it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5483;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-escrow-events-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_escrow_events_test`;

const CONTRACT_A = `CA${'A'.repeat(54)}`;
const CONTRACT_B = `CB${'B'.repeat(54)}`;

type Role = 'patient' | 'doctor' | 'facility' | 'admin';

describe('GET /admin/payments/escrow-events', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let escrowEvents: typeof import('../../src/modules/payments/services/escrow-events.js');
  const tokens = {} as Record<Role, string>;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const base = Date.now() - 10 * 60_000;
  const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000);

  function get(query = '', role: Role | null = 'admin') {
    const req = request(app).get(`/admin/payments/escrow-events${query}`);
    return role ? req.set('Authorization', `Bearer ${tokens[role]}`) : req;
  }

  async function seedEvent(input: {
    contractId?: string;
    eventType: string;
    state: 'pending' | 'matched' | 'unmatched';
    detectedAt: Date;
    escrowId?: bigint | null;
    paymentIntentId?: string | null;
    alertedAt?: Date | null;
    id?: string;
  }) {
    return prisma.escrowChainEvent.create({
      data: {
        id: input.id,
        eventId: `evt-${randomUUID()}`,
        contractId: input.contractId ?? CONTRACT_A,
        ledger: 1000 + Math.floor(Math.random() * 1000),
        txHash: 'f'.repeat(64),
        escrowId: input.escrowId === undefined ? 7n : input.escrowId,
        eventType: input.eventType,
        state: input.state,
        paymentIntentId: input.paymentIntentId ?? null,
        detectedAt: input.detectedAt,
        alertedAt: input.alertedAt ?? null,
      },
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_escrow_events_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    // No configured contract means the poller never builds an RPC client.
    // Set before config loads so a developer's .env can't add one.
    process.env.ESCROW_CONTRACTS = '';
    process.env.ESCROW_CONTRACT_ID = '';
    process.env.ESCROW_EVENT_ALERT_WEBHOOK_URL = '';

    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    escrowEvents = await import('../../src/modules/payments/services/escrow-events.js');
    app = (await import('../../src/app.js')).createApp();

    for (const role of ['patient', 'doctor', 'facility', 'admin'] as const) {
      const user = await prisma.user.create({
        data: { email: `escrow-events-${role}-${runId}@example.com`, passwordHash: 'unused', role },
      });
      tokens[role] = jwt.sign({ sub: user.id, role }, 'test-access-secret', { expiresIn: '15m' });
    }
  }, 180_000);

  afterAll(async () => {
    fetchSpy.mockRestore();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('access control', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await get('', null);
      expect(response.status).toBe(401);
      expect(response.body).not.toHaveProperty('items');
    });

    it('rejects a malformed bearer token with 401', async () => {
      const response = await request(app)
        .get('/admin/payments/escrow-events')
        .set('Authorization', 'Bearer not-a-jwt');
      expect(response.status).toBe(401);
    });

    it.each(['patient', 'doctor', 'facility'] as const)('rejects a %s with 403', async (role) => {
      const response = await get('', role);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('items');
    });

    it('lets an admin read an empty list', async () => {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], cursors: [], nextCursor: null });
    });
  });

  describe('with seeded events', () => {
    const ids = {
      unmatchedRelease: '00000000-0000-4000-8000-000000000001',
      unmatchedRefund: '00000000-0000-4000-8000-000000000002',
      matchedRelease: '00000000-0000-4000-8000-000000000003',
      pendingFunded: '00000000-0000-4000-8000-000000000004',
      tieLow: '00000000-0000-4000-8000-00000000000a',
      tieHigh: '00000000-0000-4000-8000-00000000000b',
    };
    const matchedIntentId = randomUUID();

    beforeAll(async () => {
      await seedEvent({ id: ids.unmatchedRelease, eventType: 'released', state: 'unmatched', detectedAt: at(10), escrowId: 9_007_199_254_740_993n, alertedAt: at(40) });
      await seedEvent({ id: ids.unmatchedRefund, contractId: CONTRACT_B, eventType: 'refunded', state: 'unmatched', detectedAt: at(20), escrowId: null, alertedAt: at(50) });
      await seedEvent({ id: ids.matchedRelease, eventType: 'released', state: 'matched', detectedAt: at(30), paymentIntentId: matchedIntentId });
      await seedEvent({ id: ids.pendingFunded, eventType: 'funded', state: 'pending', detectedAt: at(40) });
      // Same detectedAt: the id tiebreak decides the order.
      await seedEvent({ id: ids.tieLow, eventType: 'funded', state: 'matched', detectedAt: at(50), paymentIntentId: randomUUID() });
      await seedEvent({ id: ids.tieHigh, eventType: 'funded', state: 'matched', detectedAt: at(50), paymentIntentId: randomUUID() });

      await prisma.escrowEventCursor.create({
        data: { contractId: CONTRACT_B, startLedger: 50, cursor: '0000123-0001', lastLedger: 900 },
      });
      await prisma.escrowEventCursor.create({
        data: {
          contractId: CONTRACT_A,
          startLedger: 10,
          cursor: null,
          lastLedger: 400,
          catchupError: 'Soroban event retention no longer covers the persisted cursor. Set a reviewed start ledger/cursor and reconcile from ledger 10.',
        },
      });
    });

    it('returns every event newest first, ties broken by id descending', async () => {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
        ids.tieHigh,
        ids.tieLow,
        ids.pendingFunded,
        ids.matchedRelease,
        ids.unmatchedRefund,
        ids.unmatchedRelease,
      ]);
      expect(response.body.nextCursor).toBeNull();
    });

    it('flags release/refund events with no matching intent as unmatched', async () => {
      const response = await get('?state=unmatched');
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(2);
      for (const item of response.body.items) {
        expect(item.state).toBe('unmatched');
        expect(item.paymentIntentId).toBeNull();
        expect(item.alertedAt).toEqual(expect.any(String));
        expect(['released', 'refunded']).toContain(item.eventType);
      }
      const [refund, release] = response.body.items;
      expect(refund).toMatchObject({ id: ids.unmatchedRefund, contractId: CONTRACT_B, eventType: 'refunded', escrowId: null });
      // BigInt escrow ids are serialised as exact decimal strings.
      expect(release).toMatchObject({ id: ids.unmatchedRelease, contractId: CONTRACT_A, eventType: 'released', escrowId: '9007199254740993' });
    });

    it('filters to matched events, each carrying its payment intent', async () => {
      const response = await get('?state=matched');
      expect(response.status).toBe(200);
      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([ids.tieHigh, ids.tieLow, ids.matchedRelease]);
      for (const item of response.body.items) {
        expect(item.state).toBe('matched');
        expect(item.paymentIntentId).toEqual(expect.any(String));
        expect(item.alertedAt).toBeNull();
      }
      expect(response.body.items[2].paymentIntentId).toBe(matchedIntentId);
    });

    it('filters to pending events, which are not yet flagged', async () => {
      const response = await get('?state=pending');
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ id: ids.pendingFunded, state: 'pending', paymentIntentId: null, alertedAt: null });
    });

    it('surfaces catchupError on the affected contract cursor only, cursors ordered by contract id', async () => {
      const response = await get('?state=pending');
      expect(response.body.cursors.map((cursor: { contractId: string }) => cursor.contractId)).toEqual([CONTRACT_A, CONTRACT_B]);
      const [a, b] = response.body.cursors;
      expect(a.catchupError).toMatch(/retention no longer covers/);
      expect(a).toMatchObject({ startLedger: 10, cursor: null, lastLedger: 400 });
      expect(b).toMatchObject({ catchupError: null, startLedger: 50, cursor: '0000123-0001', lastLedger: 900 });
    });

    it('pages through every event without gaps or repeats using nextCursor', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const response = await get(query);
        expect(response.status).toBe(200);
        expect(response.body.items.length).toBeLessThanOrEqual(2);
        seen.push(...response.body.items.map((item: { id: string }) => item.id));
        cursor = response.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual([
        ids.tieHigh,
        ids.tieLow,
        ids.pendingFunded,
        ids.matchedRelease,
        ids.unmatchedRefund,
        ids.unmatchedRelease,
      ]);
    });

    it('combines the state filter with pagination', async () => {
      const first = await get('?state=matched&limit=2');
      expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([ids.tieHigh, ids.tieLow]);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await get(`?state=matched&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([ids.matchedRelease]);
      expect(second.body.nextCursor).toBeNull();
    });

    it('returns no nextCursor when the page is exactly full', async () => {
      const response = await get('?limit=6');
      expect(response.body.items).toHaveLength(6);
      expect(response.body.nextCursor).toBeNull();
    });

    it.each([
      ['an unknown state', '?state=failed'],
      ['limit 0', '?limit=0'],
      ['limit above 200', '?limit=201'],
      ['a non-numeric limit', '?limit=ten'],
      ['an unknown query parameter', '?contract=abc'],
    ])('rejects %s with 400', async (_label, query) => {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('items');
    });

    it('rejects a garbage cursor with 400 INVALID_CURSOR', async () => {
      const response = await get('?cursor=not-a-cursor');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_CURSOR');
    });
  });

  it('shows a release the reconcile pass could not match as unmatched, and a matched one with its intent', async () => {
    const patientUser = await prisma.user.create({ data: { email: `escrow-events-payer-${runId}@example.com`, passwordHash: 'unused', role: 'patient' } });
    const patient = await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Escrow Payer' } });
    const facilityUser = await prisma.user.create({ data: { email: `escrow-events-lab-${runId}@example.com`, passwordHash: 'unused', role: 'facility' } });
    const facility = await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Escrow Lab', type: 'lab' } });
    const order = await createOrderFixture(prisma, {
      patientProfileId: patient.id, facilityProfileId: facility.id, kind: 'lab_order', amountStroops: 500n, tag: `escrow-events-${runId}`,
    });
    const intent = await prisma.paymentIntent.create({
      data: {
        labOrderId: order.id, patientProfileId: patient.id, facilityId: facility.id, status: 'released',
        amount: 500n, assetCode: 'XLM', escrowId: 4242n, stellarTxHash: 'a'.repeat(64), sorobanContractId: CONTRACT_A,
      },
    });
    // Both are older than the poller's 30s grace window.
    const orphan = await seedEvent({ eventType: 'released', state: 'pending', detectedAt: new Date(Date.now() - 120_000), escrowId: 999_999n });
    const known = await seedEvent({ eventType: 'released', state: 'pending', detectedAt: new Date(Date.now() - 120_000), escrowId: 4242n });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await escrowEvents.pollEscrowContractEvents();
    } finally {
      consoleError.mockRestore();
    }

    const response = await get('?limit=200');
    expect(response.status).toBe(200);
    const byId = new Map(response.body.items.map((item: { id: string }) => [item.id, item]));
    expect(byId.get(orphan.id)).toMatchObject({ state: 'unmatched', paymentIntentId: null, escrowId: '999999', alertedAt: expect.any(String) });
    expect(byId.get(known.id)).toMatchObject({ state: 'matched', paymentIntentId: intent.id, escrowId: '4242', alertedAt: null });
  });

  it('made no network calls', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
