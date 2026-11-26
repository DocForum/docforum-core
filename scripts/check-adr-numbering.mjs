#!/usr/bin/env node
// CI gate for ADR numbering. Run locally from anywhere with:
//   node scripts/check-adr-numbering.mjs
// Checks: unique ADR numbers, filename/heading agreement, and that every ADR
// is listed in docs/adr/README.md.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');
const problems = [];

const files = (await readdir(ADR_DIR))
  .filter((file) => file.endsWith('.md') && file !== 'README.md')
  .sort();
const byNumber = new Map();

for (const file of files) {
  const match = /^(\d{4})-/.exec(file);
  if (!match) {
    problems.push(`docs/adr/${file}: filename does not start with a 4-digit ADR number`);
    continue;
  }
  const number = match[1];
  if (!byNumber.has(number)) byNumber.set(number, []);
  byNumber.get(number).push(file);

  const text = await readFile(path.join(ADR_DIR, file), 'utf8');
  const heading = /^# ADR (\d{4}):/m.exec(text);
  if (!heading) {
    problems.push(`docs/adr/${file}: no "# ADR NNNN:" heading`);
  } else if (heading[1] !== number) {
    problems.push(`docs/adr/${file}: heading says ADR ${heading[1]}, filename says ADR ${number}`);
  }
}

for (const [number, owners] of byNumber) {
  if (owners.length > 1) {
    problems.push(
      `duplicate ADR ${number}: ${owners.map((file) => `docs/adr/${file}`).join(', ')}`,
    );
  }
}

const index = await readFile(path.join(ADR_DIR, 'README.md'), 'utf8');
for (const file of files) {
  if (!index.includes(`](${file})`)) {
    problems.push(`docs/adr/README.md: missing index link to ${file}`);
  }
}

if (problems.length > 0) {
  console.error('ADR numbering check FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `ADR numbering OK: ${files.length} ADRs with unique numbers/headings, all indexed in docs/adr/README.md.`,
);
