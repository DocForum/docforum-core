#!/usr/bin/env node
// Fails when the backend reads an environment variable that `.env.example`
// does not document (issue #344). Run from backend/: `npm run check:env`.
//
// Detected reads in src/:
//   process.env.NAME, process.env['NAME'], requireEnv('NAME'),
//   env.NAME (functions that take a ProcessEnv argument, e.g. parsePaymentsConfig),
//   NAME: z.… keys of zod schemas parsed from process.env under src/config/.
// A variable counts as documented when `.env.example` has a `NAME=` line,
// commented out (`# NAME=`) or not. Names built at runtime (template
// literals such as JWT_${prefix}_SECRET) cannot be detected; document them by
// hand.
//
// Options (used by tests): --src <dir> --env-file <file>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
}

// Set by the runtime or the platform, not by operators.
const IGNORED = new Set(['NODE_ENV']);

const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /requireEnv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
  /\benv\.([A-Z][A-Z0-9_]*)/g,
];
const SCHEMA_KEY = /^\s*([A-Z][A-Z0-9_]+)\s*:\s*(?:z\.|optional\w*)/gm;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage', 'generated'].includes(entry.name)) walk(full, out);
    } else if (/\.(c|m)?(t|j)s$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

export function documentedVars(envExample) {
  const names = new Set();
  for (const line of envExample.split('\n')) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

export function readVars(srcDir) {
  const found = new Map();
  const add = (name, file) => {
    if (!found.has(name)) found.set(name, path.relative(srcDir, file));
  };
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const re of READ_PATTERNS) for (const m of content.matchAll(re)) add(m[1], file);
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    if (rel.startsWith('config/') && content.includes('process.env')) {
      for (const m of content.matchAll(SCHEMA_KEY)) add(m[1], file);
    }
  }
  return found;
}

function main() {
  const srcDir = arg('--src', path.join(backendDir, 'src'));
  const envFile = arg('--env-file', path.join(backendDir, '.env.example'));
  if (!fs.existsSync(envFile)) {
    console.error(`check-env-parity: ${envFile} not found`);
    process.exit(1);
  }
  const documented = documentedVars(fs.readFileSync(envFile, 'utf8'));
  const missing = [...readVars(srcDir)]
    .filter(([name]) => !documented.has(name) && !IGNORED.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
  if (missing.length > 0) {
    console.error(`check-env-parity: ${missing.length} variable(s) read in src/ but missing from .env.example:`);
    for (const [name, file] of missing) console.error(`  ${name}  (${file})`);
    console.error('Add each one to .env.example with a one-line comment and a safe default or placeholder.');
    process.exit(1);
  }
  console.log('check-env-parity: .env.example documents every variable read in src/.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
