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

// Test seam (issue #78) — same pattern as auth's setEmailSender and the
// SEP-10 Horizon fetcher override: lets the offline integration suite
// exercise the real funding flow (guard, snapshot, status transition)
// without reaching the escrow contract on testnet. Never set outside
// tests.
export type EscrowSdkForTests = EscrowSdkModule;

export function setEscrowSdkOverride(sdk: EscrowSdkForTests): void {
  override = sdk;
}

export function resetEscrowSdkOverride(): void {
  override = undefined;
}
