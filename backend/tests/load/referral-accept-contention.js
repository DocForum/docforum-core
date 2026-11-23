import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Load test: many patients accepting referrals into the same specialist's few slots.
// Correctness is asserted from the database after the run (see
// backend/tests/load/verify-referral-accept-contention.ts), not from HTTP status codes.
//
// NEVER run this against the shared Render preview. Target a local or dedicated
// load-test environment only.

const BASE_URL = __ENV.LOAD_TEST_BASE_URL || 'http://localhost:3000';
const SEED_FILE = __ENV.LOAD_TEST_SEED_FILE || 'tests/load/seed-referral-accept-contention.json';
const SHARED_PREVIEW_HOST = 'onrender.com';

if (BASE_URL.includes(SHARED_PREVIEW_HOST)) {
  fail('Refusing to run referral accept contention test against a Render host');
}

const acceptLatency = new Trend('referral_accept_latency', true);
const acceptedCount = new Counter('referral_accept_ok');
const conflictCount = new Counter('referral_accept_conflict');

const seed = JSON.parse(open(`../../${SEED_FILE}`));

export const options = {
  scenarios: {
    referral_accept_contention: {
      executor: 'per-vu-iterations',
      vus: seed.referrals.length,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.5'],
    referral_accept_latency: ['p(95)<2000'],
  },
};

export default function () {
  const referral = seed.referrals[__VU - 1];
  const res = http.post(
    `${BASE_URL}/api/referrals/${referral.id}/accept`,
    JSON.stringify({ slotId: referral.targetSlotId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${referral.patientToken}`,
      },
    },
  );

  acceptLatency.add(res.timings.duration);
  if (res.status === 200 || res.status === 201) {
    acceptedCount.add(1);
  } else if (res.status === 409) {
    conflictCount.add(1);
  }

  check(res, {
    'status is an expected outcome': (r) => [200, 201, 409].includes(r.status),
  });
}
