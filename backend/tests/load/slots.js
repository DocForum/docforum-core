import http from 'k6/http';
import { check, group } from 'k6';
import { Trend } from 'k6/metrics';

// Slot listing load test.
//
// Profiles the read path used when a patient opens a doctor's
// availability calendar. The PROD (<7) targets ~300 ms p95 for read
// paths, so the thresholds below enforce that at a realistic concurrency.
//
// Environment variables:
//   BASE_URL      - required. Must point at a seeded local/staging stack.
//                    Never point this at the shared Render preview.
//   DOCTOR_IDS     - comma-separated doctor IDs to list slots for.
//                    Defaults to a small set of seeded IDs.
//   SLOT_DAYS      - number of days of availability to request.
//   SLOT_TIMEZONE  - IANA timezone for the query.

const BASE_URL = (__ENV && __ENV.BASE_URL) || 'http://localhost:3000';
const DOCTOR_IDS = ((__ENV && __ENV.DOCTOR_IDS) || '101,102,103,104,105')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const SLOT_DAYS = Number(typeof __ENV !== 'undefined' && __ENV.SLOT_DAYS ? __ENV.SLOT_DAYS : 7);
const SLOT_TIMEZONE = (typeof __ENV !== 'undefined' && __ENV.SLOT_TIMEZONE) || 'UTC';

if (!DOCTOR_IDS.length) {
  throw new Error('DOCTOR_IDS must contain at least one doctor ID');
}

const slotLatency = new Trend('slot_listing_latency');

export const options = {
  scenarios: {
    slot_listing: {
      exec: 'constant-vus',
      vus: Number(typeof __ENV !== 'undefined' && __ENV.VUS ? __ENV.VUS : 50),
      duration: (typeof __ENV !== 'undefined' && __ENV.DURATION) || '1m',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01' ],
    'http_req_duration~{tag:slot_listing}:p95': ['p(95)<300'],
    'http_req_duration~{tag:slot_listing}:p99': ['p(99)<600'],
    slot_listing_latency: ['p(95)<300', 'p(99)<600'],
  },
};

function pickDoctor() {
  return DOCTOR_IDS[Math.floor(Math.random() * DOCTOR_IDS.length)];
}

function slotsUrl(doctorId) {
  const params = new URLSearchParams();
  params.set('days', String(SLOT_DAYS));
  params.set('timezone', SLOT_TIMEZONE);
  return `${BASE_URL}/api/doctors/${encodeURIComponent(doctorId)}/slots?${params.toString()}`;
}

export default function () {
  group('slot listing', () => {
    const doctorId = pickDoctor();
    const resp = http.get(slotsUrl(doctorId), {
      tags: { tag: 'slot_listing' },
    });

    slotLatency.add(resp.timings.duration);

    check(resp, {
      'slots status is 200': (r) => r.status === 200,
    });

    check(resp.body, {
      'slots body is JSON': (body) => {
        try {
          JSON.parse(body);
          return true;
        } catch (err) {
          return false;
        }
      },
    });
  });
}
