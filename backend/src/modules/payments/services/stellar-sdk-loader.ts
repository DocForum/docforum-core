// @stellar/stellar-sdk (v16) ships both CJS and ESM builds, but its
// package `types` resolve as ECMAScript-module declarations — a static
// import in this CommonJS backend trips TS1479/TS1541 under `module:
// node16`. A dynamic `import()` is required instead, exactly like the
// existing escrow-sdk-loader.ts (ESM-only @docforum/escrow-sdk) and the
// embedded-postgres interop. One cached module promise per process.
type StellarSdkModule = typeof import('@stellar/stellar-sdk', { with: { 'resolution-mode': 'import' } });

let modulePromise: Promise<StellarSdkModule> | undefined;

export function loadStellarSdk(): Promise<StellarSdkModule> {
  modulePromise ??= import('@stellar/stellar-sdk');
  return modulePromise;
}
