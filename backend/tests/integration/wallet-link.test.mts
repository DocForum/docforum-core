// Integration tests for verified wallet links (issue #78) — real embedded
// Postgres (active-link constraint, transactions, migration backfill),
// real HTTP through the Express app, FAKE Horizon (SEP-10 signer lookup)
// and a FAKE escrow SDK (funding path) — zero network.
//
// The cutoff env var is set to a PAST date at module load, so this suite
// runs with the guard ENFORCED: legacy links must be refused, verified
// links allowed. The complementary "legacy allowed before the cutoff"
// side is unit-tested (tests/unit/wallet-link.test.ts) against the
// default grace window.
//
// Own port (5439) so it runs alongside the other integration files
// (5433 booking, 5435/5436/5437 others, 5438 sep10).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { Sep10AccountInfo } from '../../src/modules/payments/services/sep10.js';
import type { EscrowSdkForTests } from '../../src/modules/payments/services/index.js';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5463;
const runId = Date.now();
const PASSWORD = 'longenough123';
const TEST_ACTOR = { userId: null, role: null, requestId: `wallet-link-${runId}` };

// --- env BEFORE src/config loads (see login-throttle.test.mts pattern) ---
// Guard enforced NOW: past cutoff => unverified_legacy funding refused.
process.env.WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF = '2026-01-01T00:00:00Z';
// Money keys only need to parse as real keypairs; the escrow SDK itself
// is faked (setEscrowSdkOverride), so nothing signs or broadcasts.
process.env.PLATFORM_PAYER_SECRET = Keypair.random().secret();
process.env.PLATFORM_RELEASER_SECRET = Keypair.random().secret();
process.env.ESCROW_CONTRACT_ID = 'TEST_CONTRACT_ID';
process.env.ESCROW_TOKEN_ID = 'TEST_TOKEN_ID';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-wallet-link-pg-'));
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
type Services = typeof import('../../src/modules/payments/services/index.js');

