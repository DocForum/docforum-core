// Unit tests for the SEP-10 server (issue #77) — no database, no network.
//
// Two groups:
//  1. Configuration validation (startup check reports var NAMES, never
//     secret values).
//  2. The structural half of the SEP-10 server verification list — the
//     cases WebAuth.readChallengeTx rejects (malformed XDR, wrong source,
//     bad sequence, bad timebounds, wrong domains, extra operations,
//     missing/wrong server signature). These fail BEFORE any DB access,
//     so they run without the embedded Postgres the integration suite
//     uses. Signature/threshold/binding/replay cases live in
//     tests/integration/sep10.test.mts.
import { describe, expect, it, vi } from 'vitest';
import { Keypair, StrKey, WebAuth } from '@stellar/stellar-sdk';
import { HttpError } from '../../src/http-error.js';
import { config } from '../../src/config/index.js';
import {
  createSep10Challenge,
  sep10ConfigProblems,
  validateSep10Config,
  verifySep10Challenge,
} from '../../src/modules/payments/services/sep10.js';

const HOME_DOMAIN = config.sep10.homeDomain!;
const WEB_AUTH_DOMAIN = config.sep10.webAuthDomain!;
const NETWORK_PASSPHRASE = config.sep10.networkPassphrase;
const SERVER_KP = Keypair.fromSecret(config.sep10.signingSecret!);
const TIMEOUT = 300;

async function expectHttpError(promise: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(status);
    expect(httpErr.code).toBe(code);
    return httpErr;
  }
  throw new Error(`expected the promise to reject with ${status} ${code}`);
}

