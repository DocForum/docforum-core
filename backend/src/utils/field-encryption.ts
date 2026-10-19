// Field-level encryption for clinical free text (Phase 8, issue #46).
//
// Envelope encryption: AES-256-GCM with a per-record random nonce (IV)
// and a versioned key-id prefix, so key rotation is possible without
// rewriting every row at once.
//
// Ciphertext format (stored in a TEXT column):
//   v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
//
// The version prefix is the key id — decryptField() looks up the matching
// key version. New writes always use the active key version; old rows
// stay readable after a rotation because their prefix points at their
// original key.
//
// Keys are loaded from env:
//   FIELD_ENCRYPTION_KEY_V1=<base64 32 bytes>   (per version)
//   FIELD_ENCRYPTION_ACTIVE_VERSION=v1          (which version new writes use)
//
// Startup fails fast when the ACTIVE key is missing in production
// (see assertKeysConfigured()); tests use a deterministic dev key via
// the test setup, and local dev can call scripts/gen-field-key.mjs.
//
// Constraint (documented in ARCHITECTURE.md §4): encrypted fields cannot
// be searched or indexed — they're write-once/read-decrypt blobs.

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // standard GCM nonce length
const KEY_BYTES = 32; // AES-256

/** Known key versions → raw key bytes. Populated lazily from env. */
const keyCache = new Map<string, Buffer>();

function getActiveVersion(): string {
  return process.env.FIELD_ENCRYPTION_ACTIVE_VERSION ?? 'v1';
}

/**
 * Returns the raw key for a given version, loading it from the
 * corresponding env var on first use. Env var name pattern:
 *   FIELD_ENCRYPTION_KEY_V1=base64-32-bytes
 * Throws if the key for the requested version is missing or malformed.
 */
function getKey(version: string): Buffer {
  const cached = keyCache.get(version);
  if (cached) return cached;

  const envName = `FIELD_ENCRYPTION_KEY_${version.toUpperCase()}`;
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `Field encryption key for version "${version}" is not configured (missing env var ${envName}).`,
    );
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`Field encryption key ${envName} is not valid base64.`);
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `Field encryption key ${envName} must decode to ${KEY_BYTES} bytes, got ${buf.length}.`,
    );
  }

  keyCache.set(version, buf);
  return buf;
}

/**
 * Encrypts a plaintext clinical field. Returns a prefixed, versioned
 * ciphertext string safe to store in a TEXT column.
 * A null/undefined input passes through unchanged (nullable columns stay
 * nullable — encryption applies to present values only).
 */
export function encryptField(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined) return plaintext;

  const version = getActiveVersion();
  const key = getKey(version);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${version}:${iv.toString('base64')}:${authTag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypts a ciphertext produced by encryptField. Handles any known key
 * version, so data encrypted before a rotation remains readable.
 * A null/undefined input passes through unchanged.
 * Throws if the ciphertext is malformed or fails authentication (wrong
 * key or tampered data — GCM's auth tag check).
 */
export function decryptField(ciphertext: string | null | undefined): string | null | undefined {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;

  const parts = ciphertext.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed field-encryption ciphertext (expected v:iv:tag:data).');
  }
  const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const key = getKey(version);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Returns true if the value looks like an encrypted field (has our
 * versioned envelope). Useful for deciding whether a stored value needs
 * re-encryption during a key rotation pass, and for tolerating legacy
 * plaintext values written before this feature existed.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  const firstColon = value.indexOf(':');
  if (firstColon < 0) return false;
  const version = value.slice(0, firstColon);
  return /^v\d+$/.test(version) && value.split(':').length === 4;
}

/**
 * Startup guard: throws if the ACTIVE key is not configured.
 * Call this in server.ts at boot so production fails fast rather than
 * encrypting with an undefined key at first write.
 *
 * In test/dev, callers may skip this (tests set a deterministic key in
 * their setup). Returns void on success.
 */
export function assertKeysConfigured(): void {
  const version = getActiveVersion();
  getKey(version); // throws if missing/malformed
}

/** Test-only: clears the key cache so env changes are picked up. */
export function _clearKeyCache(): void {
  keyCache.clear();
}
