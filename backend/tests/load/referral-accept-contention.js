import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Referral accept contention (issue #349): many patients accept referrals
// into the same specialist's few slots at once. Each accept runs the
// conditional referral update plus the slot claim in one transaction.
//
// Correctness is asserted from the database after the run by
// tests/load/verify-referral-accept-contention.mts, not from status codes:
// no double-booked slot, every referral accepted with exactly one
// appointment or still pending. Seed first with
// tests/load/seed-referral-accept-contention.mts (see .github/workflows/load-tests.yml).
//
// NEVER run this against the shared Render preview.

const BASE_URL = __ENV.LOAD_TEST_BASE_URL || 'http://localhost:4000';
const SEED_FILE = __ENV.LOAD_TEST_SEED_FILE || './seed-referral-accept-contention.json';

if (BASE_URL.includes('render.com')) {
  fail('Refusing to run the referral accept contention test against a Render host');
}

const seed = JSON.parse(open(SEED_FILE));

const acceptLatency = new Trend('referral_accept_latency', true);
const accepted = new Counter('referral_accept_ok');
const conflicts = new Counter('referral_accept_conflict');

export const options = {
  scenarios: {
    referral_accept_contention: {
      // One VU per referral, all released together, so every slot sees
      // several simultaneous claims.
      executor: 'per-vu-iterations',
      vus: seed.referrals.length,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    referral_accept_latency: ['p(95)<2000'],
    // Losers get 409; anything else (5xx, 4xx validation) fails the run.
    checks: ['rate==1.0'],
  },
};

export default function () {
  const referral = seed.referrals[__VU - 1];
  const res = http.post(
    `${BASE_URL}/referrals/${referral.id}/accept`,
    JSON.stringify({ availabilitySlotId: referral.targetSlotId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${referral.patientToken}`,
      },
      tags: { endpoint: 'referral_accept' },
      timeout: '10s',
    },
  );

  acceptLatency.add(res.timings.duration);
  if (res.status === 200 || res.status === 201) accepted.add(1);
  else if (res.status === 409) conflicts.add(1);

  check(res, {
    'accept is 2xx or 409': (r) => r.status === 200 || r.status === 201 || r.status === 409,
  });
}