describe('SEP-10 config validation (issue #77)', () => {
  it('passes with the test suite configuration', async () => {
    await expect(validateSep10Config()).resolves.toBeUndefined();
    await expect(sep10ConfigProblems()).resolves.toEqual([]);
  });

  it('names each missing env var, and never echoes a secret value', async () => {
    vi.resetModules();
    vi.stubEnv('SEP10_SIGNING_SECRET', '');
    vi.stubEnv('SEP10_HOME_DOMAIN', '');
    vi.stubEnv('SEP10_WEB_AUTH_DOMAIN', '');
    vi.stubEnv('SEP10_CHALLENGE_TIMEOUT_SECONDS', 'not-a-number');

    const { sep10ConfigProblems: freshProblems } = await import('../../src/modules/payments/services/sep10.js');
    const problems = await freshProblems();

    expect(problems).toContain('SEP10_SIGNING_SECRET');
    expect(problems).toContain('SEP10_HOME_DOMAIN');
    expect(problems).toContain('SEP10_WEB_AUTH_DOMAIN');
    expect(problems.join(' ')).toContain('SEP10_CHALLENGE_TIMEOUT_SECONDS');

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('flags a malformed signing secret without printing it', async () => {
    vi.resetModules();
    vi.stubEnv('SEP10_SIGNING_SECRET', 'Sdefinitelynotarealsecretkey');

    const { sep10ConfigProblems: freshProblems } = await import('../../src/modules/payments/services/sep10.js');
    const problems = await freshProblems();

    expect(problems).toContain('SEP10_SIGNING_SECRET (not a valid Stellar secret key)');
    expect(problems.join(' ')).not.toContain('Sdefinitelynotarealsecretkey');

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('SEP-10 challenge account validation', () => {
  it('rejects a G-shaped key that fails the strkey checksum', async () => {
    // Valid public key with the last character flipped — right shape,
    // wrong CRC16 checksum. Must be caught server-side (400), not at
    // wallet-signing time.
    const valid = Keypair.random().publicKey();
    const corrupted = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    expect(StrKey.isValidEd25519PublicKey(corrupted)).toBe(false);

    const err = await expectHttpError(createSep10Challenge('user-id-unused', corrupted), 400, 'SEP10_INVALID_ACCOUNT');
    expect(err.message).toContain('valid Stellar public key');
  });

  it('rejects non-G input (muxed M…, lowercase, wrong length)', async () => {
    for (const bad of ['GSHORT', 'g' + 'A'.repeat(55), Keypair.random().publicKey().toLowerCase(), 'M' + 'A'.repeat(55)]) {
      await expectHttpError(createSep10Challenge('user-id-unused', bad), 400, 'SEP10_INVALID_ACCOUNT');
    }
  });
});

describe('SEP-10 server verification list — structural checks (unit)', () => {
  const clientKp = Keypair.random();

  it('rejects garbage input that is not XDR', async () => {
    await expectHttpError(verifySep10Challenge('user-id-unused', 'not-an-xdr-string'), 400, 'SEP10_INVALID_CHALLENGE');
  });

  it('rejects a transaction whose source is not the server signing account', async () => {
    // Built and signed by an attacker-controlled "server" key: the tx
    // source is the attacker's account, so it is not our challenge.
    const attackerServerKp = Keypair.random();
    const forged = WebAuth.buildChallengeTx(
      attackerServerKp,
      clientKp.publicKey(),
      HOME_DOMAIN,
      TIMEOUT,
      NETWORK_PASSPHRASE,
      WEB_AUTH_DOMAIN,
    );
    const err = await expectHttpError(verifySep10Challenge('user-id-unused', forged), 400, 'SEP10_INVALID_CHALLENGE');
    expect(err.message).toContain('source account');
  });

  it('rejects a challenge not signed by the server (wrong/missing server signature)', async () => {
    // Correct source account, but signed by a key that is NOT the
    // configured server key — the server signature check must fail.
    const { Account, BASE_FEE, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const impostorKp = Keypair.random();
    const now = Math.floor(Date.now() / 1000);
    const forged = new TransactionBuilder(new Account(SERVER_KP.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: now, maxTime: now + TIMEOUT },
    })
      .addOperation(
        Operation.manageData({
          name: `${HOME_DOMAIN} auth`,
          value: 'a'.repeat(64),
          source: clientKp.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH_DOMAIN, source: SERVER_KP.publicKey() }))
      .build();
    forged.sign(impostorKp);

    const err = await expectHttpError(
      verifySep10Challenge('user-id-unused', forged.toEnvelope().toXDR('base64')),
      400,
      'SEP10_INVALID_CHALLENGE',
    );
    expect(err.message).toContain('signed by server');
  });

  it('rejects a non-zero sequence number', async () => {
    const { Account, BASE_FEE, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const now = Math.floor(Date.now() / 1000);
    const forged = new TransactionBuilder(new Account(SERVER_KP.publicKey(), '0'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: now, maxTime: now + TIMEOUT },
    })
      .addOperation(
        Operation.manageData({
          name: `${HOME_DOMAIN} auth`,
          value: 'a'.repeat(64),
          source: clientKp.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH_DOMAIN, source: SERVER_KP.publicKey() }))
      .build();
    forged.sign(SERVER_KP);

    const err = await expectHttpError(
      verifySep10Challenge('user-id-unused', forged.toEnvelope().toXDR('base64')),
      400,
      'SEP10_INVALID_CHALLENGE',
    );
    expect(err.message).toContain('sequence number');
  });

  it('rejects expired time bounds', async () => {
    const { Account, BASE_FEE, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const now = Math.floor(Date.now() / 1000);
    // Expired well beyond the SDK's 5-minute clock-drift grace window.
    const expired = new TransactionBuilder(new Account(SERVER_KP.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: now - 1800, maxTime: now - 1200 },
    })
      .addOperation(
        Operation.manageData({
          name: `${HOME_DOMAIN} auth`,
          value: 'a'.repeat(64),
          source: clientKp.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH_DOMAIN, source: SERVER_KP.publicKey() }))
      .build();
    expired.sign(SERVER_KP);

    const err = await expectHttpError(
      verifySep10Challenge('user-id-unused', expired.toEnvelope().toXDR('base64')),
      400,
      'SEP10_INVALID_CHALLENGE',
    );
    expect(err.message).toContain('expired');
  });

  it('rejects a challenge whose Manage Data key uses a different home domain', async () => {
    const forged = WebAuth.buildChallengeTx(
      SERVER_KP,
      clientKp.publicKey(),
      'evil.example',
      TIMEOUT,
      NETWORK_PASSPHRASE,
      WEB_AUTH_DOMAIN,
    );
    const err = await expectHttpError(verifySep10Challenge('user-id-unused', forged), 400, 'SEP10_INVALID_CHALLENGE');
    expect(err.message).toContain('home domain');
  });

  it('rejects a challenge whose web_auth_domain operation value is wrong', async () => {
    const forged = WebAuth.buildChallengeTx(
      SERVER_KP,
      clientKp.publicKey(),
      HOME_DOMAIN,
      TIMEOUT,
      NETWORK_PASSPHRASE,
      'evil.example', // web_auth_domain op will carry this, not ours
    );
    await expectHttpError(verifySep10Challenge('user-id-unused', forged), 400, 'SEP10_INVALID_CHALLENGE');
  });

  it('rejects extra operations that are not server-sourced Manage Data', async () => {
    const { Account, BASE_FEE, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const now = Math.floor(Date.now() / 1000);
    const forged = new TransactionBuilder(new Account(SERVER_KP.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: now, maxTime: now + TIMEOUT },
    })
      .addOperation(
        Operation.manageData({
          name: `${HOME_DOMAIN} auth`,
          value: 'a'.repeat(64),
          source: clientKp.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH_DOMAIN, source: SERVER_KP.publicKey() }))
      // A client-sourced extra op — a SEP-10 challenge only ever allows
      // server-sourced additional operations (plus client_domain).
      .addOperation(
        Operation.manageData({ name: 'sneaky', value: 'x', source: clientKp.publicKey() }),
      )
      .build();
    forged.sign(SERVER_KP);

    await expectHttpError(
      verifySep10Challenge('user-id-unused', forged.toEnvelope().toXDR('base64')),
      400,
      'SEP10_INVALID_CHALLENGE',
    );
  });

  it('rejects a challenge whose first operation is not Manage Data', async () => {
    const { Account, BASE_FEE, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const now = Math.floor(Date.now() / 1000);
    const forged = new TransactionBuilder(new Account(SERVER_KP.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: now, maxTime: now + TIMEOUT },
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '1', source: clientKp.publicKey() }))
      .build();
    forged.sign(SERVER_KP);

    await expectHttpError(
      verifySep10Challenge('user-id-unused', forged.toEnvelope().toXDR('base64')),
      400,
      'SEP10_INVALID_CHALLENGE',
    );
  });

  it('rejects a challenge with a nonce that is not 48-random-bytes base64', async () => {
    const { Account, BASE_FEE, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const now = Math.floor(Date.now() / 1000);
    const forged = new TransactionBuilder(new Account(SERVER_KP.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: now, maxTime: now + TIMEOUT },
    })
      .addOperation(
        Operation.manageData({
          name: `${HOME_DOMAIN} auth`,
          value: 'too-short', // not 48 bytes once base64-decoded
          source: clientKp.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH_DOMAIN, source: SERVER_KP.publicKey() }))
      .build();
    forged.sign(SERVER_KP);

    await expectHttpError(
      verifySep10Challenge('user-id-unused', forged.toEnvelope().toXDR('base64')),
      400,
      'SEP10_INVALID_CHALLENGE',
    );
  });
});
