// Integration tests for the SEP-10 Stellar Web Authentication server
// (issue #77) — real embedded Postgres (nonce ledger, atomic consume),
// real HTTP through the Express app, and a FAKE Horizon (no network: the
// account/signer lookup is injected via setSep10AccountFetcher, same
// service-surface seam pattern as auth's setEmailSender).
//
// What lives here (DB- or HTTP-level): the happy path, replay
// (sequential and genuinely concurrent), expiry (both the challenge's
// time bounds and an expired nonce record), multisig thresholds with
// differing weights, unfunded accounts (master-key rule), user/account
// binding, unknown nonces, and the endpoint-level auth/validation cases.
// The structural verification list (wrong source, bad sequence, wrong
// domains, extra ops, wrong server signature) is unit-tested in
// tests/unit/sep10.test.mts against the same service functions.
//
// Self-contained embedded Postgres, own port (5438) so it runs alongside
// the other integration files (5433 booking, 5435/5436/5437 others).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { Sep10AccountInfo } from '../../src/modules/payments/services/sep10.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5464;
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-sep10-pg-'));
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
type Sep10Services = typeof import('../../src/modules/payments/services/index.js');

describe('SEP-10 Stellar Web Authentication server', () => {
  let app: App;
  let prisma: Prisma;
  let sep10: Sep10Services;
  let serverKp: Keypair;
  let homeDomain: string;
  let webAuthDomain: string;
  let networkPassphrase: string;

  // Fake Horizon state: per-account overrides; anything not overridden is
  // treated as a funded account whose master key is the only signer
  // (weight 1, med threshold 1) — the plain single-signer case.
  const accountOverrides = new Map<string, Sep10AccountInfo | null>();
  function fundedSingleSigner(accountId: string) {
    return {
      accountId,
      thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
      signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }],
    };
  }

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
    sep10 = servicesModule;

    serverKp = Keypair.fromSecret(configModule.config.sep10.signingSecret!);
    homeDomain = configModule.config.sep10.homeDomain!;
    webAuthDomain = configModule.config.sep10.webAuthDomain!;
    networkPassphrase = configModule.config.sep10.networkPassphrase;

    sep10.setSep10AccountFetcher((accountId) =>
      Promise.resolve(accountOverrides.has(accountId) ? accountOverrides.get(accountId)! : fundedSingleSigner(accountId)),
    );
  });

  afterAll(async () => {
    sep10?.resetSep10AccountFetcher();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    accountOverrides.clear();
  });

  // --- helpers -----------------------------------------------------------

  async function signupVerified(label: string): Promise<{ userId: string; accessToken: string }> {
    const email = `sep10-${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: `SEP10 ${label}` });
    expect(res.status).toBe(200);
    const userId = res.body.user.id as string;
    // The route requires a verified address (issue #34 guard) — mark it
    // verified directly, same as the other payments integration suites.
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    return { userId, accessToken: res.body.accessToken as string };
  }

  function getChallenge(accessToken: string, account: string) {
    return request(app).get('/payments/sep10/challenge').set('Authorization', `Bearer ${accessToken}`).query({ account });
  }

  function postVerify(accessToken: string, transaction: string) {
    return request(app)
      .post('/payments/sep10/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ transaction });
  }

  function signChallenge(challengeXdr: string, ...keypairs: Keypair[]): string {
    const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase) as Transaction;
    for (const kp of keypairs) tx.sign(kp);
    return tx.toEnvelope().toXDR('base64').toString();
  }

  function challengeNonce(challengeXdr: string): string {
    const read = WebAuth.readChallengeTx(challengeXdr, serverKp.publicKey(), networkPassphrase, homeDomain, webAuthDomain);
    const [firstOp] = read.tx.operations;
    if (!firstOp || firstOp.type !== 'manageData') throw new Error('challenge has no leading Manage Data operation');
    return String(firstOp.value);
  }

  /** Issues a challenge over HTTP for `account` and signs it with the
   * given keypairs, returning both the raw challenge and the signed XDR. */
  async function issueAndSign(accessToken: string, account: string, ...keypairs: Keypair[]) {
    const res = await getChallenge(accessToken, account);
    expect(res.status).toBe(200);
    return { challenge: res.body.transaction as string, signed: signChallenge(res.body.transaction, ...keypairs) };
  }

  // --- challenge endpoint ------------------------------------------------

  it('issues a well-formed challenge bound to the caller and the requested account', async () => {
    const { accessToken, userId } = await signupVerified('shape');
    const clientKp = Keypair.random();

    const res = await getChallenge(accessToken, clientKp.publicKey());
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(300);
    expect(res.body.network_passphrase).toBe(networkPassphrase);

    // Structure per SEP-10: server-signed, sequence 0, bounded ~5-min
    // timebounds, Manage Data nonce sourced by the client, web_auth_domain.
    const read = WebAuth.readChallengeTx(
      res.body.transaction,
      serverKp.publicKey(),
      networkPassphrase,
      homeDomain,
      webAuthDomain,
    );
    expect(read.clientAccountID).toBe(clientKp.publicKey());
    const tx = read.tx;
    expect(Number(tx.sequence)).toBe(0);
    expect(Number(tx.timeBounds!.maxTime) - Number(tx.timeBounds!.minTime)).toBe(300);

    // The issuance ledger recorded the binding.
    const row = await prisma.sep10Challenge.findUnique({ where: { nonce: challengeNonce(res.body.transaction) } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(userId);
    expect(row!.account).toBe(clientKp.publicKey());
    expect(row!.consumedAt).toBeNull();
    expect(row!.expiresAt.getTime()).toBe(Number(tx.timeBounds!.maxTime) * 1000);
  });

  it('rejects an invalid account parameter with 400 (shape and checksum)', async () => {
    const { accessToken } = await signupVerified('bad-account');
    const rowsBefore = await prisma.sep10Challenge.count();
    const tooShort = await getChallenge(accessToken, 'GNOTAKEY');
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.message).toMatch(/valid Stellar public key/);

    // Right shape, corrupted checksum.
    const valid = Keypair.random().publicKey();
    const corrupted = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    const badChecksum = await getChallenge(accessToken, corrupted);
    expect(badChecksum.status).toBe(400);
    expect(badChecksum.body.message).toMatch(/valid Stellar public key/);

    const missing = await request(app).get('/payments/sep10/challenge').set('Authorization', `Bearer ${accessToken}`);
    expect(missing.status).toBe(400);

    // Nothing was recorded for any of them.
    expect(await prisma.sep10Challenge.count()).toBe(rowsBefore);
  });

  it('rejects unauthenticated requests to both endpoints', async () => {
    const noAuthGet = await request(app).get('/payments/sep10/challenge').query({ account: Keypair.random().publicKey() });
    expect(noAuthGet.status).toBe(401);

    const noAuthPost = await request(app).post('/payments/sep10/verify').send({ transaction: 'x' });
    expect(noAuthPost.status).toBe(401);
  });

  it('rejects an unauthenticated-email account with 403 EMAIL_NOT_VERIFIED', async () => {
    const email = `sep10-unverified-${runId}@example.com`;
    const signup = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: 'SEP10 Unverified' });
    expect(signup.status).toBe(200);
    const token = signup.body.accessToken as string;

    const res = await getChallenge(token, Keypair.random().publicKey());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  // --- happy path + single use -------------------------------------------

  it('verifies a signed challenge end-to-end and consumes the nonce', async () => {
    const { accessToken, userId } = await signupVerified('happy');
    const clientKp = Keypair.random();

    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), clientKp);

    const verify = await postVerify(accessToken, signed);
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ account: clientKp.publicKey(), signers: [clientKp.publicKey()], userId });

    const row = await prisma.sep10Challenge.findUnique({ where: { nonce: challengeNonce(signed) } });
    expect(row!.consumedAt).not.toBeNull();
  });

  it('rejects a replayed challenge', async () => {
    const { accessToken } = await signupVerified('replay');
    const clientKp = Keypair.random();
    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), clientKp);

    expect((await postVerify(accessToken, signed)).status).toBe(200);

    const replay = await postVerify(accessToken, signed);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SEP10_CHALLENGE_ALREADY_USED');
  });

  it('lets exactly ONE of several concurrent verifies succeed', async () => {
    const { accessToken } = await signupVerified('concurrent');
    const clientKp = Keypair.random();
    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), clientKp);

    // Genuinely concurrent: all in flight before any response is read.
    // The nonce is consumed by a single conditional UPDATE, so exactly one
    // request can win — the same DB-level pattern as double-booking.
    const results = await Promise.all(Array.from({ length: 8 }, () => postVerify(accessToken, signed)));

    const succeeded = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 401);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(r.body.code).toBe('SEP10_CHALLENGE_ALREADY_USED');
  });

  // --- expiry -----------------------------------------------------------

  it('rejects a challenge whose time bounds have expired', async () => {
    const { accessToken } = await signupVerified('expired-bounds');
    const clientKp = Keypair.random();

    // Build (with the real server key) a challenge that expired long ago —
    // beyond the SDK's 5-minute clock-drift grace window.
    const { Account, BASE_FEE, Operation, TransactionBuilder: TB } = await import('@stellar/stellar-sdk');
    const now = Math.floor(Date.now() / 1000);
    const expired = new TB(new Account(serverKp.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase,
      timebounds: { minTime: now - 1800, maxTime: now - 1200 },
    })
      .addOperation(
        Operation.manageData({ name: `${homeDomain} auth`, value: 'a'.repeat(64), source: clientKp.publicKey() }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: webAuthDomain, source: serverKp.publicKey() }))
      .build();
    expired.sign(serverKp);

    const res = await postVerify(accessToken, signChallenge(expired.toEnvelope().toXDR('base64'), clientKp));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SEP10_INVALID_CHALLENGE');
    expect(res.body.message).toMatch(/expired/);
  });

  it('rejects a challenge whose nonce record has expired', async () => {
    const { accessToken } = await signupVerified('expired-record');
    const clientKp = Keypair.random();
    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), clientKp);

    // The tx time bounds still allow the SDK's drift grace, but OUR
    // ledger row is past its issued expiry — the stricter check wins.
    await prisma.sep10Challenge.update({
      where: { nonce: challengeNonce(signed) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await postVerify(accessToken, signed);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SEP10_CHALLENGE_EXPIRED');
  });

  // --- signatures: wrong signer, multisig, unfunded ----------------------

  it('rejects a challenge signed by a key that is not a signer', async () => {
    const { accessToken } = await signupVerified('wrong-signer');
    const clientKp = Keypair.random();
    const attackerKp = Keypair.random();

    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), attackerKp);

    const res = await postVerify(accessToken, signed);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SEP10_INVALID_SIGNATURE');
    // The nonce was NOT burned by a failed verification.
    const row = await prisma.sep10Challenge.findUnique({ where: { nonce: challengeNonce(signed) } });
    expect(row!.consumedAt).toBeNull();
  });

  it('rejects a challenge carrying an extra unrecognized signature', async () => {
    const { accessToken } = await signupVerified('extra-sig');
    const clientKp = Keypair.random();

    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), clientKp, Keypair.random());

    const res = await postVerify(accessToken, signed);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SEP10_INVALID_SIGNATURE');
  });

  it('accepts a multisig account when signer weights meet the medium threshold', async () => {
    const { accessToken } = await signupVerified('multisig-ok');
    const clientKp = Keypair.random();
    const signer1 = Keypair.random();
    const signer2 = Keypair.random();
    // threshold 3; weights 1 + 2 — only BOTH signatures together pass.
    accountOverrides.set(clientKp.publicKey(), {
      accountId: clientKp.publicKey(),
      thresholds: { low_threshold: 0, med_threshold: 3, high_threshold: 3 },
      signers: [
        { key: clientKp.publicKey(), weight: 1, type: 'ed25519_public_key' },
        { key: signer1.publicKey(), weight: 1, type: 'ed25519_public_key' },
        { key: signer2.publicKey(), weight: 2, type: 'ed25519_public_key' },
      ],
    });

    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), signer1, signer2);

    const res = await postVerify(accessToken, signed);
    expect(res.status).toBe(200);
    expect(new Set(res.body.signers)).toEqual(new Set([signer1.publicKey(), signer2.publicKey()]));
  });

  it('rejects a multisig challenge below the threshold, including single signers of differing weights', async () => {
    const { accessToken } = await signupVerified('multisig-below');
    const clientKp = Keypair.random();
    const signer1 = Keypair.random(); // weight 1
    const signer2 = Keypair.random(); // weight 2 — still below threshold 3 alone
    accountOverrides.set(clientKp.publicKey(), {
      accountId: clientKp.publicKey(),
      thresholds: { low_threshold: 0, med_threshold: 3, high_threshold: 3 },
      signers: [
        { key: clientKp.publicKey(), weight: 1, type: 'ed25519_public_key' },
        { key: signer1.publicKey(), weight: 1, type: 'ed25519_public_key' },
        { key: signer2.publicKey(), weight: 2, type: 'ed25519_public_key' },
      ],
    });

    // The heaviest single signer (weight 2) still misses threshold 3…
    const heavyOnly = await issueAndSign(accessToken, clientKp.publicKey(), signer2);
    const heavyRes = await postVerify(accessToken, heavyOnly.signed);
    expect(heavyRes.status).toBe(401);
    expect(heavyRes.body.code).toBe('SEP10_INVALID_SIGNATURE');
    expect(heavyRes.body.message).toMatch(/threshold/);

    // …and so does the lightest one.
    const lightOnly = await issueAndSign(accessToken, clientKp.publicKey(), signer1);
    const lightRes = await postVerify(accessToken, lightOnly.signed);
    expect(lightRes.status).toBe(401);
    expect(lightRes.body.code).toBe('SEP10_INVALID_SIGNATURE');
  });

  it('accepts an UNFUNDED account only when the master key signs (SEP-10 spec)', async () => {
    const { accessToken } = await signupVerified('unfunded');
    const unfundedKp = Keypair.random();
    accountOverrides.set(unfundedKp.publicKey(), null); // Horizon 404 — not yet created

    // Spec rule: no signers/thresholds exist on-chain yet, so the master
    // key of the client account must sign the challenge.
    const { signed } = await issueAndSign(accessToken, unfundedKp.publicKey(), unfundedKp);
    const ok = await postVerify(accessToken, signed);
    expect(ok.status).toBe(200);
    expect(ok.body.signers).toEqual([unfundedKp.publicKey()]);

    // A different key standing in for an unfunded account must fail.
    const another = await issueAndSign(accessToken, unfundedKp.publicKey(), Keypair.random());
    const bad = await postVerify(accessToken, another.signed);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('SEP10_INVALID_SIGNATURE');
  });

  // --- binding and the nonce ledger --------------------------------------

  it('rejects a challenge issued to user A when user B submits it', async () => {
    const a = await signupVerified('user-a');
    const b = await signupVerified('user-b');
    const clientKp = Keypair.random();

    const { signed } = await issueAndSign(a.accessToken, clientKp.publicKey(), clientKp);
    expect((await postVerify(a.accessToken, signed)).status).toBe(200);

    // Even ignoring consumption: B can never redeem A's challenge. Reissue
    // a fresh one to demonstrate the binding, not the single-use rule.
    const fresh = await issueAndSign(a.accessToken, clientKp.publicKey(), clientKp);
    const res = await postVerify(b.accessToken, fresh.signed);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEP10_CHALLENGE_NOT_FOR_CALLER');
  });

  it('rejects a challenge whose recorded account does not match the challenge tx', async () => {
    const { accessToken } = await signupVerified('account-mismatch');
    const clientKp = Keypair.random();
    const otherKp = Keypair.random();

    const { signed } = await issueAndSign(accessToken, clientKp.publicKey(), clientKp);
    // Simulate a ledger row whose account binding no longer matches the
    // transaction's client account (e.g. tampering or a bad migration).
    await prisma.sep10Challenge.update({
      where: { nonce: challengeNonce(signed) },
      data: { account: otherKp.publicKey() },
    });

    const res = await postVerify(accessToken, signed);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEP10_CHALLENGE_NOT_FOR_CALLER');
  });

  it('rejects a structurally valid challenge that was never issued by this server', async () => {
    const { accessToken } = await signupVerified('unknown-nonce');
    const clientKp = Keypair.random();

    // Perfectly signed by the real server key — but its nonce is not in
    // our issuance ledger (nobody issued it, or the row was pruned).
    const forged = WebAuth.buildChallengeTx(serverKp, clientKp.publicKey(), homeDomain, 300, networkPassphrase, webAuthDomain);

    const res = await postVerify(accessToken, signChallenge(forged, clientKp));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SEP10_CHALLENGE_UNKNOWN');
  });

  it('rejects a tampered challenge that has extra client-sourced operations', async () => {
    const { accessToken } = await signupVerified('tampered');
    const clientKp = Keypair.random();

    const challengeRes = await getChallenge(accessToken, clientKp.publicKey());
    const challenge = challengeRes.body.transaction as string;

    // Rebuild the challenge with an added client-sourced op (invalid per
    // SEP-10: extra ops must be server-sourced Manage Data), re-signed by
    // the server key so only the structural rule can catch it.
    const { Account, BASE_FEE, Operation, TransactionBuilder: TB } = await import('@stellar/stellar-sdk');
    const original = TransactionBuilder.fromXDR(challenge, networkPassphrase) as Transaction;
    const tampered = new TB(new Account(serverKp.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase,
      timebounds: { minTime: Number(original.timeBounds!.minTime), maxTime: Number(original.timeBounds!.maxTime) },
    })
      .addOperation(
        Operation.manageData({ name: `${homeDomain} auth`, value: 'a'.repeat(64), source: clientKp.publicKey() }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: webAuthDomain, source: serverKp.publicKey() }))
      .addOperation(Operation.manageData({ name: 'sneaky', value: 'x', source: clientKp.publicKey() }))
      .build();
    tampered.sign(serverKp);

    const res = await postVerify(accessToken, signChallenge(tampered.toEnvelope().toXDR('base64'), clientKp));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SEP10_INVALID_CHALLENGE');
  });
});
