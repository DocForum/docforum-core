import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/modules/notifications/templates.ts', import.meta.url), 'utf8');
const forbidden = /payload\.|patientName|doctorName|diagnos|symptom|medication|freeText|consultationNotes|appointmentId|orderId/i;
const violations = source.split('\n').filter((line) => !line.trim().startsWith('//') && forbidden.test(line));
if (violations.length) {
  console.error('Notification templates contain PHI or clinical terms:', violations.join('\n'));
  process.exit(1);
}
console.log('Notification templates are PHI-safe.');
