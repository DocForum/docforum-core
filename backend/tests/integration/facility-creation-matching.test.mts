// Facility account creation + capability matching (Phase 5, issue #14) —
// integration coverage against a real Postgres and the full HTTP stack,
// because the reviewer's bar is that the admin gate is enforced *server-side*
// (test, not assumption) and that matching fails closed.
//
// What this proves:
//   * POST /facilities is admin-only: 401 unauthenticated, 403 for patient
//     and doctor tokens — and writes nothing on refusal;
//   * there is no self-serve path: `POST /auth/signup` refuses the facility
//     role (PRD OQ-2 — curated partner list);
//   * admin creation writes User(role facility) + FacilityProfile + its
//     FacilityCapability rows + a `facility.created` AuditEvent in one
//     transaction, and the resulting account can actually log in;
//   * inconsistent payloads (capability type that cannot belong to the
//     facility type) are rejected, duplicate emails 409;
//   * GET /facilities/eligible narrows to facilities that HOLD the matching
//     capability: a facility with no capability rows, or only the wrong type
//     of them, is never shown — fail closed (PRD FR-13 / §8.1.6).
//
// Self-contained embedded Postgres on its own port (5456), same pattern as
// the other files in this directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5456; // unique per integration file
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-facility-admin-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_facility_admin_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

/** Same as the admin-lifecycle file: bootstrap an admin the way an operator
 * does, password on stdin. */
