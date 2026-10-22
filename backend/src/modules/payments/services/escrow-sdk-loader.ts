// @docforum/escrow-sdk is an ESM-only package; this backend is CommonJS
// (no "type": "module" in package.json) — same CJS/ESM interop problem
// this repo already solved for `embedded-postgres` (see
// tests/integration/booking.test.mts). A static `import` here would emit
// a `require()` call, which ESM refuses (TS1479) — a dynamic `import()`
// is required instead.
type EscrowSdkModule = typeof import('@docforum/escrow-sdk', { with: { 'resolution-mode': 'import' } });

let modulePromise: Promise<EscrowSdkModule> | undefined;
let override: EscrowSdkModule | undefined;

export function loadEscrowSdk(): Promise<EscrowSdkModule> {
  if (override) return Promise.resolve(override);
  modulePromise ??= import('@docforum/escrow-sdk');
  return modulePromise;
}

/** Test seam (issue #43): integration tests that exercise the DB side of
 * fund/release/refund substitute a fake SDK instead of calling testnet.
 * `undefined` restores the real one. Never called by application code. */
export function setEscrowSdkForTests(sdk: EscrowSdkModule | undefined): void {
  override = sdk;
  modulePromise = sdk ? Promise.resolve(sdk) : undefined;
}

export type EscrowSdkForTests = EscrowSdkModule;

export function setEscrowSdkOverride(sdk: EscrowSdkForTests): void {
  setEscrowSdkForTests(sdk);
}

export function resetEscrowSdkOverride(): void {
  setEscrowSdkForTests(undefined);
}

export type EscrowSdkKeypair = InstanceType<EscrowSdkModule['Keypair']>;
export type { EscrowSdkModule };
