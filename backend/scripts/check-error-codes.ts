// Fails when a `new HttpError(...)` in src/ has no catalogue code, or names a
// code the catalogue does not know (issue #115). This is the "reviewer greps
// for any remaining uncoded HttpError construction" check, automated.
//
//   npm run errors:lint
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isErrorCode } from '../src/error-catalogue';

const ROOT = resolve(process.cwd(), 'src');
const PROBLEMS: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

const CALL = /new HttpError\(\s*(?:(['"])([A-Z][A-Z0-9_]*)\1)?/g;

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  // Ignore prose in comments: only real constructions are checked.
  const withoutComments = src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  for (const match of withoutComments.matchAll(CALL)) {
    const code = match[2];
    const line = src.slice(0, match.index).split('\n').length;
    if (!code) {
      PROBLEMS.push(`${rel}:${line}: HttpError constructed without a catalogue code`);
    } else if (!isErrorCode(code)) {
      PROBLEMS.push(`${rel}:${line}: unknown error code ${code}`);
    }
  }
}

if (PROBLEMS.length > 0) {
  console.error(`${PROBLEMS.length} uncoded or unknown HttpError construction(s):`);
  for (const problem of PROBLEMS) console.error(`  ${problem}`);
  process.exit(1);
}

console.log('Every HttpError construction is coded and every code is in the catalogue.');
