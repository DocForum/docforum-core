import { createHash, randomBytes } from 'node:crypto';

/** The invite token that goes in the link an admin hands over. Never
 * persisted, never logged — only its hash is. */
export function generateAdminInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (not bcrypt): this is 256 bits of CSPRNG output, so there is
 * nothing to brute-force, and hashing must be cheap because it happens on
 * every redemption attempt. */
export function hashAdminInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
