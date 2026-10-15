// Shared across modules — the one place an HTTP-status-bearing error is
// defined, so error-handler.ts has a single shape to check for.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // Optional machine-readable discriminator, for cases where the client
    // has to branch on *why* rather than render the message (e.g.
    // `EMAIL_NOT_VERIFIED` — Phase 8 issue #34). Additive: the error
    // envelope keeps its existing `message` field, so docforum-web's
    // api-client parsing is unaffected.
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
