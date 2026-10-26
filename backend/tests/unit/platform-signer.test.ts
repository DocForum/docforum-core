import { describe, expect, it, vi } from 'vitest';
import {
  createEnvPlatformSigner,
  EnvPlatformSigner,
  PlatformSignerError,
  RemotePlatformSigner,
  type EnvSignerDelegate,
} from '../../src/modules/payments/services/platform-signer';

// stellar-sdk is ESM; this test file compiles as CommonJS, so load it dynamically.
const stellarSdk = () => import('@stellar/stellar-sdk');

const signerConfig = {
  endpoint: 'https://signer.example.test',
  token: 'test-token-that-must-not-leak',
  role: 'payer' as const,
  expectedPublicKey: 'GEXPECTED',
  networkPassphrase: 'Test SDF Network ; September 2015',
  timeoutMs: 1000,
};

describe('PlatformSigner adapters', () => {
  it('delegates env signer calls and returns the SEP-43 shapes', async () => {
    const delegate: EnvSignerDelegate = {
      signTransaction: vi.fn(async (xdr) => ({ signedTxXdr: `signed:${xdr}` })),
      signAuthEntry: vi.fn(async (xdr) => ({ signedAuthEntry: `auth:${xdr}` })),
    };
    const signer = new EnvPlatformSigner('GENV', delegate);
    expect(signer.publicKey()).toBe('GENV');
    await expect(signer.signTransaction('tx-xdr', { networkPassphrase: signerConfig.networkPassphrase }))
      .resolves.toEqual({ signedTxXdr: 'signed:tx-xdr', signerAddress: 'GENV' });
    await expect(signer.signAuthEntry('auth-xdr', { networkPassphrase: signerConfig.networkPassphrase }))
      .resolves.toEqual({ signedAuthEntry: 'auth:auth-xdr', signerAddress: 'GENV' });
  });

  it('sanitizes env signer failures', async () => {
    const delegate: EnvSignerDelegate = {
      signTransaction: async () => { throw new Error(`key leaked ${signerConfig.token}`); },
      signAuthEntry: async () => { throw new Error(`key leaked ${signerConfig.token}`); },
    };
    const signer = new EnvPlatformSigner('GENV', delegate);
    const error = await signer.signTransaction('tx-xdr', { networkPassphrase: signerConfig.networkPassphrase }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformSignerError);
    expect((error as Error).message).not.toContain(signerConfig.token);
  });

  it('rejects an env delegate that returns a bare string instead of { signedTxXdr }', async () => {
    const delegate = {
      signTransaction: async () => 'signed-xdr',
      signAuthEntry: async () => 'signed-auth',
    } as unknown as EnvSignerDelegate;
    const signer = new EnvPlatformSigner('GENV', delegate);
    await expect(signer.signTransaction('tx-xdr', { networkPassphrase: signerConfig.networkPassphrase }))
      .rejects.toThrow(/invalid signing response/);
    await expect(signer.signAuthEntry('auth-xdr', { networkPassphrase: signerConfig.networkPassphrase }))
      .rejects.toThrow(/invalid authorization response/);
  });

  it('signs a real transaction with a real keypair, as stellar-sdk will call it', async () => {
    const { Account, Keypair, Networks, Operation, TransactionBuilder } = await stellarSdk();
    const keypair = Keypair.random();
    const signer = await createEnvPlatformSigner(keypair, Networks.TESTNET);
    expect(signer.publicKey()).toBe(keypair.publicKey());

    const unsigned = new TransactionBuilder(new Account(keypair.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();
    // stellar-sdk's AssembledTransaction.sign() destructures `signedTxXdr` from the result.
    const { signedTxXdr, signerAddress } = await signer.signTransaction(unsigned.toXDR(), { networkPassphrase: Networks.TESTNET });
    expect(signerAddress).toBe(keypair.publicKey());

    const signed = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
    expect(keypair.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
  });

  it('signs a Soroban authorization entry with a real keypair', async () => {
    const { hash, Keypair, Networks } = await stellarSdk();
    const keypair = Keypair.random();
    const signer = await createEnvPlatformSigner(keypair, Networks.TESTNET);
    const entry = Buffer.from('authorization-preimage').toString('base64');
    const { signedAuthEntry } = await signer.signAuthEntry(entry, { networkPassphrase: Networks.TESTNET });
    expect(keypair.verify(hash(Buffer.from(entry, 'base64')), Buffer.from(signedAuthEntry, 'base64'))).toBe(true);
  });

  it('validates the remote public key and signs a transaction through the remote adapter', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return new Response(JSON.stringify({ publicKey: 'GEXPECTED' }), { status: 200 });
      return new Response(JSON.stringify({ signedXdr: 'signed-transaction-xdr' }), { status: 200 });
    });
    const signer = new RemotePlatformSigner(signerConfig, request as unknown as typeof fetch);
    await expect(signer.validate()).resolves.toBeUndefined();
    await expect(signer.signTransaction('unsigned-xdr', { networkPassphrase: signerConfig.networkPassphrase }))
      .resolves.toEqual({ signedTxXdr: 'signed-transaction-xdr', signerAddress: 'GEXPECTED' });
    expect(request).toHaveBeenNthCalledWith(2, 'https://signer.example.test/signers/payer/sign-transaction', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: `Bearer ${signerConfig.token}` }),
      body: JSON.stringify({ xdr: 'unsigned-xdr', options: { networkPassphrase: signerConfig.networkPassphrase } }),
    }));
  });

  it('rejects a remote public-key mismatch without exposing response content', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ publicKey: 'GWRONG', secret: signerConfig.token }), { status: 200 }));
    const signer = new RemotePlatformSigner(signerConfig, request as unknown as typeof fetch);
    await expect(signer.validate()).rejects.toThrow(/does not match its configured expected address/);
    const error = await signer.validate().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformSignerError);
    expect((error as Error).message).not.toContain(signerConfig.token);
  });

  it('sanitizes remote signer transport errors', async () => {
    const request = vi.fn(async () => { throw new Error(`remote echoed ${signerConfig.token}`); });
    const signer = new RemotePlatformSigner(signerConfig, request as unknown as typeof fetch);
    const error = await signer.signTransaction('unsigned-xdr', { networkPassphrase: signerConfig.networkPassphrase }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformSignerError);
    expect((error as Error).message).not.toContain(signerConfig.token);
  });
});