describe('verified wallet links (issue #78)', () => {
  let app: App;
  let prisma: Prisma;
  let services: Services;
  let networkPassphrase: string;
  let patientNotice: string;

  // Fake Horizon (same shape as sep10.test.mts): unfunded = null.
  const accountOverrides = new Map<string, Sep10AccountInfo | null>();
  const fundedSingleSigner = (accountId: string): Sep10AccountInfo => ({
    accountId,
    thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }],
  });

  // Fake escrow SDK: records what funding asked for, returns plausible
  // values — lets us assert the payee snapshot and re-link isolation
  // without touching testnet.
  const escrowCalls: { payee?: string }[] = [];
  let releaseCalls = 0;

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
    const servicesModule = await import('../../src/modules/payments/services/index.js');
    const configModule = await import('../../src/config/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    services = servicesModule;

    networkPassphrase = configModule.config.sep10.networkPassphrase;
    patientNotice = servicesModule.PATIENT_WALLET_LINK_PRIVACY_NOTICE;

    servicesModule.setSep10AccountFetcher((accountId) =>
      Promise.resolve(accountOverrides.has(accountId) ? accountOverrides.get(accountId)! : fundedSingleSigner(accountId)),
    );

    servicesModule.setEscrowSdkOverride({
      Keypair,
      EscrowClient: class {
        async createEscrow(args: { payee: string }) {
          escrowCalls.push({ payee: args.payee });
          return { escrowId: BigInt(escrowCalls.length), txHash: `fake-tx-${escrowCalls.length}` };
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
  });

  afterAll(async () => {
    services?.resetEscrowSdkOverride();
    services?.resetSep10AccountFetcher();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    accountOverrides.clear();
  });

  // --- helpers -----------------------------------------------------------

  async function signupPatient(label: string): Promise<{ userId: string; token: string }> {
    const email = `wl-patient-${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: `WL ${label}` });
    expect(res.status).toBe(200);
    await prisma.user.update({ where: { id: res.body.user.id }, data: { emailVerifiedAt: new Date() } });
    return { userId: res.body.user.id as string, token: res.body.accessToken as string };
  }

  /** Facility accounts are admin-invited (signup rejects the role), so
   * this arranges one directly and logs in through the real login route. */
  async function createFacility(label: string): Promise<{ userId: string; facilityId: string; token: string }> {
    const email = `wl-facility-${label}-${runId}@example.com`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    const profile = await prisma.facilityProfile.create({
      data: { userId: user.id, name: `WL Facility ${label}`, type: 'lab' },
    });
    const login = await request(app).post('/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { userId: user.id, facilityId: profile.id, token: login.body.accessToken as string };
  }

  function getChallenge(token: string, account: string) {
    return request(app).get('/payments/sep10/challenge').set('Authorization', `Bearer ${token}`).query({ account });
  }

  function postLink(token: string, body: unknown) {
    return request(app).post('/payments/wallet-link').set('Authorization', `Bearer ${token}`).send(body as object);
  }

  /** Challenge + wallet sign in one step (issue #77 flow). */
  async function signedChallengeFor(token: string, ...signers: Keypair[]): Promise<string> {
    const account = signers[0]!.publicKey();
    const res = await getChallenge(token, account);
    expect(res.status).toBe(200);
    const tx = TransactionBuilder.fromXDR(res.body.transaction, networkPassphrase) as Transaction;
    for (const signer of signers) tx.sign(signer);
    return tx.toEnvelope().toXDR('base64').toString();
  }

  async function activeLinks(ownerType: 'patient' | 'facility', ownerId: string) {
    return prisma.walletLink.findMany({ where: { ownerType, ownerId, replacedAt: null } });
  }

  // --- link creation -----------------------------------------------------

  it('facility: links a verified wallet end-to-end (address derived from the challenge)', async () => {
    const facility = await createFacility('happy');
    const wallet = Keypair.random();
    const signed = await signedChallengeFor(facility.token, wallet);

    const res = await postLink(facility.token, { transaction: signed });
    expect(res.status).toBe(200);
    expect(res.body.stellarPublicKey).toBe(wallet.publicKey()); // derived, not supplied
    expect(res.body.ownerType).toBe('facility');
    expect(res.body.ownerId).toBe(facility.facilityId);
    expect(res.body.verificationMethod).toBe('sep10');
    expect(res.body.verifiedAt).toBeTruthy();
    expect(res.body.replacedAt).toBeNull();
    // Facility payout link carries no patient privacy notice.
    expect(res.body.privacyNotice).toBeUndefined();

    const row = await prisma.walletLink.findFirst({ where: { ownerId: facility.facilityId } });
    expect(row!.activeOwnerKey).toBe(`facility:${facility.facilityId}`);
  });

  it('patient: links a verified wallet and the ADR 0005 privacy notice rides in the response', async () => {
    const patient = await signupPatient('happy');
    const wallet = Keypair.random();
    const signed = await signedChallengeFor(patient.token, wallet);

    const res = await postLink(patient.token, { transaction: signed });
    expect(res.status).toBe(200);
    expect(res.body.stellarPublicKey).toBe(wallet.publicKey());
    expect(res.body.ownerType).toBe('patient');
    expect(res.body.verificationMethod).toBe('sep10');
    // Requirement 3: verbatim notice, cannot be skipped by the client.
    expect(res.body.privacyNotice).toBe(patientNotice);
    expect(res.body.privacyNotice).toContain('public forever');

    const profile = await prisma.patientProfile.findUnique({ where: { userId: patient.userId } });
    const rows = await activeLinks('patient', profile!.id);
    expect(rows).toHaveLength(1);
  });

  it('rejects a raw address in the body — the address can only come from the verified challenge', async () => {
    const patient = await signupPatient('raw');
    const address = Keypair.random().publicKey();
    const rowsBefore = await prisma.walletLink.count();

    const withAddress = await postLink(patient.token, { stellarPublicKey: address });
    expect(withAddress.status).toBe(400);

    const both = await postLink(patient.token, { transaction: 'AAAA', stellarPublicKey: address });
    expect(both.status).toBe(400);

    expect(await prisma.walletLink.count()).toBe(rowsBefore);
  });

  it('creates NO link when SEP-10 verification fails, and does not burn the nonce', async () => {
    const patient = await signupPatient('failed');
    const accountOwner = Keypair.random();
    const impostor = Keypair.random();

    // Challenge issued for accountOwner, but signed by someone else.
    const res1 = await getChallenge(patient.token, accountOwner.publicKey());
    const tx = TransactionBuilder.fromXDR(res1.body.transaction, networkPassphrase) as Transaction;
    tx.sign(impostor);
    const signed = tx.toEnvelope().toXDR('base64').toString();

    const res = await postLink(patient.token, { transaction: signed });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SEP10_INVALID_SIGNATURE');

    const profile = await prisma.patientProfile.findUnique({ where: { userId: patient.userId } });
    expect(await activeLinks('patient', profile!.id)).toHaveLength(0);

    // The failed attempt did NOT consume the challenge nonce — the row
    // is still unconsumed, so the user hasn't lost anything but a retry.
    const challengeRow = await prisma.sep10Challenge.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(challengeRow!.consumedAt).toBeNull();
  });

  it('rejects a REPLAYED signed challenge (second link attempt) without creating a second link', async () => {
    const patient = await signupPatient('replay');
    const wallet = Keypair.random();
    const signed = await signedChallengeFor(patient.token, wallet);

    expect((await postLink(patient.token, { transaction: signed })).status).toBe(200);
    const replay = await postLink(patient.token, { transaction: signed });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SEP10_CHALLENGE_ALREADY_USED');

    const profile = await prisma.patientProfile.findUnique({ where: { userId: patient.userId } });
    expect(await activeLinks('patient', profile!.id)).toHaveLength(1);
  });

  it("rejects a challenge issued to user A when user B submits it (B gets no link)", async () => {
    const a = await signupPatient('owner-a');
    const b = await signupPatient('owner-b');
    const wallet = Keypair.random();
    const signed = await signedChallengeFor(a.token, wallet);

    const res = await postLink(b.token, { transaction: signed });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEP10_CHALLENGE_NOT_FOR_CALLER');

    const bProfile = await prisma.patientProfile.findUnique({ where: { userId: b.userId } });
    expect(await activeLinks('patient', bProfile!.id)).toHaveLength(0);
  });

  it('refuses roles that cannot own a wallet link (doctor) with 403', async () => {
    const email = `wl-doctor-${runId}@example.com`;
    const signup = await request(app)
      .post('/auth/signup')
      .send({ role: 'doctor', email, password: PASSWORD, fullName: 'WL Doctor' });
    expect(signup.status).toBe(200);
    await prisma.user.update({ where: { id: signup.body.user.id }, data: { emailVerifiedAt: new Date() } });

    const res = await postLink(signup.body.accessToken, { transaction: 'AAAA' });
    expect(res.status).toBe(403);
  });

  it('enforces ONE active link per owner at the DB level, including concurrent creates', async () => {
    const facility = await createFacility('concurrent');
    const key = `facility:${facility.facilityId}`;

    // Raw DB constraint check: a second ACTIVE row for the same owner
    // violates the unique sentinel even outside the service.
    const base = {
      ownerType: 'facility' as const,
      ownerId: facility.facilityId,
      verificationMethod: 'sep10' as const,
      verifiedAt: new Date(),
    };
    await prisma.walletLink.create({ data: { ...base, stellarPublicKey: Keypair.random().publicKey(), activeOwnerKey: key } });
    await expect(
      prisma.walletLink.create({ data: { ...base, stellarPublicKey: Keypair.random().publicKey(), activeOwnerKey: key } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.walletLink.deleteMany({ where: { ownerId: facility.facilityId } });

    // CONCURRENT inserts of two active rows for the same owner (no
    // pre-existing row): the unique index must let exactly one through,
    // whichever order Postgres runs them in.
    const rawCreate = () =>
      prisma.walletLink.create({ data: { ...base, stellarPublicKey: Keypair.random().publicKey(), activeOwnerKey: key } });
    const rawResults = await Promise.allSettled([rawCreate(), rawCreate()]);
    expect(rawResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = rawResults.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe('P2002');
    expect(await activeLinks('facility', facility.facilityId)).toHaveLength(1);
    await prisma.walletLink.deleteMany({ where: { ownerId: facility.facilityId } });

    // Genuinely concurrent HTTP creates: two valid challenges, both in
    // flight before either resolves. Exactly one active link must exist
    // afterwards. (The two statuses depend on interleaving: a true
    // insert-collision yields 200+409; if the second request starts
    // after the first committed, it is a plain re-link and both get 200
    // with the first row replaced. Both serializations are legal — the
    // invariant is "never two active links".)
    const w1 = Keypair.random();
    const w2 = Keypair.random();
    const s1 = await signedChallengeFor(facility.token, w1);
    const s2 = await signedChallengeFor(facility.token, w2);
    const [r1, r2] = await Promise.all([postLink(facility.token, { transaction: s1 }), postLink(facility.token, { transaction: s2 })]);

    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect([r1.status, r2.status]).toContain(200);
    const active = await activeLinks('facility', facility.facilityId);
    expect(active).toHaveLength(1); // THE invariant
    expect([w1.publicKey(), w2.publicKey()]).toContain(active[0]!.stellarPublicKey);
  });

  // --- re-link safety + funding -----------------------------------------

  it('re-link deactivates the old link and leaves escrows funded to the old address untouched', async () => {
    const facility = await createFacility('relink');
    const patient = await signupPatient('relink');
    const patientProfile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patient.userId } });

    const addr1 = Keypair.random();
    const addr2 = Keypair.random();

    // Link v1 (verified), fund an escrow to it.
    expect((await postLink(facility.token, { transaction: await signedChallengeFor(facility.token, addr1) })).status).toBe(200);

    const order = await createOrderFixture(prisma, {
      patientProfileId: patientProfile.id,
      facilityProfileId: facility.facilityId,
      kind: 'lab_order',
      amountStroops: 500_000n,
      tag: `relink-${runId}`,
    });
    const intent = await services.createPaymentIntent({
      orderType: 'lab_order',
      orderId: order.id,
      patientProfileId: patientProfile.id,
      facilityId: facility.facilityId,
      assetCode: 'XLM',
      amount: 500_000n,
    });
    const funded = await services.fundPaymentIntent(TEST_ACTOR, intent.id);
    expect(funded.status).toBe('escrowed');
    expect(funded.fundedWalletAddress).toBe(addr1.publicKey());
    expect(escrowCalls.at(-1)!.payee).toBe(addr1.publicKey());

    // Re-link to a different address: old row is REPLACED (not mutated,
    // not deleted), new row active.
    const relink = await postLink(facility.token, { transaction: await signedChallengeFor(facility.token, addr2) });
    expect(relink.status).toBe(200);
    expect(relink.body.stellarPublicKey).toBe(addr2.publicKey());

    const all = await prisma.walletLink.findMany({ where: { ownerId: facility.facilityId }, orderBy: { createdAt: 'asc' } });
    expect(all).toHaveLength(2);
    const [oldLink, newLink] = all;
    expect(oldLink!.stellarPublicKey).toBe(addr1.publicKey()); // history preserved
    expect(oldLink!.replacedAt).not.toBeNull();
    expect(oldLink!.activeOwnerKey).toBeNull();
    expect(newLink!.stellarPublicKey).toBe(addr2.publicKey());
    expect(newLink!.replacedAt).toBeNull();
    expect(newLink!.activeOwnerKey).toBe(`facility:${facility.facilityId}`);

    // The already-funded escrow still references its own address/link —
    // re-linking did not rewrite it — and release works regardless.
    const intentAfter = await services.getPaymentIntent(intent.id);
    expect(intentAfter.fundedWalletAddress).toBe(addr1.publicKey());
    const released = await services.releasePaymentIntent(TEST_ACTOR, intent.id);
    expect(released.status).toBe('released');
    expect(releaseCalls).toBeGreaterThan(0);
  });

  it('funding refuses an UNVERIFIED legacy link after the cutoff, and funds verified links after it', async () => {
    // The suite's cutoff is in the past, so "after cutoff" is now.
    const legacy = await createFacility('legacy');
    const verified = await createFacility('verified-post-cutoff');
    const patient = await signupPatient('funding');

    // Simulate a migrated legacy link (typed-in address, never verified).
    await prisma.walletLink.create({
      data: {
        ownerType: 'facility',
        ownerId: legacy.facilityId,
        stellarPublicKey: Keypair.random().publicKey(),
        verificationMethod: 'unverified_legacy',
        activeOwnerKey: `facility:${legacy.facilityId}`,
      },
    });
    expect(services.walletLinkFundingAllowed('unverified_legacy', Date.parse('2026-01-01T00:00:00Z'), Date.now())).toBe(false);

    const patientProfile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patient.userId } });
    const legacyOrder = await createOrderFixture(prisma, {
      patientProfileId: patientProfile.id,
      facilityProfileId: legacy.facilityId,
      kind: 'lab_order',
      amountStroops: 100_000n,
      tag: `legacy-${runId}`,
    });
    const legacyIntent = await services.createPaymentIntent({
      orderType: 'lab_order',
      orderId: legacyOrder.id,
      patientProfileId: patientProfile.id,
      facilityId: legacy.facilityId,
      assetCode: 'XLM',
      amount: 100_000n,
    });
    const callsBefore = escrowCalls.length;
    await expect(services.fundPaymentIntent(TEST_ACTOR, legacyIntent.id)).rejects.toMatchObject({
      status: 409,
      code: 'WALLET_LINK_UNVERIFIED',
    });
    expect(escrowCalls.length).toBe(callsBefore); // SDK never reached
    expect((await services.getPaymentIntent(legacyIntent.id)).status).toBe('created'); // untouched

    // A SEP-10-verified link funds fine after the same cutoff.
    const wallet = Keypair.random();
    expect((await postLink(verified.token, { transaction: await signedChallengeFor(verified.token, wallet) })).status).toBe(200);
    const verifiedOrder = await createOrderFixture(prisma, {
      patientProfileId: patientProfile.id,
      facilityProfileId: verified.facilityId,
      kind: 'lab_order',
      amountStroops: 100_000n,
      tag: `verified-${runId}`,
    });
    const verifiedIntent = await services.createPaymentIntent({
      orderType: 'lab_order',
      orderId: verifiedOrder.id,
      patientProfileId: patientProfile.id,
      facilityId: verified.facilityId,
      assetCode: 'XLM',
      amount: 100_000n,
    });
    const funded = await services.fundPaymentIntent(TEST_ACTOR, verifiedIntent.id);
    expect(funded.status).toBe('escrowed');
    expect(funded.fundedWalletAddress).toBe(wallet.publicKey());
  });

  it('GET /payments/wallet-link returns the caller\'s active link and 404 when none', async () => {
    const fresh = await signupPatient('get-link');
    expect((await request(app).get('/payments/wallet-link').set('Authorization', `Bearer ${fresh.token}`)).status).toBe(404);

    const wallet = Keypair.random();
    await postLink(fresh.token, { transaction: await signedChallengeFor(fresh.token, wallet) });
    const got = await request(app).get('/payments/wallet-link').set('Authorization', `Bearer ${fresh.token}`);
    expect(got.status).toBe(200);
    expect(got.body.stellarPublicKey).toBe(wallet.publicKey());
    expect(got.body.verificationMethod).toBe('sep10');
  });

  // --- migration ---------------------------------------------------------

  it('migration: existing facility rows become active unverified_legacy links', async () => {
    // Real migration test: bring up a scratch DB at the schema JUST
    // BEFORE this migration, insert an old-shape facility link, then
    // apply only the new migration and assert the backfill.
    const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');
    const NEW_MIGRATION = '20261016153822_add_verified_wallet_links';
    const earlier = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d < NEW_MIGRATION && fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
      .sort();

    const migDbName = `docforum_migration_test_${runId}`;
    await pg.createDatabase(migDbName);
    const migUrl = `postgresql://docforum:docforum@localhost:${PORT}/${migDbName}`;

    const script = earlier.map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8')).join('\n;\n');
    execFileSync('npx', ['prisma', 'db', 'execute', '--stdin'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: migUrl },
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Old-shape row: facility-only, typed-in address.
    const { PrismaClient } = await import('@prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const migPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: migUrl }) });
    try {
      const userId = `mig-user-${runId}`;
      const profileId = `mig-facility-${runId}`;
      const oldAddress = Keypair.random().publicKey();
      await migPrisma.$executeRawUnsafe(
        'INSERT INTO "User" ("id", "email", "passwordHash", "role", "updatedAt") VALUES ($1, $2, $3, $4::"Role", now())',
        userId,
        `mig-${runId}@example.com`,
        'unused',
        'facility',
      );
      await migPrisma.$executeRawUnsafe(
        'INSERT INTO "FacilityProfile" ("id", "userId", "name", "type", "updatedAt") VALUES ($1, $2, $3, $4, now())',
        profileId,
        userId,
        'Mig Facility',
        'lab',
      );
      await migPrisma.$executeRawUnsafe(
        'INSERT INTO "WalletLink" ("id", "facilityId", "stellarPublicKey", "createdAt", "updatedAt") VALUES ($1, $2, $3, now(), now())',
        `mig-link-${runId}`,
        profileId,
        oldAddress,
      );

      // Apply ONLY the new migration.
      execFileSync('npx', ['prisma', 'db', 'execute', '--file', path.join(MIGRATIONS_DIR, NEW_MIGRATION, 'migration.sql')], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: migUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const rows = await migPrisma.walletLink.findMany({ where: { ownerId: profileId } });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.stellarPublicKey).toBe(oldAddress); // address untouched
      expect(row.ownerType).toBe('facility');
      expect(row.verificationMethod).toBe('unverified_legacy'); // never SEP-10-checked
      expect(row.verifiedAt).toBeNull();
      expect(row.replacedAt).toBeNull();
      expect(row.activeOwnerKey).toBe(`facility:${profileId}`); // still the active link

      // And the backfilled link participates in the new world: it can
      // be replaced, and it can only be replaced once.
      await migPrisma.walletLink.create({
        data: {
          ownerType: 'facility',
          ownerId: profileId,
          stellarPublicKey: Keypair.random().publicKey(),
          verificationMethod: 'sep10',
          verifiedAt: new Date(),
          activeOwnerKey: `facility:${profileId}`,
        },
      }).then(
        () => {
          throw new Error('second active link should have been rejected');
        },
        (err: { code?: string }) => expect(err.code).toBe('P2002'),
      );
      // Deactivate-then-insert is the legal path:
      await migPrisma.walletLink.updateMany({
        where: { ownerId: profileId, replacedAt: null },
        data: { replacedAt: new Date(), activeOwnerKey: null },
      });
      const promoted = await migPrisma.walletLink.create({
        data: {
          ownerType: 'facility',
          ownerId: profileId,
          stellarPublicKey: Keypair.random().publicKey(),
          verificationMethod: 'sep10',
          verifiedAt: new Date(),
          activeOwnerKey: `facility:${profileId}`,
        },
      });
      expect(promoted.verificationMethod).toBe('sep10');
    } finally {
      await migPrisma.$disconnect();
    }
  }, 60_000);
});
