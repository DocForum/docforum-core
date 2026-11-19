/** A strictly positive number from an env var, else the default. A typo like
 * `REFERRAL_PENDING_TTL_DAYS=0` must not silently expire every referral. */
export function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
