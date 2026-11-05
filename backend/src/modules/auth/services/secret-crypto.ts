// Envelope encryption for the stored TOTP secret (Phase 8 #36 requires the
// secret be encrypted at rest).
//
// AES-256-GCM with a key derived from TOTP_ENCRYPTION_KEY. Format is
// `iv.tag.ciphertext`, all base64 — self-describing so re-keying or
// rotating the scheme later is a data migration, not a guessing game.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';

const IV_BYTES = 12; // GCM standard nonce length
const ALGORITHM = 'aes-256-gcm';

function encryptionKey(): Buffer {
  const configured = config.twoFactor.encryptionKey;
  if (!configured) {
    // Fails loudly and by name rather than silently storing a plaintext
    // secret — the whole point of this file.
    throw new HttpError(
      500,
      'Two-factor authentication is not configured on this server (missing TOTP_ENCRYPTION_KEY).',
    );
  }
  return createHash('sha256').update(configured).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(encrypted: string): string {
  const [ivPart, tagPart, ciphertextPart] = encrypted.split('.');
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new HttpError(500, 'Stored two-factor secret is malformed.');
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64')), decipher.final()]).toString('utf8');
}
