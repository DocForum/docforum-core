// Facility price lists (Phase 5, issue #127) — integration coverage against a
// real Postgres and the module services, not hand-built queries.
//
// What this proves:
//   * facility owners publish versioned prices; history is append-only;
//   * another facility's owner cannot publish to a facility they do not own;
//   * the eligible-facility lookup returns the in-force price, and
//     "price on request" when nothing is published (never 0);
//   * issuing an order with a catalogItemCode prices it from the facility's
//     list and snapshots the amount + code on the PaymentIntent, so a later
//     price change does not re-price the intent;
//   * no published price → 422 PRICE_ON_REQUEST and no order is written.
//
// Self-contained embedded Postgres on its own port (5448), same pattern as the
// other files in this directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5459; // unique per integration file
const runId = Date.now();
const MINUTE = 60_000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-prices-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_prices_test`;

describe('facility price lists and intent pricing (issue #127)', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let facilitiesService: typeof import('../../src/modules/facilities/services/index.js');
  let ordersService: typeof import('../../src/modules/orders/services/index.js');

  let ownerActor: { userId: string; role: 'facility'; requestId: null };
  let strangerActor: { userId: string; role: 'facility'; requestId: null };
  let doctorActor: { userId: string; role: 'doctor'; requestId: null };
  let doctorProfileId: string;
  let patientProfileId: string;
  let facilityId: string;
  let strangerFacilityId: string;
  let consultationId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_prices_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Set before the dynamic imports: config and PrismaClient read
    // DATABASE_URL at import time (same ordering note as the other files).
    process.env.DATABASE_URL = databaseUrl;

    const dbModule = await import('../../src/db/prisma-client.js');
    prisma = dbModule.prisma;
    facilitiesService = await import('../../src/modules/facilities/services/index.js');
    ordersService = await import('../../src/modules/orders/services/index.js');

    const patientUser = await prisma.user.create({
      data: { email: `prices-patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    const patient = await prisma.patientProfile.create({
      data: { userId: patientUser.id, fullName: 'Prices Test Patient' },
    });
    patientProfileId = patient.id;

    const ownerUser = await prisma.user.create({
      data: { email: `prices-owner-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    ownerActor = { userId: ownerUser.id, role: 'facility', requestId: null };
    const facility = await prisma.facilityProfile.create({
      data: { userId: ownerUser.id, name: 'Aaa Prices Lab', type: 'lab' },
    });
    facilityId = facility.id;
    // Issue #14 made a matching FacilityCapability row a condition of being
    // eligible at all (fail closed) — this file is about pricing, so the
    // qualification data is seeded directly rather than re-tested here.
    await prisma.facilityCapability.create({
      data: { facilityProfileId: facilityId, capabilityType: 'lab_test', detail: null },
    });

    const strangerUser = await prisma.user.create({
      data: { email: `prices-stranger-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    strangerActor = { userId: strangerUser.id, role: 'facility', requestId: null };
    const strangerFacility = await prisma.facilityProfile.create({
      data: { userId: strangerUser.id, name: 'Stranger Pharmacy', type: 'pharmacy' },
    });
    strangerFacilityId = strangerFacility.id;

    const doctorUser = await prisma.user.create({
      data: { email: `prices-doctor-${runId}@example.com`, passwordHash: 'unused', role: 'doctor' },
    });
    doctorActor = { userId: doctorUser.id, role: 'doctor', requestId: null };
    const doctor = await prisma.doctorProfile.create({
      data: { userId: doctorUser.id, fullName: 'Prices Test Doctor', verificationStatus: 'verified' },
    });
    doctorProfileId = doctor.id;

    const startTime = new Date(Date.now() + 60 * MINUTE);
    const slot = await prisma.availabilitySlot.create({
      data: { doctorProfileId, startTime, endTime: new Date(startTime.getTime() + 30 * MINUTE) },
    });
    const appointment = await prisma.appointment.create({
      data: { patientProfileId, doctorProfileId, availabilitySlotId: slot.id },
    });
    const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });
    consultationId = consultation.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
  });

  const publish = (overrides: Partial<{ catalogItemCode: string; amount: string; effectiveFrom: string }> = {}) =>
    facilitiesService.createPriceVersion(ownerActor, facilityId, {
      catalogItemCode: 'cbc-panel',
      amount: '25000000',
      effectiveFrom: new Date(Date.now() - MINUTE).toISOString(),
      ...overrides,
    });

  it('publishes a version, records an audit event, and keeps history append-only', async () => {
    const first = await publish();
    expect(first.amount).toBe(25_000_000n);
    expect(first.asset).toBe('native');

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: 'FacilityPrice', entityId: first.id, action: 'facility_price.created' },
    });
    expect(audit).not.toBeNull();

    // Correcting the price publishes a new row; the earlier one is untouched.
    const second = await publish({ amount: '30000000', effectiveFrom: new Date(Date.now() - MINUTE + 1000).toISOString() });
    const history = await facilitiesService.listPrices(facilityId, { catalogItemCode: 'cbc-panel' });
    expect(history.map((row) => row.amount)).toEqual(expect.arrayContaining([25_000_000n, 30_000_000n]));
    const persistedFirst = await prisma.facilityPrice.findUniqueOrThrow({ where: { id: first.id } });
    expect(persistedFirst.amount).toBe(25_000_000n);
    expect(second.id).not.toBe(first.id);
  });

  it('rejects a duplicate effectiveFrom for the same item and asset', async () => {
    const when = new Date(Date.now() - 2 * MINUTE).toISOString();
    await publish({ catalogItemCode: 'duplicate-check', effectiveFrom: when });
    await expect(publish({ catalogItemCode: 'duplicate-check', effectiveFrom: when })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses writes from another facility owner', async () => {
    await expect(
      facilitiesService.createPriceVersion(strangerActor, facilityId, { catalogItemCode: 'cbc-panel', amount: '1000000' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a zero or fractional amount', async () => {
    await expect(publish({ catalogItemCode: 'bad-amount', amount: '0' })).rejects.toMatchObject({ status: 400 });
    await expect(publish({ catalogItemCode: 'bad-amount', amount: '1.5' })).rejects.toMatchObject({ status: 400 });
  });

  it('resolves the price in force at a timestamp, and null before the first version', async () => {
    const now = Date.now();
    const before = await facilitiesService.resolveCurrentPrice(prisma, {
      facilityProfileId: facilityId,
      catalogItemCode: 'not-yet-priced',
      at: new Date(now),
    });
    expect(before).toBeNull();

    await publish({ catalogItemCode: 'future-price', amount: '11111111', effectiveFrom: new Date(now + 60 * MINUTE).toISOString() });
    expect(await facilitiesService.resolveCurrentPrice(prisma, {
      facilityProfileId: facilityId, catalogItemCode: 'future-price', at: new Date(now),
    })).toBeNull();
    const later = await facilitiesService.resolveCurrentPrice(prisma, {
      facilityProfileId: facilityId, catalogItemCode: 'future-price', at: new Date(now + 61 * MINUTE),
    });
    expect(later?.amount).toBe(11_111_111n);
  });

  it('eligible facilities expose the current price and "price on request" rather than zero', async () => {
    const eligible = await facilitiesService.listEligibleFacilities({ type: 'lab', catalogItemCode: 'cbc-panel' });
    const ours = eligible.find((facility) => facility.facilityId === facilityId);
    expect(ours?.price?.amount).toBe(30_000_000n);
    expect(ours?.priceOnRequest).toBe(false);

    const unpriced = await facilitiesService.listEligibleFacilities({ type: 'lab', catalogItemCode: 'unpublished-item' });
    const oursUnpriced = unpriced.find((facility) => facility.facilityId === facilityId);
    expect(oursUnpriced?.price).toBeNull();
    expect(oursUnpriced?.priceOnRequest).toBe(true);

    // A pharmacy never appears in a lab lookup.
    expect(eligible.some((facility) => facility.facilityId === strangerFacilityId)).toBe(false);
  });

  it('prices an issued lab order from the list and snapshots the amount and code', async () => {
    const order = await ordersService.issueLabOrder(doctorActor, {
      consultationId,
      facilityProfileId: facilityId,
      catalogItemCode: 'cbc-panel',
      testType: 'CBC panel',
      urgency: 'routine',
    });

    expect(order.amountStroops).toBe(30_000_000n);
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: order.paymentIntent.id } });
    expect(intent.amount).toBe(30_000_000n);
    expect(intent.catalogItemCode).toBe('cbc-panel');
    expect(intent.facilityId).toBe(facilityId);

    // A later price change must not re-price an existing intent.
    await publish({ catalogItemCode: 'cbc-panel', amount: '99000000' });
    const afterChange = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(afterChange.amount).toBe(30_000_000n);
    expect(afterChange.catalogItemCode).toBe('cbc-panel');
  });

  it('fails with 422 PRICE_ON_REQUEST and writes no order when no price is published', async () => {
    const before = await prisma.labOrder.count();
    await expect(
      ordersService.issueLabOrder(doctorActor, {
        consultationId,
        facilityProfileId: facilityId,
        catalogItemCode: 'never-priced',
        testType: 'Unpriced panel',
        urgency: 'routine',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'PRICE_ON_REQUEST' });
    expect(await prisma.labOrder.count()).toBe(before);
  });

  it('still supports an explicit amount (legacy manual pricing) with no catalog code', async () => {
    const order = await ordersService.issueLabOrder(doctorActor, {
      consultationId,
      facilityProfileId: facilityId,
      amountStroops: 4_200_000n,
      testType: 'Manual price panel',
      urgency: 'routine',
    });
    expect(order.amountStroops).toBe(4_200_000n);
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: order.paymentIntent.id } });
    expect(intent.amount).toBe(4_200_000n);
    expect(intent.catalogItemCode).toBeNull();
  });
});
