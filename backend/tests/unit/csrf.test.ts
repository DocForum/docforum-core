import { describe, expect, it } from 'vitest';
import { csrfTokensMatch, generateCsrfToken, isAllowedOrigin } from '../../src/middleware/csrf';

describe('CSRF primitives (issue #37)', () => {
  it('generates a fresh, URL-safe token each time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      // 32 random bytes, base64url.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('matches equal tokens and rejects mismatches, length differences and empty input', () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
    expect(csrfTokensMatch(token, generateCsrfToken())).toBe(false);
    expect(csrfTokensMatch(token, token.slice(0, 10))).toBe(false);
    expect(csrfTokensMatch('', '')).toBe(false);
    expect(csrfTokensMatch(token, '')).toBe(false);
  });

  it('only allowlists configured origins', () => {
    // Local dev defaults (tests don't run with NODE_ENV=production).
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173.evil.example')).toBe(false);
    expect(isAllowedOrigin('https://docforum.github.io')).toBe(false);
  });
});
