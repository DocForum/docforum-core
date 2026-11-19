#!/usr/bin/env node
// Docs fragments: new content for the shared docs arrives as one file per PR
// under docs.d/, and a maintainer folds the fragments into the docs in batches.
//
// When every PR added its lines straight into ROADMAP.md, ARCHITECTURE*.md,
// README.md and friends, most PRs inserted text at the same few places, so
// each merge put the other open PRs into conflict. A new file per PR never
// collides with anyone else's. See docs.d/README.md.
//
//   node scripts/docs-fragments.mjs fold [--dry-run]     # maintainers
//   node scripts/docs-fragments.mjs check <base-ref> [--maintainer]   # CI
//
// `check` fails when a PR adds net-new lines to a protected doc (changing
// existing lines in place is fine), or when a fragment wouldn't fold cleanly.
// `--maintainer` skips the protected-doc rule (fold PRs and maintainer edits)
// but still validates the fragments.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const root = git('rev-parse', '--show-toplevel').trim();
const DIR = 'docs.d';
const config = JSON.parse(fs.readFileSync(path.join(root, DIR, 'config.json'), 'utf8'));
const PROTECTED = config.protected;

// ---------------------------------------------------------------- fragments

function parseFragment(rel, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${rel}: missing front matter (a \`---\` block with \`file:\` and \`section:\` or \`after:\`)`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([a-z]+):\s*(.*)$/);
    if (!kv) throw new Error(`${rel}: can't read front matter line ${JSON.stringify(line)}`);
    let v = kv[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  const unknown = Object.keys(meta).filter((k) => !['file', 'section', 'after'].includes(k));
  if (unknown.length) throw new Error(`${rel}: unknown front matter key(s): ${unknown.join(', ')}`);
  if (!meta.file) throw new Error(`${rel}: front matter needs \`file:\``);
  if (!PROTECTED.includes(meta.file)) {
    throw new Error(`${rel}: \`file: ${meta.file}\` isn't one of the shared docs (${PROTECTED.join(', ')}). Edit other files directly.`);
  }
  if (!!meta.section === !!meta.after) throw new Error(`${rel}: give exactly one of \`section:\` or \`after:\``);
  const body = m[2].replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!body) throw new Error(`${rel}: no content after the front matter`);
  return { rel, ...meta, body };
}

function loadFragments() {
  const dir = path.join(root, DIR);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => {
      const rel = `${DIR}/${f}`;
      return parseFragment(rel, fs.readFileSync(path.join(dir, f), 'utf8'));
    });
}

// ------------------------------------------------------------------ docs

// Headings outside fenced code blocks: { line, level, text }.
function headings(lines) {
  const out = [];
  let fence = null;
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) out.push({ line: i, level: h[1].length, text: h[2] });
  });
  return out;
}

const norm = (s) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// `section: A > B` picks heading B inside section A. Returns the insertion
// index. Content that starts with its own heading goes at the very end of the
// section, after its subsections; anything else (list items, table rows,
// paragraphs) goes at the end of the section's own text, before its first
// subsection.
function sectionEnd(lines, file, spec, rel, wholeSection) {
  const hs = headings(lines);
  const raw = spec.split('>').map((p) => p.trim()).filter(Boolean);
  const parts = raw.map(norm);
  let candidates = hs.map((h, idx) => ({ h, idx }));
  let scopeEnd = lines.length;
  let scopeStart = -1;
  let found = null;
  for (const [i, part] of parts.entries()) {
    const inScope = candidates.filter(({ h }) => h.line > scopeStart && h.line < scopeEnd);
    const matches = inScope.filter(({ h }) => norm(h.text) === part);
    if (matches.length === 0) {
      throw new Error(`${rel}: no heading ${JSON.stringify(raw[i])} in ${file}${scopeStart >= 0 ? ' inside the earlier section' : ''}`);
    }
    if (matches.length > 1) {
      throw new Error(`${rel}: heading ${JSON.stringify(raw[i])} appears ${matches.length} times in ${file}; name its parent too (\`section: Parent > ${raw[i]}\`), or use \`after:\` with a line from the place you mean`);
    }
    found = matches[0];
    const next = hs.slice(found.idx + 1).find((h) => h.level <= found.h.level);
    scopeStart = found.h.line;
    scopeEnd = Math.min(next ? next.line : lines.length, scopeEnd);
  }
  if (!wholeSection) {
    const sub = hs.find((h) => h.line > scopeStart && h.line < scopeEnd);
    if (sub) scopeEnd = sub.line;
  }
  let at = scopeEnd;
  while (at > scopeStart + 1 && lines[at - 1].trim() === '') at--;
  return at;
}

function anchorLine(lines, file, text, rel) {
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(text)) hits.push(i); });
  if (hits.length === 0) throw new Error(`${rel}: no line in ${file} contains ${JSON.stringify(text)}`);
  if (hits.length > 1) {
    throw new Error(`${rel}: ${hits.length} lines in ${file} contain ${JSON.stringify(text)} (lines ${hits.map((h) => h + 1).join(', ')}); quote more of the line so it matches once`);
  }
  return hits[0] + 1;
}

// fenced[i] is true when text inserted after line i lands inside a fenced
// code block (line i opens the block or is inside it, but doesn't close it).
function inFence(lines) {
  let fence = null;
  return lines.map((l) => {
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) { fence = null; return false; }
      return true;
    }
    return fence !== null;
  });
}

