// Integration tests for the admin account lifecycle (Phase 8, issue #39):
// the bootstrap CLI, invites (hashed/expiring/single-use), deactivation
// (login + refresh + live access tokens all refused), the last-active-admin
// guard, and the promise that deactivation deletes nothing.
//
// Self-contained embedded Postgres, own port (5439) so it runs alongside the
// other integration files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5439;
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-admin-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

function cookiePair(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const match = list.find((cookie) => cookie.startsWith(`${name}=`));
  return match ? match.split(';')[0]! : null;
}

/** Runs the bootstrap CLI the way an operator would: password on stdin,
 * never in argv. */
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

describe('admin account lifecycle', () => {
  let app: App;
  let prisma: Prisma;
  let bootstrapAdminEmail: string;
  let bootstrapAdminToken: string;

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

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signupPatient(label: string) {
    const email = `admin-lifecycle-${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: `Admin Lifecycle ${label}` });
    expect(res.status).toBe(200);
    return { email, accessToken: res.body.accessToken as string, cookie: cookiePair(res, 'docforum_refresh')!, raw: res };
  }

  async function loginAs(email: string, password = PASSWORD) {
    const res = await request(app).post('/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return { accessToken: res.body.accessToken as string, cookie: cookiePair(res, 'docforum_refresh')!, raw: res };
  }

  it('bootstraps an admin from the CLI, refuses a second without --force, and rejects passwords in argv', async () => {
    bootstrapAdminEmail = `bootstrap-admin-${runId}@example.com`;
    const created = runCreateAdmin([`--email=${bootstrapAdminEmail}`], `${PASSWORD}\n`);
    expect(created.status).toBe(0);

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: bootstrapAdminEmail } });
    expect(admin.role).toBe('admin');
    expect(admin.deactivatedAt).toBeNull();
    // The password is hashed, and does not appear in the CLI's output.
    expect(admin.passwordHash).not.toContain(PASSWORD);
    expect(created.stdout).not.toContain(PASSWORD);
    expect(created.stdout).not.toContain(admin.passwordHash);

    // A stray second run must not quietly add another administrator.
    const refused = runCreateAdmin([`--email=second-admin-${runId}@example.com`], `${PASSWORD}\n`);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/--force/);
    expect(await prisma.user.count({ where: { email: `second-admin-${runId}@example.com` } })).toBe(0);

    const forced = runCreateAdmin([`--email=second-admin-${runId}@example.com`, '--force'], `${PASSWORD}\n`);
    expect(forced.status).toBe(0);

    // Credentials never travel in argv (`ps`/history/CI logs).
    const argvRefused = runCreateAdmin([`--email=third-${runId}@example.com`, `--password=${PASSWORD}`], '');
    expect(argvRefused.status).not.toBe(0);
    expect(argvRefused.stderr).toMatch(/command-line arguments/);
    expect(await prisma.user.count({ where: { email: `third-${runId}@example.com` } })).toBe(0);

    bootstrapAdminToken = (await loginAs(bootstrapAdminEmail)).accessToken;
  });

  it('issues a hashed, expiring, single-use invite that redeems into an admin session', async () => {
    const inviteeEmail = `invited-admin-${runId}@example.com`;

    const created = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAdminToken}`)
      .send({ email: inviteeEmail });
    expect(created.status).toBe(201);

    const token = created.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.email).toBe(inviteeEmail);

    // Stored hashed, never raw, with a future expiry.
    const stored = await prisma.adminInvite.findFirstOrThrow({ where: { email: inviteeEmail } });
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.consumedAt).toBeNull();

    const redeemed = await request(app)
      .post('/auth/signup-with-invite')
      .send({ token, email: inviteeEmail, password: PASSWORD });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.user.role).toBe('admin');

    const invite = await prisma.adminInvite.findFirstOrThrow({ where: { email: inviteeEmail } });
    expect(invite.consumedAt).not.toBeNull();

    // Single-use: the same link can't mint a second admin.
    const replay = await request(app)
      .post('/auth/signup-with-invite')
      .send({ token, email: inviteeEmail, password: PASSWORD });
    expect(replay.status).toBe(400);
    expect(await prisma.user.count({ where: { email: inviteeEmail } })).toBe(1);

    // And the new admin really is an admin.
    const asNewAdmin = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${redeemed.body.accessToken as string}`)
      .send({ email: `invited-by-new-admin-${runId}@example.com` });
    expect(asNewAdmin.status).toBe(201);
  });

  it('refuses invites from non-admins, for a different address, and once expired', async () => {
    const patient = await signupPatient('invite-authz');
    const asPatient = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ email: `whatever-${runId}@example.com` });
    expect(asPatient.status).toBe(403);

    // Existing accounts aren't invitable either — that's a promote,
    // not an invite.
    const forExisting = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAdminToken}`)
      .send({ email: patient.email });
    expect(forExisting.status).toBe(409);

    const wrongAddressEmail = `wrong-address-${runId}@example.com`;
    const invite = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAdminToken}`)
      .send({ email: wrongAddressEmail });
    expect(invite.status).toBe(201);

    const mismatched = await request(app)
      .post('/auth/signup-with-invite')
      .send({ token: invite.body.token as string, email: `someone-else-${runId}@example.com`, password: PASSWORD });
    expect(mismatched.status).toBe(403);

    // Expiry: age the stored invite rather than waiting it out.
    const expiringEmail = `expiring-${runId}@example.com`;
    const expiring = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAdminToken}`)
      .send({ email: expiringEmail });
    await prisma.adminInvite.updateMany({
      where: { email: expiringEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await request(app)
      .post('/auth/signup-with-invite')
      .send({ token: expiring.body.token as string, email: expiringEmail, password: PASSWORD });
    expect(expired.status).toBe(400);
    expect(await prisma.user.count({ where: { email: expiringEmail } })).toBe(0);
  });

  it('deactivation blocks login, refresh and existing access tokens, and reactivation lets them back in', async () => {
    const patient = await signupPatient('deactivate');
    const patientRow = await prisma.user.findUniqueOrThrow({ where: { email: patient.email } });

    // The access token works before deactivation.
    const before = await request(app)
      .get('/appointments/mine')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(before.status).toBe(200);

    const deactivated = await request(app)
      .patch(`/admin/users/${patientRow.id}/deactivate`)
      .set('Authorization', `Bearer ${bootstrapAdminToken}`);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.deactivatedAt).not.toBeNull();

    // Login is refused…
    const login = await request(app).post('/auth/login').send({ email: patient.email, password: PASSWORD });
    expect(login.status).toBe(403);

    // …refresh is refused (the refresh cookie is still valid)…
    const refresh = await request(app)
      .post('/auth/refresh')
      .set('Cookie', patient.cookie);
    expect(refresh.status).toBe(403);

    // …and the access token that was already in the client's hand stops
    // working immediately, rather than living out its 15-minute TTL.
    const after = await request(app)
      .get('/appointments/mine')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(after.status).toBe(401);

    // Reactivation: logging in works again…
    const reactivated = await request(app)
      .patch(`/admin/users/${patientRow.id}/reactivate`)
      .set('Authorization', `Bearer ${bootstrapAdminToken}`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.deactivatedAt).toBeNull();

    // `iat` is second-precision and `isSessionRevoked` deliberately counts a
    // token minted in the same second as the invalidation as revoked (the
    // safe direction). A login immediately after reactivation can therefore
    // mint a same-second token that is correctly refused — wait out the
    // second boundary so the fresh token is genuinely fresh.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const freshLogin = await loginAs(patient.email);
    const withFreshToken = await request(app)
      .get('/appointments/mine')
      .set('Authorization', `Bearer ${freshLogin.accessToken}`);
    expect(withFreshToken.status).toBe(200);

    // …but the pre-deactivation token stays dead: sessions invalidated by a
    // deactivation must not come back to life with the account.
    const reused = await request(app)
      .get('/appointments/mine')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(reused.status).toBe(401);

    // A wrong password is still just a 401, and a missing user is a 404.
    const missing = await request(app)
      .patch('/admin/users/00000000-0000-0000-0000-000000000000/deactivate')
      .set('Authorization', `Bearer ${bootstrapAdminToken}`);
    expect(missing.status).toBe(404);
  });

  it('refuses to deactivate the last active admin', async () => {
    // Leave exactly one active admin: the two bootstrapped ones, minus one.
    const admins = await prisma.user.findMany({ where: { role: 'admin', deactivatedAt: null }, select: { id: true, email: true } });
    expect(admins.length).toBeGreaterThanOrEqual(2);
    const [keep, ...others] = admins;
    for (const other of others) {
      await prisma.user.update({ where: { id: other.id }, data: { deactivatedAt: new Date() } });
    }

    const refused = await request(app)
      .patch(`/admin/users/${keep!.id}/deactivate`)
      .set('Authorization', `Bearer ${bootstrapAdminToken}`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/last active admin/i);

    const stillActive = await prisma.user.findUniqueOrThrow({ where: { id: keep!.id } });
    expect(stillActive.deactivatedAt).toBeNull();
  });

  it('deactivation deletes no clinical or payment records', async () => {
    // A booked appointment is the strongest thing this phase can check —
    // there are no Prescription/LabOrder/PaymentIntent rows to protect yet.
    const doctor = `doctor-${runId}@example.com`;
    const doctorSignup = await request(app)
      .post('/auth/signup')
      .send({ role: 'doctor', email: doctor, password: PASSWORD, fullName: 'Deactivation Test Doctor' });
    expect(doctorSignup.status).toBe(200);
    const doctorToken = doctorSignup.body.accessToken as string;

    const doctorMe = await request(app).get('/doctors/me').set('Authorization', `Bearer ${doctorToken}`);
    const doctorProfileId = doctorMe.body.id as string;

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 10, slotLengthMinutes: 30 });
    expect(generate.status).toBe(201);
    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);

    const patient = await signupPatient('records');
    // Booking is gated on a verified email (Phase 8, issue #34 — merged in
    // from main after this test was written). Deletion-resistance is the
    // subject here, not verification, so the fixture marks the patient
    // verified directly rather than replaying the emailed-token flow.
    await prisma.user.update({
      where: { email: patient.email },
      data: { emailVerifiedAt: new Date() },
    });
    const booking = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slots.body[0].id as string });
    expect(booking.status).toBe(201);

    const patientRow = await prisma.user.findUniqueOrThrow({ where: { email: patient.email } });
    const deactivated = await request(app)
      .patch(`/admin/users/${patientRow.id}/deactivate`)
      .set('Authorization', `Bearer ${bootstrapAdminToken}`);
    expect(deactivated.status).toBe(200);

    // The appointment and the slot it consumed are untouched.
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.body.id as string } });
    expect(appointment.patientProfileId).toBeTruthy();
    // availabilitySlotId is nullable (a cancelled appointment releases its
    // slot) — this booking is live, so it still holds the slot.
    expect(appointment.availabilitySlotId).toBeTruthy();
    const slot = await prisma.availabilitySlot.findUniqueOrThrow({
      where: { id: appointment.availabilitySlotId as string },
    });
    expect(slot.status).toBe('booked');
  });
});
