#!/usr/bin/env node
// Pulls this site's content from each repo's own real docs — never a
// hand-maintained copy. Runs before every dev/build (see package.json).
// Everything it writes lands under docs/site/{product,architecture,api,
// roadmap,runbooks,repos}/ and is gitignored: the deployed site is always
// built fresh from whatever's actually on `main` in each repo right now,
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
  // Local files get the same rewrite as remote ones: a repo-relative link
  // (e.g. ROADMAP.md -> docs/adr/0017-...md) has no page in the site.
  const content = rewriteRelativeLinks(await readFile(src, 'utf8'), 'docforum-core');
  await writeFile(dest, content);
  console.log(`  synced (local)  ${from} -> docs/site/${to}`);
}

// Synced files link relative to their own repo root (./ROADMAP.md,
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
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(url);
      break;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`  SKIPPED (${err.message}) ${repo}/${filePath} — network error after 3 attempts`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (!res || !res.ok) {
    console.warn(`  SKIPPED (${res?.status}) ${repo}/${filePath} — file may not exist on main`);
    return;
  }
  const content = rewriteRelativeLinks(await res.text(), repo);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
  console.log(`  synced (remote) ${repo}/${filePath} -> docs/site/${to}`);
}

async function syncOpenApiAndApiPages() {
  const openapiSrc = path.join(CORE_ROOT, 'backend/openapi.json');
  if (!existsSync(openapiSrc)) {
    throw new Error('Build failed: backend/openapi.json does not exist');
  }

  const rawSpec = await readFile(openapiSrc, 'utf8');
  let parsedSpec;
  try {
    parsedSpec = JSON.parse(rawSpec);
  } catch (err) {
    throw new Error(`Build failed: backend/openapi.json is not valid JSON: ${err.message}`);
  }

  if (!parsedSpec.openapi || !parsedSpec.openapi.startsWith('3.')) {
    throw new Error(`Build failed: backend/openapi.json missing valid OpenAPI 3.x version: ${parsedSpec.openapi}`);
  }

  if (!parsedSpec.info?.title) {
    throw new Error('Build failed: backend/openapi.json missing info.title');
  }

  if (!parsedSpec.paths || typeof parsedSpec.paths !== 'object' || Object.keys(parsedSpec.paths).length === 0) {
    throw new Error('Build failed: backend/openapi.json has no paths defined');
  }

  console.log(`  validated backend/openapi.json (${Object.keys(parsedSpec.paths).length} paths)`);

  const publicDest = path.join(SITE_ROOT, 'public/openapi.json');
  await mkdir(path.dirname(publicDest), { recursive: true });
  await writeFile(publicDest, rawSpec);
  console.log('  synced (local)  backend/openapi.json -> docs/site/public/openapi.json');

  // 1. Narrative API Reference (formerly the hand-maintained reference)
  await copyLocal('docs/api/README.md', 'api/narrative.md');

  // 2. Interactive Reference page (renders OpenAPI spec)
  const referenceContent = `---
title: Interactive API Reference
outline: false
---

# Interactive API Reference

Interactive API reference rendered from the OpenAPI 3 specification.
Explore endpoints, request payloads, and response status codes below.

- [Narrative API Documentation](./narrative.md) — Module overview and architectural background
- [Error Catalogue](./errors.md) — Standardized error codes and troubleshooting

<ClientOnly>
  <ApiReference />
</ClientOnly>
`;
  const referenceDest = path.join(SITE_ROOT, 'api/reference.md');
  await mkdir(path.dirname(referenceDest), { recursive: true });
  await writeFile(referenceDest, referenceContent);
  console.log('  synced (local)  generated -> docs/site/api/reference.md');

  // 3. Error catalogue page — generated from backend/src/error-catalogue.ts
  // by `npm run errors:catalogue` in backend/. Never hand-write codes here: a
  // stale hand-maintained list drifted from the real API once already.
  const errorsSource = path.join(CORE_ROOT, 'docs/api/error-catalogue.md');
  if (!existsSync(errorsSource)) {
    throw new Error(
      'Build failed: docs/api/error-catalogue.md does not exist — run `npm run errors:catalogue` in backend/',
    );
  }
  const errorsBody = await readFile(errorsSource, 'utf8');
  const errorsContent = `---\ntitle: Error catalogue\noutline: deep\n---\n\n${errorsBody}`;
  const errorsDest = path.join(SITE_ROOT, 'api/errors.md');
  await mkdir(path.dirname(errorsDest), { recursive: true });
  await writeFile(errorsDest, errorsContent);
  console.log('  synced (local)  generated -> docs/site/api/errors.md');
}

async function main() {
  console.log('Syncing docs-site content from source-of-truth files...\n');

  console.log('docforum-core (local — this repo):');
  await copyLocal('PRD.md', 'product/prd.md');
  await copyLocal('ARCHITECTURE.md', 'architecture/overview.md');
  await copyLocal('ARCHITECTURE_ESSENTIALS.md', 'architecture/essentials.md');
  await copyLocal('ROADMAP.md', 'roadmap/core.md');
  await syncOpenApiAndApiPages();
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
  await copyLocal(
    'docs/adr/0005-non-custodial-patient-payments.md',
    'architecture/adr/0005-non-custodial-patient-payments.md',
  );

  console.log('\nOperator runbooks (local — docs/runbooks/):');
  await copyLocal(
    'docs/runbooks/escrow-event-alerts.md',
    'runbooks/escrow-event-alerts.md',
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
