// Fails (exit 1) when an editor backup or merge artefact is tracked
// (issue #298): `*.bak`, `*.orig`, `*.rej`. These show up in code search,
// confuse contributors about which file is live, and carry stale code into
// reviews.
//
// Runs against the git index, so it catches files committed by any PR on the
// `Frontend` job, not just the ones that happen to be in a build.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const FORBIDDEN = /\.(bak|orig|rej)$/i;

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => Boolean(file) && existsSync(file));

const offenders = tracked.filter((file) => FORBIDDEN.test(file));

if (offenders.length > 0) {
  console.error('✗ editor backup / merge artefacts are tracked:');
  for (const file of offenders) console.error(`  - ${file}`);
  console.error('\nDelete them and add the pattern to .gitignore.');
  process.exit(1);
}

console.log(`✓ no backup files tracked (${tracked.length} files checked)`);
