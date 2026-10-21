import { describe, it, expect } from 'vitest';
import { checkRateLimit, measureOverhead } from '../../src/modules/rate-limit/services';

describe('Rate Limiter', () => {
  describe('checkRateLimit', () => {
    it('should allow requests within the limit', async () => {
      const result = await checkRateLimit('test-user-1', {
        windowSeconds: 60,
        maxRequests: 5,
        identifier: 'user',
      });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it('should block requests beyond the limit', async () => {
      const max = 5;
      for (let i = 0; i < max; i++) {
        await checkRateLimit(`user-${i}`, {
          windowSeconds: 60,
          maxRequests: max,
          identifier: 'user',
        });
      }

      const result = await checkRateLimit('user-over', {
        windowSeconds: 60,
        maxRequests: max,
        identifier: 'user',
      });
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should reset after window expires', async () => {
      const max = 3;
      for (let i = 0; i < max; i++) {
        await checkRateLimit('test-user', {
          windowSeconds: 60,
          maxRequests: max,
          identifier: 'user',
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 61000));

      const result = await checkRateLimit('test-user', {
        windowSeconds: 60,
        maxRequests: max,
        identifier: 'user',
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('measureOverhead', () => {
    it('should return a reasonable overhead time', async () => {
      const overhead = await measureOverhead('test-user', {
        windowSeconds: 60,
        maxRequests: 100,
        identifier: 'user',
      });
      expect(overhead).toBeLessThan(1000);
    });
  });
});
