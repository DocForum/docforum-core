// Endpoint-by-role access matrix generator (issue #357).
//
//   npm run docs:access-matrix            # write docs/api/access-matrix.md
//   npm run docs:access-matrix:check      # fail if the committed file is stale
//
// Who can call what lives in `requireRole(...)` calls across ~20 module
// routers, and hand-written copies of that table go wrong quietly: a route
// gets a guard added and the doc says "doctor only" forever. So the doc is
// generated from the live app: `createApp()` is built, its router stack walked,
// and each route's middleware chain read back.
//
// Two Express 5 details shape how it works:
//   - the mount prefix is NOT recoverable from a layer (`layer.path` stays
//     undefined until a request matches, and layers keep compiled matchers
//     rather than a regexp). `src/mounts.ts` is the only place a prefix is
//     written, so the mounts are replayed against a spy app that records
//     `router -> prefix`, and the real stack's router layers are matched by
//     object identity.
//   - `requireRole(...)` returns an anonymous closure, so a role guard cannot
//     be found by function name. It is identified by source text against a
//     live canary (`requireRole('doctor')`) and its allowed roles are recovered
//     by *calling* it once per role: `next()` means that role passes, a throw
//     means it is rejected. Same fallback covers any other anonymous guard —
//     the chain never has to be named to be understood.
import express from 'express';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Role } from '@prisma/client';
import { createApp } from '../src/app.js';
import * as moduleMounts from '../src/mounts.js';
import { requireRole } from '../src/middleware/auth.js';

const ROLES: Role[] = ['patient', 'doctor', 'facility', 'admin'];
const OUTPUT_REL = join('..', 'docs', 'api', 'access-matrix.md');

/** Lazily derived: a test imports this module for the collector, and must not
 * evaluate script-location state to do it. */
export function outputPath(): string {
  return resolve(__dirname, '..', OUTPUT_REL);
}

type Handler = ((req: unknown, res: unknown, next: unknown) => unknown) & {
  stack?: Layer[];
  name?: string;
};
type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
  handle: Handler;
};

/** `router -> mount prefix`, read off `src/mounts.ts` by replaying it. */
function collectMountPrefixes(): Map<Handler, string> {
  const prefixes = new Map<Handler, string>();
  const spy = express() as unknown as { use: (...args: unknown[]) => unknown };
  const originalUse = spy.use.bind(spy);
  spy.use = (...args: unknown[]) => {
    const [first, second] = args as [unknown, unknown?];
    const path = typeof first === 'string' ? first : undefined;
    const handler = (path === undefined ? first : second) as Handler | undefined;
    if (path !== undefined && typeof handler === 'function' && Array.isArray(handler.stack)) {
      prefixes.set(handler, path);
    }
    return originalUse(...(args as [never]));
  };
  for (const mount of Object.values(moduleMounts) as ((app: unknown) => void)[]) {
    mount(spy);
  }
  return prefixes;
}

/**
 * Does this middleware reject some roles and accept others? `requireRole` is
 * the only guard in the app written that way, and asking it rather than
 * parsing it is what keeps the matrix honest when the closure is anonymous.
 * Returns null when the handler is not a role guard.
 */
function rolesAllowedBy(handler: Handler): Role[] | null {
  if (typeof handler !== 'function') return null;
  if (handler.toString() !== requireRole('doctor').toString()) return null;
  const allowed: Role[] = [];
  for (const role of ROLES) {
    let passed = false;
    try {
      handler({ user: { id: 'matrix-probe', role } }, {}, () => {
        passed = true;
      });
    } catch {
      passed = false;
    }
    if (passed) allowed.push(role);
  }
  return allowed;
}

/** A guard nobody has named (an inline arrow, a wrapper): report it exists. */
function displayName(handler: Handler): string {
  return handler.name || '(anonymous)';
}

export interface Endpoint {
  prefix: string;
  path: string;
  method: string;
  roles: Role[] | null;
  auth: string[];
  verifiedEmail: boolean;
  idempotency: boolean;
  otherGuards: string[];
}

/**
 * Walk one router's layers in registration order. A pathless `use(...)`
 * (Express marks it with `layer.slash === true`) guards every later route in
 * that router, so it is carried forward as `inherited`; route layers get the
 * inherited guards plus their own chain, whose last handler is the controller
 * and is therefore not a guard.
 */
