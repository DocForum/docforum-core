// @docforum/escrow-sdk is an ESM-only package; this backend is CommonJS
// (no "type": "module" in package.json) — same CJS/ESM interop problem
// this repo already solved for `embedded-postgres` (see
// tests/integration/booking.test.mts). A static `import` here would emit
// a `require()` call, which ESM refuses (TS1479) — a dynamic `import()`
// is required instead.
// The module type is derived from the dynamic import expression rather than
// a `typeof import(..., { with: { 'resolution-mode': 'import' } })` type
// query: the expression always resolves in ESM mode (no attribute needed),
// and typescript-eslint's TS 6 checker returns an error type for the
// attribute form — an unsafe-assignment false positive (typescript-eslint#10940).
const importEscrowSdk = () => import('@docforum/escrow-sdk');

type EscrowSdkModule = Awaited<ReturnType<typeof importEscrowSdk>>;

let modulePromise: Promise<EscrowSdkModule> | undefined;

export function loadEscrowSdk(): Promise<EscrowSdkModule> {
  modulePromise ??= importEscrowSdk();
  return modulePromise;
}
