import http from 'kf6/http';
import { check, sleep } from 'kf6';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) {
  throw new Error('BASE_URL env variable is required');
}

const SEARCH_TERMS = (__ENV.SEARCH_TERMS || 'cardiology,dermatology,general,pediatrics,neurology')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PAGE_SIZE = Number(__ENV.SEARCH_PAGE_SIZE || 20);

export const options = {
  scenarios: {
    search: {
      executor: 'constant-vus',
      vus: Number(__ENV.SEARCH_VUS || 50),
      duration: __ENV.SEARCH_DURATION || '1m',
      gracefulStop: '10s',
      tags: { scenario: 'search' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:search}': ['p(95)<300'],
    'http_req_failed{scenario:search}': ['rate<0.01'],
    checks: ['rate==1'],
  },
};

function pickTerm() {
  return SEARCH_TERMS[__VU_ITER % SEARCH_TERMS.length];
}

export default function () {
  const term = pickTerm();
  const url = `${BASE_URL}/api/doctors?search=${encodeURIComponent(term)}&page=1&limit=${PAGE_SIZE}`;

  const res = http.get(url, {
    tags: { scenario: 'search', endpoint: 'doctor_search' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response is json': (r) => {
      try {
        r.json();
        return true;
      } catch {
        return false;
      }
    },
    'response has data array': (r) => {
      try {
        const body = r.json();
        const items = Array.isArray(body) ? body : body.data || body.items || body.results;
        return Array.isArray(items);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1 + Math.random() * 0.2);
}
