import { createHash, randomBytes } from 'node:crypto';

/** The token that goes in the verification link. Only ever exists in the
 * outbound email and in the request that redeems it — never persisted. */
export function generateVerificationToken(): string {
  // 32 bytes of CSPRNG output, base64url so it survives a query string
  // untouched. Guessing one is not a realistic attack.
  return randomBytes(32).toString('base64url');
}

/** The only form of the token that touches the database (Phase 8, issue
 * #34 — a stolen database dump must not contain working verification
 * links). SHA-256, not bcrypt: this is a 256-bit random value, not a
 * low-entropy human password, so there is nothing to brute-force and no
 * need to pay bcrypt's cost on every redemption. */
export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