function walkStack(stack: Layer[], prefix: string, inherited: Handler[], out: Endpoint[]): void {
  const guards = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const chain = [...guards, ...layer.route.stack.map((entry) => entry.handle)];
      const controller = chain.at(-1);
      const endpoint: Endpoint = {
        prefix,
        path: layer.route.path,
        method: Object.keys(layer.route.methods)
          .filter((method) => layer.route!.methods[method])
          .map((method) => method.toUpperCase())
          .join(','),
        roles: null,
        auth: [],
        verifiedEmail: false,
        idempotency: false,
        otherGuards: [],
      };
      for (const handler of chain) {
        if (handler === controller) continue;
        const roles = rolesAllowedBy(handler);
        if (roles) {
          endpoint.roles = [...new Set([...(endpoint.roles ?? []), ...roles])].sort();
          continue;
        }
        const name = displayName(handler);
        if (name === 'requireVerifiedEmail') endpoint.verifiedEmail = true;
        else if (name === 'idempotencyMiddleware') endpoint.idempotency = true;
        else if (name.startsWith('authenticate')) endpoint.auth.push(name);
        else endpoint.otherGuards.push(name);
      }
      out.push(endpoint);
      continue;
    }
    // A nested router (none exist today, per src/mounts.ts) carries its own
    // guards for its own routes only; anything else pathless is middleware.
    if (typeof layer.handle !== 'function') continue;
    if (Array.isArray(layer.handle.stack)) continue;
    guards.push(layer.handle);
  }
}

export function collectEndpoints(): { endpoints: Endpoint[]; appGuards: string[]; unidentified: string[] } {
  const prefixes = collectMountPrefixes();
  const app = createApp() as unknown as { router: { stack: Layer[] } };
  const endpoints: Endpoint[] = [];
  const appGuards: string[] = [];
  const unidentified: string[] = [];

  // App-level, pathless middleware (request id, security headers, CORS, body
  // parsing, the anonymous-RLS context) runs before every router below.
  const globalMiddleware = new Set<Handler>();
  for (const layer of app.router.stack) {
    if (layer.route || !layer.handle) continue;
    const prefix = prefixes.get(layer.handle);
    if (prefix !== undefined && Array.isArray(layer.handle.stack)) continue;
    globalMiddleware.add(layer.handle);
  }

  for (const layer of app.router.stack) {
    if (layer.route) {
      // Route defined straight on the app (the health endpoints).
      walkStack([layer], '', [], endpoints);
      continue;
    }
    const prefix = prefixes.get(layer.handle);
    if (prefix !== undefined && Array.isArray(layer.handle.stack)) {
      // A module router's own `router.use(guard)` lines are read inside its
      // own stack, so each router starts with a fresh guard list.
      walkStack(layer.handle.stack ?? [], prefix, [], endpoints);
      continue;
    }
    if (globalMiddleware.has(layer.handle)) {
      appGuards.push(displayName(layer.handle));
      continue;
    }
    unidentified.push(displayName(layer.handle));
  }
  return { endpoints, appGuards, unidentified };
}

export function joinPath(prefix: string, path: string): string {
  if (!prefix) return path === '/' ? '/' : path;
  if (path === '/' || path === '') return prefix;
  return `${prefix.replace(/\/$/, '')}${path}`;
}

const cell = (value: string) => value.replace(/\|/g, '\\|');

