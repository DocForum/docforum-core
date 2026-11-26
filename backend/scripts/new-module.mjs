#!/usr/bin/env node
// new-module.mjs — scaffold a backend module skeleton (issue #350).
//
// Usage:
//   npm run new:module -- <name>       # e.g. npm run new:module -- lab-kits
//
// Creates backend/src/modules/<name>/ with the four intentional folders
// (routes/controllers/services/repositories), validation.ts and mount.ts.
// It deliberately does NOT touch src/mounts.ts, src/export-sections.ts,
// src/retention-holds.ts or docs/api/README.md: those are shared wiring
// files, and adding lines to them is a maintainer/contributor decision.
// The exact lines to add are printed after generation instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODULES_ROOT = fileURLToPath(new URL('../src/modules', import.meta.url));
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Validate a module name before anything is written. Throws on bad input. */
export function validateModuleName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Module name is required and must be a lowercase kebab-case identifier (e.g. lab-kits).');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid module name "${name}": path separators are not allowed.`);
  }
  if (name.includes('..')) {
    throw new Error(`Invalid module name "${name}": ".." is not allowed.`);
  }
  if (name !== name.trim() || !KEBAB_CASE.test(name)) {
    throw new Error(
      `Invalid module name "${name}": use lowercase kebab-case (letters, digits and single hyphens; e.g. lab-kits).`,
    );
  }
  return name;
}

function camelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function pascalCase(name) {
  const camel = camelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function titleCase(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** The text a contributor must add to shared files. Printed, never applied. */
export function buildFollowUps(name) {
  const alias = camelCase(name);
  const Label = pascalCase(name);
  const docsSection = `${titleCase(name)} (/${name}) — backend/src/modules/${name}`;
  return `Manual follow-ups (not applied — shared files are edited by hand):

1. backend/src/mounts.ts — add this line in alphabetical order:
   export { mount as ${alias} } from './modules/${name}/mount';

2. src/export-sections.ts — ONLY if this module stores patient data. Export a
   PatientExportSection from services/ and add its import + array entry:
   import { ${alias}ExportSection } from './modules/${name}/services';
   // in PATIENT_EXPORT_SECTIONS:
   ${alias}ExportSection,

3. src/retention-holds.ts — ONLY if this module keeps patient-linked records
   (RESTRICT FK + a hold). Export the predicate from services/ and add:
   import { has${Label}RecordsForPatient } from './modules/${name}/services';
   // in RETENTION_HOLDS:
   { name: '${name}', holds: has${Label}RecordsForPatient },

4. docs/api/README.md — add API rows through a docs.d/ fragment when the
   first endpoint lands (docs.d/README.md):
   ---
   file: docs/api/README.md
   section: ${docsSection}
   ---
   | \`GET /${name}\` | — | — | Describe the first endpoint here. |
`;
}

function placeholderFiles(name) {
  const alias = camelCase(name);
  const Label = pascalCase(name);
  return {
    'mount.ts': `import type { Express } from 'express';
import { ${alias}Router } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // TODO: mount this module's routers once its first route exists.
  app.use('/${name}', ${alias}Router);
}
`,
    'validation.ts': `import { z } from 'zod';

/** Request schemas for the ${name} module (see modules/medications/validation.ts). */
// TODO: replace with the first real schema, e.g. z.object({ ... }).strict().
export const placeholderQuerySchema = z.object({}).strict();
`,
    'routes/index.ts': `import { Router } from 'express';

/** Routes for the ${name} module. Mounted by ../mount.ts (see src/mounts.ts). */
// TODO: add the first route, e.g.
// ${alias}Router.get('/', authenticate, ${alias}Controller.list);
export const ${alias}Router = Router();
`,
    'controllers/index.ts': `/** ${Label} HTTP handlers. Validate input with ../validation. */
// TODO: add the first handler and call this module's services/.
export {};
`,
    'services/index.ts': `/** ${Label} business logic — the only surface other modules may call (hard rule 4). */
// TODO: export service functions here; do not import another module's repositories.
export {};
`,
    'repositories/index.ts': `/** ${Label} data access. Never imported from another module (hard rule 4). */
// TODO: add queries here.
export {};
`,
  };
}

/**
 * Creates the skeleton under `options.modulesRoot` (defaults to the real
 * backend/src/modules). Returns the created paths and the follow-up text.
 * All validation and the collision check happen before any file is written.
 */
export function createModule(name, options = {}) {
  const validName = validateModuleName(name);
  const modulesRoot = options.modulesRoot ? path.resolve(options.modulesRoot) : DEFAULT_MODULES_ROOT;
  const directory = path.join(modulesRoot, validName);

  if (!fs.existsSync(modulesRoot)) {
    throw new Error(`Modules root does not exist: ${modulesRoot}`);
  }
  if (fs.existsSync(directory)) {
    throw new Error(`Module "${validName}" already exists at ${directory}; refusing to overwrite it.`);
  }

  fs.mkdirSync(directory);
  try {
    for (const [relativePath, contents] of Object.entries(placeholderFiles(validName))) {
      const target = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    name: validName,
    directory,
    files: Object.keys(placeholderFiles(validName)).sort(),
    followUps: buildFollowUps(validName),
  };
}

// Direct CLI invocation only — importing this module has no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: npm run new:module -- <name>   (e.g. npm run new:module -- lab-kits)');
    process.exitCode = 1;
  } else {
    try {
      const created = createModule(args[0]);
      console.log(`Created ${created.directory}/`);
      for (const file of created.files) console.log(`  ${file}`);
      console.log('');
      console.log(created.followUps);
    } catch (error) {
      console.error(`new:module: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
