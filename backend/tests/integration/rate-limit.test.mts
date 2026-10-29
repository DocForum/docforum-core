import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5498;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-rl-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type Services = typeof import('../../src/modules/rate-limit/services/index.js');

describe('rate limiting persistence', () => {
  let prisma: Prisma;
  let services: Services;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    const dbModule = await import('../../src/db/prisma-client.js');
    services = await import('../../src/modules/rate-limit/services/index.js');
    prisma = dbModule.prisma;
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('blocks after max requests and persists rows', async () => {
    const config = services.createRateLimitConfig('ip', 60, 2);
    const id = `rl-${Date.now()}`;
    const r1 = await services.checkRateLimit(id, config);
    expect(r1.allowed).toBe(true);
    const r2 = await services.checkRateLimit(id, config);
    expect(r2.allowed).toBe(true);
    const r3 = await services.checkRateLimit(id, config);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfter).toBeGreaterThan(0);

    const count = await prisma.rateLimitRecord.count({ where: { key: id, scope: 'ip' } });
    expect(count).toBe(2);
  });

  it('prunes old records', async () => {
    const removed = await services.pruneOldRateLimitRecords(new Date(Date.now() + 1000));
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});
