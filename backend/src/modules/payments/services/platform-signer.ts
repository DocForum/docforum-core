/** Signer surface shared with docforum-escrow issue #60. XDR values cross the
 * process boundary as strings so remote signers never receive PHI or app data. */
export interface PlatformSignerOptions {
  networkPassphrase: string;
  [key: string]: unknown;
}

export interface PlatformSigner {
  publicKey(): string;
  signTransaction(xdr: string, options: PlatformSignerOptions): Promise<string>;
  signAuthEntry?(authEntryXdr: string, options: PlatformSignerOptions): Promise<string>;
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

/** Adapter for the existing SDK Keypair implementation. */
export class EnvPlatformSigner implements PlatformSigner {
  constructor(private readonly signer: PlatformSigner) {}

  publicKey(): string {
    return this.signer.publicKey();
  }

  async signTransaction(xdr: string, options: PlatformSignerOptions): Promise<string> {
    try {
      return await this.signer.signTransaction(xdr, options);
    } catch {
      throw new PlatformSignerError('Environment transaction signing failed.');
    }
  }

  async signAuthEntry(authEntryXdr: string, options: PlatformSignerOptions): Promise<string> {
    if (!this.signer.signAuthEntry) throw new PlatformSignerError('Configured signer cannot sign Soroban authorization entries.');
    try {
      return await this.signer.signAuthEntry(authEntryXdr, options);
    } catch {
      throw new PlatformSignerError('Environment authorization signing failed.');
    }
  }
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

  signTransaction(xdr: string, options: PlatformSignerOptions): Promise<string> {
    return this.callSigned('sign-transaction', { xdr, options: { ...options, networkPassphrase: this.config.networkPassphrase } });
  }

  signAuthEntry(authEntryXdr: string, options: PlatformSignerOptions): Promise<string> {
    return this.callSigned('sign-auth-entry', { authEntryXdr, options: { ...options, networkPassphrase: this.config.networkPassphrase } });
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
