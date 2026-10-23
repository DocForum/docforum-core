#!/usr/bin/env node
// Folds the changelog fragments in changelog.d/ into the "## Changelog"
// section of ROADMAP.md, then deletes them. Maintainers run this and commit
// the result in its own PR; contributors only ever add fragment files, so
// their PRs never touch the same lines (see changelog.d/README.md).
//
// Each entry is dated by the day its fragment was added to the current
// branch (for squash-merged PRs, the merge date), taken from git history.
// A fragment that isn't committed yet gets today's date.
//
//   node scripts/fold-changelog.mjs            # fold and delete fragments
//   node scripts/fold-changelog.mjs --dry-run  # print what would be added
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const dir = path.join(root, 'changelog.d');
const roadmapPath = path.join(root, 'ROADMAP.md');
const today = new Date().toISOString().slice(0, 10);

function addedOn(rel) {
  // Newest first; the last line is the commit that added the file.
  const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%as', '--', rel], {
    cwd: root, encoding: 'utf8',
  }).trim();
  return out ? out.split('\n').pop() : today;
}

function toEntry(date, text) {
  // Tolerate fragments written in the old style ("- 2026-10-20 — ...").
  const body = text.trim()
    .replace(/^-\s+/, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*[—-]+\s*/, '');
  const [first, ...rest] = body.split('\n');
  // Continuation lines are indented so the whole entry stays one list item.
  return [`- ${date} — ${first}`, ...rest.map((line) => (line.trim() ? `  ${line}` : ''))]
    .join('\n')
    .replace(/\n{2,}/g, '\n');
}

const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
  : [];
if (files.length === 0) {
  console.log('No changelog fragments to fold.');
  process.exit(0);
}

const fragments = files
  .map((file) => {
    const rel = `changelog.d/${file}`;
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (!text.trim()) throw new Error(`${rel} is empty`);
    return { file, rel, date: addedOn(rel), text };
  })
  .sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));

const lines = fs.readFileSync(roadmapPath, 'utf8').split('\n');
const heading = lines.findIndex((l) => /^## Changelog\b/.test(l));
if (heading === -1) throw new Error('ROADMAP.md has no "## Changelog" section');
let end = lines.findIndex((l, i) => i > heading && /^## /.test(l));
if (end === -1) end = lines.length;
// Insert after the section's last non-blank line.
let at = end;
while (at > heading + 1 && lines[at - 1].trim() === '') at--;

const entries = fragments.map((f) => toEntry(f.date, f.text));
if (dryRun) {
  console.log(entries.join('\n'));
  process.exit(0);
}

lines.splice(at, 0, ...entries);
fs.writeFileSync(roadmapPath, lines.join('\n'));
for (const f of fragments) fs.unlinkSync(path.join(root, f.rel));
console.log(`Folded ${fragments.length} fragment(s) into ROADMAP.md:`);
for (const f of fragments) console.log(`  ${f.date}  ${f.rel}`);
