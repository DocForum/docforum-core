import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * Generates docs/api/openapi.json (OpenAPI 3.1) from the Zod schemas
 * declared in backend/src/modules/validation.ts and the route registry.
 *
 * Usage:
 *   node backend/scripts/generate-openapi.mjs
 *   node backend/scripts/generate-openapi.mjs --check
 *     (exits 1 if the committed file is out of date)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_PATH = resolve(REPO_ROOT, 'docs', 'api', 'openapi.json');

// -----------------------------------------------------------------------------
// Zod -> JSON Schema conversion (zod-to-json-schema is not a dependency,
// so we implement the subset we actually use. This keeps the generator
// dependency-free and the output deterministic.)
// -----------------------------------------------------------------------------

function unwrap(schema) {
  // ZzoObject has _defInfo and shape; ZodString has _defInfo.typeName == 'ZodString'
  // We inspect the internal shape rather than depending on zod-to-json-schema.
  if (!schema || typeof schema !== 'object') return { type: 'unknown' };
  const def = schema._defInfo || {};
  const typeName = def.typeName;

  if (typeName === 'ZodString') {
    const out = { type: 'string' };
    const checks = def.checks || [];
    for (const c of checks) {
      if (c.kind === 'min' && typeof c.value === 'number') out.minLength = c.value;
      if (c.kind === 'max' && typeof c.value === 'number') out.maxLength = c.value;
      if (c.kind === 'regex' && c.regex) out.pattern = c.regex.source;
      if (c.kind === 'email') out.format = 'email';
      if (c.kind === 'url') out.format = 'uri';
      if (c.kind === 'datetime') out.format = 'date-time';
      if (c.kind === 'date') out.format = 'date';
    }
    return out;
  }

  if (typeName === 'ZodNumber') {
    const out = { type: 'number' };
    const checks = def.checks || [];
    for (const c of checks) {
      if (c.kind === 'min' && typeof c.value === 'number') out.minimum = c.value;
      if (c.kind === 'max' && typeof c.value === 'number') out.maximum = c.value;
      if (c.kind === 'int') out.type = 'integer';
    }
    return out;
  }

  if (typeName === 'ZodBigInt') {
    // BigInt fields (payment amounts) are serialised as strings.
    return { type: 'string', pattern: '^[0-9]+$', description: 'BigInt serialised as a string' };
  }

  if (typeName === 'ZodBoolean') return { type: 'boolean' };
  if (typeName === 'ZodDate') return { type: 'string', format: 'date-time' };
  if (typeName === 'ZodEnum') {
    const values = def.values ? Array.from(def.values) : [];
    return { type: 'string', enum: values };
  }
  if (typeName === 'ZodLiteral') {
    const v = def.value;
    return { const: v, type: typeof v === 'number' ? 'number' : typeof v };
  }
  if (typeName === 'ZodArray') {
    return { type: 'array', items: unwrap(def.type) };
  }
  if (typeName === 'ZodObject') {
    const shape = def.shape ? def.shape() : {};
    const properties = {};
    const required = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = unwrap(val);
      const isOptional = val._defInfo && val._defInfo.isOptional;
      if (!isOptional) required.push(key);
    }
    const out = { type: 'object', properties };
    if (required.length) out.required = required;
    return out;
  }
  if (typeName === 'ZodOptional') {
    return unwrap(def.innerType);
  }
  if (typeName === 'ZodNullable') {
    const inner = unwrap(def.innerType);
    return { anyOf: [inner, { type: 'null' }] };
  }
  if (typeName === 'ZodDefault') {
    return unwrap(def.innerType);
  }
  if (typeName === 'ZodUnion') {
    const options = def.options || [];
    return { anyOf: options.map(unwrap) };
  }
  if (typeName === 'ZodRecord') {
    return { type: 'object', additionalProperties: unwrap(def.valueType) };
  }
  return { type: 'unknown' };
}

// -----------------------------------------------------------------------------
// Route registry. Each module exports a descriptor from its routes/
// directory; the generator imports them and merges them into one spec.
// This keeps the spec colocated with the routes that implement it.
// -----------------------------------------------------------------------------

const MODULES = [
  'auth',
  'doctors',
  'availability',
  'appointments',
  'orders',
  'payments',
  'patients',
  'users',
  'audit',
  'referrals',
  'consultations',
];

async function loadRouteDescriptors() {
  const descriptors = [];
  for (const mod of MODULES) {
    const candidate = resolve(REPO_ROOT, 'backend', 'src', 'modules', mod, 'routes', 'openapi.mjs');
    if (existsSync(candidate)) {
      const imported = await import(candidate.href);
      if (imported.default) descriptors.push(...imported.default);
    }
  }
  return descriptors;
}

// -----------------------------------------------------------------------------
// Spec assembly
// -----------------------------------------------------------------------------

const ERROR_ENVELOPE = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    code: { type: 'string' },
    requestId: { type: 'string' },
  },
  required: ['message'],
};

function buildSpec(routes) {
  const paths = {};
  const schemas = {
    Error: ERROR_ENVELOPE,
  };

  for (const route of routes) {
    const pathItem = (paths[route.path] = paths[route.path] || {});
    const operation = {
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      operationId: route.operationId,
      responses: {},
    };

    if (route.adminOnly) {
      operation.security = [{ bearerAuth: [] }];
      operation.description = (operation.description || '') + '\n\n**Admin-only.**';
    } else if (route.auth) {
      operation.security = [{ bearerAuth: [] }];
    }

    if (route.requestBody) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': { schema: unwrap(route.requestBody) },
        },
      };
    }

    for (const [status, response] of Object.entries(route.responses || {})) {
      const entry = { description: response.description || '' };
      if (response.schema) {
        entry.content = {
          'application/json': { schema: unwrap(response.schema) },
        };
      }
      operation.responses[status] = entry;
    }

    // Every operation gets a default error response so clients can rely on the envelope.
    if (!operation.responses['400']) {
      operation.responses['400'] = {
        description: 'Error envelope',
        content: { 'application/json': { schema: ERROR_ENVELOPE } },
      };
    }

    pathItem[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'DocForum API',
      version: '0.1.0',
      description:
        'Generated from the Zod schemas in backend/src/modules/*/validation.ts. ' +
        'Do not edit by hand - run `node backend/scripts/generate-openapi.mjs`.',
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Local dev' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas,
    },
    paths,
  };
}

function stableStringify(obj) {
  // Sort keys recursively so the output is deterministic and the drift
  // check doesn't flicker on key ordering.
  if (Array.isArray(obj)) return obj.map(stableStringify);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const key of Object.keys(obj).sort()) out[key] = stableStringify(obj[key]);
    return out;
  }
  return obj;
}

async function main() {
  const checkMode = process.argv.includes('--check');
  const routes = await loadRouteDescriptors();
  const spec = buildSpec(routes);
  const json = JSON.stringify(stableStringify(spec), null, 2) + '\n';

  if (checkMode) {
    if (!existsSync(OUT_PATH)) {
      console.error('docs/api/openapi.json is missing. Run the generator.');
      process.exit(1);
    }
    const committed = readFileSync(OUT_PATH, 'utf8');
    if (committed !== json) {
      console.error('docs/api/openapi.json is out of date. Run `node backend/scripts/generate-openapi.mjs` and commit the result.');
      process.exit(1);
    }
    console.log('OpenAPI spec is up to date.');
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json, 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
