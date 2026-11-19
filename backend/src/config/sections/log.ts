// Structured logging (Phase 9). Level is configurable per environment;
// tests run quiet by default so captured output stays readable.
export const log = {
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === 'test' ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // Header carrying the request id; accepted from the client or generated.
  requestIdHeader: 'x-request-id',
} as const;
