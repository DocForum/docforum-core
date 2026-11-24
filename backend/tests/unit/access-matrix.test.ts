// The matrix is only worth reading if it says what the routers actually do, so
// the handful of rows a reviewer would check by hand are pinned here instead
// (issue #357). Each expectation below was read off the route file it names:
// `referrals/routes`, `appointments/routes`, `auth/routes`, `users/routes` and
// `flags/routes`. The last test pins the stronger property — the committed
// markdown is byte-for-byte what the live routers generate, which is what the
// CI step checks.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectEndpoints,
  joinPath,
  outputPath,
  render,
  type Endpoint,
} from '../../scripts/gen-access-matrix.js';

function endpoint(method: string, path: string): Endpoint {
  const found = endpoints.find((row) => `${row.method} ${joinPath(row.prefix, row.path)}` === `${method} ${path}`);
  if (!found) throw new Error(`${method} ${path} is not in the generated matrix`);
  return found;
}

let endpoints: Endpoint[] = [];
let unidentified: string[] = [];

beforeAll(() => {
  const collected = collectEndpoints();
  endpoints = collected.endpoints;
  unidentified = collected.unidentified;
});

describe('generated access matrix (issue #357)', () => {
  it('covers every route the app mounts', () => {
    expect(endpoints.length).toBeGreaterThan(100);
    expect(unidentified, `unattributed router layers: ${unidentified.join(', ')}`).toEqual([]);
    for (const row of endpoints) {
      expect(row.method, JSON.stringify(row)).toMatch(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL)$/);
      expect(joinPath(row.prefix, row.path), JSON.stringify(row)).toMatch(/^\//);
    }
  });

  it('reads the referrals guards the route file writes', () => {
    const create = endpoint('POST', '/referrals');
    expect(create.roles).toEqual(['doctor']);
    expect(create.auth).toEqual(['authenticate']);
    expect(create.verifiedEmail).toBe(true);
    expect(create.idempotency).toBe(false);

    expect(endpoint('GET', '/referrals/mine').roles).toEqual(['patient']);
    expect(endpoint('GET', '/referrals/created').roles).toEqual(['doctor']);
    // The lists are reads, so they skip the verified-email gate.
    expect(endpoint('GET', '/referrals/mine').verifiedEmail).toBe(false);
    expect(endpoint('GET', '/referrals/admin/queue').roles).toEqual(['admin']);

    const withdraw = endpoint('POST', '/referrals/:referralId/withdraw');
    expect(withdraw.roles).toEqual(['doctor']);
    expect(withdraw.verifiedEmail).toBe(true);
    // The detail route carries no `requireRole`: `getReferralDetail` decides by
    // role in the service, so a row here can only say "any authenticated
    // caller reaches the handler" — the limit the document states up front.
    const detail = endpoint('GET', '/referrals/:referralId');
    expect(detail.roles).toBeNull();
    expect(detail.auth).toEqual(['authenticate']);
  });

  it('reports both gates on a booking write', () => {
    const book = endpoint('POST', '/appointments');
    expect(book.roles).toEqual(['patient']);
    expect(book.verifiedEmail).toBe(true);
    expect(book.idempotency).toBe(true);
  });

  it('carries router-level guards onto every route of that router', () => {
    // `users` and `flags` guard with `router.use(authenticate, requireRole('admin'))`
    // rather than per route, so a per-route walk alone would report them open.
    expect(endpoint('POST', '/admin/invites').roles).toEqual(['admin']);
    expect(endpoint('GET', '/admin/feature-flags').roles).toEqual(['admin']);
    expect(endpoint('PATCH', '/admin/feature-flags/:key').auth).toEqual(['authenticate']);
    // `/me/flags` is authenticated but deliberately role-free.
    const myFlags = endpoint('GET', '/me/flags');
    expect(myFlags.roles).toBeNull();
    expect(myFlags.auth).toEqual(['authenticate']);
  });

  it('leaves public endpoints without a role and names unrecognised guards', () => {
    expect(endpoint('POST', '/auth/login').roles).toBeNull();
    expect(endpoint('POST', '/auth/verify-email').auth).toEqual([]);
    // The CSRF/origin guard is neither a role, verified-email nor idempotency.
    expect(endpoint('POST', '/auth/refresh').otherGuards).toContain('requireAllowedOrigin');
    // Health routes are mounted on the app itself, not on a module router.
    const live = endpoint('GET', '/health/live');
    expect(live.prefix).toBe('');
    expect(live.roles).toBeNull();
  });

  it('matches the committed markdown exactly', () => {
    expect(readFileSync(outputPath(), 'utf8')).toBe(render());
  });
});
