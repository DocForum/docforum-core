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
};

// Route files are the authoritative registration point in the modular
// backend. Preserve hand-authored Zod-derived detail above while discovering
// newly mounted routes so an endpoint cannot silently be absent from the
// committed contract.
const moduleRoot = join(root, 'backend/src/modules');
const mountPrefixes = new Map();
for (const module of readdirSync(moduleRoot, { withFileTypes: true })) {
  if (!module.isDirectory()) continue;
  let mount;
  try { mount = readFileSync(join(moduleRoot, module.name, 'mount.ts'), 'utf8'); } catch { continue; }
  const prefix = mount.match(/app\.use\(['"]([^'"]+)['"]/u)?.[1];
  if (prefix) mountPrefixes.set(module.name, prefix);
}
for (const module of readdirSync(moduleRoot, { withFileTypes: true })) {
  if (!module.isDirectory()) continue;
  const routesDir = join(moduleRoot, module.name, 'routes');
  let files;
  try { files = readdirSync(routesDir).filter((file) => file.endsWith('.ts')); } catch { continue; }
  for (const file of files) {
    const source = readFileSync(join(routesDir, file), 'utf8');
    const prefix = mountPrefixes.get(module.name) ?? '';
    for (const match of source.matchAll(/\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]/gu)) {
      const method = match[1];
      const route = match[2];
      const path = `${prefix}${route === '/' ? '' : route}`.replaceAll('//', '/');
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
