import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5458;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-payment-history-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_payment_history_test`;

describe('payment history and facility ledger APIs', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let patientA: { id: string; token: string };
  let patientB: { id: string; token: string };
  let facilityA: { id: string; token: string };
  let facilityB: { id: string; token: string };

  function token(id: string, role: 'patient' | 'facility') {
    return jwt.sign({ sub: id, role }, 'test-access-secret', { expiresIn: '15m' });
  }

  async function createIntent(input: {
    patientProfileId: string;
    facilityId: string;
    status: 'created' | 'escrowed' | 'released' | 'refunded';
    amountStroops: bigint;
    createdAt: Date;
  }) {
    const order = await createOrderFixture(prisma, {
      patientProfileId: input.patientProfileId,
      facilityProfileId: input.facilityId,
      kind: 'lab_order',
      amountStroops: input.amountStroops,
      tag: `payment-history-${runId}-${Math.random().toString(36).slice(2)}`,
    });
    return prisma.paymentIntent.create({
      data: {
        labOrderId: order.id,
        patientProfileId: input.patientProfileId,
        facilityId: input.facilityId,
        status: input.status,
        amount: input.amountStroops,
        assetCode: 'XLM',
        createdAt: input.createdAt,
        ...(input.status === 'escrowed' || input.status === 'released' || input.status === 'refunded'
          ? { escrowId: input.amountStroops + 1n, stellarTxHash: 'a'.repeat(64), sorobanContractId: 'C'.repeat(56) }
          : {}),
      },
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_payment_history_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    const dbModule = await import('../../src/db/prisma-client.js');
    prisma = dbModule.prisma;
    app = (await import('../../src/app.js')).createApp();

    async function makePatient(label: string) {
      const user = await prisma.user.create({
        data: { email: `${label}-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
      });
      const profile = await prisma.patientProfile.create({ data: { userId: user.id, fullName: label } });
      return { id: profile.id, token: token(user.id, 'patient') };
    }

    async function makeFacility(label: string) {
      const user = await prisma.user.create({
        data: { email: `${label}-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
      });
      const profile = await prisma.facilityProfile.create({ data: { userId: user.id, name: label, type: 'lab' } });
      return { id: profile.id, token: token(user.id, 'facility') };
    }

    [patientA, patientB, facilityA, facilityB] = await Promise.all([
      makePatient('payment-history-a'),
      makePatient('payment-history-b'),
      makeFacility('payment-history-facility-a'),
      makeFacility('payment-history-facility-b'),
    ]);

    const now = Date.now();
    await Promise.all([
      createIntent({ patientProfileId: patientA.id, facilityId: facilityA.id, status: 'escrowed', amountStroops: 9_007_199_254_740_993n, createdAt: new Date(now - 3000) }),
      createIntent({ patientProfileId: patientA.id, facilityId: facilityA.id, status: 'released', amountStroops: 20n, createdAt: new Date(now - 2000) }),
      createIntent({ patientProfileId: patientA.id, facilityId: facilityA.id, status: 'refunded', amountStroops: 30n, createdAt: new Date(now - 1000) }),
      createIntent({ patientProfileId: patientB.id, facilityId: facilityB.id, status: 'escrowed', amountStroops: 900n, createdAt: new Date(now) }),
    ]);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns only the authenticated patient payments with stable cursor pagination', async () => {
    const first = await request(app).get('/payments/mine?limit=2').set('Authorization', `Bearer ${patientA.token}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.items[0].amount).toBe('30');
    expect(first.body.items[0].refundAfter).toBeNull();

    const second = await request(app)
      .get('/payments/mine')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set('Authorization', `Bearer ${patientA.token}`);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].amount).toBe('9007199254740993');
    expect(second.body.nextCursor).toBeNull();

    const otherPatient = await request(app).get('/payments/mine').set('Authorization', `Bearer ${patientB.token}`);
    expect(otherPatient.body.items).toHaveLength(1);
    expect(otherPatient.body.items[0].amount).toBe('900');
  });

  it('includes the entire final day when filtering by a date-only to value', async () => {
    const payment = await createIntent({
      patientProfileId: patientB.id,
      facilityId: facilityB.id,
      status: 'created',
      amountStroops: 40n,
      createdAt: new Date('2020-01-02T23:59:59.500Z'),
    });

    const response = await request(app)
      .get('/payments/mine?from=2020-01-02&to=2020-01-02')
      .set('Authorization', `Bearer ${patientB.token}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(payment.id);
    await prisma.paymentIntent.delete({ where: { id: payment.id } });
  });

  it('returns facility-owned rows and exact SQL totals across statuses', async () => {
    const response = await request(app)
      .get('/payments/facility/ledger?status=escrowed')
      .set('Authorization', `Bearer ${facilityA.token}`);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].amount).toBe('9007199254740993');
    expect(response.body.items[0].stellarTxHash).toBe('a'.repeat(64));
    expect(response.body.items[0].asset).toEqual({ type: 'native', code: 'XLM' });
    expect(response.body.totals).toEqual([
      {
        asset: { type: 'native', code: 'XLM' },
        escrowed: '9007199254740993',
        released: '20',
        refunded: '30',
      },
    ]);

    const otherFacility = await request(app)
      .get('/payments/facility/ledger')
      .set('Authorization', `Bearer ${facilityB.token}`);
    expect(otherFacility.body.items).toHaveLength(1);
    expect(otherFacility.body.totals[0].escrowed).toBe('900');
  });

  it('rejects cross-role access and invalid query filters', async () => {
    expect((await request(app).get('/payments/mine').set('Authorization', `Bearer ${facilityA.token}`)).status).toBe(403);
    expect((await request(app).get('/payments/facility/ledger').set('Authorization', `Bearer ${patientA.token}`)).status).toBe(403);
    expect((await request(app).get('/payments/mine?unknown=true').set('Authorization', `Bearer ${patientA.token}`)).status).toBe(400);
    expect((await request(app).get('/payments/mine?from=2026-10-20&to=2026-10-19').set('Authorization', `Bearer ${patientA.token}`)).status).toBe(400);
  });
});