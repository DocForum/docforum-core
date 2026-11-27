import { describe, expect, it } from 'vitest';
import { signAttachmentToken, verifyAttachmentToken } from '../../src/modules/consultations/signed-url';

describe('consultation attachment signed URLs', () => {
  const id = '5f3f2f7e-8a03-4b3b-9d2e-1a2b3c4d5e6f';

  it('accepts a token it minted before expiry', () => {
    const expires = Date.now() + 60_000;
    expect(verifyAttachmentToken(id, expires, signAttachmentToken(id, expires))).toBe(true);
  });

  it('rejects an expired token even when the signature is genuine', () => {
    const expires = Date.now() - 1;
    expect(verifyAttachmentToken(id, expires, signAttachmentToken(id, expires))).toBe(false);
  });

  it('rejects a token minted for another attachment', () => {
    const expires = Date.now() + 60_000;
    const signature = signAttachmentToken(id, expires);
    expect(verifyAttachmentToken('00000000-0000-0000-0000-000000000000', expires, signature)).toBe(false);
  });

  it('rejects a tampered expiry or signature', () => {
    const expires = Date.now() + 60_000;
    const signature = signAttachmentToken(id, expires);
    const tampered = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyAttachmentToken(id, expires + 60_000, signature)).toBe(false);
    expect(verifyAttachmentToken(id, expires, tampered)).toBe(false);
    expect(verifyAttachmentToken(id, expires, '')).toBe(false);
  });
});
