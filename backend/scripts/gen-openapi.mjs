#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

// Generate OpenAPI spec (placeholder - in production this would introspect routes)
const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'DocForum API',
    description: 'DocForum backend API - modular monolith',
    version: '1.0.0'
  },
  servers: [
    { url: 'http://localhost:4000', description: 'Local development' }
  ],
  paths: {}
};

// Write spec
writeFileSync(join(root, 'backend/openapi.json'), JSON.stringify(openapi, null, 2));

// Generate types
mkdirSync(join(root, 'packages/api-client/src'), { recursive: true });
try {
  execSync('npx openapi-typescript backend/openapi.json -o packages/api-client/src/types.ts', {
    cwd: root,
    stdio: 'inherit'
  });
  console.log('Types generated');
} catch (e) {
  console.error('Failed to generate types:', e.message);
  process.exit(1);
}
