// Integration tests for guardians and dependents (Phase 8, issue #42,
// docs/adr/0011): creating and listing dependents, booking on a
// dependent's behalf, refusing someone else's dependent before anything is
// booked, revocation and age of majority, the DB constraints, the
// migration's data-preservation guard — and the booking concurrency
// guarantee re-proven with a guardian booking in the race. Self-contained,
// same embedded-Postgres pattern as booking.test.mts. Own port (5454).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');
const PORT = 5454;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-guardian-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const urlFor = (db: string) => `postgresql://docforum:docforum@localhost:${PORT}/${db}`;
const databaseUrl = urlFor('docforum_test');

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

interface Patient {
  email: string;
  userId: string;
  profileId: string;
  token: string;
}

const emailedTokens = new Map<string, string>();

function yearsAgo(years: number, days = 0): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() - days));
  return d.toISOString().slice(0, 10);
}

// Prisma 7 (ADR 0006) dropped `db execute --url`: the CLI reads the URL from
// prisma.config.ts, i.e. from DATABASE_URL, so the target goes in the env.
function dbExecute(url: string, sql: string) {
  execFileSync('npx', ['prisma', 'db', 'execute', '--stdin'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function dbExecuteFile(url: string, file: string) {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describe('guardian and dependent profiles', () => {
  let app: App;
  let prisma: Prisma;
  let doctorToken: string;
  let doctorProfileId: string;
  let g1: Patient; // guardian with dependents
  let g2: Patient; // another guardian
  let adult: Patient; // ordinary patient, no dependents
  let unverified: Patient;
  let d1: string; // g1's dependent
  let d2: string; // g2's dependent
  const freeSlots: string[] = [];

  async function signup(role: 'patient' | 'doctor', label: string, verify = true) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app).post('/auth/signup').send({ role, email, password: 'longenough123', fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    if (verify) expect((await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) })).status).toBe(200);
    return { email, userId: res.body.user.id as string, token: res.body.accessToken as string };
  }

  async function signupPatient(label: string, verify = true): Promise<Patient> {
    const user = await signup('patient', label, verify);
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: user.userId } });
    return { ...user, profileId: profile.id };
  }

  const auth = (p: { token: string }) => ({ Authorization: `Bearer ${p.token}` });
  const createDependent = (p: Patient, body: object) => request(app).post('/patients/me/dependents').set(auth(p)).send(body);
  const book = (p: Patient, body: object) => request(app).post('/appointments').set(auth(p)).send(body);
  const nextSlot = () => {
    const slot = freeSlots.shift();
    if (!slot) throw new Error('test ran out of slots');
    return slot;
  };

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.AGE_OF_MAJORITY_YEARS = '18';

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const doctor = await signup('doctor', 'guardian-doctor');
    doctorToken = doctor.token;
    doctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctor.userId } })).id;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generated = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ date: tomorrow, startHour: 8, endHour: 18, slotLengthMinutes: 30 });
    expect(generated.status).toBe(201);
    freeSlots.push(...((await request(app).get(`/availability/doctors/${doctorProfileId}/slots`)).body as { id: string }[]).map((s) => s.id));

    g1 = await signupPatient('guardian-one');
    g2 = await signupPatient('guardian-two');
    adult = await signupPatient('adult');
    unverified = await signupPatient('unverified', false);
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets a patient create a dependent: a login-less profile plus a guardianship', async () => {
    const res = await createDependent(g1, { fullName: 'Child One', dateOfBirth: yearsAgo(6) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fullName: 'Child One', dateOfBirth: `${yearsAgo(6)}T00:00:00.000Z` });
    expect(Object.keys(res.body).sort()).toEqual(['dateOfBirth', 'fullName', 'guardianSince', 'id']);
    d1 = res.body.id;

    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { id: d1 } });
    expect(profile.userId).toBeNull();
    const guardianships = await prisma.guardianship.findMany({ where: { dependentProfileId: d1 } });
    expect(guardianships).toEqual([expect.objectContaining({ guardianUserId: g1.userId, revokedAt: null })]);

    const other = await createDependent(g2, { fullName: 'Child Two', dateOfBirth: yearsAgo(10) });
    expect(other.status).toBe(201);
    d2 = other.body.id;
  });

  it('refuses unauthorised or invalid dependent creation, and never links an existing profile', async () => {
    const before = await prisma.guardianship.count();
    // Linking attempts: naming an existing profile/user is rejected outright.
    for (const extra of [{ patientProfileId: adult.profileId }, { userId: adult.userId }, { patientProfileId: d2 }]) {
      const res = await createDependent(g1, { fullName: 'Sneaky', dateOfBirth: yearsAgo(5), ...extra });
      expect(res.status).toBe(400);
    }
    expect(await prisma.guardianship.count({ where: { dependentProfileId: { in: [adult.profileId, d2] }, guardianUserId: g1.userId } })).toBe(0);

    const adultDob = await createDependent(g1, { fullName: 'Grown Up', dateOfBirth: yearsAgo(18) });
    expect(adultDob.status).toBe(400);
    expect(adultDob.body.code).toBe('DEPENDENT_NOT_A_MINOR');
    expect((await createDependent(g1, { fullName: 'Future', dateOfBirth: '2999-01-01' })).status).toBe(400);
    expect((await createDependent(g1, { fullName: 'Bad', dateOfBirth: '2020-02-30' })).status).toBe(400);
    expect((await createDependent(g1, { dateOfBirth: yearsAgo(3) })).status).toBe(400);

    const doctor = await request(app).post('/patients/me/dependents').set('Authorization', `Bearer ${doctorToken}`).send({ fullName: 'X', dateOfBirth: yearsAgo(3) });
    expect(doctor.status).toBe(403);
    const unverifiedRes = await createDependent(unverified, { fullName: 'X', dateOfBirth: yearsAgo(3) });
    expect(unverifiedRes.status).toBe(403);
    expect(unverifiedRes.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await request(app).post('/patients/me/dependents').send({ fullName: 'X', dateOfBirth: yearsAgo(3) })).status).toBe(401);

    // One day short of majority is still a minor.
    const almost = await createDependent(g1, { fullName: 'Almost Adult', dateOfBirth: yearsAgo(18, -1) });
    expect(almost.status).toBe(201);
    expect(await prisma.guardianship.count()).toBe(before + 1);
  });

  it("lists only the caller's own active dependents", async () => {
    const mine = await request(app).get('/patients/me/dependents').set(auth(g1));
    expect(mine.status).toBe(200);
    expect(mine.body.map((d: { fullName: string }) => d.fullName)).toEqual(['Child One', 'Almost Adult']);
    const theirs = await request(app).get('/patients/me/dependents').set(auth(g2));
    expect(theirs.body.map((d: { id: string }) => d.id)).toEqual([d2]);
    expect((await request(app).get('/patients/me/dependents').set(auth(adult))).body).toEqual([]);
    expect((await request(app).get('/patients/me/dependents').set('Authorization', `Bearer ${doctorToken}`)).status).toBe(403);
  });

  it('lets a guardian book for their dependent and see that appointment', async () => {
    const slot = nextSlot();
    const res = await book(g1, { availabilitySlotId: slot, patientProfileId: d1 });
    expect(res.status).toBe(201);
    expect(res.body.patientProfileId).toBe(d1);

    // Audit (issue #43): the guardian is the actor; the event names the
    // dependent's profile the appointment was booked for.
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'Appointment', entityId: res.body.id } });
    expect(event).toMatchObject({ actorUserId: g1.userId, actorRole: 'patient', action: 'appointment.booked', toState: 'scheduled' });
    expect(event.metadata).toMatchObject({ patientProfileId: d1, availabilitySlotId: slot });

    const dependentAppointments = await request(app).get(`/appointments/mine?patientProfileId=${d1}`).set(auth(g1));
    expect(dependentAppointments.status).toBe(200);
    expect(dependentAppointments.body.map((a: { id: string }) => a.id)).toEqual([res.body.id]);
    // The guardian's own list is the guardian's own history only.
    const own = await request(app).get('/appointments/mine').set(auth(g1));
    expect(own.body).toEqual([]);
  });

  it("refuses another guardian's dependent, or another patient, before anything is booked", async () => {
    for (const target of [d2, adult.profileId]) {
      const slot = nextSlot();
      const res = await book(g1, { availabilitySlotId: slot, patientProfileId: target });
      expect(res.status).toBe(404);
      // Rejected before the booking ran: the slot is still open, no appointment exists.
      expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('open');
      expect(await prisma.appointment.count({ where: { availabilitySlotId: slot } })).toBe(0);
      freeSlots.unshift(slot);
    }
    expect((await request(app).get(`/appointments/mine?patientProfileId=${d2}`).set(auth(g1))).status).toBe(404);
    expect(await prisma.appointment.count({ where: { patientProfileId: { in: [d2, adult.profileId] } } })).toBe(0);
  });

  it('keeps self-booking working, with or without naming your own profile', async () => {
    const plain = await book(adult, { availabilitySlotId: nextSlot() });
    expect(plain.status).toBe(201);
    expect(plain.body.patientProfileId).toBe(adult.profileId);
    const named = await book(adult, { availabilitySlotId: nextSlot(), patientProfileId: adult.profileId });
    expect(named.status).toBe(201);
    expect(named.body.patientProfileId).toBe(adult.profileId);
    expect((await request(app).get('/appointments/mine').set(auth(adult))).body).toHaveLength(2);
  });

  it('rejects a missing, empty or unknown patientProfileId cleanly', async () => {
    const slot = nextSlot();
    expect((await book(g1, { availabilitySlotId: slot, patientProfileId: '' })).status).toBe(400);
    expect((await book(g1, { availabilitySlotId: slot, patientProfileId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);
    expect((await book(g1, { patientProfileId: d1 })).status).toBe(400);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('open');
    freeSlots.unshift(slot);
  });

  it('ends access on revocation and at the age of majority, keeping the history', async () => {
    // Revoked guardianship.
    const revokedChild = await createDependent(g1, { fullName: 'Revoked Child', dateOfBirth: yearsAgo(8) });
    await prisma.guardianship.updateMany({ where: { dependentProfileId: revokedChild.body.id }, data: { revokedAt: new Date() } });
    const revokedBooking = await book(g1, { availabilitySlotId: nextSlot(), patientProfileId: revokedChild.body.id });
    expect(revokedBooking.status).toBe(403);
    expect(revokedBooking.body.code).toBe('GUARDIANSHIP_INACTIVE');

    // Reaching majority: D1 (who has an appointment) turns 18.
    await prisma.patientProfile.update({ where: { id: d1 }, data: { dateOfBirth: new Date(`${yearsAgo(18)}T00:00:00.000Z`) } });
    const adultBooking = await book(g1, { availabilitySlotId: nextSlot(), patientProfileId: d1 });
    expect(adultBooking.status).toBe(403);
    expect(adultBooking.body.code).toBe('GUARDIANSHIP_INACTIVE');
    expect((await request(app).get(`/appointments/mine?patientProfileId=${d1}`).set(auth(g1))).status).toBe(403);

    const listed = (await request(app).get('/patients/me/dependents').set(auth(g1))).body.map((d: { id: string }) => d.id);
    expect(listed).not.toContain(d1);
    expect(listed).not.toContain(revokedChild.body.id);

    // Clinical history and the guardianship record are kept, not deleted.
    expect(await prisma.appointment.count({ where: { patientProfileId: d1 } })).toBe(1);
    expect(await prisma.guardianship.count({ where: { dependentProfileId: { in: [d1, revokedChild.body.id] } } })).toBe(2);
  });

  it('enforces the model in the database: unique pair, dependent DOB, RESTRICT', async () => {
    await expect(
      prisma.guardianship.create({ data: { guardianUserId: g2.userId, dependentProfileId: d2 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.patientProfile.create({ data: { userId: null, fullName: 'No DOB' } })).rejects.toThrow(
      /PatientProfile_dependent_has_dob/,
    );
    await expect(prisma.patientProfile.delete({ where: { id: d2 } })).rejects.toThrow(/Guardianship_dependentProfileId_fkey/);
  });

  it('keeps the booking concurrency guarantee with a guardian booking in the race', async () => {
    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => signupPatient(`racer-${i}`)));
    const child = await createDependent(g2, { fullName: 'Race Child', dateOfBirth: yearsAgo(4) });
    expect(child.status).toBe(201);
    const slot = nextSlot();

    const responses = await Promise.all([
      book(g2, { availabilitySlotId: slot, patientProfileId: child.body.id }),
      ...racers.map((racer) => book(racer, { availabilitySlotId: slot })),
    ]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(racers.length);
    expect(await prisma.appointment.count({ where: { availabilitySlotId: slot } })).toBe(1);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('booked');
  });

  it("revokes a guardian's access when they delete their account, keeping the dependent and the record", async () => {
    const patients = await import('../../src/modules/patients/services/index.js');
    const g3 = await signupPatient('guardian-deleting');
    const created = await createDependent(g3, { fullName: 'Kept Child', dateOfBirth: '2018-03-04' });
    expect(created.status).toBe(201);
    const d3 = created.body.id as string;
    expect((await book(g3, { availabilitySlotId: nextSlot(), patientProfileId: d3 })).status).toBe(201);
    const dependentBefore = await prisma.patientProfile.findUniqueOrThrow({ where: { id: d3 } });

    const deleted = await request(app).delete('/patients/me').set(auth(g3)).send({ password: 'longenough123' });
    expect(deleted.status).toBe(204);

    // Revoked, not deleted: the row is the record of who had access.
    const guardianship = await prisma.guardianship.findFirstOrThrow({ where: { guardianUserId: g3.userId } });
    expect(guardianship.revokedAt).not.toBeNull();
    // The dependent's own profile and history are the dependent's — untouched.
    expect(await prisma.patientProfile.findUniqueOrThrow({ where: { id: d3 } })).toEqual(dependentBefore);
    expect(await prisma.appointment.count({ where: { patientProfileId: d3 } })).toBe(1);

    // The still-valid access token acts for no one.
    // Booking is refused even earlier: deletion clears the verified email.
    const booking = await book(g3, { availabilitySlotId: freeSlots[0], patientProfileId: d3 });
    expect(booking.status).toBe(403);
    expect(booking.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await request(app).get(`/appointments/mine?patientProfileId=${d3}`).set(auth(g3))).status).toBe(404);
    expect((await request(app).get('/patients/me/dependents').set(auth(g3))).status).toBe(404);

    // The purge keeps the guardian's tombstone while the guardianship row exists.
    const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await patients.purgeDeletedPatientAccounts(later);
    expect(await prisma.user.findUnique({ where: { id: g3.userId } })).not.toBeNull();
    expect(await prisma.guardianship.count({ where: { guardianUserId: g3.userId } })).toBe(1);
  });

  describe('migration', () => {
    const newMigration = fs.readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith('_guardian_dependent_profiles'))!;
    const earlier = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d < newMigration && fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
      .sort();
    const migrationFile = (dir: string) => path.join(MIGRATIONS_DIR, dir, 'migration.sql');

    /** A fresh database at the migration just before this one, seeded —
     * one `prisma db execute` for all of it (each CLI spawn costs seconds). */
    async function databaseAtPreviousMigration(name: string, seedSql: string) {
      await pg.createDatabase(name);
      const script = [...earlier.map((dir) => fs.readFileSync(migrationFile(dir), 'utf8')), seedSql].join('\n;\n');
      dbExecute(urlFor(name), script);
      return urlFor(name);
    }

    async function withClient<T>(url: string, fn: (client: Prisma) => Promise<T>): Promise<T> {
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      // Prisma 7 (ADR 0006): the URL goes to a driver adapter, not `datasources`.
      const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      try {
        return await fn(client);
      } finally {
        await client.$disconnect();
      }
    }

    const seed = (guardianUserId: string | null) => `
      INSERT INTO "User" ("id","email","passwordHash","role","updatedAt") VALUES ('u1','u1@example.com','x','patient',NOW());
      INSERT INTO "User" ("id","email","passwordHash","role","updatedAt") VALUES ('doc','doc@example.com','x','doctor',NOW());
      INSERT INTO "PatientProfile" ("id","userId","fullName","guardianUserId","updatedAt") VALUES ('p1','u1','Existing Patient',${guardianUserId === null ? 'NULL' : `'${guardianUserId}'`},NOW());
      INSERT INTO "DoctorProfile" ("id","userId","fullName","updatedAt") VALUES ('d1','doc','Doc',NOW());
      INSERT INTO "AvailabilitySlot" ("id","doctorProfileId","status","startTime","endTime","updatedAt") VALUES ('s1','d1','booked',NOW(),NOW() + interval '30 minutes',NOW());
      INSERT INTO "Appointment" ("id","patientProfileId","doctorProfileId","availabilitySlotId","updatedAt") VALUES ('a1','p1','d1','s1',NOW());
    `;

    it('preserves existing profiles and their records', { timeout: 120_000 }, async () => {
      const url = await databaseAtPreviousMigration('migration_clean', seed(null));
      dbExecuteFile(url, migrationFile(newMigration));
      await withClient(url, async (client) => {
        expect(await client.patientProfile.findUniqueOrThrow({ where: { id: 'p1' } })).toMatchObject({ userId: 'u1', fullName: 'Existing Patient' });
        expect(await client.appointment.findUniqueOrThrow({ where: { id: 'a1' } })).toMatchObject({ patientProfileId: 'p1' });
        expect(await client.guardianship.count()).toBe(0);
      });
    });

    it('refuses to run, changing nothing, if legacy guardianUserId data exists', { timeout: 120_000 }, async () => {
      const url = await databaseAtPreviousMigration('migration_legacy', seed('u-someone'));
      expect(() => dbExecuteFile(url, migrationFile(newMigration))).toThrow();
      // The column and its value are still there for an operator to resolve,
      // and nothing else from the migration was applied.
      await withClient(url, async (client) => {
        const legacy = await client.$queryRaw<{ guardianUserId: string }[]>`SELECT "guardianUserId" FROM "PatientProfile" WHERE "id" = 'p1'`;
        expect(legacy).toEqual([{ guardianUserId: 'u-someone' }]);
        const table = await client.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('"Guardianship"') IS NOT NULL AS "exists"`;
        expect(table).toEqual([{ exists: false }]);
      });
    });
  });
});