function renderTable(rows: Endpoint[]): string[] {
  const lines = [
    '| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const path = joinPath(row.prefix, row.path);
    lines.push(
      `| \`${cell(`${row.method} ${path}`)}\` | ${row.roles ? `\`${cell(row.roles.join(', '))}\`` : '_none_'} | ${
        row.auth.length ? row.auth.map((name) => `\`${name}\``).join(', ') : '—'
      } | ${row.verifiedEmail ? 'yes' : '—'} | ${row.idempotency ? 'yes' : '—'} | ${
        row.otherGuards.length ? row.otherGuards.map((name) => `\`${cell(name)}\``).join(', ') : '—'
      } |`,
    );
  }
  return lines;
}

export function render(): string {
  const { endpoints, appGuards, unidentified } = collectEndpoints();
  const groups = new Map<string, Endpoint[]>();
  for (const endpoint of endpoints) {
    const key = endpoint.prefix || '(app)';
    const group = groups.get(key);
    if (group) group.push(endpoint);
    else groups.set(key, [endpoint]);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === '(app)') return -1;
    if (b === '(app)') return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [
    '# Endpoint access matrix',
    '',
    '<!-- GENERATED FILE — do not edit.',
    '',
    'Built from the live app by `backend/scripts/gen-access-matrix.ts`',
    '(`npm run docs:access-matrix` in `backend/`). CI runs',
    '`npm run docs:access-matrix:check` and fails when this file no longer',
    'matches the routers, so a route and its documentation cannot drift apart.',
    '-->',
    '',
    'Which role gets past which route, read off the middleware chains in',
    '`backend/src/modules/*/routes` and the routers listed in',
    '`backend/src/mounts.ts`. Endpoint-level guards only — see the limits at',
    'the bottom before treating a row as a grant of access.',
    '',
    '`Roles` is the set `requireRole` admits (`_none_` = no `requireRole` in',
    'the chain, so any authenticated caller reaches the handler). `Verified',
    'email` and `Idempotency` are the two guards the write paths gate on',
    '(`requireVerifiedEmail`, `idempotencyMiddleware`). `Other guards` names',
    'anything else in the chain that is not a controller, including inline',
    'handlers Express cannot name, which appear as `(anonymous)`.',
    '',
    'Every route also passes the application middleware, in order:',
    '',
    ...[
      appGuards.length
        ? appGuards.map((name) => `\`${cell(name)}\``).join(', ')
        : '_none recorded_',
    ],
    '',
  ];

  for (const key of orderedKeys) {
    const rows = groups.get(key)!;
    lines.push('');
    lines.push(`## ${key === '(app)' ? 'Application routes' : `\`${key}\``}`);
    lines.push('');
    lines.push(...renderTable(rows));
  }

  const limits = [
    '- **Service-level ownership and state checks.** Most endpoints narrow access',
    '  after the handler starts — the patient id on `/appointments/mine`, "the',
    '  consultation must be yours" in consultations, "this referral is not for',
    '  you" in referrals, a facility\'s own orders, and the role-aware visibility',
    '  rules inside the read services. A row above says which role *reaches* the',
    '  handler, not which rows that handler will return or mutate.',
    '- **Idempotency keys and rate limits as semantics.** The `Idempotency` column',
    '  says the middleware runs, not which header it reads or what a replay does.',
    '- **Anything not in a chain.** Feature flags, `docs/api/README.md` prose,',
    '  and database RLS policies (`docs/adr/0014`) decide access too and are',
    '  invisible to a router walk.',
    '- **Role guards reached indirectly.** A guard wrapped by another function is',
    '  no longer recognisable as `requireRole` by source text, so its roles are',
    '  not inferred; the wrapper is listed under `Other guards` instead.',
  ];
  lines.push('');
  lines.push('## What this does not capture');
  lines.push('');
  lines.push(...limits);
  lines.push('');
  lines.push(
    unidentified.length
      ? `Router layers this script could not attribute to a mount or to application` +
        ` middleware: ${unidentified.map((name) => `\`${cell(name)}\``).join(', ')}.` +
        ' Check `backend/src/mounts.ts` if a route seems missing.'
      : 'Every router layer in the app was attributed to a mount prefix.',
  );
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const check = process.argv.includes('--check');
  const target = outputPath();
  const output = render();
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output);
    const endpoints = output.split('\n').filter((line) => line.startsWith('| `')).length;
    console.log(`gen-access-matrix: wrote ${OUTPUT_REL} (${endpoints} endpoints)`);
    return;
  }
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    console.error(`gen-access-matrix: ${OUTPUT_REL} is missing.`);
    process.exit(1);
  }
  if (committed !== output) {
    console.error(
      `gen-access-matrix: ${OUTPUT_REL} is stale — the routers no longer match the committed matrix.\n` +
        '       Run `npm run docs:access-matrix` in backend/ and commit the result.',
    );
    process.exit(1);
  }
  console.log(`gen-access-matrix: ${OUTPUT_REL} is up to date.`);
}

// Importing this module must not touch the filesystem: the unit test that
// pins the hand-checked rows pulls in the collector, and only a direct run of
// the script is the CLI.
if (require.main === module) main();