function runCreateAdmin(args: string[], stdin: string) {
  try {
    const stdout = execFileSync('node', ['scripts/create-admin.mjs', ...args], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      input: stdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('facility account creation + capability matching (issue #14)', () => {
  let app: App;
  let prisma: Prisma;
  let facilitiesService: typeof import('../../src/modules/facilities/services/index.js');
  let adminToken: string;
  let adminUserId: string;
  let patientToken: string;
  let doctorToken: string;

  let northlabId: string; // admin-created lab WITH lab_test capability
  let quickscriptsId: string; // admin-created pharmacy WITH medication_dispense
  let legacyLabId: string; // direct-seeded lab, NO capability rows
  let crosswiredLabId: string; // direct-seeded lab, WRONG capability

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_facility_admin_test');

    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Set before the dynamic imports: config and PrismaClient read
    // DATABASE_URL at import time (same ordering note as the other files).
    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    facilitiesService = await import('../../src/modules/facilities/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    const adminEmail = `facility-admin-${runId}@example.com`;
    const created = runCreateAdmin([`--email=${adminEmail}`], `${PASSWORD}\n`);
    expect(created.status).toBe(0);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    adminUserId = admin.id;
    adminToken = await login(adminEmail);

    const patient = await signup('patient', `facility-patient-${runId}@example.com`);
    patientToken = patient.accessToken;
    const doctor = await signup('doctor', `facility-doctor-${runId}@example.com`);
    doctorToken = doctor.accessToken;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function login(email: string, password = PASSWORD) {
    const res = await request(app).post('/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function signup(role: 'patient' | 'doctor', email: string) {
    const res = await request(app)
      .post('/auth/signup')
      .send({ role, email, password: PASSWORD, fullName: `Facility Test ${role}` });
    expect(res.status).toBe(200);
    return { email, accessToken: res.body.accessToken as string };
  }

  function postFacility(token: string | null, body: Record<string, unknown>) {
    const req = request(app).post('/facilities');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  }

  const validLabPayload = (overrides: Record<string, unknown> = {}) => ({
    email: `northlab-${runId}@example.com`,
    password: PASSWORD,
    name: 'Northlab Diagnostics',
    type: 'lab',
    capabilities: [{ capabilityType: 'lab_test', detail: 'haematology' }],
    ...overrides,
  });

  it('rejects non-admin callers at the route — server-side, and writes nothing', async () => {
    const unauthenticated = await postFacility(null, validLabPayload());
    expect(unauthenticated.status).toBe(401);

    const asPatient = await postFacility(patientToken, validLabPayload({ email: `patient-try-${runId}@example.com` }));
    expect(asPatient.status).toBe(403);

    const asDoctor = await postFacility(doctorToken, validLabPayload({ email: `doctor-try-${runId}@example.com` }));
    expect(asDoctor.status).toBe(403);

    expect(await prisma.user.count({ where: { role: 'facility' } })).toBe(0);
    expect(await prisma.facilityProfile.count()).toBe(0);
  });

  it('offers no self-serve facility signup (PRD OQ-2)', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'facility', email: `self-serve-${runId}@example.com`, password: PASSWORD, fullName: 'Self Serve' });
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { email: `self-serve-${runId}@example.com` } })).toBe(0);
  });

  it('admin creation writes the account, profile, capabilities and audit row, and the facility can log in', async () => {
    const res = await postFacility(adminToken, validLabPayload());
    expect(res.status).toBe(201);
    northlabId = res.body.id;

    // No credential ever leaves the response.
    expect(res.body).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body.name).toBe('Northlab Diagnostics');
    expect(res.body.type).toBe('lab');
    expect(res.body.capabilities).toHaveLength(1);
    expect(res.body.capabilities[0]).toMatchObject({ capabilityType: 'lab_test', detail: 'haematology' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(user.role).toBe('facility');
    expect(user.passwordHash).not.toContain(PASSWORD);
    // Admin attests the address out of band; the provider (#17) can't mail it.
    expect(user.emailVerifiedAt).not.toBeNull();

    const profile = await prisma.facilityProfile.findUniqueOrThrow({ where: { id: northlabId } });
    expect(profile.userId).toBe(user.id);
    const capability = await prisma.facilityCapability.findFirstOrThrow({ where: { facilityProfileId: northlabId } });
    expect(capability.capabilityType).toBe('lab_test');

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: 'FacilityProfile', entityId: northlabId, action: 'facility.created' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(adminUserId);
    expect(audit!.toState).toBe('created');
    // The audit row carries ids and counts only — never the email.
    expect(JSON.stringify(audit!.metadata)).not.toContain('northlab-');

    // The new account is a real login.
    const facilityToken = await login(`northlab-${runId}@example.com`);
    const prices = await request(app)
      .get('/facilities/me/prices')
      .set('Authorization', `Bearer ${facilityToken}`);
    expect(prices.status).toBe(200);
    expect(prices.body.prices).toEqual([]);
  });

  it('rejects inconsistent or duplicate payloads and writes nothing extra', async () => {
    const before = await prisma.facilityProfile.count();

    // A lab cannot hold a dispensing capability — and vice versa.
    const mismatched = await postFacility(
      adminToken,
      validLabPayload({
        email: `mismatch-${runId}@example.com`,
        capabilities: [{ capabilityType: 'medication_dispense' }],
      }),
    );
    expect(mismatched.status).toBe(400);

    const noCapabilities = await postFacility(
      adminToken,
      validLabPayload({ email: `nocaps-${runId}@example.com`, capabilities: [] }),
    );
    expect(noCapabilities.status).toBe(400);

    const shortPassword = await postFacility(
      adminToken,
      validLabPayload({ email: `weak-${runId}@example.com`, password: 'short' }),
    );
    expect(shortPassword.status).toBe(400);

    const extraField = await postFacility(adminToken, validLabPayload({ userId: 'forge-me' }));
    expect(extraField.status).toBe(400);

    // Duplicate email: the 409 reason, not a stack trace.
    const duplicate = await postFacility(adminToken, validLabPayload());
    expect(duplicate.status).toBe(409);

    expect(await prisma.facilityProfile.count()).toBe(before);
  });

  it('matches by capability and fails closed on missing or malformed data (PRD FR-13)', async () => {
    const pharmacy = await postFacility(
      adminToken,
      validLabPayload({
        email: `quickscripts-${runId}@example.com`,
        name: 'QuickScripts Pharmacy',
        type: 'pharmacy',
        capabilities: [{ capabilityType: 'medication_dispense', detail: 'antibiotics' }],
      }),
    );
    expect(pharmacy.status).toBe(201);
    quickscriptsId = pharmacy.body.id;

    // Fail-closed fixtures, written directly (deliberate): a lab created
    // before #14 with no capability rows at all, and a lab whose capability
    // data is malformed — the wrong capability type for its facility type.
    // Neither is creatable through the admin endpoint any more.
    const legacyUser = await prisma.user.create({
      data: { email: `legacy-lab-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const legacy = await prisma.facilityProfile.create({
      data: { userId: legacyUser.id, name: 'Legacy Unqualified Lab', type: 'lab' },
    });
    legacyLabId = legacy.id;

    const crossUser = await prisma.user.create({
      data: { email: `cross-lab-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const cross = await prisma.facilityProfile.create({
      data: { userId: crossUser.id, name: 'Crosswired Lab', type: 'lab' },
    });
    await prisma.facilityCapability.create({
      data: { facilityProfileId: cross.id, capabilityType: 'medication_dispense', detail: null },
    });
    crosswiredLabId = cross.id;

    const eligibleLabs = await request(app).get('/facilities/eligible').query({ type: 'lab' });
    expect(eligibleLabs.status).toBe(200);
    const labIds = eligibleLabs.body.facilities.map((facility: { facilityId: string }) => facility.facilityId);
    // Only the lab that actually holds a lab_test capability appears.
    expect(labIds).toEqual([northlabId]);
    // Named explicitly because "absent" is the whole point: fail closed.
    expect(labIds).not.toContain(legacyLabId);
    expect(labIds).not.toContain(crosswiredLabId);

    const eligiblePharmacies = await request(app).get('/facilities/eligible').query({ type: 'pharmacy' });
    expect(eligiblePharmacies.status).toBe(200);
    const pharmacyIds = eligiblePharmacies.body.facilities.map((facility: { facilityId: string }) => facility.facilityId);
    expect(pharmacyIds).toEqual([quickscriptsId]);

    // The order-kind entry point other modules (and #15) will use.
    const forLabOrder = await facilitiesService.listEligibleFacilitiesForOrderKind('lab_order');
    expect(forLabOrder.map((facility) => facility.facilityId)).toEqual([northlabId]);
    const forPrescription = await facilitiesService.listEligibleFacilitiesForOrderKind('prescription');
    expect(forPrescription.map((facility) => facility.facilityId)).toEqual([quickscriptsId]);

    expect(facilitiesService.facilityRequirementForOrderKind('lab_order')).toEqual({
      facilityType: 'lab',
      capabilityType: 'lab_test',
    });
    expect(() =>
      facilitiesService.facilityRequirementForOrderKind('nonsense' as 'lab_order'),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('excludes deactivated facilities from eligible queries and refuses order routing (issue #284)', async () => {
    // 1. Create a pharmacy facility with valid capability
    const pharmacyRes = await postFacility(
      adminToken,
      validLabPayload({
        email: `deact-pharmacy-${runId}@example.com`,
        name: 'Deactivatable Pharmacy',
        type: 'pharmacy',
        capabilities: [{ capabilityType: 'medication_dispense', detail: 'analgesics' }],
      }),
    );
    expect(pharmacyRes.status).toBe(201);
    const facilityId = pharmacyRes.body.id as string;
    await prisma.facilityProfile.update({
      where: { id: facilityId },
      data: { latitude: 6.45, longitude: 3.39, address: '10 Marina, Lagos' },
    });
    const facilityProfile = await prisma.facilityProfile.findUniqueOrThrow({ where: { id: facilityId } });

    // 2. Before deactivation: appears in both plain and distance-sorted queries
    const plainBefore = await request(app).get('/facilities/eligible').query({ type: 'pharmacy' });
    expect(plainBefore.status).toBe(200);
    expect(plainBefore.body.facilities.some((f: { facilityId: string }) => f.facilityId === facilityId)).toBe(true);

    const distanceBefore = await request(app).get('/facilities/eligible').query({
      type: 'pharmacy',
      near: '6.45,3.39',
      radiusKm: 10,
    });
    expect(distanceBefore.status).toBe(200);
    expect(distanceBefore.body.facilities.some((f: { facilityId: string }) => f.facilityId === facilityId)).toBe(true);

    // Can be accepted for order kind before deactivation
    const reqBefore = await facilitiesService.requireFacilityForOrderKind(prisma, facilityId, 'prescription');
    expect(reqBefore.id).toBe(facilityId);

    // Route a fulfillment record before deactivation
    const pharmacyOrdersService = await import('../../src/modules/pharmacy-orders/services/index.js');
    // Seed an issued prescription directly
    const testDoctorUser = await prisma.user.create({
      data: { email: `doc-${runId}-deact@example.com`, passwordHash: 'unused', role: 'doctor' },
    });
    const testDoctor = await prisma.doctorProfile.create({
      data: { userId: testDoctorUser.id, fullName: 'Prescribing Doctor', verificationStatus: 'verified', timeZone: 'UTC' },
    });
    const testPatientUser = await prisma.user.create({
      data: { email: `pat-${runId}-deact@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    const testPatient = await prisma.patientProfile.create({
      data: { userId: testPatientUser.id, fullName: 'Routed Patient' },
    });
    const testAppointment = await prisma.appointment.create({
      data: { doctorProfileId: testDoctor.id, patientProfileId: testPatient.id },
    });
    const testConsultation = await prisma.consultation.create({
      data: { appointmentId: testAppointment.id },
    });
    const testPrescription = await prisma.prescription.create({
      data: {
        consultationId: testConsultation.id,
        patientProfileId: testPatient.id,
        prescribingDoctorId: testDoctor.id,
        facilityProfileId: facilityId,
        amountStroops: 10000000n,
        items: {
          create: [{ drugName: 'Ibuprofen', dosage: '400mg', frequency: 'daily', duration: '5 days' }],
        },
      },
      include: { items: true },
    });
    const routedRecord = await pharmacyOrdersService.createFulfillment(
      {
        orderType: 'prescription',
        orderId: testPrescription.id,
        facilityId,
        orderItemIds: [testPrescription.items[0].id],
      },
      { userId: testPatientUser.id, role: 'patient' },
    );
    expect(routedRecord.facilityId).toBe(facilityId);

    // 3. Deactivate the facility account
    await prisma.user.update({
      where: { id: facilityProfile.userId },
      data: { deactivatedAt: new Date() },
    });

    // 4. Excluded from plain eligible-facility queries
    const plainAfter = await request(app).get('/facilities/eligible').query({ type: 'pharmacy' });
    expect(plainAfter.status).toBe(200);
    expect(plainAfter.body.facilities.some((f: { facilityId: string }) => f.facilityId === facilityId)).toBe(false);

    // 5. Excluded from distance-sorted eligible-facility queries
    const distanceAfter = await request(app).get('/facilities/eligible').query({
      type: 'pharmacy',
      near: '6.45,3.39',
      radiusKm: 10,
    });
    expect(distanceAfter.status).toBe(200);
    expect(distanceAfter.body.facilities.some((f: { facilityId: string }) => f.facilityId === facilityId)).toBe(false);

    // 6. Refused at order kind requirement (prescription/lab order issuance)
    await expect(
      facilitiesService.requireFacilityForOrderKind(prisma, facilityId, 'prescription'),
    ).rejects.toThrowError(expect.objectContaining({ status: 400, message: expect.stringMatching(/deactivated/i) }));

    // 7. Refused when patient attempts to route fulfillment
    const secondPrescription = await prisma.prescription.create({
      data: {
        consultationId: testConsultation.id,
        patientProfileId: testPatient.id,
        prescribingDoctorId: testDoctor.id,
        facilityProfileId: quickscriptsId, // active facility at issuance
        amountStroops: 10000000n,
        items: {
          create: [{ drugName: 'Paracetamol', dosage: '500mg', frequency: 'twice', duration: '3 days' }],
        },
      },
      include: { items: true },
    });
    await expect(
      pharmacyOrdersService.createFulfillment(
        {
          orderType: 'prescription',
          orderId: secondPrescription.id,
          facilityId, // routing to deactivated facility
          orderItemIds: [secondPrescription.items[0].id],
        },
        { userId: testPatientUser.id, role: 'patient' },
      ),
    ).rejects.toThrowError(expect.objectContaining({ status: 400, message: expect.stringMatching(/deactivated/i) }));

    // 8. Orders/fulfillments already routed before deactivation remain readable
    const readableRecord = await prisma.fulfillmentRecord.findUniqueOrThrow({
      where: { id: routedRecord.id },
      include: { facility: true },
    });
    expect(readableRecord.id).toBe(routedRecord.id);
    expect(readableRecord.facilityId).toBe(facilityId);
    expect(readableRecord.facility.name).toBe('Deactivatable Pharmacy');
  });
});
