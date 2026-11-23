// GET /notifications/stream (issue #97) — real-HTTP integration coverage for
// issue #331. Every connection a test opens is tracked and destroyed in
// afterEach, and each test that closes a stream waits for the hub to drop
// it, so no socket outlives its test and vitest never hangs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5484;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-notification-stream-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_notification_stream_test`;

interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received so far, raw. */
  text: () => string;
  /** Resolves once the body so far satisfies `predicate`. */
  waitFor: (predicate: (body: string) => boolean, timeoutMs?: number) => Promise<string>;
  /** Resolves when the server ends the response. */
  ended: Promise<void>;
  close: () => void;
}

describe('GET /notifications/stream', () => {
  let server: http.Server;
  let baseUrl: string;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let stream: typeof import('../../src/modules/notifications/services/stream.js');
  let controllers: typeof import('../../src/modules/notifications/controllers/index.js');
  const users: Record<'alice' | 'bob', { id: string; token: string }> = {} as never;
  const open = new Set<http.ClientRequest>();

  function token(userId: string, expiresInSeconds = 900) {
    return jwt.sign({ sub: userId, role: 'patient' }, 'test-access-secret', { expiresIn: expiresInSeconds });
  }

  function connect(authToken?: string): Promise<OpenStream> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/notifications/stream`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}`, Accept: 'text/event-stream' } : {},
      });
      open.add(req);
      req.on('error', (error) => {
        // A destroyed request reports ECONNRESET/"socket hang up"; only a
        // failure before the response arrives is a real error.
        if (!req.destroyed) reject(error);
      });
      req.on('response', (res) => {
        let body = '';
        const waiters: Array<() => void> = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          for (const waiter of waiters.splice(0)) waiter();
        });
        const ended = new Promise<void>((done) => res.on('end', done));
        res.on('error', () => {});
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => body,
          ended,
          waitFor(predicate, timeoutMs = 3_000) {
            return new Promise((ok, fail) => {
              const timer = setTimeout(() => fail(new Error(`timed out waiting; received: ${JSON.stringify(body)}`)), timeoutMs);
              const check = () => {
                if (predicate(body)) {
                  clearTimeout(timer);
                  ok(body);
                } else {
                  waiters.push(check);
                }
              };
              check();
            });
          },
          close() {
            req.destroy();
            open.delete(req);
          },
        });
      });
    });
  }

  async function waitForCount(userId: string, expected: number, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (stream.notificationHub.count(userId) !== expected) {
      if (Date.now() > deadline) {
        throw new Error(`hub count for ${userId} is ${stream.notificationHub.count(userId)}, expected ${expected}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_notification_stream_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    stream = await import('../../src/modules/notifications/services/stream.js');
    controllers = await import('../../src/modules/notifications/controllers/index.js');
    // Short heartbeat so the heartbeat test takes milliseconds, not 15s.
    controllers.streamTimings.heartbeatMs = 100;
    const app = (await import('../../src/app.js')).createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const name of ['alice', 'bob'] as const) {
      const user = await prisma.user.create({
        data: { email: `stream-${name}-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
      });
      users[name] = { id: user.id, token: token(user.id) };
    }
  }, 180_000);

  afterEach(async () => {
    for (const req of open) req.destroy();
    open.clear();
    if (users.alice) await waitForCount(users.alice.id, 0);
    if (users.bob) await waitForCount(users.bob.id, 0);
  });

  afterAll(async () => {
    controllers.streamTimings.heartbeatMs = 15_000;
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects a request with no token with 401 and opens no stream', async () => {
    const res = await connect();
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await res.ended;
    expect(JSON.parse(res.text())).toHaveProperty('message');
  });

  it('rejects an invalid token with 401', async () => {
    const res = await connect('not-a-jwt');
    expect(res.status).toBe(401);
    await res.ended;
  });

  it('opens an event stream with caching disabled and a retry hint', async () => {
    const res = await connect(users.alice.token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-store, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    await res.waitFor((body) => body.startsWith('retry: 5000\n\n'));
    await waitForCount(users.alice.id, 1);
    res.close();
    await waitForCount(users.alice.id, 0);
  });

  it('sends heartbeat comments on the configured interval', async () => {
    const res = await connect(users.alice.token);
    const body = await res.waitFor((b) => (b.match(/: heartbeat\n\n/g) ?? []).length >= 2, 2_000);
    expect(body.startsWith('retry: 5000\n\n')).toBe(true);
    res.close();
    await waitForCount(users.alice.id, 0);
  });

  it('delivers a published event only to the recipient’s streams', async () => {
    const alice1 = await connect(users.alice.token);
    const alice2 = await connect(users.alice.token);
    const bob = await connect(users.bob.token);
    await waitForCount(users.alice.id, 2);
    await waitForCount(users.bob.id, 1);

    const delivered = stream.notificationHub.publish(users.alice.id, {
      id: 'n-1',
      event: 'notification',
      data: { type: 'referral.created', notificationId: 'n-1' },
    });
    expect(delivered).toBe(2);

    const frame = 'id: n-1\nevent: notification\ndata: {"type":"referral.created","notificationId":"n-1"}\n\n';
    await alice1.waitFor((b) => b.includes(frame));
    await alice2.waitFor((b) => b.includes(frame));
    // Give bob's socket a moment to have received anything it was going to.
    await new Promise((r) => setTimeout(r, 150));
    expect(bob.text()).not.toContain('n-1');

    alice1.close();
    alice2.close();
    bob.close();
    await waitForCount(users.alice.id, 0);
    await waitForCount(users.bob.id, 0);
  });

  it(`allows exactly ${5} streams per user, then answers 429 STREAM_LIMIT`, async () => {
    expect(stream.MAX_STREAMS_PER_USER).toBe(5);
    const streams: OpenStream[] = [];
    for (let i = 0; i < stream.MAX_STREAMS_PER_USER; i += 1) {
      const res = await connect(users.alice.token);
      expect(res.status).toBe(200);
      streams.push(res);
    }
    await waitForCount(users.alice.id, 5);

    const over = await connect(users.alice.token);
    expect(over.status).toBe(429);
    expect(over.headers['content-type']).toMatch(/application\/json/);
    await over.ended;
    expect(JSON.parse(over.text())).toMatchObject({ code: 'STREAM_LIMIT' });
    // The rejected attempt did not take a slot.
    expect(stream.notificationHub.count(users.alice.id)).toBe(5);

    // The cap is per user: bob is unaffected.
    const bob = await connect(users.bob.token);
    expect(bob.status).toBe(200);

    // Closing one frees exactly one slot.
    streams.shift()!.close();
    await waitForCount(users.alice.id, 4);
    const again = await connect(users.alice.token);
    expect(again.status).toBe(200);
    await waitForCount(users.alice.id, 5);
    const overAgain = await connect(users.alice.token);
    expect(overAgain.status).toBe(429);
    await overAgain.ended;

    for (const s of [...streams, again, bob]) s.close();
    await waitForCount(users.alice.id, 0);
    await waitForCount(users.bob.id, 0);
  });

  it('sends token-expired when the access token expires, ends the stream and unsubscribes', async () => {
    // jwt `exp` has one-second granularity, so this lands within ~1–2s.
    const res = await connect(token(users.bob.id, 2));
    expect(res.status).toBe(200);
    await waitForCount(users.bob.id, 1);
    await res.waitFor((b) => b.includes('event: token-expired\ndata: {"reason":"access-token-expired"}\n\n'), 3_500);
    await res.ended;
    await waitForCount(users.bob.id, 0);
    expect(stream.notificationHub.publish(users.bob.id, { data: 'late' })).toBe(0);
  });

  it('unsubscribes when the client disconnects', async () => {
    const res = await connect(users.alice.token);
    await waitForCount(users.alice.id, 1);
    res.close();
    await waitForCount(users.alice.id, 0);
    expect(stream.notificationHub.publish(users.alice.id, { data: 'after-close' })).toBe(0);
  });
});
