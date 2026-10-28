import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { sep10ChallengeQuerySchema, stellarPublicKeySchema } from '../../src/modules/payments/validation.js';

describe('Stellar public key validation (issue #26)', () => {
  const validKeys = [
    'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    Keypair.random().publicKey(),
    Keypair.random().publicKey(),
  ];

  describe('valid Stellar public keys', () => {
    it.each(validKeys)('accepts valid public key %s via stellarPublicKeySchema', (key) => {
      const result = stellarPublicKeySchema.safeParse(key);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(key);
      }
    });

    it.each(validKeys)('accepts valid public key %s via sep10ChallengeQuerySchema', (key) => {
      const result = sep10ChallengeQuerySchema.safeParse({ account: key });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.account).toBe(key);
      }
    });
  });

  describe('keys with a wrong checksum (valid length/prefix, but invalid CRC)', () => {
    it('rejects keys where the last character is altered (old regex would pass, but CRC fails)', () => {
      for (const valid of validKeys) {
        // Corrupt the last character using a valid base32 character (A-Z, 2-7)
        const lastChar = valid.slice(-1);
        const replacement = lastChar === 'A' ? 'B' : 'A';
        const corrupted = valid.slice(0, -1) + replacement;

        // Verify this corrupted key would have passed the old regex: /^G[A-Z2-7]{55}$/
        expect(/^G[A-Z2-7]{55}$/.test(corrupted)).toBe(true);

        // stellarPublicKeySchema must reject it
        const directResult = stellarPublicKeySchema.safeParse(corrupted);
        expect(directResult.success).toBe(false);
        if (!directResult.success) {
          expect(directResult.error.issues[0]?.message).toBe(
            'account must be a valid Stellar public key (starts with G, 56 chars).',
          );
        }

        // sep10ChallengeQuerySchema must reject it
        const queryResult = sep10ChallengeQuerySchema.safeParse({ account: corrupted });
        expect(queryResult.success).toBe(false);
        if (!queryResult.success) {
          expect(queryResult.error.issues[0]?.message).toBe(
            'account must be a valid Stellar public key (starts with G, 56 chars).',
          );
        }
      }
    });

    it('rejects all-A body and checksum (valid format for regex, invalid CRC)', () => {
      const allA = 'G' + 'A'.repeat(55);
      expect(/^G[A-Z2-7]{55}$/.test(allA)).toBe(true);

      const result = sep10ChallengeQuerySchema.safeParse({ account: allA });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          'account must be a valid Stellar public key (starts with G, 56 chars).',
        );
      }
    });
  });

  describe('keys with wrong prefixes', () => {
    it('rejects Stellar secret seed keys starting with S', () => {
      const secret = Keypair.random().secret();
      expect(secret.startsWith('S')).toBe(true);

      const result = sep10ChallengeQuerySchema.safeParse({ account: secret });
      expect(result.success).toBe(false);
    });

    it('rejects keys starting with invalid prefix letters (e.g. A, B, M)', () => {
      const valid = validKeys[0];
      for (const badPrefix of ['A', 'B', 'C', 'M', 'P', 'Z']) {
        const key = badPrefix + valid.slice(1);
        const result = sep10ChallengeQuerySchema.safeParse({ account: key });
        expect(result.success).toBe(false);
      }
    });

    it('rejects keys starting with numeric characters (e.g. 1, 2, 7)', () => {
      const valid = validKeys[0];
      for (const badPrefix of ['1', '2', '7']) {
        const key = badPrefix + valid.slice(1);
        const result = sep10ChallengeQuerySchema.safeParse({ account: key });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('keys with incorrect lengths', () => {
    const valid = validKeys[0];

    it('rejects empty string', () => {
      const result = sep10ChallengeQuerySchema.safeParse({ account: '' });
      expect(result.success).toBe(false);
    });

    it('rejects truncated keys (less than 56 characters)', () => {
      for (const len of [1, 10, 32, 55]) {
        const truncated = valid.slice(0, len);
        const result = sep10ChallengeQuerySchema.safeParse({ account: truncated });
        expect(result.success).toBe(false);
      }
    });

    it('rejects extended keys (more than 56 characters)', () => {
      for (const extra of ['A', 'AA', 'AAAAA']) {
        const extended = valid + extra;
        const result = sep10ChallengeQuerySchema.safeParse({ account: extended });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('keys with invalid characters', () => {
    it('rejects lowercase characters', () => {
      const lower = validKeys[0].toLowerCase();
      const result = sep10ChallengeQuerySchema.safeParse({ account: lower });
      expect(result.success).toBe(false);
    });

    it('rejects non-base32 characters (0, 1, 8, 9, special chars)', () => {
      const valid = validKeys[0];
      for (const char of ['0', '1', '8', '9', '-', '_', '.', '!']) {
        const withBadChar = valid.slice(0, 10) + char + valid.slice(11);
        const result = sep10ChallengeQuerySchema.safeParse({ account: withBadChar });
        expect(result.success).toBe(false);
      }
    });
  });
});
