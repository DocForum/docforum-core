// Structured JSON logging (Phase 9 — issue #30, PR #189).
//
// One `pino` logger for the process; request paths get a child logger
// carrying the request id (see middleware/request-id.ts). Log level is
// per-environment via `config.log.level` (`LOG_LEVEL` wins; `silent` under
// NODE_ENV=test so captured output stays readable; `info` in production).
//
// Redaction is configured once, here, and applies to every line the
// process emits: auth headers, cookies, passwords, tokens, and the PHI
// field paths this platform actually holds (PRD §7 — patient intake and
// clinical free text must never reach a log line). Censor is the literal
// `[REDACTED]` so a drain can tell a redacted field from an absent one.
import pino from 'pino';
import { config } from './config';

/** Redaction paths (pino `redact.paths` syntax). Top-level keys are listed
 * bare and again with a `*.key` wildcard so a sensitive field is censored
 * at any nesting depth, not only at the root. Keep in sync with the PHI
 * field names in ARCHITECTURE.md §4 — a new clinical free-text column
 * belongs here. */
export const REDACT_PATHS = [
  // Credentials.
  'password', '*.password',
  'passwordHash', '*.passwordHash',
  'token', '*.token',
  'accessToken', '*.accessToken',
  'refreshToken', '*.refreshToken',
  'csrfToken', '*.csrfToken',
  // Request credentials as headers (pino redacts exact paths, so these
  // are spelled out rather than wildcarded).
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  // PHI field paths (PRD §7).
  'intakeNotes', '*.intakeNotes',
  'symptoms', '*.symptoms',
  'diagnosis', '*.diagnosis',
  'allergies', '*.allergies',
  'medications', '*.medications',
  'dateOfBirth', '*.dateOfBirth',
  'ssn', '*.ssn',
];

const MAX_SERIALISER_DEPTH = 8;

/** Deep-copies a value, converting every BigInt to its decimal string.
 * Payment amounts are raw stroops (BigInt), and a bare JSON.stringify of
 * one throws — which would take a log line (and in a request path, the
 * response) down with it. */
function stringifyBigInts(value: unknown, depth = 0): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_SERIALISER_DEPTH) return value;
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stringifyBigInts(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = stringifyBigInts(entry, depth + 1);
  }
  return out;
}

/** Serialisers for the keys that can legitimately carry BigInt values.
 * pino applies a serialiser wherever the key appears, at any depth. */
export const bigIntSerialiser = {
  amount: stringifyBigInts,
  amountStroops: stringifyBigInts,
  totalStroops: stringifyBigInts,
  stroops: stringifyBigInts,
};

export const loggerOptions: pino.LoggerOptions = {
  level: config.log.level,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  serializers: bigIntSerialiser,
};

/** The process-wide logger. Non-request code (jobs, startup) logs through
 * this; request code gets a child via `requestLogger`. */
export const logger = pino(loggerOptions);

/** Request-scoped child logger: every line it emits carries the request id
 * that `X-Request-Id` responses and `AuditEvent` rows also carry, so one
 * id correlates an HTTP request, its logs and its audit trail. */
export function requestLogger(bindings: { requestId: string }): pino.Logger {
  return logger.child({ requestId: bindings.requestId });
}
