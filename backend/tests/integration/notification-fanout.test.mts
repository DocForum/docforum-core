// Issue #330: real-time notification events reach a user's SSE stream on
// EVERY backend instance, through Postgres LISTEN/NOTIFY.
//
// Two app instances on one embedded Postgres. `vi.resetModules()` between
// the two imports gives instance B its own module graph — its own
// NotificationHub, Prisma pool and broker (asserted below) — so delivery
// from A to B can only travel through Postgres, exactly as between two
// processes. Covers: cross-instance delivery, single delivery per stream
// (no duplicates on the publishing instance), ids-only NOTIFY payloads and
// SSE frames, listener reconnection after the server kills the session,
// the post-reconnect `resync` hint, and the readiness report.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5485; // unique per integration file
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-notify-fanout-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_notify_fanout_test`;

process.env.NOTIFICATION_FANOUT_DRIVER = 'pg';
process.env.NOTIFICATION_FANOUT_RECONNECT_MIN_MS = '50';
process.env.NOTIFICATION_FANOUT_RECONNECT_MAX_MS = '200';

type AppModule = typeof import('../../src/app.js');
type NotificationsModule = typeof import('../../src/modules/notifications/services/index.js');
type FanoutModule = typeof import('../../src/modules/notifications/services/fanout.js');
type DbModule = typeof import('../../src/db/prisma-client.js');

interface Instance {
  name: string;
  server: http.Server;
  baseUrl: string;
  notifications: NotificationsModule;
  fanout: FanoutModule;
  db: DbModule;
}

interface SseFrame { id?: string; event?: string; data?: string }

/** An open SSE stream; collects parsed frames. */
function openStream(baseUrl: string, token: string) {
  const frames: SseFrame[] = [];
  let buffer = '';
  let request: http.ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    request = http.get(`${baseUrl}/notifications/stream`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream status ${res.statusCode}`));
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const frame: SseFrame = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = (frame.data ?? '') + line.slice(6);
          }
          if (frame.event || frame.data) frames.push(frame);
        }
      });
      resolve();
    });
    request.on('error', reject);
  });
  return { frames, ready, close: () => request.destroy() };
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('cross-instance notification fan-out (issue #330)', () => {
  let a: Instance;
  let b: Instance;
  let userId: string;
  let userToken: string;
  const rawNotifies: string[] = [];
  let observer: Client;

  async function bootInstance(name: string): Promise<Instance> {
    const appModule: AppModule = await import('../../src/app.js');
    const notifications: NotificationsModule = await import('../../src/modules/notifications/services/index.js');
    const fanout: FanoutModule = await import('../../src/modules/notifications/services/fanout.js');
    const db: DbModule = await import('../../src/db/prisma-client.js');
    notifications.startNotificationFanout();
    const server = appModule.createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { name, server, baseUrl: `http://127.0.0.1:${port}`, notifications, fanout, db };
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_notify_fanout_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    a = await bootInstance('A');
    vi.resetModules();
    b = await bootInstance('B');

    // Watch the raw channel to assert exactly what crosses NOTIFY.
    observer = new Client({ connectionString: databaseUrl });
    await observer.connect();
    observer.on('notification', (message) => {
      if (message.channel === a.fanout.NOTIFICATION_FANOUT_CHANNEL && message.payload) rawNotifies.push(message.payload);
    });
    await observer.query(`LISTEN "${a.fanout.NOTIFICATION_FANOUT_CHANNEL}"`);

    const user = await a.db.prisma.user.create({
      data: { email: `fanout-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    userId = user.id;
    userToken = jwt.sign({ sub: user.id, role: 'patient' }, 'test-access-secret', { expiresIn: '15m' });

    await waitFor(() => a.fanout.getNotificationFanoutState() === 'listening' && b.fanout.getNotificationFanoutState() === 'listening');
  }, 180_000);

  afterAll(async () => {
    await observer?.end().catch(() => undefined);
    for (const instance of [a, b]) {
      if (!instance) continue;
      await instance.fanout.notificationBroker.stop();
      instance.server.closeAllConnections();
      await new Promise((resolve) => instance.server.close(resolve));
      await instance.db.prisma.$disconnect();
    }
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs two genuinely separate instances (own hub, broker and Prisma client)', () => {
    expect(b.fanout.notificationBroker).not.toBe(a.fanout.notificationBroker);
    expect(b.db.prisma).not.toBe(a.db.prisma);
  });

  it('an event published on instance A reaches the user\'s stream on instance B — once — with ids only', async () => {
    const onB = openStream(b.baseUrl, userToken);
    const onA = openStream(a.baseUrl, userToken);
    await Promise.all([onB.ready, onA.ready]);
    const secretPaymentIntentId = randomUUID();
    rawNotifies.length = 0;

    try {
      const notification = await a.notifications.notify(userId, 'payment_refunded', { paymentIntentId: secretPaymentIntentId });

      const frameB = await waitFor(() => onB.frames.find((frame) => frame.event === 'notification'));
      expect(frameB.id).toBe(notification.id);
      expect(JSON.parse(frameB.data!)).toEqual({ id: notification.id, type: 'payment_refunded' });

      // The publishing instance's own stream gets it through its own LISTEN —
      // exactly once, never a second local copy.
      await waitFor(() => onA.frames.find((frame) => frame.event === 'notification'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(onA.frames.filter((frame) => frame.event === 'notification')).toHaveLength(1);
      expect(onB.frames.filter((frame) => frame.event === 'notification')).toHaveLength(1);

      // What crossed NOTIFY: three ids, nothing from the notification payload.
      await waitFor(() => rawNotifies.length > 0);
      expect(rawNotifies).toHaveLength(1);
      expect(JSON.parse(rawNotifies[0]!)).toEqual({ notificationId: notification.id, userId, type: 'payment_refunded' });
      for (const text of [...rawNotifies, ...onA.frames.map((f) => f.data ?? ''), ...onB.frames.map((f) => f.data ?? '')]) {
        expect(text).not.toContain(secretPaymentIntentId);
      }
    } finally {
      onA.close();
      onB.close();
    }
  });

  it('a duplicate notify (same sourceEventId) does not publish a second event', async () => {
    rawNotifies.length = 0;
    const sourceEventId = randomUUID();
    await b.notifications.notify(userId, 'new_booking', { appointmentId: randomUUID() }, { sourceEventId });
    await b.notifications.notify(userId, 'new_booking', { appointmentId: randomUUID() }, { sourceEventId });
    await waitFor(() => rawNotifies.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rawNotifies).toHaveLength(1);
  });

  it('reconnects the listener after the server kills its session, sends resync, and keeps delivering', async () => {
    const onB = openStream(b.baseUrl, userToken);
    await onB.ready;
    try {
      const { rowCount } = await observer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`,
        [a.db.NOTIFICATION_LISTENER_APPLICATION_NAME],
      );
      expect(rowCount).toBe(2); // one listener per instance

      await waitFor(() => b.fanout.getNotificationFanoutState() !== 'listening');
      await waitFor(() => a.fanout.getNotificationFanoutState() === 'listening' && b.fanout.getNotificationFanoutState() === 'listening');

      // Clients are told to refetch whatever was missed while disconnected.
      await waitFor(() => onB.frames.find((frame) => frame.event === 'resync'));

      // Delivery across instances works again, in the other direction too.
      const notification = await a.notifications.notify(userId, 'booking_confirmed', { appointmentId: randomUUID() });
      const frame = await waitFor(() => onB.frames.find((f) => f.event === 'notification' && f.id === notification.id));
      expect(JSON.parse(frame.data!)).toEqual({ id: notification.id, type: 'booking_confirmed' });
    } finally {
      onB.close();
    }
  });

  it('exposes the listener state in readiness without gating it', async () => {
    const res = await fetch(`${b.baseUrl}/health/ready`);
    const body = (await res.json()) as { status: string; checks: { notifications: string } };
    expect(body.checks.notifications).toBe('listening');
    expect(res.status).toBe(body.status === 'ready' ? 200 : 503);
  });
});
