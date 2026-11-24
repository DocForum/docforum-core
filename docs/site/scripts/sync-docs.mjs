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

  // 3. Error Catalogue page
  const errorsContent = `---
title: Error Catalogue
outline: deep
---

# Error Catalogue

Standardized error codes returned across DocForum API endpoints, grouped by domain. All error responses follow the standard error envelope:

\`\`\`json
{
  "message": "Human-readable description of the error",
  "code": "ERROR_CODE",
  "details": {}
}
\`\`\`

## Authentication & Session Errors {#auth-errors}

### \`AUTH_INVALID_CREDENTIALS\`
- **HTTP Status:** 401 Unauthorized
- **Description:** Incorrect email or password provided during sign in.
- **Resolution:** Verify credentials and retry. Repeated failures will trigger rate limiting.

### \`ACCOUNT_DEACTIVATED\`
- **HTTP Status:** 403 Forbidden
- **Description:** Account has been administratively deactivated.
- **Resolution:** Contact platform administration to review account status.

### \`UNAUTHORIZED\`
- **HTTP Status:** 401 Unauthorized
- **Description:** Missing, expired, or invalid bearer token or session cookie.
- **Resolution:** Obtain a fresh access token via \`POST /auth/login\` or \`POST /auth/refresh\`.

### \`FORBIDDEN\`
- **HTTP Status:** 403 Forbidden
- **Description:** The authenticated user does not have sufficient role permissions for this resource.

## Password & Validation Errors {#password-errors}

### \`PASSWORD_TOO_LONG\`
- **HTTP Status:** 400 Bad Request
- **Description:** Password exceeds maximum allowed size of 72 UTF-8 bytes (Bcrypt password length bound).
- **Resolution:** Choose a password containing 72 UTF-8 bytes or fewer.

### \`PASSWORD_COMMONLY_BREACHED\`
- **HTTP Status:** 400 Bad Request
- **Description:** Password matches an entry in the static denylist of commonly breached passwords.
- **Resolution:** Choose a unique, non-trivial passphrase.

### \`PASSWORD_TOO_SHORT\`
- **HTTP Status:** 400 Bad Request
- **Description:** Password is shorter than the required minimum of 8 characters.
- **Resolution:** Choose a password with at least 8 characters.

### \`PASSWORD_UNCHANGED\`
- **HTTP Status:** 400 Bad Request
- **Description:** In \`POST /auth/password\`, the new password is identical to the current password.
- **Resolution:** Enter a different new password.

### \`VALIDATION_ERROR\` {#validation-errors}
- **HTTP Status:** 400 Bad Request
- **Description:** Request payload failed schema validation.
- **Resolution:** Check field constraints in the endpoint documentation and the returned \`details\` object.

## Email Verification & Invites {#email-errors}

### \`EMAIL_NOT_VERIFIED\`
- **HTTP Status:** 403 Forbidden
- **Description:** Account email address has not been verified. Mutating clinical and payment actions are gated on email verification.
- **Resolution:** Complete verification via the link sent to your registered email address, or request a new link via \`POST /auth/verify-email/resend\`.

### \`EMAIL_ALREADY_VERIFIED\`
- **HTTP Status:** 409 Conflict
- **Description:** Attempted to resend verification or verify an already verified address.

### \`EMAIL_ALREADY_REGISTERED\`
- **HTTP Status:** 409 Conflict
- **Description:** An account with this email address already exists (case-insensitive matching).
- **Resolution:** Sign in to the existing account or use a different email address.

### \`INVALID_VERIFICATION_TOKEN\`
- **HTTP Status:** 400 Bad Request
- **Description:** The verification token is invalid, unrecognized, or already consumed.

### \`VERIFICATION_TOKEN_EXPIRED\`
- **HTTP Status:** 400 Bad Request
- **Description:** The verification token has expired. Request a new token via \`POST /auth/verify-email/resend\`.

### \`INVITE_REVOKED\`
- **HTTP Status:** 400 Bad Request
- **Description:** The admin invite token was revoked by an administrator.

## Rate Limiting {#rate-limiting}

### \`RATE_LIMIT_EXCEEDED\`
- **HTTP Status:** 429 Too Many Requests
- **Description:** Client has exceeded the allowed request quota or failed login attempts threshold.
- **Resolution:** Wait for the window specified in the \`Retry-After\` header before retrying.

## Appointments & Clinical {#clinical-errors}

### \`SLOT_ALREADY_BOOKED\`
- **HTTP Status:** 409 Conflict
- **Description:** The requested appointment slot has already been booked by another patient.
- **Resolution:** Select another available availability slot from \`GET /availability/doctors/:id/slots\`.
`;
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
