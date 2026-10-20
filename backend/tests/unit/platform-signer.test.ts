import { describe, expect, it, vi } from 'vitest';
import {
  EnvPlatformSigner,
  PlatformSignerError,
  RemotePlatformSigner,
  type PlatformSigner,
} from '../../src/modules/payments/services/platform-signer';

const signerConfig = {
  endpoint: 'https://signer.example.test',
  token: 'test-token-that-must-not-leak',
  role: 'payer' as const,
  expectedPublicKey: 'GEXPECTED',
  networkPassphrase: 'Test SDF Network ; September 2015',
  timeoutMs: 1000,
};

describe('PlatformSigner adapters', () => {
  it('delegates env signer calls through the common interface', async () => {
    const delegate: PlatformSigner = {
      publicKey: () => 'GENV',
      signTransaction: vi.fn(async (xdr) => `signed:${xdr}`),
      signAuthEntry: vi.fn(async (xdr) => `auth:${xdr}`),
    };
    const signer = new EnvPlatformSigner(delegate);
    expect(signer.publicKey()).toBe('GENV');
    await expect(signer.signTransaction('tx-xdr', { networkPassphrase: signerConfig.networkPassphrase })).resolves.toBe('signed:tx-xdr');
    await expect(signer.signAuthEntry('auth-xdr', { networkPassphrase: signerConfig.networkPassphrase })).resolves.toBe('auth:auth-xdr');
  });

  it('sanitizes env signer failures', async () => {
    const delegate: PlatformSigner = {
      publicKey: () => 'GENV',
      signTransaction: async () => { throw new Error(`key leaked ${signerConfig.token}`); },
    };
    const signer = new EnvPlatformSigner(delegate);
    const error = await signer.signTransaction('tx-xdr', { networkPassphrase: signerConfig.networkPassphrase }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformSignerError);
    expect((error as Error).message).not.toContain(signerConfig.token);
  });
  it('validates the remote public key and signs a transaction through the remote adapter', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return new Response(JSON.stringify({ publicKey: 'GEXPECTED' }), { status: 200 });
      return new Response(JSON.stringify({ signedXdr: 'signed-transaction-xdr' }), { status: 200 });
    });
    const signer = new RemotePlatformSigner(signerConfig, request as unknown as typeof fetch);
    await expect(signer.validate()).resolves.toBeUndefined();
    await expect(signer.signTransaction('unsigned-xdr', { networkPassphrase: signerConfig.networkPassphrase }))
      .resolves.toBe('signed-transaction-xdr');
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
