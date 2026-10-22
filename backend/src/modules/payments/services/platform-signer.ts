/** Signer surface shared with docforum-escrow issue #60. XDR values cross the
 * process boundary as strings so remote signers never receive PHI or app data. */
export interface PlatformSignerOptions {
  networkPassphrase: string;
  [key: string]: unknown;
}

/** SEP-43 result shapes. @stellar/stellar-sdk's contract client reads
 * `signedTxXdr` back from whatever signer it is given. */
export interface SignedTransaction {
  signedTxXdr: string;
  signerAddress?: string;
}

export interface SignedAuthEntry {
  signedAuthEntry: string;
  signerAddress?: string;
}

export interface PlatformSigner {
  publicKey(): string;
  signTransaction(xdr: string, options: PlatformSignerOptions): Promise<SignedTransaction>;
  signAuthEntry?(authEntryXdr: string, options: PlatformSignerOptions): Promise<SignedAuthEntry>;
}

/** What `contract.basicNodeSigner(keypair, networkPassphrase)` returns. */
export interface EnvSignerDelegate {
  signTransaction(xdr: string, options?: PlatformSignerOptions): Promise<SignedTransaction>;
  signAuthEntry(authEntryXdr: string, options?: PlatformSignerOptions): Promise<SignedAuthEntry>;
}

export type PlatformSignerRole = 'payer' | 'releaser';

export interface RemoteSignerConfig {
  endpoint: string;
  token: string;
  role: PlatformSignerRole;
  expectedPublicKey: string;
  networkPassphrase: string;
  timeoutMs: number;
}

export class PlatformSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformSignerError';
  }
}

/** Adapter for a local keypair, wrapped with stellar-sdk's `basicNodeSigner`.
 * A bare Keypair has no `signTransaction`, so it can't be the delegate. */
export class EnvPlatformSigner implements PlatformSigner {
  constructor(private readonly accountId: string, private readonly signer: EnvSignerDelegate) {}

  publicKey(): string {
    return this.accountId;
  }

  async signTransaction(xdr: string, options: PlatformSignerOptions): Promise<SignedTransaction> {
    let result: SignedTransaction;
    try {
      result = await this.signer.signTransaction(xdr, options);
    } catch {
      throw new PlatformSignerError('Environment transaction signing failed.');
    }
    if (typeof result?.signedTxXdr !== 'string' || result.signedTxXdr.length === 0) {
      throw new PlatformSignerError('Environment signer returned an invalid signing response.');
    }
    return { signedTxXdr: result.signedTxXdr, signerAddress: this.accountId };
  }

  async signAuthEntry(authEntryXdr: string, options: PlatformSignerOptions): Promise<SignedAuthEntry> {
    let result: SignedAuthEntry;
    try {
      result = await this.signer.signAuthEntry(authEntryXdr, options);
    } catch {
      throw new PlatformSignerError('Environment authorization signing failed.');
    }
    if (typeof result?.signedAuthEntry !== 'string' || result.signedAuthEntry.length === 0) {
      throw new PlatformSignerError('Environment signer returned an invalid authorization response.');
    }
    return { signedAuthEntry: result.signedAuthEntry, signerAddress: this.accountId };
  }
}

// stellar-sdk is ESM-only in practice on Node 20 (its CJS build requires an
// ESM dependency), so it is loaded with a dynamic import, like the escrow SDK.
type StellarSdkModule = typeof import('@stellar/stellar-sdk', { with: { 'resolution-mode': 'import' } });
type StellarKeypair = InstanceType<StellarSdkModule['Keypair']>;
let stellarSdkPromise: Promise<StellarSdkModule> | undefined;
function loadStellarSdk(): Promise<StellarSdkModule> {
  stellarSdkPromise ??= import('@stellar/stellar-sdk');
  return stellarSdkPromise;
}

/** Builds an env-mode signer from a keypair. stellar-sdk's `basicNodeSigner`
 * does the signing and returns the SEP-43 shapes. The keypair comes from the
 * escrow SDK loader, so tests that fake the SDK also fake the keypair. */
export async function createEnvPlatformSigner(keypair: StellarKeypair, networkPassphrase: string): Promise<EnvPlatformSigner> {
  const { contract } = await loadStellarSdk();
  return new EnvPlatformSigner(keypair.publicKey(), contract.basicNodeSigner(keypair, networkPassphrase));
}

/** HTTP reference adapter. The service must implement the documented JSON
 * endpoints; all failures are sanitized so response bodies/tokens cannot leak. */
export class RemotePlatformSigner implements PlatformSigner {
  constructor(private readonly config: RemoteSignerConfig, private readonly request: typeof fetch = fetch) {
    try {
      const endpoint = new URL(config.endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new PlatformSignerError('Remote signer endpoint must be a clean HTTPS URL.');
      }
    } catch (error) {
      if (error instanceof PlatformSignerError) throw error;
      throw new PlatformSignerError('Remote signer endpoint must be a valid HTTPS URL.');
    }
  }

  publicKey(): string {
    return this.config.expectedPublicKey;
  }

  async validate(): Promise<void> {
    const result = await this.call<{ publicKey: string }>('GET', 'public-key');
    if (result.publicKey !== this.config.expectedPublicKey) {
      throw new PlatformSignerError(`Remote ${this.config.role} signer public key does not match its configured expected address.`);
    }
  }

  async signTransaction(xdr: string, options: PlatformSignerOptions): Promise<SignedTransaction> {
    const signedTxXdr = await this.callSigned('sign-transaction', { xdr, options: { ...options, networkPassphrase: this.config.networkPassphrase } });
    return { signedTxXdr, signerAddress: this.config.expectedPublicKey };
  }

  async signAuthEntry(authEntryXdr: string, options: PlatformSignerOptions): Promise<SignedAuthEntry> {
    const signedAuthEntry = await this.callSigned('sign-auth-entry', { authEntryXdr, options: { ...options, networkPassphrase: this.config.networkPassphrase } });
    return { signedAuthEntry, signerAddress: this.config.expectedPublicKey };
  }

  private async callSigned(path: string, payload: Record<string, unknown>): Promise<string> {
    const result = await this.call<Record<string, unknown>>('POST', path, payload);
    const signature = result.signedXdr ?? result.signedAuthEntryXdr;
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new PlatformSignerError(`Remote ${this.config.role} signer returned an invalid signing response.`);
    }
    return signature;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>): Promise<T> {
    const base = this.config.endpoint.replace(/\/$/, '');
    const url = `${base}/signers/${this.config.role}/${path}`;
    try {
      const response = await this.request(url, {
        method,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) throw new PlatformSignerError(`Remote ${this.config.role} signer request failed (HTTP ${response.status}).`);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof PlatformSignerError) throw error;
      throw new PlatformSignerError(`Remote ${this.config.role} signer request failed.`);
    }
  }
}
