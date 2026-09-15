// @docforum/escrow-sdk is an ESM-only package; this backend is CommonJS
// (no "type": "module" in package.json) — same CJS/ESM interop problem
// this repo already solved for `embedded-postgres` (see
// tests/integration/booking.test.mts). A static `import` here would emit
// a `require()` call, which ESM refuses (TS1479) — a dynamic `import()`
// is required instead.
type EscrowSdkModule = typeof import('@docforum/escrow-sdk', { with: { 'resolution-mode': 'import' } });

let modulePromise: Promise<EscrowSdkModule> | undefined;

export function loadEscrowSdk(): Promise<EscrowSdkModule> {
  modulePromise ??= import('@docforum/escrow-sdk');
  return modulePromise;
}
