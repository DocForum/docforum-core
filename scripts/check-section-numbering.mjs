#!/usr/bin/env node
// CI gate for ARCHITECTURE.md section numbers. Run locally from anywhere with:
//   node scripts/check-section-numbering.mjs
// A duplicated `### N.N` heading makes citations like "§4.11" ambiguous, so
// fail when two top-level sections claim the same number. `### N.N.M` child
// headings are intentionally ignored (they belong to their N.N parent).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = await readFile(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
const sections = new Map();

for (const line of text.split(/\r?\n/)) {
  const match = /^### (\d+\.\d+) \S/.exec(line);
  if (!match) continue;
  const titles = sections.get(match[1]) ?? [];
  titles.push(line.replace(/^### /, ''));
  sections.set(match[1], titles);
}

const problems = [];
for (const [number, titles] of sections) {
  if (titles.length > 1) {
    problems.push(`duplicate section §${number}: ${titles.join(' | ')}`);
  }
}

if (problems.length > 0) {
  console.error('Section numbering check FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Section numbering OK: ${sections.size} top-level sections with unique numbers.`);
