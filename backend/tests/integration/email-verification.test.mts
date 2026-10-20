// Integration tests for email verification (Phase 8, issue #34):
// unverified accounts can log in and browse but cannot book or move money,
// verification tokens are single-use and expiring, and resend is
// rate-limited. Self-contained, same embedded-Postgres pattern as
// booking.test.mts — see that file's header for why.
//
// Uses its own port (5435) and points the app's PrismaClient at it by
// setting DATABASE_URL before importing src/app.js, so this file can run
// alongside the other integration files without sharing a database. (The
// app's PrismaClient is constructed at module load and reads DATABASE_URL
// then — same reason booking.test.mts imports the app dynamically.)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5435;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-email-verify-pg-'));
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

/** Verification links are emailed, so the test installs its own sender and
 * reads the token out of the mail (the token is never persisted raw, so the
 * database can't be asked for it). */
const emailedTokens = new Map<string, string>();

describe('email verification', () => {
  let app: App;
  let prisma: Prisma;
  let slotId: string;
  let doctorProfileId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Must be set before the app module (and its PrismaClient) loads.
    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    // A doctor + one open slot, so a booking attempt is a real attempt.
    const doctorSignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `doctor-verify-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Verify Test Doctor',
    });
    expect(doctorSignup.status).toBe(200);

    const doctorMe = await request(app)
      .get('/doctors/me')
      .set('Authorization', `Bearer ${doctorSignup.body.accessToken as string}`);
    doctorProfileId = doctorMe.body.id as string;

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorSignup.body.accessToken as string}`)
      .send({ date: tomorrow, startHour: 9, endHour: 10, slotLengthMinutes: 30 });
    expect(generate.status).toBe(201);

    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
    expect(slots.body.length).toBeGreaterThan(0);
    slotId = slots.body[0].id;
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signupPatient(label: string) {
    const email = `patient-${label}-${runId}@example.com`;
    const res = await request(app).post('/auth/signup').send({
      role: 'patient',
      email,
      password: 'longenough123',
      fullName: `Verify Test ${label}`,
    });
    expect(res.status).toBe(200);
    return {
      email,
      accessToken: res.body.accessToken as string,
      user: res.body.user as { emailVerifiedAt: string | null },
    };
  }

  function tokenFor(email: string): string {
    const token = emailedTokens.get(email);
    if (!token) throw new Error(`No verification email captured for ${email}`);
    return token;
  }

  it('starts new accounts unverified, lets them log in, but blocks booking with 403 EMAIL_NOT_VERIFIED', async () => {
    const { email, accessToken, user } = await signupPatient('unverified');

    expect(user.emailVerifiedAt).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.emailVerifiedAt).toBeNull();

    // Login is allowed while unverified — they need to be able to reach
    // the resend endpoint.
    const login = await request(app).post('/auth/login').send({ email, password: 'longenough123' });
    expect(login.status).toBe(200);

    const booking = await request(app).post('/appointments').set('Authorization', `Bearer ${accessToken}`).send({ availabilitySlotId: slotId });
    expect(booking.status).toBe(403);
    expect(booking.body.code).toBe('EMAIL_NOT_VERIFIED');

    // Browsing stays open to unverified accounts.
    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
    expect(slots.status).toBe(200);
  });

  it('redeeming the emailed token verifies the account and unblocks booking', async () => {
    const { email, accessToken } = await signupPatient('redeem');

    const bookingBefore = await request(app).post('/appointments').set('Authorization', `Bearer ${accessToken}`).send({ availabilitySlotId: slotId });
    expect(bookingBefore.status).toBe(403);
    expect(bookingBefore.body.code).toBe('EMAIL_NOT_VERIFIED');

    const verified = await request(app).post('/auth/verify-email').send({ token: tokenFor(email) });
    expect(verified.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.emailVerifiedAt).not.toBeNull();

    const bookingAfter = await request(app).post('/appointments').set('Authorization', `Bearer ${accessToken}`).send({ availabilitySlotId: slotId });
    expect(bookingAfter.status).toBe(201);

    const doubleBooking = await request(app).post('/appointments').set('Authorization', `Bearer ${accessToken}`).send({ availabilitySlotId: slotId });
    expect(doubleBooking.status).toBe(409); // the slot is now taken
  });

  it('rejects an expired token with VERIFICATION_TOKEN_EXPIRED', async () => {
    const { email } = await signupPatient('expired');
    const token = tokenFor(email);

    await prisma.emailVerificationToken.updateMany({
      where: { user: { email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).post('/auth/verify-email').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERIFICATION_TOKEN_EXPIRED');

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.emailVerifiedAt).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const res = await request(app).post('/auth/verify-email').send({ token: 'not-a-real-token' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VERIFICATION_TOKEN');
  });

  it('lets only one of two concurrent redemptions of the same token succeed', async () => {
    const { email } = await signupPatient('concurrent');
    const token = tokenFor(email);

    const responses = await Promise.all([
      request(app).post('/auth/verify-email').send({ token }),
      request(app).post('/auth/verify-email').send({ token }),
    ]);

    expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
    expect(responses.filter((res) => res.status === 400)).toHaveLength(1);
  });

  it('rate-limits resend and retires the previous link when a new one is issued', async () => {
    const { email, accessToken } = await signupPatient('resend');
    const firstToken = tokenFor(email);

    const tooSoon = await request(app)
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe('EMAIL_VERIFICATION_RATE_LIMITED');

    // Age the outstanding token past the resend window rather than waiting
    // a real minute for it.
    await prisma.emailVerificationToken.updateMany({
      where: { user: { email } },
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    });

    const resend = await request(app)
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(resend.status).toBe(200);

    // Latest link wins: the first one was retired when the new one was issued.
    const stale = await request(app).post('/auth/verify-email').send({ token: firstToken });
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe('INVALID_VERIFICATION_TOKEN');

    const fresh = await request(app)
      .post('/auth/verify-email')
      .send({ token: tokenFor(email) });
    expect(fresh.status).toBe(200);

    const alreadyVerified = await request(app)
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(alreadyVerified.status).toBe(409);
    expect(alreadyVerified.body.code).toBe('EMAIL_ALREADY_VERIFIED');
  });

  it('blocks payment mutations for an unverified admin, and unblocks once verified', async () => {
    // Admins can't self-serve signup, so promote an (unverified) patient —
    // which is exactly the state ADR 0003's runbook creates today.
    const { email } = await signupPatient('admin');
    await prisma.user.update({ where: { email }, data: { role: 'admin' } });

    // A fresh login so the access token carries the new role — the token
    // from signup still says `patient`, and the role check runs before the
    // verification check.
    const login = await request(app).post('/auth/login').send({ email, password: 'longenough123' });
    const adminToken = login.body.accessToken as string;

    const blocked = await request(app).post('/payments/intents/00000000-0000-4000-8000-000000000000/fund').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');

    await request(app).post('/auth/verify-email').send({ token: tokenFor(email) });

    // Past the guard it reaches the intent lookup, which is the proof the
    // guard was what stopped it a moment ago.
    const unblocked = await request(app).post('/payments/intents/00000000-0000-4000-8000-000000000000/fund').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(unblocked.status).toBe(404);
    expect(unblocked.body.code).toBeUndefined();
  });
});
