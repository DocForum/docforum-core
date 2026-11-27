// Generates `docs/api/error-catalogue.md` from the error catalogue (issue #115).
//
//   npm run errors:catalogue          rewrite the page
//   npm run errors:check             fail if the page is stale
//
// The page is committed so the docs site and reviewers see it without a build
// step; CI runs the check so it can never drift from the catalogue.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ERROR_CATALOGUE, ERROR_GROUPS, type ErrorModule } from '../src/error-catalogue';

const OUT = resolve(process.cwd(), '..', 'docs', 'api', 'error-catalogue.md');

const TITLES: Record<ErrorModule, string> = {
  shared: 'Shared: envelope, auth middleware, request parsing',
  auth: 'Auth',
  users: 'Users and admin invites',
  patients: 'Patients, guardianship and exports',
  doctors: 'Doctors, specialties and symptoms',
  availability: 'Availability',
  appointments: 'Appointments and waitlist',
  intake: 'Intake',
  consultations: 'Consultations, messages, attachments and follow-ups',
  referrals: 'Referrals',
  orders: 'Orders',
  prescriptions: 'Prescriptions',
  'lab-orders': 'Lab orders and results',
  'pharmacy-orders': 'Pharmacy orders and fulfillment',
  facilities: 'Facilities and pricing',
  payments: 'Payments',
  notifications: 'Notifications',
  medications: 'Medications',
  'rate-limit': 'Rate limiting',
  audit: 'Audit',
  flags: 'Feature flags',
  metrics: 'Metrics',
  'lab-tests': 'Lab tests',
};

// Markdown table cell: escape backslashes first, then the column separator.
// A bare `<` outside inline code would be parsed as an HTML/Vue tag by the
// docs site build, so catalogue text keeps placeholders in backticks.
const cell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export function renderErrorCatalogue(): string {
  const lines: string[] = [
    '# Error catalogue',
    '',
    'Every failed request answers with the same envelope:',
    '',
    '```json',
    '{ "code": "SLOT_TAKEN", "message": "This slot is no longer available." }',
    '```',
    '',
    '`code` is stable: branch on it. `message` is human-readable, may be',
    'translated, and may change between releases, so never match on its text.',
    '`details` is present only when the code carries structured, non-sensitive',
    'context — validation failures put one entry per failing field in',
    '`details.fields[]` (`path`, field-level `code`, `message`). A validation',
    'failure is `VALIDATION_FAILED` unless a field rule carries its own',
    'catalogue code (for example `PASSWORD_TOO_SHORT`), which is then the',
    'top-level code.',
    '',
    'HTTP status is fixed by the code: `backend/src/error-catalogue.ts` is the',
    'single source of truth, and `HttpError` derives the status from it.',
    '',
    'This page is generated — edit the catalogue and run',
    '`npm run errors:catalogue` in `backend/` instead of editing this file.',
    '',
  ];

  for (const module of ERROR_GROUPS) {
    const entries = Object.entries(ERROR_CATALOGUE)
      .filter(([, definition]) => definition.module === module)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) continue;

    lines.push(`## ${TITLES[module]}`, '', '| Code | HTTP | Meaning | Client guidance |', '|---|---|---|---|');
    for (const [code, definition] of entries) {
      lines.push(
        `| \`${code}\` | ${definition.status} | ${cell(definition.meaning)} | ${cell(definition.guidance)} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const rendered = renderErrorCatalogue();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    current = '';
  }
  if (current !== rendered) {
    console.error(
      'docs/api/error-catalogue.md is out of date. Run `npm run errors:catalogue` in backend/ and commit the result.',
    );
    process.exit(1);
  }
  console.log('docs/api/error-catalogue.md matches the error catalogue.');
} else {
  writeFileSync(OUT, rendered);
  console.log(`Wrote ${join(OUT)} (${Object.keys(ERROR_CATALOGUE).length} codes).`);
}
