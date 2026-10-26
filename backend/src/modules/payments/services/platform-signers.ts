import { config } from '../../../config';
import { loadEscrowSdk } from './escrow-sdk-loader';
import {
  createEnvPlatformSigner,
  PlatformSignerError,
  RemotePlatformSigner,
  type PlatformSigner,
  type PlatformSignerRole,
} from './platform-signer';

export { createEnvPlatformSigner, EnvPlatformSigner, PlatformSignerError, RemotePlatformSigner } from './platform-signer';
export type { PlatformSigner, PlatformSignerRole } from './platform-signer';

export interface PlatformSigners {
  payer: PlatformSigner;
  releaser: PlatformSigner;
}

let signersPromise: Promise<PlatformSigners> | undefined;

function expectedPublicKey(role: PlatformSignerRole): string | undefined {
  return role === 'payer' ? config.payments.platformPayerPublicKey : config.payments.platformReleaserPublicKey;
}

async function createSigners(): Promise<PlatformSigners> {
  const { platformSignerMode, platformSignerUrl, platformSignerToken, platformSignerTimeoutMs, networkPassphrase } = config.payments;
  if (!Number.isSafeInteger(platformSignerTimeoutMs) || platformSignerTimeoutMs < 1) {
    throw new PlatformSignerError('PLATFORM_SIGNER_TIMEOUT_MS must be a positive integer.');
  }

  if (platformSignerMode === 'remote') {
    if (!platformSignerUrl || !platformSignerToken) {
      throw new PlatformSignerError('Remote signer mode requires PLATFORM_SIGNER_URL and PLATFORM_SIGNER_TOKEN.');
    }
    const payerKey = expectedPublicKey('payer');
    const releaserKey = expectedPublicKey('releaser');
    if (!payerKey || !releaserKey) {
      throw new PlatformSignerError('Remote signer mode requires configured payer and releaser public keys.');
    }
    const payer = new RemotePlatformSigner({ endpoint: platformSignerUrl, token: platformSignerToken, role: 'payer', expectedPublicKey: payerKey, networkPassphrase, timeoutMs: platformSignerTimeoutMs });
    const releaser = new RemotePlatformSigner({ endpoint: platformSignerUrl, token: platformSignerToken, role: 'releaser', expectedPublicKey: releaserKey, networkPassphrase, timeoutMs: platformSignerTimeoutMs });
    await Promise.all([payer.validate(), releaser.validate()]);
    return { payer, releaser };
  }

  if (platformSignerMode !== 'env') throw new PlatformSignerError('PLATFORM_SIGNER_MODE must be env or remote.');
  const { Keypair } = await loadEscrowSdk();
  const payerSecret = config.payments.platformPayerSecret;
  const releaserSecret = config.payments.platformReleaserSecret;
  if (!payerSecret || !releaserSecret) {
    throw new PlatformSignerError('Environment signer mode requires PLATFORM_PAYER_SECRET and PLATFORM_RELEASER_SECRET.');
  }

  try {
    const payer = await createEnvPlatformSigner(Keypair.fromSecret(payerSecret), networkPassphrase);
    const releaser = await createEnvPlatformSigner(Keypair.fromSecret(releaserSecret), networkPassphrase);
    for (const [role, signer] of [['payer', payer], ['releaser', releaser]] as const) {
      const expected = expectedPublicKey(role);
      if (expected && signer.publicKey() !== expected) {
        throw new PlatformSignerError(`Configured ${role} signer public key does not match its expected address.`);
      }
      if (!expected && process.env.NODE_ENV !== 'test') {
        throw new PlatformSignerError(`PLATFORM_${role.toUpperCase()}_PUBLIC_KEY is required when environment signers are configured.`);
      }
    }
    return { payer, releaser };
  } catch (error) {
    if (error instanceof PlatformSignerError) throw error;
    throw new PlatformSignerError('Environment platform signer initialization failed. Check signer configuration.');
  }
}

export function getPlatformSigners(): Promise<PlatformSigners> {
  signersPromise ??= createSigners().catch((error: unknown) => {
    signersPromise = undefined;
    throw error;
  });
  return signersPromise;
}

/** Validate active signer addresses during startup, before payments are served. */
export async function validatePlatformSigners(): Promise<void> {
  const configured = config.payments.platformSignerMode !== 'env'
    || Boolean(config.payments.platformPayerSecret || config.payments.platformReleaserSecret);
  if (configured) await getPlatformSigners();
}

export function resetPlatformSignersForTests(): void {
  signersPromise = undefined;
}
