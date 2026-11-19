import { requireEnv } from '../helpers';

export interface JwtSigningKey {
  /** Key id written into the token header so verification picks the right secret. */
  kid: string;
  secret: string;
}

/**
 * Build the signing keyring for one token type. The first entry is the
 * current key (new tokens are signed with it). An optional `_PREVIOUS` secret
 * stays in the keyring during a rotation overlap, so tokens minted before the
 * rotation keep verifying until they expire. Remove `_PREVIOUS` once the
 * overlap window (the token TTL) has passed. See docs/runbooks/secret-rotation.md.
 */
function jwtSigningKeys(prefix: 'ACCESS' | 'REFRESH'): JwtSigningKey[] {
  const keys: JwtSigningKey[] = [
    {
      kid: process.env[`JWT_${prefix}_KID`] || `${prefix.toLowerCase()}-current`,
      secret: requireEnv(`JWT_${prefix}_SECRET`),
    },
  ];
  const previous = process.env[`JWT_${prefix}_SECRET_PREVIOUS`];
  if (previous) {
    keys.push({
      kid: process.env[`JWT_${prefix}_KID_PREVIOUS`] || `${prefix.toLowerCase()}-previous`,
      secret: previous,
    });
  }
  return keys;
}

const accessKeys = jwtSigningKeys('ACCESS');
const refreshKeys = jwtSigningKeys('REFRESH');

export const jwt = {
  accessSecret: accessKeys[0].secret,
  refreshSecret: refreshKeys[0].secret,
  accessKeys,
  refreshKeys,
  // Short-lived access token; refresh token is the long-lived one.
  // No revocation list yet for either — see ARCHITECTURE_ESSENTIALS.md
  // "Known unresolved design gaps" (JWT refresh rotation without a
  // revocation list). A stolen refresh token has no clean kill switch
  // until that's built (Phase 8).
  accessTtl: '15m',
  refreshTtl: '30d',
} as const;
