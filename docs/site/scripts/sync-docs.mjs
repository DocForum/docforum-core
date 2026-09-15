#!/usr/bin/env node
// Pulls this site's content from each repo's own real docs — never a
// hand-maintained copy. Runs before every dev/build (see package.json).
// Everything it writes lands under docs/site/{product,architecture,api,
// roadmap,repos}/ and is gitignored: the deployed site is always built
// fresh from whatever's actually on `main` in each repo right now,
// there is no second copy to let drift.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_ROOT = path.resolve(SITE_ROOT, '../..');

async function copyLocal(from, to) {
  const src = path.join(CORE_ROOT, from);
  const dest = path.join(SITE_ROOT, to);
  await mkdir(path.dirname(dest), { recursive: true });
  const content = await readFile(src, 'utf8');
  await writeFile(dest, content);
  console.log(`  synced (local)  ${from} -> docs/site/${to}`);
}

// Synced READMEs link relative to their own repo root (./ROADMAP.md,
// docs/adr/foo.md, LICENSE, ...) — meaningless in the docs site's own
// structure. Rewrite anything that isn't already absolute (http/https)
// or a same-page anchor (#foo) to point at the real file on GitHub,
// preserving any #fragment. Without this, `vitepress build`'s dead-link
// check fails outright (correctly — those links really were dead).
function rewriteRelativeLinks(markdown, repo) {
  return markdown.replace(/\]\(([^)]+)\)/g, (match, target) => {
    if (/^(https?:|mailto:|#)/.test(target)) return match;
    const [filePart, fragment] = target.split('#');
    const cleanPath = filePart.replace(/^\.\//, '');
    const absolute = `https://github.com/DocForum/${repo}/blob/main/${cleanPath}`;
    return `](${absolute}${fragment ? `#${fragment}` : ''})`;
  });
}

async function fetchRemote(repo, filePath, to) {
  const url = `https://raw.githubusercontent.com/DocForum/${repo}/main/${filePath}`;
  const dest = path.join(SITE_ROOT, to);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  SKIPPED (${res.status}) ${repo}/${filePath} — file may not exist on main`);
    return;
  }
  const content = rewriteRelativeLinks(await res.text(), repo);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
  console.log(`  synced (remote) ${repo}/${filePath} -> docs/site/${to}`);
}

async function main() {
  console.log('Syncing docs-site content from source-of-truth files...\n');

  console.log('docforum-core (local — this repo):');
  await copyLocal('PRD.md', 'product/prd.md');
  await copyLocal('ARCHITECTURE.md', 'architecture/overview.md');
  await copyLocal('ARCHITECTURE_ESSENTIALS.md', 'architecture/essentials.md');
  await copyLocal('ROADMAP.md', 'roadmap/core.md');
  await copyLocal('docs/api/README.md', 'api/reference.md');
  await copyLocal('docs/adr/0001-modular-monolith.md', 'architecture/adr/0001-modular-monolith.md');
  await copyLocal(
    'docs/adr/0002-stellar-escrow-for-fulfillment-payout.md',
    'architecture/adr/0002-stellar-escrow-for-fulfillment-payout.md',
  );
  await copyLocal(
    'docs/adr/0003-render-preview-deployment.md',
    'architecture/adr/0003-render-preview-deployment.md',
  );
  await copyLocal(
    'docs/adr/0004-custodial-payments-v1.md',
    'architecture/adr/0004-custodial-payments-v1.md',
  );

  console.log('\ndocforum-web (remote — github.com/DocForum/docforum-web@main):');
  await fetchRemote('docforum-web', 'README.md', 'repos/web/readme.md');
  await fetchRemote('docforum-web', 'ARCHITECTURE_ESSENTIALS.md', 'repos/web/architecture.md');
  await fetchRemote('docforum-web', 'ROADMAP.md', 'repos/web/roadmap.md');

  console.log('\ndocforum-escrow (remote — github.com/DocForum/docforum-escrow@main):');
  await fetchRemote('docforum-escrow', 'README.md', 'repos/escrow/readme.md');
  await fetchRemote('docforum-escrow', 'ARCHITECTURE_ESSENTIALS.md', 'repos/escrow/architecture.md');
  await fetchRemote('docforum-escrow', 'ROADMAP.md', 'repos/escrow/roadmap.md');
  await fetchRemote(
    'docforum-escrow',
    'docs/adr/0001-generic-escrow-not-healthcare-specific.md',
    'repos/escrow/adr-0001.md',
  );
  await fetchRemote(
    'docforum-escrow',
    'docs/adr/0002-per-escrow-releaser-set-at-creation.md',
    'repos/escrow/adr-0002.md',
  );
  await fetchRemote(
    'docforum-escrow',
    'docs/adr/0003-sdk-distribution-github-release-tarball.md',
    'repos/escrow/adr-0003.md',
  );

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
