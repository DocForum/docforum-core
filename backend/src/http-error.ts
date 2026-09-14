// Shared across modules — the one place an HTTP-status-bearing error is
// defined, so error-handler.ts has a single shape to check for.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
