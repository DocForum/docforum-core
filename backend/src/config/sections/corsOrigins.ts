const PRODUCTION_CORS_ORIGINS = ['https://docforum.github.io'];
const LOCAL_DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function parseCorsOrigins(raw: string | undefined, isProduction: boolean): string[] {
  if (!raw) return isProduction ? PRODUCTION_CORS_ORIGINS : LOCAL_DEV_CORS_ORIGINS;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

// Explicit, per-environment CORS allowlist (Phase 8, issue #37). A single
// configured origin string was one typo away from "reflect whatever origin
// asked"; an allowlist makes every permitted frontend a deliberate entry.
// `CORS_ORIGINS` (comma-separated) is the preferred form; `CORS_ORIGIN` is
// still honoured as a single-origin setting so the existing Render
// configuration (docs/adr/0003) keeps working unchanged.
export const corsOrigins = parseCorsOrigins(
  process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN,
  process.env.NODE_ENV === 'production',
);
