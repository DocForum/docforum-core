// Unit tests for field-level encryption with key rotation (Phase 8, issue #46).
// Tests: round-trip, tamper detection, rotation, key-config validation.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// Generate deterministic test keys before importing the utility
const V1_KEY = crypto.randomBytes(32).toString('base64');
const V2_KEY = crypto.randomBytes(32).toString('base64');

describe('field-level encryption for clinical free text (issue #46)', () => {
  beforeAll(() => {
    process.env.FIELD_ENCRYPTION_KEY_V1 = V1_KEY;
    process.env.FIELD_ENCRYPTION_KEY_V2 = V2_KEY;
    process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
  });

  afterAll(() => {
    delete process.env.FIELD_ENCRYPTION_KEY_V1;
    delete process.env.FIELD_ENCRYPTION_KEY_V2;
    delete process.env.FIELD_ENCRYPTION_ACTIVE_VERSION;
  });

  let enc: typeof import('../../src/utils/field-encryption');

  beforeEach(async () => {
    enc = await import('../../src/utils/field-encryption.js');
    enc._clearKeyCache();
  });

  describe('encryptField / decryptField round-trip', () => {
    it('round-trips a consultation note', () => {
      const note = 'Patient presents with cough and mild fever. O2 sat 98%.';
      const encrypted = enc.encryptField(note);

      expect(encrypted).not.toBeNull();
      expect(encrypted).not.toBe(note);
      // Ciphertext must not contain the plaintext
      expect(encrypted).not.toContain('cough');
      expect(encrypted!.startsWith('v1:')).toBe(true);

      const decrypted = enc.decryptField(encrypted);
      expect(decrypted).toBe(note);
    });

    it('round-trips referral snapshot notes', () => {
      const snapshot = 'Referred for cardiology — chest pain, 3-day history.';
      expect(enc.decryptField(enc.encryptField(snapshot))).toBe(snapshot);
    });

    it('round-trips empty string (still encrypted — empty is not null)', () => {
      const encrypted = enc.encryptField('');
      expect(encrypted).not.toBe('');
      expect(enc.decryptField(encrypted)).toBe('');
    });

    it('round-trips unicode content', () => {
      const note = 'Paciente refiere dolor en el pecho — evaluación urgente 🩺';
      expect(enc.decryptField(enc.encryptField(note))).toBe(note);
    });

    it('passes through null and undefined unchanged (nullable columns)', () => {
      expect(enc.encryptField(null)).toBeNull();
      expect(enc.encryptField(undefined)).toBeUndefined();
      expect(enc.decryptField(null)).toBeNull();
      expect(enc.decryptField(undefined)).toBeUndefined();
    });

    it('produces different ciphertext each time (random per-record nonce)', () => {
      const note = 'Same plaintext every time';
      const a = enc.encryptField(note);
      const b = enc.encryptField(note);
      expect(a).not.toBe(b);
      expect(enc.decryptField(a)).toBe(note);
      expect(enc.decryptField(b)).toBe(note);
    });
  });

  describe('key rotation', () => {
    it('new writes use the active key version', () => {
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
      enc._clearKeyCache();
      const encrypted = enc.encryptField('note under v1');
      expect(encrypted!.startsWith('v1:')).toBe(true);
    });

    it('after rotating active version to v2, new writes use v2', () => {
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v2';
      enc._clearKeyCache();
      const encrypted = enc.encryptField('note under v2');
      expect(encrypted!.startsWith('v2:')).toBe(true);
      expect(enc.decryptField(encrypted)).toBe('note under v2');
      // restore
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
      enc._clearKeyCache();
    });

    it('data encrypted under v1 remains readable after rotation to v2', () => {
      // Encrypt under v1
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
      enc._clearKeyCache();
      const oldData = enc.encryptField('written before rotation');
      expect(oldData!.startsWith('v1:')).toBe(true);

      // Rotate: v2 becomes active
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v2';
      enc._clearKeyCache();
      const newData = enc.encryptField('written after rotation');
      expect(newData!.startsWith('v2:')).toBe(true);

      // OLD data still decrypts (version-prefixed key lookup)
      expect(enc.decryptField(oldData)).toBe('written before rotation');
      // NEW data decrypts too
      expect(enc.decryptField(newData)).toBe('written after rotation');

      // restore
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
      enc._clearKeyCache();
    });

    it('throws if a key version referenced by ciphertext is missing', () => {
      const bogus = 'v99:aGVsbG8=:aGVsbG8=:aGVsbG8=';
      expect(() => enc.decryptField(bogus)).toThrow(/FIELD_ENCRYPTION_KEY_V99/);
    });
  });

  describe('tamper detection (GCM auth tag)', () => {
    it('throws when ciphertext payload is tampered with', () => {
      const encrypted = enc.encryptField('sensitive clinical note');
      const parts = encrypted!.split(':');
      const data = Buffer.from(parts[3]!, 'base64');
      data[0] = data[0]! ^ 0xff;
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${data.toString('base64')}`;

      expect(() => enc.decryptField(tampered)).toThrow();
    });

    it('throws when auth tag is tampered with', () => {
      const encrypted = enc.encryptField('sensitive clinical note');
      const parts = encrypted!.split(':');
      const tag = Buffer.from(parts[2]!, 'base64');
      tag[0] = tag[0]! ^ 0xff;
      const tampered = `${parts[0]}:${parts[1]}:${tag.toString('base64')}:${parts[3]}`;

      expect(() => enc.decryptField(tampered)).toThrow();
    });

    it('throws when IV is tampered with', () => {
      const encrypted = enc.encryptField('sensitive clinical note');
      const parts = encrypted!.split(':');
      const iv = Buffer.from(parts[1]!, 'base64');
      iv[0] = iv[0]! ^ 0xff;
      const tampered = `${parts[0]}:${iv.toString('base64')}:${parts[2]}:${parts[3]}`;

      expect(() => enc.decryptField(tampered)).toThrow();
    });
  });

  describe('malformed input handling', () => {
    it('throws on ciphertext without the versioned envelope', () => {
      expect(() => enc.decryptField('just-plaintext-not-encrypted')).toThrow(/Malformed/);
    });

    it('throws on ciphertext with wrong number of segments', () => {
      expect(() => enc.decryptField('v1:only:three')).toThrow(/Malformed/);
    });
  });

  describe('isEncrypted', () => {
    it('returns true for a valid envelope', () => {
      const encrypted = enc.encryptField('a note');
      expect(enc.isEncrypted(encrypted)).toBe(true);
    });

    it('returns false for plaintext (legacy rows written before this feature)', () => {
      expect(enc.isEncrypted('plain clinical note')).toBe(false);
    });

    it('returns false for null/undefined/empty', () => {
      expect(enc.isEncrypted(null)).toBe(false);
      expect(enc.isEncrypted(undefined)).toBe(false);
      expect(enc.isEncrypted('')).toBe(false);
    });

    it('returns false for wrong segment count', () => {
      expect(enc.isEncrypted('v1:abc:def')).toBe(false);
    });

    it('returns false for non-version prefix', () => {
      expect(enc.isEncrypted('x1:abc:def:ghi')).toBe(false);
    });
  });

  describe('assertKeysConfigured (startup fail-fast)', () => {
    it('passes when the active key is configured', () => {
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
      enc._clearKeyCache();
      expect(() => enc.assertKeysConfigured()).not.toThrow();
    });

    it('throws when the active key is missing (production fail-fast)', () => {
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v9';
      enc._clearKeyCache();
      expect(() => enc.assertKeysConfigured()).toThrow(/FIELD_ENCRYPTION_KEY_V9/);
      // restore
      process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
      enc._clearKeyCache();
    });
  });

  describe('key configuration validation', () => {
    it('throws when a key env var is missing', () => {
      enc._clearKeyCache();
      delete process.env.FIELD_ENCRYPTION_KEY_V3;
      expect(() => enc.decryptField('v3:aGVsbG8=:aGVsbG8=:aGVsbG8=')).toThrow(
        /FIELD_ENCRYPTION_KEY_V3/,
      );
    });

    it('throws when the key is wrong length', () => {
      enc._clearKeyCache();
      process.env.FIELD_ENCRYPTION_KEY_V4 = Buffer.from('short').toString('base64');
      expect(() => enc.decryptField('v4:aGVsbG8=:aGVsbG8=:aGVsbG8=')).toThrow(/32 bytes/);
      delete process.env.FIELD_ENCRYPTION_KEY_V4;
      enc._clearKeyCache();
    });
  });
});
