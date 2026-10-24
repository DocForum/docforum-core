import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/modules/auth/services/secret-crypto';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a TOTP secret', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('never returns the plaintext in the ciphertext', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    // iv.tag.ciphertext, base64 each.
    expect(encrypted.split('.')).toHaveLength(3);
  });

  it('uses a fresh IV, so the same secret encrypts differently each time', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const [iv, tag, ciphertext] = encryptSecret('JBSWY3DPEHPK3PXP').split('.');
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join('.'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptSecret('not-an-envelope')).toThrow(/malformed/);
  });
});
