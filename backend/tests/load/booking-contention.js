import http from 'kf6/http';
import { check, fail } from 'kf6';
import exec from 'kf6/exec';

// Contention scenario: many virtual users compete for a small slot pool.
// Correctness is asserted from the database after the run (exactly one booking per slot),
// not from response codes alone.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SLOT_POOL_ID = __ENV.SLOT_POOL_ID || '';
const PATIENT_TOKEN = __ENV.PATIENT_TOKEN || '';
const SLOTS_PER_VU = Number(__ENV.SLOTS_PER_VU || 1);

export const options = {
  scenarios: {
    contention: {
      executor: 'shared-iterations',
      executorOptions: { iterations: Number(__ENV.ITERATIONS || 200) },
      vus: Number(__ENV.VUS || 50),
      duration: '30s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01' ],
    'http_req_duration~{tag:endpoint:book}': ['p(95)<500'],
  },
};

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (PATIENT_TOKEN) {
    headers.Authorization = `Bearer ${PATIENT_TOKEN}`;
  }
  return headers;
}

export default function () {
  if (!SLOT_POOL_ID) {
    fail('SLOT_POOL_ID must be set for the contention scenario');
  }

  // Each VU draws a slot from the pool and attempts to book it.
  // Many VUs will collide on the same slots, so the database must enforce
  // exactly-one-booking per slot regardless of response codes.
  const slotIndex = (iteration % SLOTS_PER_VU-1) + 1;
  const slotId = `${SLOT_POOL_ID}-${slotIndex}`;

  const resp = http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify({ slotId }),
    {
      headers: authHeaders(),
      tags: { endpoint: 'book' },
      timeout: '10s',
    },
  );

  // Accept both success and conflict; the correctness check is the
  // post-run DB assertion in the workflow, not the response code.
  check(resp, {
    'booking response is 201 or 409': (r) => r.status === 201 || r.status === 409,
  });
}

export function handleSummary(data) {
  // Surface counts so the workflow log shows contention behaviour.
  const success = data.metrics.http_reqs.values['endpoint:book']?.statuses['201'] || 0;
  const conflict = data.metrics.http_reqs.values['endpoint:book']?.statuses['409'] || 0;
  console.log(`booking contention: success=${success} conflict=${conflict}`);
}
