#!/usr/bin/env node
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

const openapi = JSON.parse(readFileSync(join(root, 'backend/openapi.json'), 'utf8'));
openapi.openapi = '3.1.0';
openapi.info = { ...openapi.info, version: '1.1.0' };
openapi.components = { ...openapi.components, responses: { ...(openapi.components?.responses ?? {}), Unauthorized: { description: 'Authentication required.' } } };
openapi.tags = [...new Map([...(openapi.tags ?? []), { name: 'Notifications' }].map((tag) => [tag.name, tag])).values()];
openapi.paths = {
  ...openapi.paths,
  '/notifications': { get: { tags: ['Notifications'], summary: 'List the authenticated user notifications', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Notification page' }, 401: { $ref: '#/components/responses/Unauthorized' } } } },
  '/notifications/unread-count': { get: { tags: ['Notifications'], summary: 'Get unread notification count', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Unread count' } } } },
  '/notifications/{id}/read': { post: { tags: ['Notifications'], summary: 'Mark a notification read', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Updated notification' } } } },
  '/notifications/webhooks/postmark': { post: { tags: ['Notifications'], summary: 'Receive signed Postmark delivery events', security: [], responses: { 204: { description: 'Accepted' }, 401: { description: 'Invalid signature' } } } },
  '/notifications/webhooks/twilio': { post: { tags: ['Notifications'], summary: 'Receive signed Twilio delivery and opt-out events', security: [], responses: { 204: { description: 'Accepted' }, 401: { description: 'Invalid signature' } } } },
  '/calendar/{token}.ics': {
    get: {
      tags: ['appointments'],
      summary: 'Read the doctor calendar subscription feed',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } }],
      responses: {
        200: {
          description: 'PHI-free iCalendar feed',
          headers: {
            ETag: { schema: { type: 'string' } },
            'Last-Modified': { schema: { type: 'string' } },
          },
          content: { 'text/calendar': { schema: { type: 'string' } } },
        },
        304: {
          description: 'Feed has not changed',
          headers: {
            ETag: { schema: { type: 'string' } },
            'Last-Modified': { schema: { type: 'string' } },
          },
        },
        404: { description: 'Unknown or revoked feed token' },
      },
    },
  },
  '/doctors/me/calendar-feed': {
    post: {
      tags: ['doctors'],
      summary: 'Rotate the caller’s calendar feed URL',
      security: [{ bearerAuth: [] }],
      responses: {
        201: {
          description: 'New subscription URL (returned once)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { feedUrl: { type: 'string', format: 'uri' } },
                required: ['feedUrl'],
              },
            },
          },
        },
        401: { description: 'Authentication required' },
      },
    },
    delete: {
      tags: ['doctors'],
      summary: 'Revoke the caller’s calendar feed URL',
      security: [{ bearerAuth: [] }],
      responses: { 204: { description: 'Feed URL revoked' }, 401: { description: 'Authentication required' } },
    },
  },
};

// Route files are the authoritative registration point in the modular
// backend. Preserve hand-authored Zod-derived detail above while discovering
// newly mounted routes so an endpoint cannot silently be absent from the
// committed contract.
const moduleRoot = join(root, 'backend/src/modules');
const mountPrefixes = new Map();
const routePrefixOverrides = new Map();
for (const module of readdirSync(moduleRoot, { withFileTypes: true })) {
  if (!module.isDirectory()) continue;
  let mount;
  try { mount = readFileSync(join(moduleRoot, module.name, 'mount.ts'), 'utf8'); } catch { continue; }
  const prefix = mount.match(/app\.use\(['"]([^'"]+)['"]/u)?.[1];
  if (prefix) mountPrefixes.set(module.name, prefix);
  if (module.name === 'appointments') {
    // The calendar feed is a root-level sibling router in this module.
    const calendarPrefix = mount.match(/app\.use\(['"]([^'"]+)['"]\s*,\s*calendarRouter/u)?.[1];
    if (calendarPrefix) routePrefixOverrides.set(module.name, new Map([['calendarRouter', calendarPrefix]]));
  }
}
for (const module of readdirSync(moduleRoot, { withFileTypes: true })) {
  if (!module.isDirectory()) continue;
  const routesDir = join(moduleRoot, module.name, 'routes');
  let files;
  try { files = readdirSync(routesDir).filter((file) => file.endsWith('.ts')); } catch { continue; }
  for (const file of files) {
    const source = readFileSync(join(routesDir, file), 'utf8');
    const prefix = mountPrefixes.get(module.name) ?? '';
    for (const match of source.matchAll(/([A-Za-z0-9_]+)\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]/gu)) {
      const router = match[1];
      const method = match[2];
      const route = match[3];
      const routerPrefix = routePrefixOverrides.get(module.name)?.get(router) ?? prefix;
      const normalizedRoute = router === 'calendarRouter' ? route.replace(':token', '{token}') : route;
      const path = `${routerPrefix}${normalizedRoute === '/' ? '' : normalizedRoute}`.replaceAll('//', '/');
      openapi.paths[path] ??= {};
      openapi.paths[path][method] ??= {
        tags: [module.name],
        operationId: `${module.name}_${method}_${path.replace(/[^a-zA-Z0-9]+/gu, '_').replace(/^_|_$/gu, '') || 'root'}`,
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Successful response' }, 400: { description: 'Validation error' }, 401: { description: 'Authentication required' } },
        ...(method === 'post' || method === 'put' || method === 'patch' ? { requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } : {}),
      };
    }
  }
}

// Write spec
writeFileSync(join(root, 'backend/openapi.json'), JSON.stringify(openapi, null, 2));

console.log('OpenAPI spec generated from the checked-in route/schema registry.');
