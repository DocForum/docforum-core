// CI gate: `npm audit --omit=dev` at high severity — Phase 8, issue #47.
//
// Why a wrapper instead of calling `npm audit --omit=dev --audit-level=high`
// directly in the workflow: one high-severity chain survives the Prisma
// upgrade and cannot be fixed from this repository at all, so the raw command
// would leave CI permanently red and the gate would get deleted rather than
// heeded. This script runs the same audit and fails on *any* high or critical
// advisory that is not in the explicit, reviewed list below — so a newly
// introduced vulnerable package still fails the build (try it: add any
// package with a high advisory and this exits 1), while the one known,
// tracked, third-party-controlled finding does not mask everything behind it.
//
// Usage: node scripts/audit-gate.mjs   (wired up as `npm run audit:prod`)
import { spawnSync } from 'node:child_process';

/**
 * Advisories we knowingly tolerate, keyed by GitHub advisory id.
 *
 * Every entry here must be an unfixable transitive dependency with a
 * documented owner. Nothing may be added to this list to silence a finding
 * that a dependency bump would clear.
 *
 * The whole list is the single axios dependency of @stellar/stellar-sdk, which
 * @docforum/escrow-sdk (a GitHub-release tarball, sdk-v0.2.0 — the latest
 * published release as of this change) pins to `^16.0.1`. Every 16.x release
 * depends on a vulnerable axios, and the fix requires `@stellar/stellar-sdk`
 * >= 17.0.2, which is outside that range. So the remedy lives in the
 * docforum-escrow repo, not here — this repo cannot resolve it by any version
 * bump of its own. Tracked upstream; delete these entries once the escrow SDK
 * ships a release built on a patched stellar-sdk.
 *
 * (Deliberately NOT worked around with a package.json `overrides` pin: that
 * would force an unverifiable axios version underneath a third-party SDK's
 * exact pin, and the payments path it feeds can only be exercised by the
 * credential-gated testnet test.)
 */
const TOLERATED_ADVISORIES = new Map([
  ['GHSA-vh66-26gq-q6x8', 'axios — prototype pollution gadget in fetch adapter'],
  ['GHSA-9fr6-4gfg-395g', 'axios — prototype-pollution gadget overrides HTTP method'],
  ['GHSA-c29m-xwm3-cm6r', 'axios — ReDoS in the fromDataURI data: URL parser'],
  ['GHSA-mghh-pgcx-3jjj', 'axios — ReDoS in shouldBypassProxy host normalisation'],
  ['GHSA-x97p-jq2g-jp4f', 'axios — prototype pollution gadget in toFormData options'],
  ['GHSA-3pq3-5fj3-cg6v', 'axios — HTTP/2 adapter bypasses DNS lookup and proxy controls'],
  ['GHSA-542g-h47m-68v8', 'axios — DoS via unhandled error event in HTTP/2 session init'],
  ['GHSA-j8rh-479h-cp32', 'axios — header injection via inherited headers'],
  ['GHSA-4hqw-qxg8-jxx2', 'axios — fetch adapter header injection via inherited FormData'],
  ['GHSA-m8m8-qj5v-23w3', 'axios — prototype-pollution gadget allowing socket hijack'],
  ['GHSA-44g4-m2mj-wpvx', 'axios — CIDR-form NO_PROXY entries ignored (proxy bypass)'],
  ['GHSA-r4gj-5m52-g5wh', 'axios — maxRedirects: 0 not enforced by the fetch adapter (SSRF)'],
]);

// `npm audit` exits non-zero when it finds anything, so capture stdout from the
// result rather than letting execSync throw the report away.
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf-8' });

if (!audit.stdout) {
  console.error('audit-gate: `npm audit --omit=dev --json` produced no output.');
  console.error(audit.stderr || '(no stderr)');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error('audit-gate: could not parse npm audit JSON output.');
  process.exit(1);
}

const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  if (vulnerability.severity !== 'high' && vulnerability.severity !== 'critical') continue;
  for (const via of vulnerability.via ?? []) {
    // String entries reference another vulnerable package in the chain; the
    // object entries carry the actual advisory.
    if (typeof via === 'string' || !via.url) continue;
    const id = via.url.split('/').pop();
    advisories.set(id, { severity: vulnerability.severity, title: via.title, url: via.url });
  }
}

const unexpected = [...advisories.entries()].filter(([id]) => !TOLERATED_ADVISORIES.has(id));
const tolerated = [...advisories.entries()].filter(([id]) => TOLERATED_ADVISORIES.has(id));

if (tolerated.length > 0) {
  console.log(`audit-gate: ${tolerated.length} high-severity advisory(ies) tolerated by policy:`);
  for (const [id, advisory] of tolerated) console.log(`  - ${id} (${advisory.severity}): ${advisory.title}`);
}

if (unexpected.length > 0) {
  console.error(`\naudit-gate: FAILED — ${unexpected.length} un-tolerated high/critical advisory(ies) in production dependencies:`);
  for (const [id, advisory] of unexpected) {
    console.error(`  - ${id} (${advisory.severity}): ${advisory.title}\n    ${advisory.url}`);
  }
  console.error('\nFix the dependency, or — only if it is genuinely unfixable from this repo — add the advisory id to TOLERATED_ADVISORIES with a documented owner.');
  process.exit(1);
}

console.log('audit-gate: PASSED — no un-tolerated high/critical advisories in production dependencies.');
