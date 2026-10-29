import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRequest, isValidIdempotencyKey } from '../../src/middleware/idempotency';

// The pure parts of the middleware (Phase 8, issue #48). Everything that
// touches the database is proven against a real Postgres in
// tests/integration/idempotency.test.mts — these are the pieces where a wrong
// answer would silently become a 422-against-yourself or a cross-user replay,
// and they are cheap to pin down exactly.
const NUL_KEY = `nul${String.fromCharCode(0)}byte`;

describe('idempotency key + request hash (issue #48)', () => {
  it('accepts ordinary client-generated keys and rejects unusable ones', () => {
    const accepted = [
      'a',
      'x'.repeat(255),
      '9f1c-4d2e-4a7b',
      'order_42/attempt~1+2',
      '550e8400-e29b-41d4-a716-446655440000',
      'key:with:colons',
    ];
    for (const key of accepted) {
      expect(isValidIdempotencyKey(key), key).toBe(true);
    }

    // Empty, whitespace, non-ASCII, control characters and anything long
    // enough to be a storage/DoS vector are refused.
    const refused = ['', ' ', 'x'.repeat(256), 'has space', `tab${String.fromCharCode(9)}here`, `nl${String.fromCharCode(10)}here`, 'emoji🔑', NUL_KEY];
    for (const key of refused) {
      expect(isValidIdempotencyKey(key), JSON.stringify(key)).toBe(false);
    }
  });

  it('serialises a body canonically, independent of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { z: 1, y: [3, { q: 1, p: 2 }] }, b: 'x' })).toBe(
      '{"a":{"y":[3,{"p":2,"q":1}],"z":1},"b":"x"}',
    );
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson([1, 'two', null])).toBe('[1,"two",null]');

    // Two shapes of the same logical body must produce one string, or a retry
    // of a request that never got an answer 422s against itself.
    expect(canonicalJson({ availabilitySlotId: 'slot-1', note: 'a' })).toBe(
      canonicalJson({ note: 'a', availabilitySlotId: 'slot-1' }),
    );

    // An absent key and an explicitly-null one are different bodies: `undefined`
    // is dropped (as JSON.stringify does), `null` is a value.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }));

    // Order inside an array IS significant — it is data, not a set.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('hashes the same request identically and different requests differently', () => {
    const hash = hashRequest('POST', '/appointments', { availabilitySlotId: 'slot-1' });

    // Method case and key order are not part of the request.
    expect(hashRequest('post', '/appointments', { availabilitySlotId: 'slot-1' })).toBe(hash);
    expect(hashRequest('POST', '/appointments', { note: 'a', availabilitySlotId: 'slot-1' })).toBe(
      hashRequest('POST', '/appointments', { availabilitySlotId: 'slot-1', note: 'a' }),
    );

    // Different bodies, different target ids, different methods, different
    // routes — all different requests under the same key.
    expect(hashRequest('POST', '/appointments', { availabilitySlotId: 'slot-1', note: null })).not.toBe(hash);
    expect(hashRequest('POST', '/appointments', { availabilitySlotId: 'slot-2' })).not.toBe(hash);
    expect(hashRequest('POST', '/payments/intents/abc/fund', {})).not.toBe(
      hashRequest('POST', '/payments/intents/xyz/fund', {}),
    );
    expect(hashRequest('POST', '/payments/intents', {})).not.toBe(hashRequest('GET', '/payments/intents', {}));
    expect(hashRequest('DELETE', '/appointments', { availabilitySlotId: 'slot-1' })).not.toBe(hash);

    // SHA-256 hex — no length or encoding surprises for a fixed-width column.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