// An indented line right under a list item is that item's continuation.
const kind = (l) => (/^\s*\|/.test(l) ? 'table' : /^(\s*([-*+]|\d+\.)\s|\s{2,}\S)/.test(l) ? 'list' : 'text');

// Applies the fragments to the docs in memory. Returns { file: newText }.
function applyAll(fragments, readDoc) {
  const byFile = new Map();
  for (const f of fragments) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const out = {};
  for (const [file, frs] of byFile) {
    let lines = readDoc(file).split('\n');
    // Resolve every anchor against the original text first, so the result
    // doesn't depend on fold order; fragments sharing an anchor are joined in
    // filename order and inserted once.
    const groups = new Map();
    for (const f of frs) {
      const at = f.section ? sectionEnd(lines, file, f.section, f.rel, /^#{1,6}\s/.test(f.body)) : anchorLine(lines, file, f.after, f.rel);
      const key = `${at}|${f.section ? 'section' : 'after'}`;
      if (!groups.has(key)) groups.set(key, { at, section: !!f.section, bodies: [] });
      groups.get(key).bodies.push(f.body);
    }
    const ordered = [...groups.values()].sort((a, b) => b.at - a.at);
    const fenced = inFence(lines);
    for (const g of ordered) {
      // Inside a code block (e.g. an API listing) lines go in exactly as
      // written. Elsewhere, table rows and list items stay attached to the
      // table or list they extend, and anything else is set off by blank lines.
      const raw = !g.section && fenced[g.at - 1];
      const block = [];
      let prev = g.at > 0 ? lines[g.at - 1] : '';
      for (const body of g.bodies) {
        const bl = body.split('\n');
        const join = raw || (prev.trim() && kind(prev) !== 'text' && kind(prev) === kind(bl[0]));
        if (!join && prev.trim() !== '') block.push('');
        block.push(...bl);
        prev = bl[bl.length - 1];
      }
      const next = lines[g.at];
      const joinNext = raw || (kind(prev) !== 'text' && kind(prev) === kind(next ?? ''));
      if (next !== undefined && next.trim() !== '' && !joinNext) block.push('');
      lines.splice(g.at, 0, ...block);
    }
    out[file] = lines.join('\n');
  }
  return out;
}

// ------------------------------------------------------------------ fold

function fold(dryRun) {
  const fragments = loadFragments();
  if (fragments.length === 0) {
    console.log('No docs fragments to fold.');
    return;
  }
  const result = applyAll(fragments, (f) => fs.readFileSync(path.join(root, f), 'utf8'));
  if (dryRun) {
    for (const f of fragments) console.log(`would fold ${f.rel} -> ${f.file} (${f.section ? `section: ${f.section}` : `after: ${f.after}`})`);
    return;
  }
  for (const [file, text] of Object.entries(result)) fs.writeFileSync(path.join(root, file), text);
  for (const f of fragments) fs.unlinkSync(path.join(root, f.rel));
  console.log(`Folded ${fragments.length} docs fragment(s):`);
  for (const f of fragments) console.log(`  ${f.rel} -> ${f.file}`);
}

// ----------------------------------------------------------------- check

function check(base, maintainer) {
  const problems = [];
  const fragments = [];
  const readDoc = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  // Check each fragment on its own so one bad file doesn't hide the others.
  for (const name of fs.readdirSync(path.join(root, DIR)).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()) {
    const rel = `${DIR}/${name}`;
    try {
      const f = parseFragment(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
      applyAll([f], readDoc);
      fragments.push(f);
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (!problems.length) {
    try { applyAll(fragments, readDoc); } catch (e) { problems.push(e.message); }
  }

  if (!maintainer) {
    const mergeBase = git('merge-base', base, 'HEAD').trim();
    for (const file of PROTECTED) {
      const diff = git('diff', '-U0', '--no-color', mergeBase, 'HEAD', '--', file);
      for (const m of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const removed = m[1] === undefined ? 1 : Number(m[1]);
        const added = m[3] === undefined ? 1 : Number(m[3]);
        if (added > removed) {
          const start = Number(m[2]);
          problems.push(
            `${file}: ${added === 1 ? `line ${start} adds` : `lines ${start}-${start + added - 1} add`} ${added - removed} new line(s). ` +
            `Put new content in a fragment under ${DIR}/ instead (see ${DIR}/README.md); ` +
            `changing existing lines in place is fine.`,
          );
        }
      }
    }
  }

  if (problems.length) {
    console.error('Docs fragments check failed:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nWhy: new lines in shared docs make every other open PR conflict. See ${DIR}/README.md.`);
    process.exit(1);
  }
  console.log(`Docs fragments OK (${fragments.length} pending fragment(s) fold cleanly${maintainer ? '; protected-doc rule skipped for a maintainer' : ''}).`);
}

// ------------------------------------------------------------------ main

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'fold') fold(rest.includes('--dry-run'));
  else if (cmd === 'check' && rest[0]) check(rest[0], rest.includes('--maintainer'));
  else {
    console.error('usage: node scripts/docs-fragments.mjs fold [--dry-run]\n       node scripts/docs-fragments.mjs check <base-ref> [--maintainer]');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
