// Issue #332: security response headers on every response, x-powered-by
// gone, HSTS absent outside production, and the SSE stream still streams
// with caching disabled.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5485;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-security-headers-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_security_headers_test`;

function expectBaselineHeaders(headers: Record<string, string | string[] | undefined>) {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-powered-by']).toBeUndefined();
  // NODE_ENV is "test": HSTS must never be sent outside production.
  expect(headers['strict-transport-security']).toBeUndefined();
}

describe('security response headers', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let doctorToken: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_security_headers_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    app = (await import('../../src/app.js')).createApp();

    const user = await prisma.user.create({
      data: { email: `headers-doctor-${runId}@example.com`, passwordHash: 'unused', role: 'doctor' },
    });
    await prisma.doctorProfile.create({ data: { userId: user.id, fullName: 'Header Doctor', timeZone: 'UTC' } });
    doctorToken = jwt.sign({ sub: user.id, role: 'doctor' }, 'test-access-secret', { expiresIn: '15m' });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sets the headers on a public route', async () => {
    const res = await request(app).get('/specialties');
    expect(res.status).toBe(200);
    expectBaselineHeaders(res.headers);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets the headers, including no-store, on an authenticated route', async () => {
    const res = await request(app).get('/doctors/me').set('Authorization', `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe('Header Doctor');
    expectBaselineHeaders(res.headers);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets the headers on a 401 from the auth middleware', async () => {
    const res = await request(app).get('/doctors/me');
    expect(res.status).toBe(401);
    expectBaselineHeaders(res.headers);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an unknown route with a JSON 404 (never an HTML page) carrying the headers', async () => {
    const res = await request(app).get(`/no-such-route-${runId}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ message: 'Not found.' });
    expectBaselineHeaders(res.headers);
  });

  it('sets the headers on a CORS preflight', async () => {
    const res = await request(app)
      .options('/doctors/me')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBeLessThan(300);
    expectBaselineHeaders(res.headers);
  });

  it('keeps a route-specific Cache-Control (SSE) and still streams', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await new Promise<{ headers: http.IncomingHttpHeaders; firstChunk: string }>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/notifications/stream`, {
          headers: { Authorization: `Bearer ${doctorToken}` },
        });
        req.on('error', (error) => { if (!req.destroyed) reject(error); });
        req.on('response', (res) => {
          res.setEncoding('utf8');
          res.once('data', (chunk: string) => {
            resolve({ headers: res.headers, firstChunk: chunk });
            req.destroy();
          });
        });
      });
      expect(result.headers['content-type']).toBe('text/event-stream');
      expect(result.headers['cache-control']).toBe('no-store, no-transform');
      expectBaselineHeaders(result.headers);
      // The first frame arrives before the response ends: it is streaming.
      expect(result.firstChunk).toBe('retry: 5000\n\n');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
